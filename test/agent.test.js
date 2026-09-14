import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeClock, callTool, harness, inboundEvent, until } from './helpers.js'
import { Store } from '../src/store.js'

const D1 = 'dialog-1'
const D2 = 'dialog-2'
const D3 = 'dialog-3'

/** Кладёт события в ленту так, как это делает приём. */
function feed(h, ...events) {
  const cursor = Math.max(0, ...events.map((e) => e.seq), h.store.getCursor() ?? 0)
  return h.service.ingest({ cursor, events })
}

test('три быстрых сообщения — один запуск, порядок сохранён', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'Напиши Денису'))
  await h.clock.advance(1000)
  feed(h, inboundEvent(D1, 'что сегодня не получится'))
  await h.clock.advance(1000)
  feed(h, inboundEvent(D1, 'хотя погоди, завтра утром получится'))

  await h.clock.advance(2999)
  assert.equal(h.agents.launched.length, 0, 'пауза ещё не прошла')
  await h.clock.advance(1)
  assert.equal(h.agents.launched.length, 1)

  const { input } = h.agents.launched[0]
  assert.equal(input.contract, '1chat.agent.run/v1')
  assert.equal(input.dialog_id, D1)
  assert.equal(input.input_version, 3)
  assert.deepEqual(
    input.messages.map((m) => m.text),
    ['Напиши Денису', 'что сегодня не получится', 'хотя погоди, завтра утром получится'],
  )
  assert.ok(input.messages.every((m) => m.id), 'у каждого сообщения есть идентификатор')
  assert.ok(!JSON.stringify(input).includes('base64'), 'картинки в контракт не попадают')
})

test('новые события сохраняются, пока агент работает', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'первое'))
  await h.clock.advance(3000)
  assert.equal(h.agents.launched.length, 1)

  // Агент ещё работает: приём не ждёт его.
  const touched = feed(h, inboundEvent(D1, 'второе'), inboundEvent(D2, 'другой диалог'))
  assert.deepEqual(touched.sort(), [D1, D2])
  assert.equal(h.store.getDialog(D1).version, 2)
  assert.equal(h.store.pendingMessages(D1, 0).length, 2)
})

test('уточнение во время работы — старая отправка заблокирована и не дошла до сервера', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'Напиши Денису, что сегодня не получится'))
  await h.clock.advance(3000)
  const first = h.agents.launched[0]

  feed(h, inboundEvent(D1, 'хотя погоди, завтра утром получится'))
  await h.clock.advance(3000)

  const reply = await callTool(h.url, first.env.ONECHAT_MCP_TOKEN, 'send_message', {
    conversation_id: 'dialog-denis',
    text: 'Сегодня не получится',
  })
  assert.equal(reply.isError, true)
  assert.match(reply.text, /^STALE_CONTEXT/)
  assert.equal(h.upstream.sends.length, 0, 'upstream не вызывался')
  assert.equal(h.agents.launched.length, 1, 'второй запуск не начат, пока первый жив')
})

test('повторный запуск видит исходное поручение и уточнение', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'Напиши Денису'))
  await h.clock.advance(3000)
  const first = h.agents.launched[0]
  feed(h, inboundEvent(D1, 'хотя погоди'))
  first.exit(0)
  await until(() => h.store.getRun(first.input.run_id).status === 'stale')

  await h.clock.advance(3000)
  assert.equal(h.agents.launched.length, 2)
  const second = h.agents.launched[1].input
  assert.deepEqual(second.messages.map((m) => m.text), ['Напиши Денису', 'хотя погоди'])
  assert.equal(second.reason, 'context_changed')
  assert.equal(second.previous_runs[0].status, 'stale')
  assert.equal(second.input_version, 2)
})

