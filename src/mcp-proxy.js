/**
 * Локальный MCP для агента.
 *
 * Агент ходит сюда, а мы переправляем его вызовы в 1-chat, подставляя ключ.
 * Ключ остаётся в одном месте — у этой службы — и агент его не знает вовсе.
 *
 * Два режима.
 *
 * Простой (`createMcpProxy`) — один постоянный пароль, всё переправляется.
 * Права проверяет сервер. Это режим `--serve-mcp` без защиты отправки.
 *
 * Защищённый (`createGuardedMcpProxy`) — для запусков агента службой.
 * Изменяющий вызов проходит, только если он сделан с паролем действующего
 * запуска и контекст этого запуска всё ещё актуален. Постоянный пароль здесь
 * даёт только чтение: иначе он был бы обходом всей защиты.
 *
 * В обоих режимах ответы сокращаются (см. compact.js).
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import { compactToolResult, compactToolsList } from './compact.js'
import { ALLOWED_METHODS, CONTROLLED_TOOLS, classifyTool, describeAction } from './policy.js'
import { ACTION_STATUS } from './store.js'

/** Только петлевой адрес. Здесь не спрашивают ключ 1-chat, поэтому открыть
 *  этот порт в сеть — то же, что выложить ключ на запись. */
export const HOST = '127.0.0.1'

export const DEFAULT_PORT = 8765

/** Сервер ждёт подтверждения мессенджера до 130 секунд; даём запас. */
export const SEND_TIMEOUT_MS = 150_000
export const READ_TIMEOUT_MS = 60_000

/**
 * Через сколько после начала отправки её отсутствие в истории означает
 * «не ушла». Раньше — нельзя: сообщение может быть ещё в пути.
 */
export const RECONCILE_AFTER_MS = 180_000

/** Заголовки, которые имеет смысл передать наверх. Остальные — наши. */
const FORWARD_UP = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const FORWARD_DOWN = ['mcp-session-id']

export function generateLocalToken() {
  return randomBytes(24).toString('hex')
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

function bearer(req) {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
}

function replyJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** Ответ инструмента с ошибкой — в том виде, в котором модель его прочитает. */
export function toolError(id, code, text) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: `${code}: ${text}` }], isError: true },
  }
}

/** Разбирает ответ серверного MCP: поток событий или обычный JSON. */
export function parseUpstream(contentType, text) {
  if ((contentType ?? '').includes('text/event-stream')) {
    const messages = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        return { format: 'raw', text }
      }
    }
    return { format: 'sse', messages }
  }
  if ((contentType ?? '').includes('application/json') && text) {
    try {
      return { format: 'json', messages: [JSON.parse(text)] }
    } catch {
      return { format: 'raw', text }
    }
  }
  return { format: 'raw', text }
}

function emit(res, status, headers, parsed, transform) {
  if (parsed.format === 'raw') {
    res.writeHead(status, headers)
    res.end(parsed.text)
    return
  }
  const messages = parsed.messages.map(transform)
  if (parsed.format === 'sse') {
    res.writeHead(status, { ...headers, 'content-type': 'text/event-stream' })
    res.end(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''))
    return
  }
  res.writeHead(status, { ...headers, 'content-type': 'application/json' })
  res.end(JSON.stringify(messages[0]))
}

/** Сокращение по запросу, на который пришёл ответ. */
function transformFor(request) {
  return (message) => {
    if (!message || message.id === undefined || message.id !== request?.id) return message
    if (request.method === 'tools/list') return compactToolsList(message)
    if (request.method === 'tools/call') return compactToolResult(request.params?.name, message)
    return message
  }
}

function upstreamUrl(baseUrl) {
  return `${baseUrl.replace(/\/$/, '')}/v1/mcp/`
}

