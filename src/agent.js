/**
 * Служба агента: приём ленты, очередь, запуски, защищённый MCP.
 *
 *   1-chat ──лента──▶ приём ──SQLite──▶ диспетчер ──stdin──▶ bridge ▶ агент
 *                                                                    │
 *   1-chat ◀──ключ── защищённый MCP ◀──пароль запуска───────────────┘
 *
 * Приём событий не ждёт агента: пока агент думает, новые сообщения
 * сохраняются и делают его контекст устаревшим. Устаревший запуск ничего
 * изменить уже не может — это проверяет MCP перед каждым изменяющим
 * действием, — а его пачку вместе с продолжением получает следующий запуск.
 */

import { compactEvent, compactMessage } from './compact.js'
import { DEFAULTS, Dispatcher, defaultBackoffMs, realClock } from './dispatcher.js'
import { createGuardedMcpProxy, reconcileSend } from './mcp-proxy.js'
import { runAgentProcess, sanitizeEnv } from './runner.js'
import { ACTION_STATUS } from './store.js'

export const CONTRACT = '1chat.agent.run/v1'

/** Сколько обработанной переписки дать как фон. */
const CONTEXT_MESSAGES = 20
const CONTEXT_ACTIONS = 10

/**
 * Превращает страницу ленты во входящие для хранилища.
 *
 * Берутся только входящие сообщения: наши исходящие агента не будят, а
 * смена статусов, реакций и карточек диалогов продолжением мысли не является.
 */
export function inboundFromEvents(events, { dialogs = null } = {}) {
  const out = []
  for (const raw of events) {
    const event = compactEvent(raw)
    if (event.type !== 'message:new' && event.type !== 'message:updated') continue
    const message = event.payload
    if (!message?.id || message.direction !== 'inbound') continue
    const dialogId = String(event.dialog_id ?? message.conversation_id)
    if (dialogs?.length && !dialogs.includes(dialogId)) continue
    out.push({
      dialogId,
      channel: event.channel_id ?? null,
      message,
      feedSeq: Number(event.seq ?? 0),
      kind: event.type === 'message:new' ? 'new' : 'updated',
    })
  }
  return out
}

const actionView = (a) => ({
  action_id: a.action_id,
  run_id: a.run_id,
  tool: a.tool,
  target_id: a.target_id,
  arguments: a.arguments,
  status: a.status,
  result: a.result,
  error: a.error,
  started_at: new Date(a.started_at).toISOString(),
})

/**
 * Контракт запуска: всё, что агенту нужно знать о пачке.
 *
 * `messages` — вся необработанная пачка, а не последнее сообщение: если
 * прошлый запуск устарел, здесь и исходное поручение, и уточнение.
 * `previous_actions` — что уже сделано по этой пачке прошлыми запусками,
 * чтобы не делать второй раз и не удивляться ALREADY_DONE.
 */
export function buildContract(store, run, { mcpUrl, now }) {
  const dialog = store.getDialog(run.dialog_id)
  const previousRuns = store
    .runsSince(run.dialog_id, run.from_version)
    .filter((r) => r.run_id !== run.run_id)
    .map((r) => ({ run_id: r.run_id, input_version: r.input_version, status: r.status, exit_code: r.exit_code }))

  return {
    contract: CONTRACT,
    run_id: run.run_id,
    dialog_id: run.dialog_id,
    channel: dialog?.channel ?? null,
    input_version: run.input_version,
    attempt: run.attempt,
    reason: previousRuns.some((r) => r.status === 'stale')
      ? 'context_changed'
      : previousRuns.length
        ? 'retry'
        : 'new_messages',
    created_at: new Date(now).toISOString(),
    deadline_at: new Date(run.deadline_at).toISOString(),
    messages: store.pendingMessages(run.dialog_id, run.from_version).map((m) => ({
      ...compactMessage(m),
      feed_seq: m.feed_seq,
    })),
    previous_actions: store.actionsSince(run.dialog_id, run.from_version).map(actionView),
    previous_runs: previousRuns,
    context: {
      recent_messages: store
        .recentHandledMessages(run.dialog_id, run.from_version, CONTEXT_MESSAGES)
        .map((m) => compactMessage(m)),
      recent_actions: store
        .recentActions(run.dialog_id, CONTEXT_ACTIONS)
        .filter((a) => a.input_version <= run.from_version)
        .map(actionView),
    },
    mcp: { url: mcpUrl, token_env: 'ONECHAT_MCP_TOKEN' },
    rules: [
      'Изменяющие действия выполняйте только через MCP из поля mcp с паролем из ONECHAT_MCP_TOKEN.',
      'STALE_CONTEXT: собеседник написал ещё — завершите работу без действий, вас запустят заново.',
      'ALREADY_DONE и UNCERTAIN_RESULT: не повторяйте действие, при необходимости прочитайте историю.',
      'Код выхода 0 означает, что пачка разобрана. Ненулевой — что работа не сделана и нужна повторная попытка.',
    ],
  }
}

