#!/usr/bin/env node
/**
 * Запуск наблюдателя одной командой.
 *
 *     npx @1chat/agent --exec "hermes run"
 *
 * Ключ берётся из ONECHAT_API_KEY. Позиция в потоке сохраняется на диск,
 * поэтому перезапуск не теряет события и не переобрабатывает старые.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import {
  AuthError,
  OneChatClient,
  UnsupportedServerError,
  isIncomingMessage,
} from './client.js'

function parseArgs(argv) {
  const args = { exec: null, state: '.state/cursor', dialogs: null, from: 'now', quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--exec') args.exec = argv[++i]
    else if (arg === '--state') args.state = argv[++i]
    else if (arg === '--dialogs') args.dialogs = argv[++i].split(',').map((d) => d.trim())
    else if (arg === '--from') args.from = argv[++i]
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

const HELP = `
Будит вашего агента, когда в 1-chat приходит сообщение.

  npx @1chat/agent --exec "hermes run"

Ключ кладётся в переменную окружения:

  export ONECHAT_API_KEY=sk_1chat_rw_...

Параметры:
  --exec <команда>   что запускать на входящее сообщение. Событие приходит
                     в stdin как JSON — текст пишет человек, и рано или поздно
                     в нём окажется всё, что ломает экранирование в аргументах
  --dialogs <id,id>  реагировать только на эти диалоги
  --state <файл>     где хранить позицию в потоке (по умолчанию .state/cursor)
  --from now|begin   с чего начать при первом запуске; по умолчанию now,
                     иначе агент проснётся на всей сохранённой истории
  --quiet            не писать в лог ничего, кроме ошибок

Переменные окружения:
  ONECHAT_API_KEY    обязательна
  ONECHAT_BASE_URL   по умолчанию https://app.1-chat.ru/api
`

async function readCursor(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const value = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function writeCursor(file, cursor) {
  await mkdir(dirname(resolve(file)), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, String(cursor))
  // Переименование атомарно: обрыв в момент записи не оставит обрезанный
  // файл, из-за которого мы начали бы весь журнал заново.
  await rename(tmp, file)
}

function runCommand(command, event) {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
    child.stdin.write(JSON.stringify(event))
    child.stdin.end()
    // Падение агента не должно ронять наблюдателя: следующее сообщение
    // придёт и должно быть обработано.
    child.on('close', () => done())
    child.on('error', () => done())
  })
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (!env.ONECHAT_API_KEY) {
    process.stderr.write('Не задан ONECHAT_API_KEY. Выпустите ключ на странице «API-ключи».\n')
    return 1
  }
  if (!args.exec) {
    process.stderr.write('Не задан --exec: нечего запускать на входящее сообщение.\n')
    return 1
  }

  const log = args.quiet
    ? () => {}
    : (message, meta) =>
        process.stderr.write(
          `${new Date().toISOString()} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`,
        )

  const client = new OneChatClient({
    apiKey: env.ONECHAT_API_KEY,
    baseUrl: env.ONECHAT_BASE_URL,
    log,
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('останавливаюсь')
      client.stop()
    })
  }

  const saved = await readCursor(args.state)
  const since = saved ?? (args.from === 'begin' ? 0 : null)

  try {
    await client.run({
      since,
      onCursor: (cursor) => writeCursor(args.state, cursor),
      onEvent: async (event) => {
        if (!isIncomingMessage(event, { dialogs: args.dialogs })) return
        log('входящее сообщение', { dialog: event.dialog_id })
        await runCommand(args.exec, event)
      },
    })
  } catch (error) {
    // Ожидаемые отказы объясняем словами. Стектрейс здесь бесполезен:
    // чинить их будет человек, у которого не тот ключ или не тот адрес,
    // а не тот, кто писал этот код.
    if (error instanceof AuthError || error instanceof UnsupportedServerError) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
  return 0
}

// Запускаем без проверки «вызван ли файл напрямую». Такая проверка
// сравнивает путь модуля с argv[1], а npm ставит команду через символическую
// ссылку — пути не совпадают, и программа молча ничего не делает. Этот файл
// объявлен точкой входа и больше ниоткуда не импортируется, так что условие
// было лишним и стоило работоспособности при установке.
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exit(1)
  })
