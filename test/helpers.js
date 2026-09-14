/**
 * Общие подделки для тестов: часы, upstream 1-chat, агент.
 *
 * Реальных сообщений здесь не отправляется — upstream целиком подменён.
 */

import { listenLocal } from '../src/mcp-proxy.js'
import { Store } from '../src/store.js'
import { createAgentService } from '../src/agent.js'

/** Часы, которые идут только когда им скажут. */
export class FakeClock {
  constructor(start = 1_000_000) {
    this.t = start
    this.timers = []
    this.seq = 0
    this.now = this.now.bind(this)
    this.setTimeout = this.setTimeout.bind(this)
    this.clearTimeout = this.clearTimeout.bind(this)
    this.sleep = this.sleep.bind(this)
  }

  now() {
    return this.t
  }

  setTimeout(fn, ms) {
    const timer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn }
    this.timers.push(timer)
    return timer.id
  }

  clearTimeout(id) {
    this.timers = this.timers.filter((timer) => timer.id !== id)
  }

  sleep(ms) {
    return new Promise((done) => this.setTimeout(done, ms))
  }

  /** Двигает время, по дороге срабатывая таймеры по порядку. */
  async advance(ms) {
    const end = this.t + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((timer) => timer !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    this.t = end
    await flush()
  }
}

/** Дать отработать всем уже готовым промисам и вводу-выводу. */
export async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((done) => setImmediate(done))
  }
}

/** Ждёт условия, двигая реальный цикл событий (не время подделки). */
export async function until(predicate, { rounds = 400, message = 'условие не наступило' } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error(message)
}

let seq = 0
let messageSeq = 0

/** Событие ленты «новое входящее». */
export function inboundEvent(dialogId, text, { id, kind = 'message:new', extra = {} } = {}) {
  seq += 1
  messageSeq += 1
  return {
    type: kind,
    dialog_id: dialogId,
    channel_id: 'telegram_client',
    seq,
    payload: {
      id: id ?? `msg-${messageSeq}`,
      tenant_id: 'tenant',
      conversation_id: dialogId,
      direction: 'inbound',
      text,
      sender_name: 'Собеседник',
      created_at: '2026-09-14T10:00:00Z',
      avatar_url: `data:image/png;base64,${'A'.repeat(4000)}`,
      metadata: null,
      attachments: [],
      reactions: [],
      ...extra,
    },
  }
}

/**
 * Подделка серверного MCP и REST 1-chat.
 *
 * `sends` — все дошедшие до «сервера» отправки. `behavior.send` меняет
 * поведение отправки: 'ok' | 'throw' | 'hang' | функция.
 */
export function mockUpstream() {
  const state = {
    calls: [],
    sends: [],
    history: new Map(),
    behavior: { send: 'ok' },
  }

  const sse = (message) =>
    new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'upstream-session' },
    })

  state.fetch = async (url, init = {}) => {
    const u = new URL(url)
    if (init.method !== 'POST' && u.pathname.includes('/v1/conversations/')) {
      const dialogId = decodeURIComponent(u.pathname.split('/')[4])
      state.calls.push({ kind: 'rest', url })
      return Response.json({ items: state.history.get(dialogId) ?? [], has_more: false })
    }

    const request = JSON.parse(Buffer.from(init.body).toString('utf8'))
    state.calls.push({ kind: 'mcp', request, headers: init.headers })

    if (request.method === 'initialize') {
      return sse({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: '1chat', version: '0' } } })
    }
    if (request.method === 'tools/list') {
      const names = ['list_messages', 'send_message', 'register_webhook', 'wait_for_changes', 'set_reaction', 'brand_new_writer']
      return sse({ jsonrpc: '2.0', id: request.id, result: { tools: names.map((name) => ({ name, inputSchema: {}, outputSchema: { type: 'object' } })) } })
    }
    if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params
      if (name === 'send_message') {
        const behavior = state.behavior.send
        const record = () => {
          const message = {
            id: `out-${state.sends.length + 1}`,
            tenant_id: 'tenant',
            conversation_id: args.conversation_id,
            direction: 'outbound',
            text: args.text,
            client_id: args.client_id ?? null,
            status: 'sent',
            avatar_url: `data:image/png;base64,${'B'.repeat(4000)}`,
          }
          state.sends.push({ args, message })
          const list = state.history.get(args.conversation_id) ?? []
          list.push(message)
          state.history.set(args.conversation_id, list)
          return message
        }
        if (behavior === 'throw') {
          record()
          throw new TypeError('fetch failed: socket hang up')
        }
        if (behavior === 'throw-before') throw new TypeError('fetch failed: connect ECONNREFUSED')
        if (typeof behavior === 'function') return behavior({ request, record, sse })
        const message = record()
        return sse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(message) }], structuredContent: { result: JSON.stringify(message) }, isError: false } })
      }
      const text = JSON.stringify({ items: [{ id: 'm1', tenant_id: 't', text: 'история', avatar_url: 'data:image/png;base64,AAAA' }] })
      return sse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text }], isError: false } })
    }
    return sse({ jsonrpc: '2.0', id: request.id, result: {} })
  }

  return state
}

