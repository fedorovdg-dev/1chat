/**
 * Что агенту можно делать внутри запуска.
 *
 * Список закрытый: инструмент, которого здесь нет, запрещён. Сервер может
 * добавить новый изменяющий инструмент — и если бы неизвестное пропускалось,
 * это был бы обход защиты отправки, появившийся без единой строки у нас.
 *
 * Схемы аргументов сверены с серверным MCP 1-chat (tools/list): имена полей
 * здесь те же, что в его inputSchema.
 */

import { fingerprintOf } from './store.js'

/** Только чтение: пропускаются с любым действующим паролем. */
export const READ_TOOLS = new Set([
  'list_conversations',
  'get_conversation',
  'list_messages',
  'list_participants',
  'list_accounts',
  // POST на сервере, но ничего не меняет и никого не беспокоит: только поиск.
  'search_recipients',
  'list_webhooks',
])

const normalizeText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Изменяющие инструменты. Каждый — только через пароль запуска и проверку
 * актуальности.
 *
 * - `target` — какой диалог затрагивается (для журнала; версия проверяется
 *   всегда по диалогу поручения, а не по получателю).
 * - `fingerprint` — что считать тем же действием.
 * - `dedupe` — не повторять то же действие в той же пачке.
 * - `uncertainOnTransportError` — обрыв связи означает «могло выполниться».
 *   Верно для отправки: сервер ждёт подтверждения мессенджера до полутора
 *   минут, и ответ теряется чаще, чем само сообщение.
 */
export const CONTROLLED_TOOLS = {
  send_message: {
    target: (a) => a.conversation_id,
    fingerprint: (a) => ['send_message', String(a.conversation_id), normalizeText(a.text)],
    dedupe: true,
    uncertainOnTransportError: true,
    reconcilable: true,
  },
  set_reaction: {
    target: (a) => a.conversation_id,
    fingerprint: (a) => ['set_reaction', String(a.conversation_id), String(a.message_id), String(a.emoji)],
    dedupe: true,
  },
  remove_reaction: {
    target: (a) => a.conversation_id,
    fingerprint: (a) => ['remove_reaction', String(a.conversation_id), String(a.message_id), String(a.emoji)],
    dedupe: true,
  },
  mark_conversation_read: {
    target: (a) => a.conversation_id,
    fingerprint: (a) => ['mark_conversation_read', String(a.conversation_id)],
    // Повтор безвреден, а запрещать его — значит мешать без причины.
    dedupe: false,
  },
  start_conversation: {
    target: () => null,
    fingerprint: (a) => [
      'start_conversation',
      String(a.channel),
      normalizeText(a.query),
      a.external_conversation_id ?? null,
      a.integration_id ?? null,
    ],
    // Сервер сам возвращает существующий диалог вместо дубля.
    dedupe: false,
  },
}

/**
 * Запрещены внутри запуска совсем.
 *
 * register_webhook — это настройка, а не переписка. wait_for_changes — лента
 * уже читается службой; агент, повисший в ожидании внутри запуска, просто
 * съест свой таймаут.
 */
export const FORBIDDEN_TOOLS = new Set(['register_webhook', 'wait_for_changes'])

/** Методы MCP, которые пропускаются. Остальные — отказ. */
export const ALLOWED_METHODS = new Set([
  'initialize',
  'ping',
  'notifications/initialized',
  'notifications/cancelled',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
])

export function classifyTool(name) {
  if (READ_TOOLS.has(name)) return 'read'
  if (Object.hasOwn(CONTROLLED_TOOLS, name)) return 'controlled'
  return 'forbidden'
}

export function describeAction(name, args) {
  const spec = CONTROLLED_TOOLS[name]
  return {
    spec,
    targetId: spec.target(args) ?? null,
    fingerprint: fingerprintOf(spec.fingerprint(args)),
  }
}