test('«стоп, не отправляй» до отправки — старый запуск ничего не отправил', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'Отправь Денису «опаздываю»'))
  await h.clock.advance(3000)
  const first = h.agents.launched[0]

  feed(h, inboundEvent(D1, 'Стоп, не отправляй'))
  await h.clock.advance(5000)

  const reply = await callTool(h.url, first.env.ONECHAT_MCP_TOKEN, 'send_message', {
    conversation_id: 'dialog-denis',
    text: 'опаздываю',
  })
  assert.match(reply.text, /^STALE_CONTEXT/)
  first.exit(0)
  await until(() => h.store.getRun(first.input.run_id).status === 'stale')
  await h.clock.advance(3000)

  const second = h.agents.launched[1]
  assert.deepEqual(second.input.messages.map((m) => m.text), ['Отправь Денису «опаздываю»', 'Стоп, не отправляй'])
  second.exit(0)
  await until(() => h.store.getRun(second.input.run_id).status === 'succeeded')
  assert.equal(h.upstream.sends.length, 0)
})

test('два диалога работают независимо и соблюдают общий лимит', async (t) => {
  const h = await harness({ settings: { concurrency: 2 } })
  t.after(h.close)

  feed(h, inboundEvent(D1, 'раз'), inboundEvent(D2, 'два'), inboundEvent(D3, 'три'))
  await h.clock.advance(3000)
  assert.equal(h.agents.launched.length, 2, 'лимит — два одновременных')
  assert.equal(h.service.dispatcher.activeCount, 2)

  // Первый диалог не держит второй: закончил второй — сразу пошёл третий.
  const d2 = h.agents.launched.find((a) => a.input.dialog_id === D2)
  d2.exit(0)
  await until(() => h.agents.launched.length === 3)
  assert.equal(h.agents.launched[2].input.dialog_id, D3)
  assert.equal(h.service.dispatcher.activeCount, 2)
})

test('в одном диалоге нет двух активных запусков', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'раз'))
  await h.clock.advance(3000)
  for (let i = 0; i < 5; i += 1) {
    feed(h, inboundEvent(D1, `ещё ${i}`))
    await h.clock.advance(20_000)
    h.service.dispatcher.poke()
  }
  assert.equal(h.agents.launched.length, 1)
  assert.equal(h.store.activeRuns().length, 1)
  // И на уровне хранилища: вторую запись о запуске не создать.
  assert.equal(h.store.startRun(D1, { timeoutMs: 1000 }), null)
})

test('рестарт не теряет сохранённые задания, а прерванный запуск теряет пароль', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), '1chat-agent-'))
  const dbFile = join(dir, 'agent.db')
  const clock = new FakeClock()

  const before = await harness({ dbFile, clock })
  feed(before, inboundEvent(D1, 'сохранено до падения'))
  await clock.advance(3000)
  const orphan = before.agents.launched[0]
  // Служба «падает»: процесс не завершается штатно, запись о запуске остаётся активной.
  before.service.dispatcher.stopping = true
  await before.server.close()
  before.store.close()

  const after = await harness({ dbFile, clock })
  t.after(after.close)
  const recovered = after.service.recover()
  assert.equal(recovered.interruptedRuns, 1)

  // Осиротевший процесс со старым паролем ничего не может.
  const reply = await callTool(after.url, orphan.env.ONECHAT_MCP_TOKEN, 'send_message', { conversation_id: D1, text: 'x' })
  assert.equal(reply.status, 401)

  await clock.advance(10_000)
  assert.equal(after.agents.launched.length, 1)
  assert.deepEqual(after.agents.launched[0].input.messages.map((m) => m.text), ['сохранено до падения'])
})

test('повторное событие не создаёт повторной работы', async (t) => {
  const h = await harness()
  t.after(h.close)

  const event = inboundEvent(D1, 'один раз', { id: 'stable-id' })
  feed(h, event)
  feed(h, event)
  // То же сообщение в событии «обновлено» со сменой статуса — не новое.
  feed(h, inboundEvent(D1, 'один раз', { id: 'stable-id', kind: 'message:updated', extra: { status: 'read' } }))
  assert.equal(h.store.getDialog(D1).version, 1)

  await h.clock.advance(3000)
  h.agents.launched[0].exit(0)
  await until(() => h.store.getRun(h.agents.launched[0].input.run_id).status === 'succeeded')

  feed(h, event)
  await h.clock.advance(60_000)
  assert.equal(h.agents.launched.length, 1)
})

