/**
 * Диспетчер: когда и кого запускать.
 *
 * Правила:
 * - пачка диалога готова, когда после последнего входящего прошла пауза
 *   (quietMs) или от первого сообщения пачки прошло максимальное ожидание
 *   (maxWaitMs) — что наступит раньше;
 * - продолжение сбрасывает паузу, но не начало пачки;
 * - в диалоге не больше одного активного запуска, всего — не больше
 *   concurrency;
 * - после ошибки следующая попытка откладывается; после maxAttempts пачка
 *   бросается, чтобы диалог не застрял.
 *
 * Максимальное ожидание разрешает только начать готовить ответ. Отправка
 * всё равно проходит проверку актуальности и паузы в локальном MCP.
 */

import { RUN_STATUS } from './store.js'

export const DEFAULTS = Object.freeze({
  quietMs: 3000,
  maxWaitMs: 15000,
  concurrency: 2,
  runTimeoutMs: 300_000,
  maxAttempts: 3,
})

/** 10 с, минута, пять минут. Немедленных перезапусков не бывает. */
export function defaultBackoffMs(attempt) {
  return [10_000, 60_000, 300_000][Math.min(attempt - 1, 2)]
}

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
}

export class Dispatcher {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {(run: object, token: string) => Promise<{promise: Promise<object>, terminate: () => void}>} options.launch
   * @param {typeof realClock} [options.clock]
   * @param {Partial<typeof DEFAULTS>} [options.settings]
   * @param {(attempt: number) => number} [options.backoffMs]
   * @param {(msg: string, meta?: object) => void} [options.log]
   */
  constructor({ store, launch, clock = realClock, settings = {}, backoffMs = defaultBackoffMs, log = () => {} }) {
    this.store = store
    this.launch = launch
    this.clock = clock
    this.settings = { ...DEFAULTS, ...settings }
    this.backoffMs = backoffMs
    this.log = log
    this.running = new Map()
    this.timer = null
    this.timerDue = Infinity
    this.stopping = false
    this.evaluating = false
    this.again = false
  }

  /** Пересчитать готовность. Безопасно вызывать сколько угодно раз подряд. */
  poke() {
    if (this.stopping) return
    if (this.evaluating) {
      this.again = true
      return
    }
    this.evaluating = true
    try {
      do {
        this.again = false
        this.#evaluate()
      } while (this.again && !this.stopping)
    } finally {
      this.evaluating = false
    }
  }

  #evaluate() {
    const now = this.clock.now()
    const { quietMs, maxWaitMs, concurrency } = this.settings
    let nextDue = Infinity

    const dialogs = this.store
      .pendingDialogs()
      .sort((a, b) => (a.first_pending_at ?? 0) - (b.first_pending_at ?? 0))

    for (const dialog of dialogs) {
      if (this.store.activeRunFor(dialog.dialog_id)) continue
      const quietDue = (dialog.last_inbound_at ?? now) + quietMs
      const maxDue = (dialog.first_pending_at ?? now) + maxWaitMs
      const due = Math.max(Math.min(quietDue, maxDue), dialog.next_attempt_at ?? 0)
      if (due > now) {
        nextDue = Math.min(nextDue, due)
        continue
      }
      // Свободного места нет — пересчитаем, когда кто-то закончит.
      if (this.running.size >= concurrency) break
      this.#start(dialog.dialog_id)
    }

    this.#schedule(nextDue)
  }

  #schedule(due) {
    if (due === this.timerDue) return
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.timerDue = due
    if (due === Infinity || this.stopping) return
    const delay = Math.max(0, due - this.clock.now())
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.timerDue = Infinity
      this.poke()
    }, delay)
  }

  #start(dialogId) {
    const started = this.store.startRun(dialogId, { timeoutMs: this.settings.runTimeoutMs })
    if (!started) return
    const { run, token } = started
    const entry = { run, handle: null, interrupted: false }
    this.running.set(run.run_id, entry)
    this.log('запуск агента', {
      run: run.run_id,
      dialog: dialogId,
      version: run.input_version,
      attempt: run.attempt,
    })

    entry.done = (async () => {
      let outcome
      try {
        entry.handle = await this.launch(run, token)
        if (this.stopping && !entry.interrupted) {
          entry.interrupted = true
          entry.handle.terminate()
        }
        outcome = await entry.handle.promise
      } catch (error) {
        outcome = { kind: 'spawn_error', error: String(error?.message ?? error) }
      }
      if (entry.interrupted) outcome = { ...outcome, kind: 'interrupted', error: 'служба остановлена' }

      const { status, abandoned } = this.store.finishRun(run.run_id, outcome, {
        maxAttempts: this.settings.maxAttempts,
        backoffMs: this.backoffMs,
      })
      this.running.delete(run.run_id)

      const meta = { run: run.run_id, dialog: dialogId, status, code: outcome.code, signal: outcome.signal }
      if (abandoned) this.log('пачка брошена после исчерпания попыток', { ...meta, error: outcome.error })
      else if (status === RUN_STATUS.SUCCEEDED) this.log('запуск завершён', meta)
      else if (status === RUN_STATUS.STALE) this.log('запуск устарел, пачка будет разобрана заново', meta)
      else this.log('запуск не удался', { ...meta, error: outcome.error })

      this.poke()
      return status
    })()
  }

  /** Сколько запусков сейчас идёт. */
  get activeCount() {
    return this.running.size
  }

  /** Дождаться, пока все идущие запуски завершатся (для тестов и остановки). */
  async idle() {
    while (this.running.size) {
      await Promise.all([...this.running.values()].map((entry) => entry.done))
    }
  }

  /**
   * Остановка: новые запуски не начинаются, идущие получают SIGTERM и
   * записываются как прерванные. Их пароли перестают действовать сразу.
   */
  async stop() {
    this.stopping = true
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    for (const entry of this.running.values()) {
      entry.interrupted = true
      entry.handle?.terminate()
    }
    await Promise.all([...this.running.values()].map((entry) => entry.done))
  }
}