/**
 * Управляемый агент: каждый запуск — объект, которым тест командует.
 * `script(run, ctx)` — что агент делает; по умолчанию ждёт команды.
 */
export function fakeAgents() {
  const launched = []
  const launchProcess = ({ input, env, timeoutMs }) => {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    const entry = {
      input,
      env,
      timeoutMs,
      terminated: false,
      exit: (code = 0) => resolve({ kind: 'exit', code, signal: null }),
      fail: (outcome) => resolve(outcome),
      terminate: () => {
        entry.terminated = true
        resolve({ kind: 'exit', code: null, signal: 'SIGTERM' })
      },
    }
    entry.promise = promise
    launched.push(entry)
    return { promise, terminate: entry.terminate, pid: 1 }
  }
  return { launched, launchProcess }
}

/** Вызов инструмента через локальный MCP так, как это делал бы агент. */
export async function callTool(url, token, name, args = {}, id = Math.floor(Math.random() * 1e9)) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  })
  const text = await response.text()
  let message = null
  if ((response.headers.get('content-type') ?? '').includes('event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    message = data ? JSON.parse(data.slice(6)) : null
  } else if (text) {
    message = JSON.parse(text)
  }
  const body = message?.result?.content?.map((part) => part.text).join('') ?? ''
  return { status: response.status, message, text: body, isError: Boolean(message?.result?.isError) }
}

/** Собирает службу с подделками и поднимает её MCP на свободном порту. */
export async function harness({ settings = {}, dbFile = ':memory:', clock = new FakeClock(), upstream = mockUpstream(), agents = fakeAgents(), readToken = 'read-token', backoffMs } = {}) {
  const store = new Store(dbFile, { now: clock.now })
  const logs = []
  const service = createAgentService({
    store,
    apiKey: 'sk_1chat_rw_secret',
    baseUrl: 'https://1chat.test/api',
    command: 'fake-agent',
    env: { PATH: process.env.PATH, ONECHAT_API_KEY: 'sk_1chat_rw_secret', OTHER: 'value' },
    clock,
    settings: { runTimeoutMs: 600_000, ...settings },
    backoffMs,
    readToken,
    mcpUrl: 'pending',
    fetch: upstream.fetch,
    launchProcess: agents.launchProcess,
    log: (message, meta) => logs.push({ message, meta }),
  })
  const server = await listenLocal(service.proxy, 0)
  service.mcpUrl = server.url
  return {
    store,
    clock,
    upstream,
    agents,
    service,
    logs,
    url: server.url,
    server,
    close: async () => {
      await service.dispatcher.stop()
      await server.close()
      store.close()
    },
  }
}