test('правка сообщения в пачке — это продолжение, правка обработанного — нет', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'в 10', { id: 'm' }))
  feed(h, inboundEvent(D1, 'в 11', { id: 'm', kind: 'message:updated' }))
  assert.equal(h.store.getDialog(D1).version, 2)
  await h.clock.advance(3000)
  assert.deepEqual(h.agents.launched[0].input.messages.map((m) => m.text), ['в 11'])
  h.agents.launched[0].exit(0)
  await until(() => h.store.getDialog(D1).handled_version === 2)

  feed(h, inboundEvent(D1, 'в 12', { id: 'm', kind: 'message:updated' }))
  assert.equal(h.store.getDialog(D1).version, 2)
})

test('ошибка и зависание агента не останавливают диспетчер; попытки ограничены', async (t) => {
  const h = await harness({ settings: { runTimeoutMs: 60_000, maxAttempts: 3 } })
  t.after(h.close)

  feed(h, inboundEvent(D1, 'упадёт'), inboundEvent(D2, 'зависнет'))
  await h.clock.advance(3000)
  const [a1, a2] = h.agents.launched
  a1.exit(2)
  a2.fail({ kind: 'timeout', code: null, signal: 'SIGKILL', error: 'таймаут' })
  await until(() => h.store.activeRuns().length === 0)

  const runs = [a1, a2].map((a) => h.store.getRun(a.input.run_id))
  assert.deepEqual(runs.map((r) => r.status).sort(), ['failed', 'timed_out'])

  // Остальные диалоги продолжают обслуживаться, пока упавшие ждут повтора.
  feed(h, inboundEvent(D3, 'живой'))
  await h.clock.advance(3000)
  assert.ok(h.agents.launched.some((a) => a.input.dialog_id === D3))
  h.agents.launched.find((a) => a.input.dialog_id === D3).exit(0)
  await until(() => h.store.activeRuns().length === 0)

  // Немедленного перезапуска упавших нет: первая пауза — 10 секунд.
  await h.clock.advance(6_000)
  assert.equal(h.agents.launched.length, 3)

  // Повторы по D1 — с паузой, и не больше трёх попыток.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await h.clock.advance(400_000)
    for (const agent of h.agents.launched) agent.exit(1)
    await until(() => h.store.activeRuns().length === 0)
  }
  const d1Runs = h.agents.launched.filter((a) => a.input.dialog_id === D1)
  assert.equal(d1Runs.length, 3)
  assert.equal(h.agents.launched.filter((a) => a.input.dialog_id === D2).length, 3)
  assert.equal(h.store.getDialog(D1).handled_version, 1, 'пачка брошена, диалог не застрял')
  assert.ok(h.logs.some((l) => l.message.includes('брошена')))
})

test('ошибка запуска команды не роняет диспетчер', async (t) => {
  const h = await harness()
  t.after(h.close)
  feed(h, inboundEvent(D1, 'x'))
  await h.clock.advance(3000)
  h.agents.launched[0].fail({ kind: 'spawn_error', error: 'ENOENT' })
  await until(() => h.store.activeRuns().length === 0)
  assert.equal(h.store.getRun(h.agents.launched[0].input.run_id).status, 'spawn_failed')
  await h.clock.advance(10_000)
  assert.equal(h.agents.launched.length, 2)
})

