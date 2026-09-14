/**
 * Запуск процесса агента.
 *
 * Здесь различаются вещи, которые раньше сливались в одно «процесс
 * закончился»: успешное завершение, ненулевой код, смерть от сигнала,
 * отказ запуска и таймаут. Решает, что с ними делать, диспетчер.
 */

import { spawn } from 'node:child_process'

/**
 * Переменные, которые не должны попасть агенту.
 *
 * Ключ 1-chat — главное. Агент работает через локальный MCP с паролем
 * запуска; с ключом на руках он мог бы ходить в 1-chat в обход проверки
 * актуальности, и вся защита отправки была бы вежливой просьбой.
 */
const SECRET_NAMES = ['ONECHAT_API_KEY']

export function sanitizeEnv(env, { apiKey } = {}) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAMES.includes(name)) continue
    // Тот же ключ под другим именем — тоже ключ.
    if (apiKey && typeof value === 'string' && value.includes(apiKey)) continue
    out[name] = value
  }
  return out
}

/**
 * @param {object} options
 * @param {string} options.command выполняется через shell
 * @param {object} options.input уходит в stdin как JSON
 * @param {Record<string,string>} options.env окружение целиком (уже очищенное)
 * @param {number} options.timeoutMs
 * @param {number} [options.killGraceMs] сколько ждать после SIGTERM до SIGKILL
 * @returns {{ promise: Promise<{kind: 'exit'|'timeout'|'spawn_error', code?: number|null, signal?: string|null, error?: string}>, terminate: (reason?: string) => void, pid: number|undefined }}
 */
export function runAgentProcess({ command, input, env, timeoutMs, killGraceMs = 5000 }) {
  let child
  try {
    child = spawn(command, {
      shell: true,
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
      // Своя группа процессов: bridge запускает агента дочерним процессом, и
      // сигнал только bridge оставил бы агента работать после таймаута.
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    return { promise: Promise.resolve({ kind: 'spawn_error', error: String(error) }), terminate: () => {}, pid: undefined }
  }

  let timedOut = false
  let terminating = null
  let settled = false
  const isGroup = process.platform !== 'win32'

  const signalGroup = (signal) => {
    if (!child.pid) return false
    try {
      if (isGroup) process.kill(-child.pid, signal)
      else child.kill(signal)
      return true
    } catch {
      // В группе никого не осталось.
      return false
    }
  }

  const groupAlive = () => isGroup && signalGroup(0)

  /**
   * SIGTERM всей группе, SIGKILL тем, кто пережил паузу.
   *
   * Завершение первого процесса группы ничего не значит: шелл может умереть
   * от SIGTERM сразу, а агент, запущенный им дочерним процессом, сигнал
   * проигнорирует. Раньше отложенный SIGKILL отменялся вместе с выходом
   * шелла, и агент продолжал работать после таймаута. Теперь добивается
   * группа, а не первый процесс.
   */
  const terminate = () => {
    if (terminating) return terminating
    terminating = (async () => {
      if (!signalGroup('SIGTERM')) return
      const deadline = Date.now() + killGraceMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        if (!groupAlive()) return
      }
      signalGroup('SIGKILL')
    })()
    return terminating
  }

  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  timer.unref?.()

  const promise = new Promise((done) => {
    const finish = async (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Запуск закончен, только когда в его группе никого не осталось:
      // процесс, оставленный агентом в фоне, иначе пережил бы свой запуск и
      // работал бы параллельно со следующим.
      if (groupAlive()) await terminate()
      else if (terminating) await terminating
      done(outcome)
    }
    child.on('error', (error) => finish({ kind: 'spawn_error', error: String(error) }))
    child.on('close', (code, signal) => {
      if (timedOut) finish({ kind: 'timeout', code, signal, error: `таймаут ${timeoutMs} мс` })
      // Шелл, которому не нашлось команды, завершается с кодом 127: для нас
      // это отказ запуска, а не ошибка агента.
      else if (code === 127) finish({ kind: 'spawn_error', code, error: 'команда не найдена' })
      else finish({ kind: 'exit', code, signal })
    })
  })

  // Агент может не читать stdin вовсе — это не повод падать.
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(input))

  return { promise, terminate, pid: child.pid }
}
