/**
 * Клиент 1-chat: ждёт события и сообщает о них наружу.
 *
 * Смысл существования — в том, чтобы ждал не агент. Каждая проверка,
 * сделанная языковой моделью, это её ход и её токены; проверка раз в
 * полминуты — это сотня ходов в час на то, чтобы узнать, что ничего не
 * произошло. Здесь ждёт обычный процесс, который не стоит ничего, а агент
 * запускается только когда реально пришло сообщение.
 *
 * Соединение исходящее. Значит не нужны ни домен, ни сертификат, ни
 * веб-сервер — ничего из того, что требуется для приёма вебхуков.
 */

import { setTimeout as sleep } from 'node:timers/promises'

/** Ошибка, после которой ждать бесполезно: ключ отозван или перевыпущен. */
export class AuthError extends Error {}

/**
 * Сервер не знает про ожидание событий.
 *
 * Так выглядит указание на устаревший 1-chat или просто опечатка в адресе.
 * Повторять бессмысленно, а голый «HTTP 404» человеку ничего не объясняет.
 */
export class UnsupportedServerError extends Error {}

const DEFAULT_BASE_URL = 'https://app.1-chat.ru/api'

/** Сервер держит запрос до 30 секунд; берём столько же. */
export const WAIT_SECONDS = 30

/**
 * Запас поверх времени удержания. Оборвать соединение на долю секунды
 * раньше, чем сервер честно ответит, — верный способ терять события.
 */
const TIMEOUT_MARGIN_MS = 15_000

/** Пауза при недоступности сети. Растёт до минуты и сбрасывается на первом успехе. */
const MAX_BACKOFF_MS = 60_000

/**
 * Нижняя граница между пустыми кругами.
 *
 * В норме нас тормозит сам сервер: он держит запрос. Но если он вдруг
 * начнёт отвечать мгновенно — из-за прокси, промежуточного кеша или
 * чужой ошибки, — цикл без этой паузы превратится в долбёжку и положит
 * и нас, и его. Клиент не должен зависеть от чужой добросовестности.
 */
const MIN_ROUND_MS = 250

export class OneChatClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey ключ вида sk_1chat_ro_… или sk_1chat_rw_…
   * @param {string} [options.baseUrl]
   * @param {(msg: string, meta?: object) => void} [options.log]
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, log = () => {}, fetch: doFetch } = {}) {
    if (!apiKey) throw new Error('Нужен apiKey. Выпустите его на странице «API-ключи».')
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.log = log
    this.fetch = doFetch ?? globalThis.fetch
    this.stopped = false
  }

  async request(path, { timeoutMs = 30_000 } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401) {
      throw new AuthError('Ключ недействителен: не существует, отозван или перевыпущен.')
    }
    if (response.status === 404) {
      throw new UnsupportedServerError(
        `Адрес ${this.baseUrl} не отвечает на ${path}. Проверьте ONECHAT_BASE_URL — ` +
          'возможно, указан не тот сервер или он ещё не обновлён.',
      )
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} на ${path}`)
    }
    return response.json()
  }

  /** Текущая позиция в потоке событий, без ожидания. */
  async cursor() {
    const { cursor } = await this.request('/v1/changes?since=0&wait=0')
    return cursor
  }

  /**
   * Один цикл ожидания: держит запрос, пока не появится событие.
   * Возвращает `{cursor, events, gap}`.
   */
  async waitOnce(since, waitSeconds = WAIT_SECONDS) {
    const data = await this.request(
      `/v1/changes?since=${since}&wait=${waitSeconds}`,
      { timeoutMs: waitSeconds * 1000 + TIMEOUT_MARGIN_MS },
    )
    return {
      cursor: data.cursor,
      events: data.events ?? [],
      // «gap» означает, что курсор старше хранимого журнала: мы спали дольше,
      // чем события живут. Притворяться, что ничего не пропустили, нельзя.
      gap: data.status === 'gap',
    }
  }

  stop() {
    this.stopped = true
  }

  /**
   * Бесконечный цикл: ждёт события и отдаёт их по одному в `onEvent`.
   *
   * @param {object} options
   * @param {number|null} options.since откуда продолжать; null — с текущего места
   * @param {(event: object) => Promise<void>|void} options.onEvent
   * @param {(cursor: number) => Promise<void>|void} [options.onCursor] сохранить позицию
   * @param {(page: {cursor: number, events: object[]}) => Promise<void>|void} [options.onPage]
   *   страница целиком: события и курсор вместе. С ним onEvent и onCursor не
   *   вызываются — сохранить их по отдельности значит однажды сохранить
   *   одно без другого.
   */
  async run({ since = null, onEvent = () => {}, onCursor = () => {}, onPage = null }) {
    const saveCursor = (cursor) => (onPage ? onPage({ cursor, events: [] }) : onCursor(cursor))
    let cursor = since
    if (cursor === null) {
      // Первый запуск начинается с текущего момента, а не с начала журнала:
      // иначе агент проснётся на двухнедельной истории и напишет всем подряд.
      cursor = await this.cursor()
      await saveCursor(cursor)
      this.log('начинаю с текущего момента', { cursor })
    } else {
      this.log('продолжаю с сохранённой позиции', { cursor })
    }

    let backoff = 1000
    while (!this.stopped) {
      const startedAt = Date.now()
      let result
      try {
        result = await this.waitOnce(cursor)
      } catch (error) {
        if (error instanceof AuthError) throw error
        if (error instanceof UnsupportedServerError) throw error
        this.log('связь потеряна, пауза', { error: String(error), backoffMs: backoff })
        await sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        continue
      }
      backoff = 1000

      if (result.gap) {
        cursor = await this.cursor()
        await saveCursor(cursor)
        this.log('позиция устарела, продолжаю с текущего момента', { cursor })
        continue
      }

      if (onPage) {
        if (result.events.length || result.cursor > cursor) {
          await onPage({ cursor: Math.max(result.cursor, cursor), events: result.events })
          cursor = Math.max(result.cursor, cursor)
        }
      } else {
        if (result.cursor > cursor) {
          cursor = result.cursor
          await onCursor(cursor)
        }

        for (const event of result.events) {
          if (this.stopped) break
          await onEvent(event)
        }
      }

      // Пустой круг, законченный слишком быстро, значит сервер не удержал
      // запрос. Дальше — только с паузой.
      const elapsed = Date.now() - startedAt
      if (!result.events.length && elapsed < MIN_ROUND_MS) {
        await sleep(MIN_ROUND_MS - elapsed)
      }
    }
  }
}

/**
 * Стоит ли будить агента этим событием.
 *
 * Нас уведомляют обо всём, включая наши же исходящие. Ответить на
 * собственное сообщение — это бесконечный переписка с самим собой,
 * в середине которой живой человек.
 */
export function isIncomingMessage(event, { dialogs = null } = {}) {
  if (event?.type !== 'message:new') return false
  if (event?.payload?.direction !== 'inbound') return false
  if (dialogs && dialogs.length && !dialogs.includes(String(event.dialog_id))) return false
  return true
}
