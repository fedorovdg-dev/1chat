import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOST,
  createMcpProxy,
  generateLocalToken,
  loadOrCreateToken,
  serveMcp,
} from '../src/mcp-proxy.js'

const KEY = 'sk_1chat_rw_test'
const TOKEN = 'local-secret'

/** Поднимает прокси с подставным 1-chat и возвращает адрес и журнал вызовов. */
async function withProxy(upstream, run, { token = TOKEN } = {}) {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, init })
    return upstream(url, init)
  }
  const { createServer } = await import('node:http')
  const server = createServer(createMcpProxy({ apiKey: KEY, baseUrl: 'https://x/api', token, fetch: fakeFetch }))
  await new Promise((done) => server.listen(0, HOST, done))
  const base = `http://${HOST}:${server.address().port}`
  try {
    return await run(base, calls)
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

const ok = async () =>
  new Response('{"jsonrpc":"2.0","result":{}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

test('без пароля не пускает', async () => {
  await withProxy(ok, async (base) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 401)
  })
})

test('с чужим паролем не пускает', async () => {
  await withProxy(ok, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer wrong-token' },
    })
    assert.equal(res.status, 401)
  })
})

test('подставляет ключ 1-chat и не пропускает локальный пароль наверх', async () => {
  await withProxy(ok, async (base, calls) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    // Наверх уходит ключ 1-chat, а не локальный пароль: иначе сервер
    // получил бы чужую строку и ответил бы отказом авторизации.
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
    assert.equal(calls[0].url, 'https://x/api/v1/mcp/')
    assert.equal(calls[0].init.body.toString(), '{"jsonrpc":"2.0","method":"tools/list"}')
  })
})

test('тело ответа отдаётся как есть', async () => {
  const sse = async () =>
    new Response('event: message\ndata: {"result":1}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' },
    })
  await withProxy(sse, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(res.headers.get('mcp-session-id'), 'abc')
    assert.match(await res.text(), /data: \{"result":1\}/)
  })
})

test('недоступный 1-chat объясняется, а не роняет службу', async () => {
  const broken = async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }
  await withProxy(broken, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /недоступен/)
  })
})

test('слушает только петлевой адрес', async () => {
  const mcp = await serveMcp({ apiKey: KEY, baseUrl: 'https://x/api', port: 0 })
  try {
    assert.equal(HOST, '127.0.0.1')
    assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:/)
  } finally {
    await mcp.close()
  }
})

test('занятый порт — внятная ошибка', async () => {
  const first = await serveMcp({ apiKey: KEY, baseUrl: 'https://x/api', port: 0 })
  try {
    await assert.rejects(
      serveMcp({ apiKey: KEY, baseUrl: 'https://x/api', port: first.port }),
      /занят/,
    )
  } finally {
    await first.close()
  }
})

test('пароль переживает перезапуск', async () => {
  const dir = await mkdtemp(join(tmpdir(), '1chat-'))
  const file = join(dir, 'nested', 'token')
  const fs = { readFile, writeFile, mkdir }
  const first = await loadOrCreateToken(file, fs)
  const second = await loadOrCreateToken(file, fs)
  // Иначе после перезапуска службы конфиг агента протухал бы молча.
  assert.equal(first, second)
  // И файл не должен быть читаем соседом по машине.
  assert.equal((await stat(file)).mode & 0o077, 0)
})

test('пароли не повторяются', () => {
  assert.notEqual(generateLocalToken(), generateLocalToken())
  assert.ok(generateLocalToken().length >= 32)
})