test('старый пароль не даёт выполнить действие', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'ответь'))
  await h.clock.advance(3000)
  const run = h.agents.launched[0]
  run.exit(0)
  await until(() => h.store.getRun(run.input.run_id).status === 'succeeded')

  const expired = await callTool(h.url, run.env.ONECHAT_MCP_TOKEN, 'send_message', { conversation_id: D1, text: 'поздно' })
  assert.equal(expired.status, 401)

  const readOnly = await callTool(h.url, 'read-token', 'send_message', { conversation_id: D1, text: 'обход' })
  assert.match(readOnly.text, /^UNAUTHORIZED/)

  const invented = await callTool(h.url, 'invented-token', 'send_message', { conversation_id: D1, text: 'обход' })
  assert.equal(invented.status, 401)

  // runId из аргументов модели ничего не значит.
  const spoofed = await callTool(h.url, 'read-token', 'send_message', { conversation_id: D1, text: 'обход', run_id: run.input.run_id })
  assert.match(spoofed.text, /^UNAUTHORIZED/)
  assert.equal(h.upstream.sends.length, 0)
})

test('неопределённый результат отправки не приводит к автоматическому дублю', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'скажи привет'))
  await h.clock.advance(3000)
  const run = h.agents.launched[0]
  const token = run.env.ONECHAT_MCP_TOKEN

  // Сообщение дошло до сервера, но ответ потерян.
  h.upstream.behavior.send = 'throw'
  const first = await callTool(h.url, token, 'send_message', { conversation_id: D1, text: 'Привет!' })
  assert.match(first.text, /^UNCERTAIN_RESULT/)
  assert.equal(h.upstream.sends.length, 1)

  // Агент пробует ещё раз — сверка находит сообщение, повтора нет.
  h.upstream.behavior.send = 'ok'
  const second = await callTool(h.url, token, 'send_message', { conversation_id: D1, text: 'Привет!' })
  assert.match(second.text, /^ALREADY_DONE/)
  assert.equal(h.upstream.sends.length, 1)
})

test('неопределённая отправка, которой нет в истории, повторяется только после срока сверки', async (t) => {
  const h = await harness({ settings: { runTimeoutMs: 3_600_000 } })
  t.after(h.close)

  feed(h, inboundEvent(D1, 'скажи привет'))
  await h.clock.advance(3000)
  const token = h.agents.launched[0].env.ONECHAT_MCP_TOKEN

  h.upstream.behavior.send = 'throw-before'
  const first = await callTool(h.url, token, 'send_message', { conversation_id: D1, text: 'Привет!' })
  assert.match(first.text, /^UNCERTAIN_RESULT/)

  h.upstream.behavior.send = 'ok'
  const early = await callTool(h.url, token, 'send_message', { conversation_id: D1, text: 'Привет!' })
  assert.match(early.text, /^UNCERTAIN_RESULT/, 'раньше срока сообщение может быть в пути')
  assert.equal(h.upstream.sends.length, 0)

  await h.clock.advance(181_000)
  const late = await callTool(h.url, token, 'send_message', { conversation_id: D1, text: 'Привет!' })
  assert.equal(late.isError, false)
  assert.equal(h.upstream.sends.length, 1)
})

test('после перезапуска начатое действие считается неопределённым', async () => {
  const clock = new FakeClock()
  const store = new Store(':memory:', { now: clock.now })
  store.ingestPage({ cursor: 1, inbound: [{ dialogId: D1, message: { id: 'a', text: 'x' }, feedSeq: 1, kind: 'new' }] })
  const { token } = store.startRun(D1, { timeoutMs: 60_000 })
  const begun = store.beginAction({ token, tool: 'send_message', targetId: D1, arguments: {}, fingerprint: 'f', quietMs: 0, dedupe: true })
  assert.equal(begun.ok, true)
  const result = store.recoverAfterRestart({ maxAttempts: 3, backoffMs: () => 1000 })
  assert.equal(result.uncertainActions, 1)
  assert.equal(store.getAction(begun.action.action_id).status, 'uncertain')
  store.close()
})

