import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

/**
 * Эти тесты запускают команду как процесс, а не импортируют её.
 *
 * Импорт проверяет, что код разбирается; запуск проверяет, что он вообще
 * что-то делает. Первый выпуск прошёл все проверки и при установке из npm
 * молчал: точка входа не срабатывала, потому что npm ставит команду через
 * символическую ссылку.
 */

test('--help печатает подсказку, а не молчит', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help'])
  assert.match(stdout, /--exec/)
  assert.ok(stdout.length > 100, 'подсказка должна быть содержательной')
})

test('без ключа объясняет, чего не хватает', async () => {
  const result = await run(process.execPath, [CLI, '--exec', 'true'], {
    env: { ...process.env, ONECHAT_API_KEY: '' },
  }).catch((e) => e)
  assert.match(result.stderr, /ONECHAT_API_KEY/)
  assert.equal(result.code, 1)
})

test('без режима объясняет, чего не хватает', async () => {
  const result = await run(process.execPath, [CLI], {
    env: { ...process.env, ONECHAT_API_KEY: 'sk_1chat_ro_x' },
  }).catch((e) => e)
  assert.match(result.stderr, /--agent/)
  assert.equal(result.code, 1)
})

test('недоступный сервер — понятная ошибка, а не стектрейс', async () => {
  // Заведомо закрытый порт на локальной машине: тест проверяет наше
  // поведение, а не чужую сеть, и не должен зависеть от интернета.
  const result = await run(
    process.execPath,
    [CLI, '--exec', 'true', '--state', '/tmp/1chat-test-cursor'],
    {
      env: {
        ...process.env,
        ONECHAT_API_KEY: 'sk_1chat_ro_dead',
        ONECHAT_BASE_URL: 'http://127.0.0.1:9',
      },
    },
  ).catch((e) => e)
  assert.equal(result.code, 1)
  assert.ok(!result.stderr.includes('at OneChatClient'), 'человеку стектрейс не нужен')
})

test('--serve-mcp поднимает порт, который без пароля молчит', async (t) => {
  const { spawn } = await import('node:child_process')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), '1chat-cli-'))
  const child = spawn(
    process.execPath,
    [CLI, '--serve-mcp', '0', '--state', join(dir, 'cursor')],
    {
      env: {
        ...process.env,
        ONECHAT_API_KEY: 'sk_1chat_rw_x',
        // Несуществующий адрес: нам важно, что запрос ушёл наверх, а не то,
        // что кто-то на него ответил.
        ONECHAT_BASE_URL: 'http://127.0.0.1:1/api',
      },
    },
  )
  t.after(() => child.kill())

  // Ждём напечатанный конфиг — он же и есть то, что человек копирует.
  const config = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`не дождались конфига: ${out}`)), 15000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('Authorization')) {
        clearTimeout(timer)
        resolve(out)
      }
    })
    child.on('exit', (code) => reject(new Error(`процесс вышел с кодом ${code}: ${out}`)))
  })

  const url = config.match(/url: "(\S+)"/)[1]
  const token = config.match(/Bearer (\S+)"/)[1]
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

  const closed = await fetch(url, { method: 'POST', body: '{}' })
  assert.equal(closed.status, 401)

  const opened = await fetch(url, {
    method: 'POST',
    body: '{}',
    headers: { Authorization: `Bearer ${token}` },
  })
  // 502: пароль подошёл, запрос ушёл наверх и там никого нет. Это и требуется.
  assert.equal(opened.status, 502)
})

test('--agent нельзя молча смешать со старым режимом', async () => {
  const result = await run(process.execPath, [CLI, '--agent', 'true', '--serve-mcp'], {
    env: { ...process.env, ONECHAT_API_KEY: 'sk_1chat_rw_x' },
  }).catch((e) => e)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /нельзя сочетать/)
})

test('неверные числа в параметрах — отказ с объяснением', async () => {
  const result = await run(process.execPath, [CLI, '--agent', 'true', '--concurrency', '0'], {
    env: { ...process.env, ONECHAT_API_KEY: 'sk_1chat_rw_x' },
  }).catch((e) => e)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--concurrency/)
})

/**
 * Сквозной прогон режима --agent настоящим процессом: настоящие таймеры,
 * настоящий SQLite на диске, настоящий дочерний агент. Подменён только
 * сервер 1-chat — локальным HTTP, реальных сообщений нет.
 */
test('--agent: пачка, запуск без ключа, отправка через пароль запуска, остановка', async (t) => {
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const KEY = 'sk_1chat_rw_e2e_secret'
  const dir = await mkdtemp(join(tmpdir(), '1chat-e2e-'))
  const sends = []
  const events = []
  let seq = 0
  const push = (text) => {
    seq += 1
    events.push({
      type: 'message:new',
      dialog_id: 'd1',
      channel_id: 'telegram_client',
      seq,
      payload: { id: `m${seq}`, direction: 'inbound', text, conversation_id: 'd1', avatar_url: 'data:image/png;base64,AAAA' },
    })
  }

  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end()
      return
    }
    if (url.pathname === '/api/v1/changes') {
      const since = Number(url.searchParams.get('since'))
      const fresh = events.filter((e) => e.seq > since)
      if (!fresh.length) await new Promise((r) => setTimeout(r, 100))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ cursor: Math.max(since, seq), events: fresh, has_more: false, status: 'ok' }))
      return
    }
    if (url.pathname === '/api/v1/mcp/') {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      if (request.method === 'tools/call' && request.params.name === 'send_message') sends.push(request.params.arguments)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{"id":"out1","tenant_id":"t"}' }], isError: false } }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  t.after(() => upstream.close())
  const base = `http://127.0.0.1:${upstream.address().port}/api`

  const agentScript = join(dir, 'agent.mjs')
  await writeFile(
    agentScript,
    `
    import { writeFileSync } from 'node:fs'
    let input = ''
    for await (const c of process.stdin) input += c
    const contract = JSON.parse(input)
    const r = await fetch(process.env.ONECHAT_MCP_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.ONECHAT_MCP_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: contract.dialog_id, text: 'ответ на ' + contract.messages.length } } }),
    })
    writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ contract, env: process.env, reply: await r.text() }))
    `,
  )

  const child = spawn(
    process.execPath,
    [CLI, '--agent', `"${process.execPath}" "${agentScript}"`, '--db', join(dir, 'agent.db'), '--mcp-port', '0', '--quiet-ms', '300', '--max-wait-ms', '5000', '--from', 'begin'],
    { env: { ...process.env, ONECHAT_API_KEY: KEY, ONECHAT_BASE_URL: base } },
  )
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => child.kill('SIGKILL'))

  push('Напиши Денису')
  push('что сегодня не получится')
  push('хотя погоди, завтра утром получится')

  const seenFile = join(dir, 'seen.json')
  let seen
  for (let i = 0; i < 300 && !seen; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
    seen = await readFile(seenFile, 'utf8').then(JSON.parse, () => null)
  }
  assert.ok(seen, `агент не запустился: ${stderr}`)
  assert.deepEqual(seen.contract.messages.map((m) => m.text), ['Напиши Денису', 'что сегодня не получится', 'хотя погоди, завтра утром получится'])
  assert.equal(seen.env.ONECHAT_API_KEY, undefined)
  assert.ok(!JSON.stringify(seen.env).includes(KEY), 'ключ не должен попасть агенту ни под каким именем')
  assert.ok(!seen.reply.includes('tenant_id'), 'ответ сокращён')
  assert.deepEqual(sends.map((s) => s.text), ['ответ на 3'])
  assert.ok(sends[0].client_id, 'client_id подставлен службой')

  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
})
