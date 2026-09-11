import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AuthError, OneChatClient, isIncomingMessage } from '../src/client.js'

const KEY = 'sk_1chat_ro_test'

/**
 * Отдаёт заготовленные ответы по очереди. Когда очередь кончилась —
 * останавливает клиент, чтобы цикл завершился сам, а не по таймеру:
 * тест, который держится на времени, рано или поздно начнёт мигать.
 */
function fakeFetch(responses, client = null) {
  const calls = []
  const queue = [...responses]
  const doFetch = async (url, options) => {
    calls.push({ url: String(url), options })
    const next = queue.shift()
    if (next === undefined) {
      if (doFetch.client) doFetch.client.stop()
      return { ok: true, status: 200, json: async () => ({ cursor: 0, events: [] }) }
    }
    if (next.throws) throw next.throws
    return { ok: next.status < 400, status: next.status, json: async () => next.body }
  }
  doFetch.calls = calls
  doFetch.client = client
  return doFetch
}

/** Клиент, который остановится, когда заготовленные ответы кончатся. */
function clientFor(responses) {
  const doFetch = fakeFetch(responses)
  const client = new OneChatClient({ apiKey: KEY, fetch: doFetch })
  doFetch.client = client
  return { client, doFetch }
}

const inbound = (seq, dialog = 'c1') => ({
  type: 'message:new',
  channel_id: 'whatsapp',
  dialog_id: dialog,
  seq,
  payload: { direction: 'inbound', text: 'привет' },
})

test('ключ обязателен — без него молчаливый простой хуже ошибки', () => {
  assert.throws(() => new OneChatClient({}), /apiKey/)
})

test('ключ уходит заголовком, а не в адресе', async () => {
  const doFetch = fakeFetch([{ status: 200, body: { cursor: 7 } }])
  const client = new OneChatClient({ apiKey: KEY, fetch: doFetch })
  await client.cursor()
  const { url, options } = doFetch.calls[0]
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`)
  assert.ok(!url.includes(KEY), 'ключ в адресе попал бы в логи прокси')
})

test('401 — отдельный тип ошибки: ждать бесполезно', async () => {
  const doFetch = fakeFetch([{ status: 401, body: {} }])
  const client = new OneChatClient({ apiKey: KEY, fetch: doFetch })
  await assert.rejects(client.cursor(), AuthError)
})

test('на удержание даётся больше времени, чем держит сервер', async () => {
  const doFetch = fakeFetch([{ status: 200, body: { cursor: 1, events: [] } }])
  const client = new OneChatClient({ apiKey: KEY, fetch: doFetch })
  await client.waitOnce(0, 30)
  // Иначе мы оборвём соединение за миг до честного ответа и потеряем события.
  assert.ok(doFetch.calls[0].url.includes('wait=30'))
})

test('первый запуск начинается с текущего момента, а не с начала журнала', async () => {
  const { client, doFetch } = clientFor([
    { status: 200, body: { cursor: 500 } },
    { status: 200, body: { cursor: 500, events: [] } },
  ])
  const saved = []
  await client.run({ since: null, onEvent: () => {}, onCursor: (c) => saved.push(c) })
  assert.ok(doFetch.calls.length >= 2)
  assert.equal(saved[0], 500, 'иначе агент проснётся на двухнедельной истории')
})

test('сохранённая позиция уважается', async () => {
  const { client, doFetch } = clientFor([{ status: 200, body: { cursor: 42, events: [] } }])
  await client.run({ since: 40, onEvent: () => {}, onCursor: () => {} })
  assert.ok(doFetch.calls[0].url.includes('since=40'))
})

test('gap не проглатывается, а признаётся', async () => {
  const { client } = clientFor([
    { status: 200, body: { cursor: 0, status: 'gap', events: [] } },
    { status: 200, body: { cursor: 900 } },
    { status: 200, body: { cursor: 900, events: [] } },
  ])
  const saved = []
  await client.run({ since: 5, onEvent: () => {}, onCursor: (c) => saved.push(c) })
  assert.ok(saved.includes(900), 'после разрыва продолжаем с текущего места')
})

test('позиция сохраняется до того, как агент отработал', async () => {
  // Иначе падение агента на первом событии заставит переобработать пачку.
  const { client } = clientFor([
    { status: 200, body: { cursor: 10, events: [inbound(9), inbound(10)] } },
  ])
  const order = []
  await client.run({
    since: 8,
    onCursor: () => order.push('cursor'),
    onEvent: () => order.push('event'),
  })
  assert.equal(order[0], 'cursor')
})

test('сбой сети не роняет цикл', async () => {
  const { client, doFetch } = clientFor([
    { throws: new Error('ECONNRESET') },
    { status: 200, body: { cursor: 3, events: [] } },
  ])
  await client.run({ since: 1, onEvent: () => {}, onCursor: () => {} })
  assert.ok(doFetch.calls.length >= 2, 'после паузы должна быть повторная попытка')
})

test('отозванный ключ останавливает цикл, а не уводит в бесконечный повтор', async () => {
  const doFetch = fakeFetch([{ status: 401, body: {} }])
  const client = new OneChatClient({ apiKey: KEY, fetch: doFetch })
  await assert.rejects(
    client.run({ since: 1, onEvent: () => {}, onCursor: () => {} }),
    AuthError,
  )
})

test('своё исходящее не будит агента', () => {
  const outbound = { ...inbound(1), payload: { direction: 'outbound', text: 'наш ответ' } }
  assert.equal(isIncomingMessage(outbound), false, 'иначе переписка с самим собой')
})

test('не-сообщения не будят агента', () => {
  assert.equal(isIncomingMessage({ type: 'dialog:updated', payload: {} }), false)
  assert.equal(isIncomingMessage({ type: 'dialog:read', payload: {} }), false)
})

test('входящее будит', () => {
  assert.equal(isIncomingMessage(inbound(1)), true)
})

test('фильтр по диалогам работает в обе стороны', () => {
  assert.equal(isIncomingMessage(inbound(1, 'c1'), { dialogs: ['c1'] }), true)
  assert.equal(isIncomingMessage(inbound(1, 'c9'), { dialogs: ['c1'] }), false)
  assert.equal(isIncomingMessage(inbound(1, 'c9'), { dialogs: [] }), true)
})

test('мусор вместо события не роняет проверку', () => {
  for (const value of [null, undefined, {}, { type: 'message:new' }]) {
    assert.equal(isIncomingMessage(value), false)
  }
})
