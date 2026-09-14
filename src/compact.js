/**
 * Сокращение того, что видит модель.
 *
 * Сервер отдаёт то же, что интерфейсу: аватарки картинкой прямо в строке,
 * идентификатор организации в каждой записи, три отметки времени на одно
 * сообщение. Интерфейсу это нужно, модели — нет, а платит она за каждый
 * символ: пять диалогов весили 82 КБ, из них 75 КБ были двумя копиями
 * одной аватарки в base64.
 *
 * Здесь остаётся то, что нужно, чтобы вести переписку и вызвать следующий
 * инструмент. Названия полей не меняются — они те же, что в документации
 * API, и модель, прочитавшая её, узнает их.
 */

/** Строка длиннее этого и целиком из алфавита base64 — почти наверняка файл. */
const BASE64_MIN_LENGTH = 256
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/

export const BINARY_PLACEHOLDER = '[двоичные данные опущены]'

/** Поля, которые не нужны для переписки нигде. */
const DROP_EVERYWHERE = new Set(['tenant_id', 'avatar_url', 'metadata'])

export function isBinaryString(value) {
  if (typeof value !== 'string') return false
  if (value.startsWith('data:')) return true
  return value.length >= BASE64_MIN_LENGTH && !/\s/.test(value) && BASE64_RE.test(value)
}

function isEmpty(value) {
  return (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  )
}

/**
 * Страховка для всего, что не описано ниже: новые инструменты, новые поля.
 *
 * Выбрасывает пустое и заведомо лишнее, а двоичное заменяет пометкой, а не
 * удаляет: модель должна знать, что вложение было, иначе она сделает вывод,
 * что его нет.
 */
export function scrub(value) {
  if (Array.isArray(value)) {
    return value.map(scrub).filter((item) => !isEmpty(item))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (DROP_EVERYWHERE.has(key)) continue
      const cleaned = scrub(item)
      if (!isEmpty(cleaned)) out[key] = cleaned
    }
    return out
  }
  return isBinaryString(value) ? BINARY_PLACEHOLDER : value
}

function pick(source, keys) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    if (!isEmpty(source[key])) out[key] = source[key]
  }
  return out
}

function compactAttachment(attachment) {
  const out = pick(attachment, ['id', 'kind', 'name', 'mime_type', 'size'])
  // Ссылка полезна, только если это ссылка. Картинка, вписанная в строку,
  // превращается в пометку, чтобы модель знала: файл есть.
  if (typeof attachment?.url === 'string') {
    out.url = isBinaryString(attachment.url) ? BINARY_PLACEHOLDER : attachment.url
  }
  return out
}

export function compactMessage(message) {
  if (!message || typeof message !== 'object') return message
  const out = pick(message, [
    'id',
    'conversation_id',
    'conversation_seq',
    'direction',
    'sender_name',
    'text',
    'status',
    // client_id остаётся: по нему сверяется, ушла ли отправка, ответ на
    // которую потерялся.
    'client_id',
  ])
  // Одно время вместо трёх: когда сообщение отправлено или получено.
  const at = message.sent_at ?? message.received_at ?? message.created_at
  if (at) out.at = at
  if (message.edited_at) out.edited_at = message.edited_at
  if (message.deleted_at) out.deleted_at = message.deleted_at
  if (Array.isArray(message.attachments) && message.attachments.length) {
    out.attachments = message.attachments.map(compactAttachment)
  }
  if (message.attachment) out.attachment = compactAttachment(message.attachment)
  if (Array.isArray(message.reactions) && message.reactions.length) {
    out.reactions = message.reactions.map((r) => pick(r, ['emoji', 'count', 'reacted_by_me']))
  }
  return out
}

export function compactConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return conversation
  const out = pick(conversation, [
    'id',
    'channel',
    'integration_account_id',
    'provider_conversation_kind',
    'title',
    'unread_count',
    'last_message_at',
  ])
  const participant = pick(conversation.participant, ['display_name', 'username', 'external_user_id'])
  if (!isEmpty(participant)) out.participant = participant
  if (conversation.last_message) {
    const last = compactMessage(conversation.last_message)
    if (!isEmpty(last)) out.last_message = last
  }
  return out
}