test('max-wait запускает подготовку при непрерывном вводе, но не обходит контроль отправки', async (t) => {
  const h = await harness()
  t.after(h.close)

  // Человек пишет каждые 2 секунды — пауза в 3 секунды не наступает никогда.
  for (let i = 0; i < 8; i += 1) {
    feed(h, inboundEvent(D1, `часть ${i}`))
    await h.clock.advance(2000)
  }
  // Первое сообщение было 16 секунд назад: подготовка началась по max-wait.
  assert.equal(h.agents.launched.length, 1)
  const run = h.agents.launched[0]
  assert.ok(run.input.messages.length >= 7)

  // Отправка ждёт паузу, а не уходит сразу.
  const pending = callTool(h.url, run.env.ONECHAT_MCP_TOKEN, 'send_message', { conversation_id: D1, text: 'ответ' })
  // Ждём именно сон отправки, а не любой таймер: диспетчер ставит свои, и
  // на медленной машине тест двигал часы раньше, чем запрос доходил до MCP.
  await until(() => h.clock.sleeping > 0, { rounds: 2000, message: 'отправка не встала в ожидание' })
  assert.equal(h.upstream.sends.length, 0)

  // Пока ждала — пришло ещё: отправка устарела.
  feed(h, inboundEvent(D1, 'и ещё'))
  await h.clock.advance(3000)
  const reply = await pending
  assert.match(reply.text, /^STALE_CONTEXT/)
  assert.equal(h.upstream.sends.length, 0)
})

test('отправка после паузы при актуальной версии проходит, с client_id службы', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'Скажи Денису привет'))
  await h.clock.advance(3000)
  const run = h.agents.launched[0]
  const reply = await callTool(h.url, run.env.ONECHAT_MCP_TOKEN, 'send_message', {
    conversation_id: 'dialog-denis',
    text: 'Привет',
    client_id: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(reply.isError, false)
  assert.equal(h.upstream.sends.length, 1)
  assert.notEqual(h.upstream.sends[0].args.client_id, '00000000-0000-0000-0000-000000000000')
  assert.ok(!reply.text.includes('base64'), 'ответ сокращён')
  assert.equal(reply.message.result.structuredContent, undefined)

  // Та же отправка в той же пачке — не второй раз.
  const again = await callTool(h.url, run.env.ONECHAT_MCP_TOKEN, 'send_message', { conversation_id: 'dialog-denis', text: 'Привет' })
  assert.match(again.text, /^ALREADY_DONE/)

  // Новый запуск по этой же пачке знает, что уже сделано.
  feed(h, inboundEvent(D1, 'и спроси, как дела'))
  run.exit(0)
  await until(() => h.store.getRun(run.input.run_id).status === 'stale')
  await h.clock.advance(3000)
  const second = h.agents.launched[1].input
  assert.equal(second.previous_actions.length, 1)
  assert.equal(second.previous_actions[0].status, 'succeeded')
  assert.equal(second.previous_actions[0].tool, 'send_message')
  // Версия проверялась по диалогу поручения, а не по получателю.
  const denisVersion = h.store.getDialog('dialog-denis')
  assert.equal(denisVersion, null)
})

test('запрещённые и неизвестные инструменты не проходят, список их не показывает', async (t) => {
  const h = await harness()
  t.after(h.close)

  feed(h, inboundEvent(D1, 'x'))
  await h.clock.advance(3000)
  const token = h.agents.launched[0].env.ONECHAT_MCP_TOKEN

  for (const name of ['register_webhook', 'wait_for_changes', 'brand_new_writer']) {
    const reply = await callTool(h.url, token, name, {})
    assert.match(reply.text, /^ACTION_NOT_ALLOWED/, name)
  }
  assert.equal(h.upstream.calls.filter((c) => c.request?.method === 'tools/call').length, 0)

  const list = async (auth) => {
    const response = await fetch(h.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    })
    const data = (await response.text()).split('\n').find((l) => l.startsWith('data: '))
    return JSON.parse(data.slice(6)).result.tools
  }
  const forRun = await list(token)
  assert.deepEqual(forRun.map((x) => x.name).sort(), ['list_messages', 'send_message', 'set_reaction'])
  assert.ok(forRun.every((x) => !x.outputSchema))
  const forRead = await list('read-token')
  assert.deepEqual(forRead.map((x) => x.name), ['list_messages'])

  // Пакет запросов — не лазейка.
  const batch = await fetch(h.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: {} } }]),
  })
  assert.equal(batch.status, 400)
})