async function forward({ call, baseUrl, apiKey, req, body, timeoutMs }) {
  const headers = { Authorization: `Bearer ${apiKey}` }
  for (const name of FORWARD_UP) {
    if (req.headers[name]) headers[name] = req.headers[name]
  }
  const response = await call(upstreamUrl(baseUrl), {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const out = {}
  for (const name of FORWARD_DOWN) {
    const value = response.headers.get(name)
    if (value) out[name] = value
  }
  const text = await response.text()
  return { status: response.status, headers: out, parsed: parseUpstream(response.headers.get('content-type'), text) }
}

/**
 * Простой режим: постоянный пароль, всё переправляется.
 *
 * @param {object} options
 * @param {string} options.apiKey ключ 1-chat
 * @param {string} options.baseUrl
 * @param {string} options.token локальный пароль
 * @param {typeof fetch} [options.fetch]
 * @param {(msg: string, meta?: object) => void} [options.log]
 */
export function createMcpProxy({ apiKey, baseUrl, token, fetch: doFetch, log = () => {} }) {
  const call = doFetch ?? globalThis.fetch

  return async function handle(req, res) {
    // Петля пускает любой процесс на этой машине, в том числе чужого
    // пользователя. Пароль отделяет нашего агента от соседа по серверу.
    if (bearer(req) !== token) {
      log('отклонён запрос без локального пароля')
      return replyJson(res, 401, { error: 'Нужен локальный пароль. Он печатается при запуске службы.' })
    }
    if (req.method !== 'POST') return replyJson(res, 405, { error: 'Только POST' })

    const body = await readBody(req)
    let request = null
    try {
      request = JSON.parse(body.toString('utf8'))
    } catch {
      // Не JSON — сервер ответит сам, сокращать нечего.
    }

    let upstream
    try {
      upstream = await forward({ call, baseUrl, apiKey, req, body, timeoutMs: SEND_TIMEOUT_MS })
    } catch (error) {
      log('1-chat недоступен', { error: String(error) })
      return replyJson(res, 502, { error: `1-chat недоступен: ${error}` })
    }
    emit(res, upstream.status, upstream.headers, upstream.parsed, transformFor(request))
  }
}

/**
 * Сверка отправки, ответ на которую потерян.
 *
 * Служба подставляет в отправку свой client_id, и сервер возвращает его в
 * сообщении. Нашли — ушло. Не нашли раньше срока — неизвестно: сообщение
 * может быть ещё в пути. Не нашли позже — не ушло.
 *
 * @returns {Promise<'sent'|'absent'|'unknown'>}
 */
export async function reconcileSend({ call, baseUrl, apiKey, action, now, reconcileAfterMs = RECONCILE_AFTER_MS }) {
  if (!action.client_id || !action.target_id) return 'unknown'
  let data
  try {
    const response = await call(
      `${baseUrl.replace(/\/$/, '')}/v1/conversations/${encodeURIComponent(action.target_id)}/messages?limit=50`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
    )
    if (!response.ok) return 'unknown'
    data = await response.json()
  } catch {
    return 'unknown'
  }
  const items = Array.isArray(data?.items) ? data.items : []
  if (items.some((m) => String(m.client_id) === String(action.client_id))) return 'sent'
  return now - action.started_at >= reconcileAfterMs ? 'absent' : 'unknown'
}

const TRANSIENT_TOOL_ERROR = /HTTP 5\d\d|timeout|timed out|тайм-?аут|недоступ/i

/**
 * Защищённый режим.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.baseUrl
 * @param {string} [options.readToken] постоянный пароль только на чтение
 * @param {import('./store.js').Store} options.store
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} options.clock
 * @param {number} options.quietMs пауза после последнего входящего перед изменяющим действием
 * @param {(dialogId: string, reason: string) => void} [options.onStale] сообщить диспетчеру
 * @param {typeof fetch} [options.fetch]
 * @param {(msg: string, meta?: object) => void} [options.log]
 */
export function createGuardedMcpProxy({
  apiKey,
  baseUrl,
  readToken,
  store,
  clock,
  quietMs,
  onStale = () => {},
  fetch: doFetch,
  log = () => {},
  reconcileAfterMs = RECONCILE_AFTER_MS,
}) {
  const call = doFetch ?? globalThis.fetch

  function authenticate(token) {
    if (!token) return null
    if (readToken && token === readToken) return { kind: 'read' }
    const run = store.runByToken(token)
    // Пароль закончившегося запуска не даёт даже чтения: процесс, переживший
    // свой запуск, не должен продолжать работать с перепиской.
    if (run && run.status === 'running') return { kind: 'run', run }
    if (run) return { kind: 'expired', run }
    return null
  }

  async function handleControlled(req, res, request, token) {
    const name = request.params?.name
    const args = { ...(request.params?.arguments ?? {}) }
    const { spec, targetId, fingerprint } = describeAction(name, args)

    // client_id назначает служба, а не модель: по нему идёт сверка, и
    // значение, которое модель могла повторить из прошлого ответа, её сломало бы.
    const clientId = name === 'send_message' ? randomUUID() : null
    if (clientId) args.client_id = clientId

    let decision
    for (;;) {
      decision = store.beginAction({
        token,
        tool: name,
        targetId,
        arguments: args,
        fingerprint,
        clientId,
        quietMs,
        dedupe: spec.dedupe,
      })
      if (decision.code !== 'WAIT') break
      // Ждём вне транзакции: пока ждём, приём событий продолжает писать, и
      // пришедшее продолжение сделает следующую проверку устаревшей.
      const left = decision.run.deadline_at - clock.now()
      if (left <= 0) {
        decision = { ok: false, code: 'RUN_NOT_ACTIVE', detail: 'deadline' }
        break
      }
      await clock.sleep(Math.min(decision.waitMs, left))
    }

    if (!decision.ok && decision.code === 'UNCERTAIN_RESULT' && spec.reconcilable) {
      decision = await resolveUncertain(decision, { token, name, targetId, args, fingerprint, clientId, spec })
    }

    if (!decision.ok) return replyJson(res, 200, refusal(request.id, decision))

    const { action } = decision
    log('действие начато', { run: action.run_id, tool: name, action: action.action_id })

    const body = Buffer.from(JSON.stringify({ ...request, params: { ...request.params, arguments: args } }))
    let upstream
    try {
      upstream = await forward({ call, baseUrl, apiKey, req, body, timeoutMs: SEND_TIMEOUT_MS })
    } catch (error) {
      const status = spec.uncertainOnTransportError ? ACTION_STATUS.UNCERTAIN : ACTION_STATUS.FAILED
      store.finishAction(action.action_id, { status, error: String(error) })
      log('действие без ответа', { action: action.action_id, status, error: String(error) })
      const text =
        status === ACTION_STATUS.UNCERTAIN
          ? 'Ответ 1-chat потерян, отправка МОГЛА выполниться. Не повторяйте: служба сверит историю сама.'
          : `1-chat недоступен: ${error}`
      return replyJson(res, 200, toolError(request.id, status === ACTION_STATUS.UNCERTAIN ? 'UNCERTAIN_RESULT' : 'UPSTREAM_UNAVAILABLE', text))
    }

    const message = upstream.parsed.messages?.find((m) => m?.id === request.id)
    const { status, error, result } = classifyOutcome(upstream, message, spec, name)
    store.finishAction(action.action_id, { status, error, result })
    log('действие завершено', { action: action.action_id, status })
    emit(res, upstream.status, upstream.headers, upstream.parsed, transformFor(request))
  }

  async function resolveUncertain(decision, attempt) {
    const verdict = await reconcileSend({
      call,
      baseUrl,
      apiKey,
      action: decision.action,
      now: clock.now(),
      reconcileAfterMs,
    })
    if (verdict === 'sent') {
      store.finishAction(decision.action.action_id, {
        status: ACTION_STATUS.SUCCEEDED,
        error: 'сверка: сообщение найдено в истории',
      })
      return { ...decision, code: 'ALREADY_DONE' }
    }
    if (verdict === 'absent') {
      store.finishAction(decision.action.action_id, {
        status: ACTION_STATUS.FAILED,
        error: 'сверка: сообщения нет в истории',
      })
      // Прошлая попытка точно не ушла — эту можно выполнять, но через ту же
      // проверку актуальности заново.
      return store.beginAction({ token: attempt.token, tool: attempt.name, targetId: attempt.targetId, arguments: attempt.args, fingerprint: attempt.fingerprint, clientId: attempt.clientId, quietMs, dedupe: attempt.spec.dedupe })
    }
    return decision
  }

  function refusal(id, decision) {
    switch (decision.code) {
      case 'STALE_CONTEXT':
        onStale(decision.run.dialog_id, 'stale_action')
        return toolError(
          id,
          'STALE_CONTEXT',
          'Пока вы работали, собеседник написал ещё. Это действие не выполнено. ' +
            'Завершите работу без дальнейших действий: служба запустит вас заново со всеми сообщениями.',
        )
      case 'ALREADY_DONE':
        return toolError(
          id,
          'ALREADY_DONE',
          `Это действие уже выполнено в этой пачке (${decision.action.tool}). Повтор не отправлен.`,
        )
      case 'UNCERTAIN_RESULT':
        return toolError(
          id,
          'UNCERTAIN_RESULT',
          'Такая же отправка уже выполнялась, и её результат неизвестен: ответ 1-chat был потерян. ' +
            'Повтор заблокирован, чтобы не отправить дважды. Проверьте историю диалога.',
        )
      case 'RUN_NOT_ACTIVE':
        return toolError(id, 'RUN_NOT_ACTIVE', 'Запуск уже завершён или истёк. Действие не выполнено.')
      case 'UNAUTHORIZED':
      default:
        return toolError(id, 'UNAUTHORIZED', 'Изменяющие действия доступны только с паролем запуска.')
    }
  }

  return async function handle(req, res) {
    const token = bearer(req)
    const auth = authenticate(token)
    if (!auth || auth.kind === 'expired') {
      log('отклонён запрос без действующего пароля', { expired: auth?.kind === 'expired' })
      return replyJson(res, 401, { error: 'Нужен пароль запуска или пароль чтения.' })
    }
    if (req.method !== 'POST') return replyJson(res, 405, { error: 'Только POST' })

    const body = await readBody(req)
    let request
    try {
      request = JSON.parse(body.toString('utf8'))
    } catch {
      return replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    // Пакет из нескольких вызовов разобрать на проверки можно, но это лишний
    // способ ошибиться в защите. Протокол MCP от пакетов отказался.
    if (Array.isArray(request)) {
      return replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Пакетные запросы не поддерживаются' } })
    }
    if (!ALLOWED_METHODS.has(request.method)) {
      return replyJson(res, 200, { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: `Метод ${request.method} недоступен` } })
    }

    if (request.method === 'tools/call') {
      const name = request.params?.name
      const kind = classifyTool(name)
      if (kind === 'forbidden') {
        return replyJson(res, 200, toolError(request.id, 'ACTION_NOT_ALLOWED', `Инструмент ${name} недоступен агенту в этом режиме.`))
      }
      if (kind === 'controlled') {
        if (auth.kind !== 'run') {
          return replyJson(res, 200, toolError(request.id, 'UNAUTHORIZED', 'Изменяющие действия доступны только с паролем запуска.'))
        }
        return handleControlled(req, res, request, token)
      }
    }

    let upstream
    try {
      upstream = await forward({ call, baseUrl, apiKey, req, body, timeoutMs: READ_TIMEOUT_MS })
    } catch (error) {
      log('1-chat недоступен', { error: String(error) })
      return replyJson(res, 502, { error: `1-chat недоступен: ${error}` })
    }

    const transform = transformFor(request)
    emit(res, upstream.status, upstream.headers, upstream.parsed, (message) => {
      const out = transform(message)
      if (request.method !== 'tools/list' || !Array.isArray(out?.result?.tools)) return out
      // Агент видит только то, что может вызвать: запрещённый инструмент в
      // списке — приглашение планировать то, что всё равно не пройдёт.
      const visible = out.result.tools.filter((tool) => {
        const kind = classifyTool(tool.name)
        return kind === 'read' || (kind === 'controlled' && auth.kind === 'run')
      })
      return { ...out, result: { ...out.result, tools: visible } }
    })
  }
}

function classifyOutcome(upstream, message, spec, name) {
  if (upstream.status >= 500 || !message) {
    return {
      status: spec.uncertainOnTransportError ? ACTION_STATUS.UNCERTAIN : ACTION_STATUS.FAILED,
      error: `HTTP ${upstream.status}`,
    }
  }
  if (upstream.status >= 400 || message.error) {
    return { status: ACTION_STATUS.FAILED, error: message.error?.message ?? `HTTP ${upstream.status}` }
  }
  const text = (message.result?.content ?? []).map((part) => part?.text ?? '').join('')
  if (message.result?.isError) {
    const transient = TRANSIENT_TOOL_ERROR.test(text)
    return {
      status: transient && spec.uncertainOnTransportError ? ACTION_STATUS.UNCERTAIN : ACTION_STATUS.FAILED,
      error: text.slice(0, 500),
    }
  }
  let result = null
  try {
    result = JSON.parse(compactToolResult(name, message).result.content[0].text)
  } catch {
    result = text.slice(0, 500) || null
  }
  return { status: ACTION_STATUS.SUCCEEDED, result }
}

/**
 * Поднимает HTTP-сервер на петлевом адресе. Возвращает `{ port, url, close }`.
 *
 * Занятый порт — это ошибка с объяснением, а не молчаливый простой: иначе
 * агент будет получать отказ соединения и винить в этом себя.
 */
export function listenLocal(handler, port = DEFAULT_PORT) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) replyJson(res, 500, { error: String(error?.message ?? error) })
      else res.end()
    })
  })
  return new Promise((done, fail) => {
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        fail(new Error(`Порт ${port} занят. Укажите другой через --mcp-port <порт>.`))
        return
      }
      fail(error)
    })
    server.listen(port, HOST, () => {
      // Спрашиваем адрес у сокета, а не повторяем аргумент: при порте 0
      // его выбирает система, и запрошенное значение ничего не значит.
      const actual = server.address().port
      done({
        port: actual,
        url: `http://${HOST}:${actual}/mcp`,
        // close() сам по себе ждёт, пока отвалятся все открытые соединения,
        // а клиент MCP держит их живыми — служба не остановилась бы по
        // SIGTERM, пока агент не умрёт первым. Рвём их явно.
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(closed)
          }),
      })
    })
  })
}

/** Простой режим целиком: пароль, сервер. Сохранён для `--serve-mcp`. */
export async function serveMcp({ apiKey, baseUrl, port = DEFAULT_PORT, token, log }) {
  const localToken = token ?? generateLocalToken()
  const server = await listenLocal(createMcpProxy({ apiKey, baseUrl, token: localToken, log }), port).catch(
    (error) => {
      throw new Error(error.message.replace('--mcp-port', '--serve-mcp'))
    },
  )
  return { ...server, token: localToken }
}

/**
 * Постоянный пароль рядом с позицией в потоке.
 *
 * Новый пароль на каждый запуск означал бы, что после перезапуска службы
 * конфиг агента протух и его надо править руками. Поэтому пароль создаётся
 * один раз и переживает перезапуск; файл доступен только владельцу.
 */
export async function loadOrCreateToken(file, { readFile, writeFile, mkdir }) {
  try {
    const saved = (await readFile(file, 'utf8')).trim()
    if (saved) return saved
  } catch {
    // файла нет — сейчас создадим
  }
  const token = generateLocalToken()
  await mkdir(dirname(resolve(file)), { recursive: true })
  await writeFile(file, token, { mode: 0o600 })
  return token
}

export { CONTROLLED_TOOLS }
