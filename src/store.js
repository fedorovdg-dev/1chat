/**
 * Хранилище службы агента: события, диалоги, запуски, действия.
 *
 * Всё, что должно пережить перезапуск, живёт здесь, а не в памяти. Главное
 * правило: курсор ленты и принятые из неё сообщения записываются одной
 * транзакцией. Курсор означает «эти события сохранены», а не «работа по
 * ним сделана» — работа учитывается отдельно, версиями диалога.
 *
 * Все операции синхронные. Это не упрощение, а способ получить нужную
 * согласованность: приём событий и проверка перед отправкой идут в одном
 * процессе, и синхронная транзакция не может перемежиться с другой.
 * Сетевые вызовы внутри транзакций не делаются никогда.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

export const SCHEMA_VERSION = 1

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  STALE: 'stale',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  SPAWN_FAILED: 'spawn_failed',
  INTERRUPTED: 'interrupted',
})

export const ACTION_STATUS = Object.freeze({
  STARTED: 'started',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
})

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dialogs (
  dialog_id        TEXT PRIMARY KEY,
  channel          TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  handled_version  INTEGER NOT NULL DEFAULT 0,
  first_pending_at INTEGER,
  last_inbound_at  INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inbound (
  message_id    TEXT PRIMARY KEY,
  dialog_id     TEXT NOT NULL,
  feed_seq      INTEGER NOT NULL,
  added_version INTEGER NOT NULL,
  fingerprint   TEXT NOT NULL,
  message       TEXT NOT NULL,
  stored_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_by_dialog ON inbound (dialog_id, added_version, feed_seq);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  dialog_id     TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  from_version  INTEGER NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,
  finished_at   INTEGER,
  exit_code     INTEGER,
  signal        TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_dialog ON runs (dialog_id, started_at);
CREATE INDEX IF NOT EXISTS runs_by_status ON runs (status);

CREATE TABLE IF NOT EXISTS actions (
  action_id     TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  dialog_id     TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  tool          TEXT NOT NULL,
  target_id     TEXT,
  fingerprint   TEXT NOT NULL,
  arguments     TEXT NOT NULL,
  client_id     TEXT,
  status        TEXT NOT NULL,
  result        TEXT,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS actions_by_dialog ON actions (dialog_id, started_at);
CREATE INDEX IF NOT EXISTS actions_by_fingerprint ON actions (dialog_id, fingerprint);
`

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function fingerprintOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

const json = (value) => (value === undefined ? null : JSON.stringify(value))
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text))

export class SqliteUnavailableError extends Error {}

export class Store {
  /**
   * @param {string} file путь к базе или ':memory:'
   * @param {object} [options]
   * @param {() => number} [options.now]
   */
  constructor(file, { now = () => Date.now() } = {}) {
    if (!DatabaseSync) {
      throw new SqliteUnavailableError(
        `Нужен Node.js 22.13 или новее: встроенный SQLite (node:sqlite) недоступен в ${process.version}.`,
      )
    }
    if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true })
    this.file = file
    this.now = now
    this.db = new DatabaseSync(file)
    // WAL: чтение не ждёт записи, а обрыв посреди записи не портит файл.
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  close() {
    this.db.close()
  }

  /** Синхронная транзакция. BEGIN IMMEDIATE — чтобы запись не проиграла гонку на середине. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  getCursor() {
    const value = this.getMeta('cursor')
    return value === null ? null : Number(value)
  }

  /**
   * Переносит курсор из файла старого режима, один раз.
   *
   * Файл переименовывается, а не удаляется: если что-то пошло не так, его
   * можно вернуть. Если курсор в базе уже есть, файл не читается — иначе
   * повторный перенос откатил бы позицию назад и сообщения пришли бы снова.
   */
  migrateCursorFile(file) {
    if (!file || !existsSync(file)) return null
    if (this.getCursor() !== null) return null
    const value = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    if (!Number.isFinite(value)) return null
    this.setMeta('cursor', String(value))
    renameSync(file, `${file}.migrated`)
    return value
  }

  /**
   * Принимает страницу ленты: сообщения и курсор — одной транзакцией.
   *
   * Возвращает диалоги, в которых что-то изменилось, чтобы диспетчер
   * пересчитал только их.
   *
   * @param {object} page
   * @param {number} page.cursor
   * @param {Array<{dialogId: string, channel?: string, message: object, feedSeq: number, kind: 'new'|'updated'}>} page.inbound
   */
  ingestPage({ cursor, inbound }) {
    const now = this.now()
    return this.transaction(() => {
      const touched = new Set()
      for (const item of inbound) {
        if (this.#ingestOne(item, now)) touched.add(item.dialogId)
      }
      this.setMeta('cursor', String(cursor))
      return [...touched]
    })
  }

  #ingestOne({ dialogId, channel, message, feedSeq, kind }, now) {
    const messageId = String(message.id)
    // Отпечаток — то, что меняет смысл: текст, удаление, вложения. Смена
    // статуса доставки или реакции продолжением мысли не является.
    const fingerprint = fingerprintOf([
      message.text ?? null,
      message.deleted_at ?? null,
      (message.attachments ?? []).map((a) => a.id ?? a.name ?? null),
    ])
    const existing = this.db
      .prepare('SELECT fingerprint, added_version FROM inbound WHERE message_id = ?')
      .get(messageId)

    const dialog = this.#ensureDialog(dialogId, channel)

    if (existing) {
      // Повтор того же события — ничего не делаем. Это и есть дедупликация
      // по устойчивому идентификатору: одно сообщение приходит в ленте
      // несколькими событиями (new, затем updated при каждой смене статуса).
      if (existing.fingerprint === fingerprint) return false
      // Правка уже обработанного сообщения не будит агента: ответ на него
      // уже дан, а переписывать прошлое не просили.
      if (existing.added_version <= dialog.handled_version) return false
      const version = dialog.version + 1
      this.db
        .prepare('UPDATE inbound SET fingerprint = ?, message = ? WHERE message_id = ?')
        .run(fingerprint, JSON.stringify(message), messageId)
      this.#bumpDialog(dialogId, dialog, version, now)
      return true
    }

    if (kind !== 'new') return false

    const version = dialog.version + 1
    this.db
      .prepare(
        `INSERT INTO inbound (message_id, dialog_id, feed_seq, added_version, fingerprint, message, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, dialogId, feedSeq, version, fingerprint, JSON.stringify(message), now)
    this.#bumpDialog(dialogId, dialog, version, now)
    return true
  }

  #ensureDialog(dialogId, channel) {
    this.db
      .prepare('INSERT INTO dialogs (dialog_id, channel) VALUES (?, ?) ON CONFLICT(dialog_id) DO NOTHING')
      .run(dialogId, channel ?? null)
    return this.getDialog(dialogId)
  }

  #bumpDialog(dialogId, dialog, version, now) {
    // Начало пачки ставится один раз и не сдвигается продолжениями: иначе
    // человек, пишущий без остановки, откладывал бы ответ бесконечно.
    const firstPending = dialog.version === dialog.handled_version ? now : dialog.first_pending_at ?? now
    this.db
      .prepare(
        'UPDATE dialogs SET version = ?, last_inbound_at = ?, first_pending_at = ? WHERE dialog_id = ?',
      )
      .run(version, now, firstPending, dialogId)
  }

  getDialog(dialogId) {
    return this.db.prepare('SELECT * FROM dialogs WHERE dialog_id = ?').get(dialogId) ?? null
  }

  /** Диалоги, где есть необработанное. */
  pendingDialogs() {
    return this.db.prepare('SELECT * FROM dialogs WHERE version > handled_version').all()
  }

  /** Сообщения пачки в порядке поступления: всё, что после обработанной версии. */
  pendingMessages(dialogId, handledVersion) {
    return this.db
      .prepare(
        'SELECT message, added_version, feed_seq FROM inbound WHERE dialog_id = ? AND added_version > ? ORDER BY feed_seq, added_version',
      )
      .all(dialogId, handledVersion)
      .map((row) => ({ ...JSON.parse(row.message), feed_seq: row.feed_seq }))
  }

  /** Недавние уже обработанные сообщения — фон для продолжения после завершённого ответа. */
  recentHandledMessages(dialogId, handledVersion, limit) {
    return this.db
      .prepare(
        'SELECT message, feed_seq FROM inbound WHERE dialog_id = ? AND added_version <= ? ORDER BY feed_seq DESC LIMIT ?',
      )
      .all(dialogId, handledVersion, limit)
      .reverse()
      .map((row) => ({ ...JSON.parse(row.message), feed_seq: row.feed_seq }))
  }

  activeRuns() {
    return this.db.prepare('SELECT * FROM runs WHERE status = ?').all(RUN_STATUS.RUNNING)
  }

  activeRunFor(dialogId) {
    return (
      this.db
        .prepare('SELECT * FROM runs WHERE dialog_id = ? AND status = ?')
        .get(dialogId, RUN_STATUS.RUNNING) ?? null
    )
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) ?? null
  }

  runByToken(token) {
    if (!token) return null
    return this.db.prepare('SELECT * FROM runs WHERE token_hash = ?').get(hashToken(token)) ?? null
  }

  /**
   * Начинает запуск, если диалог всё ещё готов. Проверка и запись — одна
   * транзакция, поэтому двух активных запусков на диалог не бывает даже при
   * одновременных вызовах.
   *
   * Возвращает `{run, token}` или null.
   */
  startRun(dialogId, { timeoutMs }) {
    const now = this.now()
    return this.transaction(() => {
      const dialog = this.getDialog(dialogId)
      if (!dialog || dialog.version <= dialog.handled_version) return null
      if (this.activeRunFor(dialogId)) return null
      const token = randomBytes(24).toString('hex')
      const run = {
        run_id: randomUUID(),
        dialog_id: dialogId,
        input_version: dialog.version,
        from_version: dialog.handled_version,
        token_hash: hashToken(token),
        status: RUN_STATUS.RUNNING,
        attempt: dialog.attempts + 1,
        started_at: now,
        deadline_at: now + timeoutMs,
      }
      this.db
        .prepare(
          `INSERT INTO runs (run_id, dialog_id, input_version, from_version, token_hash, status, attempt, started_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.run_id,
          run.dialog_id,
          run.input_version,
          run.from_version,
          run.token_hash,
          run.status,
          run.attempt,
          run.started_at,
          run.deadline_at,
        )
      return { run, token }
    })
  }

  /**
   * Завершает запуск и решает, что делать с пачкой.
   *
   * - Устарел (пришло продолжение) — пачка остаётся необработанной, и
   *   следующий запуск увидит её целиком вместе с продолжением. Это не
   *   ошибка агента, попытка не тратится.
   * - Успех — пачка до input_version обработана.
   * - Ошибка — попытка тратится, следующая откладывается; после последней
   *   пачка признаётся брошенной, чтобы диалог не застрял навсегда.
   *
   * @returns {{status: string, abandoned: boolean}}
   */
  finishRun(runId, outcome, { maxAttempts, backoffMs }) {
    const now = this.now()
    return this.transaction(() => {
      const run = this.getRun(runId)
      if (!run || run.status !== RUN_STATUS.RUNNING) return { status: run?.status ?? null, abandoned: false }
      const dialog = this.getDialog(run.dialog_id)
      const stale = dialog.version !== run.input_version

      let status
      if (outcome.kind === 'exit' && outcome.code === 0 && !outcome.signal) {
        status = stale ? RUN_STATUS.STALE : RUN_STATUS.SUCCEEDED
      } else if (stale && outcome.kind !== 'interrupted') {
        // Устаревший запуск, который упал или истёк, — всё равно устаревший:
        // его пачку разберёт следующий, и ошибкой агента это не считается.
        status = RUN_STATUS.STALE
      } else {
        status = {
          exit: RUN_STATUS.FAILED,
          timeout: RUN_STATUS.TIMED_OUT,
          spawn_error: RUN_STATUS.SPAWN_FAILED,
          interrupted: RUN_STATUS.INTERRUPTED,
        }[outcome.kind] ?? RUN_STATUS.FAILED
      }

      this.db
        .prepare(
          'UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, signal = ?, error = ? WHERE run_id = ?',
        )
        .run(status, now, outcome.code ?? null, outcome.signal ?? null, outcome.error ?? null, runId)

      let abandoned = false
      if (status === RUN_STATUS.SUCCEEDED) {
        this.#markHandled(run.dialog_id, run.input_version, dialog)
      } else if (status === RUN_STATUS.STALE) {
        // Окно максимального ожидания начинается заново, пачка — нет. Иначе
        // при непрерывном вводе окно давно истекло, и каждый устаревший
        // запуск сразу сменялся бы новым: круг запусков, каждый из которых
        // стоит модели токенов и ничего не успевает сделать.
        this.db
          .prepare('UPDATE dialogs SET next_attempt_at = 0, first_pending_at = ? WHERE dialog_id = ?')
          .run(now, run.dialog_id)
      } else {
        const attempts = dialog.attempts + 1
        if (attempts >= maxAttempts) {
          abandoned = true
          this.#markHandled(run.dialog_id, run.input_version, dialog)
        } else {
          this.db
            .prepare('UPDATE dialogs SET attempts = ?, next_attempt_at = ? WHERE dialog_id = ?')
            .run(attempts, now + backoffMs(attempts), run.dialog_id)
        }
      }
      return { status, abandoned }
    })
  }

  #markHandled(dialogId, version, dialog) {
    // Если за время запуска пришло новое (для успешного это невозможно, для
    // брошенного — возможно), начало новой пачки — сейчас.
    const stillPending = dialog.version > version
    this.db
      .prepare(
        'UPDATE dialogs SET handled_version = ?, attempts = 0, next_attempt_at = 0, first_pending_at = ? WHERE dialog_id = ?',
      )
      .run(version, stillPending ? this.now() : null, dialogId)
  }

  /**
   * После перезапуска службы: запуски, которые числились активными, уже не
   * идут. Их пароли перестают действовать сразу — осиротевший процесс, если
   * он пережил службу, ничего отправить не сможет.
   */
  recoverAfterRestart({ maxAttempts, backoffMs }) {
    const interrupted = this.activeRuns()
    for (const run of interrupted) {
      this.finishRun(run.run_id, { kind: 'interrupted', error: 'служба перезапущена' }, { maxAttempts, backoffMs })
    }
    const now = this.now()
    const orphaned = this.db
      .prepare('UPDATE actions SET status = ?, error = ?, finished_at = ? WHERE status = ?')
      .run(ACTION_STATUS.UNCERTAIN, 'служба перезапущена во время действия', now, ACTION_STATUS.STARTED)
    return { interruptedRuns: interrupted.length, uncertainActions: Number(orphaned.changes) }
  }

  // ── действия ────────────────────────────────────────────────────

  /**
   * Проверка перед изменяющим действием и его регистрация — одна синхронная
   * транзакция. Приём событий пишет в ту же базу из того же процесса, так
   * что между «версия актуальна» и «действие начато» новое сообщение
   * вклиниться не может.
   *
   * @returns {{ok: true, action: object} | {ok: false, code: string, detail?: string, action?: object, waitMs?: number}}
   */
  beginAction({ token, tool, targetId, arguments: args, fingerprint, clientId, quietMs, dedupe }) {
    const now = this.now()
    return this.transaction(() => {
      const run = this.runByToken(token)
      if (!run) return { ok: false, code: 'UNAUTHORIZED' }
      if (run.status !== RUN_STATUS.RUNNING) return { ok: false, code: 'RUN_NOT_ACTIVE', detail: run.status }
      if (now >= run.deadline_at) return { ok: false, code: 'RUN_NOT_ACTIVE', detail: 'deadline' }

      const dialog = this.getDialog(run.dialog_id)
      if (dialog.version !== run.input_version) return { ok: false, code: 'STALE_CONTEXT', run }

      const quietLeft = (dialog.last_inbound_at ?? 0) + quietMs - now
      if (quietLeft > 0) return { ok: false, code: 'WAIT', waitMs: quietLeft, run }

      if (dedupe) {
        // Совпадение ищем среди действий текущей необработанной пачки — в
        // том числе у прошлых, устаревших или упавших запусков. Новый запуск
        // не должен второй раз отправить то, что уже ушло.
        const previous = this.db
          .prepare(
            `SELECT * FROM actions WHERE dialog_id = ? AND fingerprint = ? AND input_version > ?
             AND status IN (?, ?, ?) ORDER BY started_at DESC LIMIT 1`,
          )
          .get(
            run.dialog_id,
            fingerprint,
            run.from_version,
            ACTION_STATUS.SUCCEEDED,
            ACTION_STATUS.STARTED,
            ACTION_STATUS.UNCERTAIN,
          )
        if (previous) {
          const code = previous.status === ACTION_STATUS.SUCCEEDED ? 'ALREADY_DONE' : 'UNCERTAIN_RESULT'
          return { ok: false, code, action: this.#actionRow(previous), run }
        }
      }

      const action = {
        action_id: randomUUID(),
        run_id: run.run_id,
        dialog_id: run.dialog_id,
        input_version: run.input_version,
        tool,
        target_id: targetId ?? null,
        fingerprint,
        arguments: args,
        client_id: clientId ?? null,
        status: ACTION_STATUS.STARTED,
        started_at: now,
      }
      this.db
        .prepare(
          `INSERT INTO actions (action_id, run_id, dialog_id, input_version, tool, target_id, fingerprint, arguments, client_id, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          action.action_id,
          action.run_id,
          action.dialog_id,
          action.input_version,
          action.tool,
          action.target_id,
          action.fingerprint,
          json(action.arguments),
          action.client_id,
          action.status,
          action.started_at,
        )
      return { ok: true, action, run }
    })
  }

  finishAction(actionId, { status, result, error }) {
    this.db
      .prepare('UPDATE actions SET status = ?, result = ?, error = ?, finished_at = ? WHERE action_id = ?')
      .run(status, json(result), error ?? null, this.now(), actionId)
  }

  getAction(actionId) {
    const row = this.db.prepare('SELECT * FROM actions WHERE action_id = ?').get(actionId)
    return row ? this.#actionRow(row) : null
  }

  /** Действия по пачке — чтобы повторный запуск знал, что уже сделано. */
  actionsSince(dialogId, fromVersion) {
    return this.db
      .prepare('SELECT * FROM actions WHERE dialog_id = ? AND input_version > ? ORDER BY started_at')
      .all(dialogId, fromVersion)
      .map((row) => this.#actionRow(row))
  }

  recentActions(dialogId, limit) {
    return this.db
      .prepare('SELECT * FROM actions WHERE dialog_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(dialogId, limit)
      .reverse()
      .map((row) => this.#actionRow(row))
  }

  uncertainActions(dialogId) {
    return this.db
      .prepare('SELECT * FROM actions WHERE dialog_id = ? AND status = ?')
      .all(dialogId, ACTION_STATUS.UNCERTAIN)
      .map((row) => this.#actionRow(row))
  }

  runsSince(dialogId, fromVersion) {
    return this.db
      .prepare('SELECT * FROM runs WHERE dialog_id = ? AND input_version > ? ORDER BY started_at')
      .all(dialogId, fromVersion)
  }

  #actionRow(row) {
    return { ...row, arguments: parse(row.arguments), result: parse(row.result) }
  }
}