test('чтение через пароль чтения сокращается и доходит до сервера', async (t) => {
  const h = await harness()
  t.after(h.close)
  const reply = await callTool(h.url, 'read-token', 'list_messages', { conversation_id: D1 })
  assert.equal(reply.isError, false)
  assert.ok(!reply.text.includes('base64'))
  assert.ok(!reply.text.includes('tenant_id'))
  const upstreamCall = h.upstream.calls.find((c) => c.request?.method === 'tools/call')
  assert.equal(upstreamCall.headers.Authorization, 'Bearer sk_1chat_rw_secret')
})

test('агенту не передаётся ключ 1-chat', async (t) => {
  const h = await harness()
  t.after(h.close)
  feed(h, inboundEvent(D1, 'x'))
  await h.clock.advance(3000)
  const { env } = h.agents.launched[0]
  assert.equal(env.ONECHAT_API_KEY, undefined)
  assert.ok(!Object.values(env).some((v) => String(v).includes('sk_1chat_rw_secret')))
  assert.equal(env.OTHER, 'value')
  assert.ok(env.ONECHAT_MCP_TOKEN)
  assert.equal(env.ONECHAT_MCP_URL, h.url)
})

test('курсор старого режима переносится один раз', async () => {
  const dir = await mkdtemp(join(tmpdir(), '1chat-migrate-'))
  const file = join(dir, 'cursor')
  await writeFile(file, '4242')
  const store = new Store(join(dir, 'agent.db'))
  assert.equal(store.migrateCursorFile(file), 4242)
  assert.equal(store.getCursor(), 4242)
  assert.ok(!existsSync(file))
  assert.equal(await readFile(`${file}.migrated`, 'utf8'), '4242')

  // Второй раз не откатывает позицию назад.
  await writeFile(file, '1')
  assert.equal(store.migrateCursorFile(file), null)
  assert.equal(store.getCursor(), 4242)
  store.close()
})

test('курсор и сообщения записываются вместе', () => {
  const store = new Store(':memory:')
  assert.throws(() =>
    store.ingestPage({
      cursor: 99,
      inbound: [
        { dialogId: D1, message: { id: 'ok', text: 'a' }, feedSeq: 1, kind: 'new' },
        // Сломанная запись посреди страницы.
        { dialogId: D1, message: { id: 'bad', text: 'b' }, feedSeq: null, kind: 'new' },
      ],
    }),
  )
  assert.equal(store.getCursor(), null, 'курсор не сдвинулся')
  assert.equal(store.pendingMessages(D1, 0).length, 0, 'и сообщения не записаны')
  store.close()
})

test('при непрерывном вводе устаревшие запуски не идут по кругу', async (t) => {
  const h = await harness()
  t.after(h.close)

  let text = 0
  const typeFor = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 2000) {
      feed(h, inboundEvent(D1, `часть ${text++}`))
      // Запуск, начатый до этого сообщения, устарел и сразу завершается.
      for (const agent of h.agents.launched) agent.exit(0)
      await until(() => h.store.activeRuns().length === 0)
      await h.clock.advance(2000)
    }
  }
  await typeFor(60_000)
  // Минута непрерывного ввода — не больше одного запуска на окно max-wait.
  assert.ok(h.agents.launched.length <= 5, `запусков: ${h.agents.launched.length}`)
  assert.ok(h.agents.launched.length >= 2)

  // Человек замолчал — последний запуск получает всю переписку целиком.
  await h.clock.advance(3000)
  const last = h.agents.launched.at(-1)
  assert.equal(last.input.messages.length, text)
  assert.ok(h.agents.launched.slice(0, -1).every((a) => h.store.getRun(a.input.run_id).status === 'stale'))
})