/**
 * Сверяет отправки с неизвестным результатом перед новым запуском, чтобы
 * агент получил в контракте правду, а не «неизвестно», когда её можно узнать.
 */
async function reconcileDialog({ store, dialogId, call, baseUrl, apiKey, now, log }) {
  for (const action of store.uncertainActions(dialogId)) {
    if (action.tool !== 'send_message') continue
    const verdict = await reconcileSend({ call, baseUrl, apiKey, action, now })
    if (verdict === 'sent') {
      store.finishAction(action.action_id, { status: ACTION_STATUS.SUCCEEDED, error: 'сверка: сообщение найдено в истории' })
      log('сверка: отправка найдена', { action: action.action_id })
    } else if (verdict === 'absent') {
      store.finishAction(action.action_id, { status: ACTION_STATUS.FAILED, error: 'сверка: сообщения нет в истории' })
      log('сверка: отправки нет', { action: action.action_id })
    }
  }
}

/**
 * Собирает службу. Ничего не запускает, пока не вызван `start()`.
 *
 * Всё внешнее — хранилище, часы, запуск процесса, сеть — передаётся
 * снаружи, поэтому тесты гоняют ту же сборку, что и боевой запуск.
 */
export function createAgentService({
  store,
  apiKey,
  baseUrl,
  command,
  env = process.env,
  clock = realClock,
  settings = {},
  backoffMs = defaultBackoffMs,
  readToken,
  mcpUrl,
  fetch: doFetch,
  launchProcess = runAgentProcess,
  log = () => {},
}) {
  const merged = { ...DEFAULTS, ...settings }
  const call = doFetch ?? globalThis.fetch
  const childEnvBase = sanitizeEnv(env, { apiKey })

  const service = { store, settings: merged, mcpUrl }

  const launch = async (run, token) => {
    await reconcileDialog({ store, dialogId: run.dialog_id, call, baseUrl, apiKey, now: clock.now(), log })
    const input = buildContract(store, run, { mcpUrl: service.mcpUrl, now: clock.now() })
    return launchProcess({
      command,
      input,
      env: {
        ...childEnvBase,
        ONECHAT_CONTRACT: CONTRACT,
        ONECHAT_RUN_ID: run.run_id,
        ONECHAT_DIALOG_ID: run.dialog_id,
        ONECHAT_MCP_URL: service.mcpUrl,
        ONECHAT_MCP_TOKEN: token,
      },
      timeoutMs: Math.max(1, run.deadline_at - clock.now()),
    })
  }

  const dispatcher = new Dispatcher({ store, launch, clock, settings: merged, backoffMs, log })

  const proxy = createGuardedMcpProxy({
    apiKey,
    baseUrl,
    readToken,
    store,
    clock,
    quietMs: merged.quietMs,
    fetch: call,
    log,
    onStale: () => dispatcher.poke(),
  })

  /** Страница ленты: сохранить атомарно, затем дать диспетчеру пересчитать. */
  const ingest = ({ cursor, events }, { dialogs } = {}) => {
    const touched = store.ingestPage({ cursor, inbound: inboundFromEvents(events, { dialogs }) })
    if (touched.length) log('входящие сохранены', { dialogs: touched.length, cursor })
    dispatcher.poke()
    return touched
  }

  const recover = () => {
    const result = store.recoverAfterRestart({ maxAttempts: merged.maxAttempts, backoffMs })
    if (result.interruptedRuns || result.uncertainActions) log('восстановление после перезапуска', result)
    dispatcher.poke()
    return result
  }

  return Object.assign(service, { dispatcher, proxy, ingest, recover })
}