export function compactParticipant(participant) {
  const out = pick(participant, ['id', 'type', 'display_name', 'external_user_id', 'channel'])
  const username = participant?.meta?.username ?? participant?.username
  if (username) out.username = username
  return out
}

export function compactAccount(account) {
  const out = pick(account, ['id', 'channel', 'external_account_id', 'status', 'events_available'])
  // settings — устаревшая копия health; оставляем одно.
  const health = account?.health
  if (health?.reauth_required || health?.error_code) {
    out.health = pick(health, ['reauth_required', 'error_code', 'error_message'])
  }
  if (account?.outreach) out.outreach = pick(account.outreach, ['remaining', 'limit', 'resets_at'])
  return out
}

export function compactRecipient(recipient) {
  return pick(recipient, [
    'channel',
    'external_conversation_id',
    'external_user_id',
    'display_name',
    'username',
    'phone',
    'input_kind',
    'can_message',
    'reason',
  ])
}

/** Событие ленты: оболочка как есть, содержимое — по типу. */
export function compactEvent(event) {
  if (!event || typeof event !== 'object') return event
  const out = pick(event, ['seq', 'type', 'dialog_id', 'channel_id'])
  const payload = event.payload
  if (typeof event.type === 'string' && event.type.startsWith('message:')) {
    out.payload = compactMessage(payload)
  } else if (event.type === 'dialog:updated') {
    out.payload = compactConversation(payload)
  } else if (payload !== undefined) {
    out.payload = scrub(payload)
  }
  return out
}

const mapList = (fn) => (data) => (Array.isArray(data) ? data.map(fn) : scrub(data))
const mapItems = (fn) => (data) =>
  data && Array.isArray(data.items) ? { ...scrub({ ...data, items: [] }), items: data.items.map(fn) } : scrub(data)

/** Как сокращать ответ каждого инструмента. Неизвестный — через scrub. */
const BY_TOOL = {
  list_conversations: mapList(compactConversation),
  get_conversation: compactConversation,
  start_conversation: (data) => (data?.id ? compactConversation(data) : scrub(data)),
  list_messages: mapItems(compactMessage),
  send_message: compactMessage,
  list_participants: mapList(compactParticipant),
  list_accounts: mapList(compactAccount),
  search_recipients: mapItems(compactRecipient),
  wait_for_changes: (data) =>
    data && Array.isArray(data.events)
      ? { ...scrub({ ...data, events: [] }), events: data.events.map(compactEvent) }
      : scrub(data),
}

/**
 * Сокращает текст ответа инструмента. Не JSON — возвращает как есть:
 * это сообщение об ошибке, и его надо показать модели дословно.
 */
export function compactToolText(toolName, text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return text
  }
  const shape = BY_TOOL[toolName] ?? scrub
  // Страховка поверх формы: если сервер добавит поле с картинкой туда, где
  // форма его пропускает, оно всё равно не дойдёт до модели.
  return JSON.stringify(scrub(shape(data)))
}

/**
 * Сокращает ответ JSON-RPC на tools/call.
 *
 * structuredContent выбрасывается: сервер кладёт туда ту же строку, что и в
 * text, и модель получала каждый ответ дважды. Схема выхода, которая его
 * требует, убирается из tools/list там же, в прокси.
 */
export function compactToolResult(toolName, message) {
  const result = message?.result
  if (!result || !Array.isArray(result.content)) return message
  const content = result.content.map((part) =>
    part?.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: compactToolText(toolName, part.text) }
      : part,
  )
  const { structuredContent, ...rest } = result
  return { ...message, result: { ...rest, content } }
}

/** Убирает из tools/list схемы выхода — без них клиент не ждёт structuredContent. */
export function compactToolsList(message) {
  const tools = message?.result?.tools
  if (!Array.isArray(tools)) return message
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map(({ outputSchema, ...tool }) => tool),
    },
  }
}
