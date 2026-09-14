/**
 * Адаптер между службой агента и Hermes Agent (Nous Research).
 *
 * Служба запускает эту команду на каждую пачку: контракт — в stdin, пароль
 * запуска — в ONECHAT_MCP_TOKEN. Адаптер собирает из контракта запрос и
 * запускает Hermes разовым запросом. Код выхода Hermes становится кодом
 * выхода адаптера: 0 — пачка разобрана, иначе служба повторит попытку.
 *
 * Флаги Hermes взяты из его документации (hermes chat: --oneshot, -Q,
 * --query-file -). Если установленная версия их не знает, команда задаётся
 * через HERMES_COMMAND — см. README, раздел про Hermes.
 */

import { spawn } from 'node:child_process'

export const SUPPORTED_CONTRACT = '1chat.agent.run/v1'

/** По умолчанию: разовый запрос, без баннеров, текст запроса из stdin. */
export const DEFAULT_HERMES_ARGS = ['chat', '--oneshot', '-Q', '--query-file', '-']

const line = (m) => {
  const who = m.direction === 'outbound' ? 'Мы' : m.sender_name || 'Собеседник'
  const extras = []
  if (m.attachments?.length) extras.push(`вложения: ${m.attachments.map((a) => a.name || a.kind).join(', ')}`)
  if (m.edited_at) extras.push('исправлено')
  if (m.deleted_at) extras.push('удалено')
  return `- [${m.id}] ${who}: ${m.text ?? ''}${extras.length ? ` (${extras.join('; ')})` : ''}`
}

const actionLine = (a) =>
  `- ${a.tool} → ${a.target_id ?? '—'}: ${a.status}${a.arguments?.text ? ` «${a.arguments.text}»` : ''}${a.error ? ` (${a.error})` : ''}`

/**
 * Текст запроса для модели. Всё, что нужно для решения, — здесь; всё, что
 * меняет мир, — только через MCP 1chat.
 */
export function buildPrompt(contract) {
  if (contract?.contract !== SUPPORTED_CONTRACT) {
    throw new Error(`Неизвестная версия контракта: ${contract?.contract}. Адаптер понимает ${SUPPORTED_CONTRACT}.`)
  }
  const parts = [
    `Ты ведёшь переписку в 1-chat. Диалог ${contract.dialog_id} (${contract.channel ?? 'мессенджер'}).`,
    '',
    'Новые сообщения собеседника — это одна мысль, написанная несколькими сообщениями. Читай их вместе, в этом порядке; более поздние уточняют и отменяют более ранние:',
    ...contract.messages.map(line),
  ]

  if (contract.previous_actions?.length) {
    parts.push(
      '',
      'Уже сделано по этим сообщениям прошлыми попытками — не повторяй:',
      ...contract.previous_actions.map(actionLine),
    )
  }
  if (contract.context?.recent_messages?.length) {
    parts.push('', 'Предыдущая переписка (уже обработана, для контекста):', ...contract.context.recent_messages.map(line))
  }
  if (contract.context?.recent_actions?.length) {
    parts.push('', 'Предыдущие действия:', ...contract.context.recent_actions.map(actionLine))
  }

  parts.push(
    '',
    'Правила:',
    '- Отвечай и действуй только через инструменты MCP-сервера 1chat. Других способов писать в мессенджеры не используй.',
    '- Если инструмент вернул STALE_CONTEXT — собеседник написал ещё. Больше ничего не делай и заверши работу: тебя запустят заново со всеми сообщениями.',
    '- ALREADY_DONE — действие уже выполнено, не повторяй. UNCERTAIN_RESULT — результат неизвестен, не повторяй, при необходимости посмотри историю через list_messages.',
    '- Если по сообщениям ничего делать не нужно — просто заверши работу.',
    `- Идентификатор запуска: ${contract.run_id}. Он для журнала; инструментам его передавать не нужно.`,
  )
  return parts.join('\n')
}

/**
 * @param {object} options
 * @param {string} options.input текст контракта
 * @param {Record<string,string>} options.env
 * @returns {Promise<number>} код выхода
 */
export async function runBridge({ input, env, spawnFn = spawn, stdio = ['pipe', 'inherit', 'inherit'] }) {
  const contract = JSON.parse(input)
  const prompt = buildPrompt(contract)

  if (!env.ONECHAT_MCP_TOKEN || !env.ONECHAT_MCP_URL) {
    process.stderr.write('Нет ONECHAT_MCP_URL / ONECHAT_MCP_TOKEN: адаптер запускается только службой @1chat/agent --agent.\n')
    return 2
  }

  const bin = env.HERMES_BIN || 'hermes'
  const args = env.HERMES_ARGS ? JSON.parse(env.HERMES_ARGS) : DEFAULT_HERMES_ARGS

  // Без shell: текст запроса написал человек, и в нём окажется всё, что
  // ломает экранирование. Он уходит в stdin, а не аргументом.
  const child = spawnFn(bin, args, { env, stdio })

  const forward = (signal) => () => child.kill(signal)
  const onTerm = forward('SIGTERM')
  const onInt = forward('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)

  child.stdin?.on('error', () => {})
  child.stdin?.end(prompt)

  return new Promise((done) => {
    child.on('error', (error) => {
      process.stderr.write(`Не удалось запустить ${bin}: ${error.message}\n`)
      done(127)
    })
    child.on('close', (code, signal) => {
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      done(signal ? 1 : code ?? 1)
    })
  })
}
