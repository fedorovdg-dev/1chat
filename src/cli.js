#!/usr/bin/env node
/**
 * Запуск одной командой.
 *
 *     npx @1chat/agent --agent "node bridge.mjs"
 *
 * Ключ берётся из ONECHAT_API_KEY. Всё, что должно пережить перезапуск —
 * позиция в ленте, необработанные сообщения, запуски и действия, — лежит в
 * SQLite (по умолчанию .state/agent.db).
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import { createAgentService } from './agent.js'
import { AuthError, OneChatClient, UnsupportedServerError, isIncomingMessage } from './client.js'
import { compactEvent } from './compact.js'
import { DEFAULTS } from './dispatcher.js'
import { DEFAULT_PORT, listenLocal, loadOrCreateToken, serveMcp } from './mcp-proxy.js'
import { SqliteUnavailableError, Store } from './store.js'

const DEFAULT_BASE_URL = 'https://app.1-chat.ru/api'

const NUMBER_FLAGS = {
  '--quiet-ms': 'quietMs',
  '--max-wait-ms': 'maxWaitMs',
  '--concurrency': 'concurrency',
  '--run-timeout-ms': 'runTimeoutMs',
  '--max-attempts': 'maxAttempts',
  '--mcp-port': 'mcpPort',
}

function parseArgs(argv) {
  const args = {
    agent: null,
    exec: null,
    state: '.state/cursor',
    db: '.state/agent.db',
    dialogs: null,
    from: 'now',
    quiet: false,
    serveMcp: null,
    mcpPort: DEFAULT_PORT,
    settings: {},
    errors: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--agent') args.agent = argv[++i]
    else if (arg === '--exec') args.exec = argv[++i]
    else if (arg === '--state') args.state = argv[++i]
    else if (arg === '--db') args.db = argv[++i]
    else if (arg === '--dialogs') args.dialogs = argv[++i].split(',').map((d) => d.trim())
    else if (arg === '--from') args.from = argv[++i]
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--serve-mcp') {
      // Порт необязателен: «--serve-mcp --exec ...» не должен съесть команду.
      const next = argv[i + 1]
      args.serveMcp = next && /^\d+$/.test(next) ? Number(argv[++i]) : DEFAULT_PORT
    } else if (Object.hasOwn(NUMBER_FLAGS, arg)) {
      const raw = argv[++i]
      const value = Number(raw)
      if (raw === undefined || !Number.isInteger(value) || value < 0) {
        args.errors.push(`${arg} ждёт целое неотрицательное число`)
      } else if (arg === '--mcp-port') args.mcpPort = value
      else args.settings[NUMBER_FLAGS[arg]] = value
    } else if (arg === '--help' || arg === '-h') args.help = true
    else args.errors.push(`Неизвестный параметр ${arg}`)
  }
  for (const [name, key] of [
    ['--concurrency', 'concurrency'],
    ['--max-attempts', 'maxAttempts'],
    ['--run-timeout-ms', 'runTimeoutMs'],
  ]) {
    if (args.settings[key] === 0) args.errors.push(`${name} должен быть больше нуля`)
  }
  return args
}

const HELP = `
Будит вашего агента, когда в 1-chat приходит сообщение, и не даёт ему
отправить устаревший ответ.

  export ONECHAT_API_KEY=sk_1chat_rw_...
  npx @1chat/agent --agent "node bridge.mjs"

Режим --agent (рекомендуемый):
  --agent <команда>     что запускать на пачку входящих. Контракт запуска
                        (JSON) приходит в stdin, пароль локального MCP —
                        в ONECHAT_MCP_TOKEN, адрес — в ONECHAT_MCP_URL.
                        Ключ 1-chat агенту не передаётся.
  --quiet-ms <мс>       пауза после последнего входящего (${DEFAULTS.quietMs})
  --max-wait-ms <мс>    максимум от первого сообщения пачки (${DEFAULTS.maxWaitMs})
  --concurrency <n>     сколько запусков одновременно (${DEFAULTS.concurrency})
  --run-timeout-ms <мс> предел одного запуска (${DEFAULTS.runTimeoutMs})
  --max-attempts <n>    попыток на пачку при ошибках (${DEFAULTS.maxAttempts})
  --mcp-port <порт>     порт локального MCP на 127.0.0.1 (${DEFAULT_PORT})
  --db <файл>           база состояния (.state/agent.db)

Общие:
  --dialogs <id,id>     реагировать только на эти диалоги
  --from now|begin      с чего начать при первом запуске (now)
  --state <файл>        курсор старого режима; в режиме --agent переносится
                        в базу один раз
  --quiet               только ошибки в лог

Старый режим (без защиты отправки):
  --exec <команда>      запуск на каждое входящее, без пачек и очереди
  --serve-mcp [порт]    простой локальный MCP с постоянным паролем

Переменные окружения:
  ONECHAT_API_KEY       обязательна
  ONECHAT_BASE_URL      по умолчанию ${DEFAULT_BASE_URL}
`

const IMPORTANT = /не удался|брошена|недоступен|ошибка|перезапуск/i

function makeLog(quiet) {
  return (message, meta) => {
    if (quiet && !IMPORTANT.test(message)) return
    process.stderr.write(`${new Date().toISOString()} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
  }
}

// ── старый режим ────────────────────────────────────────────────────

async function readCursor(file) {
  try {
    const value = Number.parseInt((await readFile(file, 'utf8')).trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function writeCursor(file, cursor) {
  await mkdir(dirname(resolve(file)), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, String(cursor))
  // Переименование атомарно: обрыв в момент записи не оставит обрезанный файл.
  await rename(tmp, file)
}

function runCommand(command, event) {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(compactEvent(event)))
    // Падение агента не должно ронять наблюдателя.
    child.on('close', () => done())
    child.on('error', () => done())
  })
}

async function legacyMain(args, env, log) {
  if (args.exec) {
    process.stderr.write(
      'ВНИМАНИЕ: старый режим --exec. Сообщения не собираются в пачки, и агент может ' +
        'отправить устаревший ответ. Используйте --agent — см. README, раздел «Переход».\n',
    )
  }
  const baseUrl = env.ONECHAT_BASE_URL ?? DEFAULT_BASE_URL
  const client = new OneChatClient({ apiKey: env.ONECHAT_API_KEY, baseUrl, log })

  let mcp = null
  if (args.serveMcp !== null) {
    const tokenFile = `${args.state}.mcp-token`
    const token = await loadOrCreateToken(tokenFile, { readFile, writeFile, mkdir })
    try {
      mcp = await serveMcp({ apiKey: env.ONECHAT_API_KEY, baseUrl, port: args.serveMcp, token, log })
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    process.stdout.write(
      `\nMCP поднят. В конфиг агента:\n\n` +
        `mcp_servers:\n  1chat:\n    url: "${mcp.url}"\n    headers:\n      Authorization: "Bearer ${mcp.token}"\n\n` +
        `Пароль постоянный и лежит в ${tokenFile}: перезапуск его не меняет.\n` +
        `Ключ 1-chat агенту не нужен — его подставляет эта служба.\n` +
        `Отправки в этом режиме не защищены от устаревшего контекста.\n\n`,
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('останавливаюсь')
      client.stop()
      mcp?.close()
    })
  }

  if (!args.exec) {
    // Только MCP: держим процесс живым, наблюдать не за чем.
    await new Promise(() => {})
    return 0
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
  } finally {
    await mcp?.close()
  }
  return 0
}

// ── режим --agent ──────────────────────────────────────────────────

async function agentMain(args, env, log) {
  const baseUrl = env.ONECHAT_BASE_URL ?? DEFAULT_BASE_URL

  const store = new Store(args.db)
  const migrated = store.migrateCursorFile(args.state)
  if (migrated !== null) log('курсор старого режима перенесён в базу', { cursor: migrated, from: args.state })

  const readToken = await loadOrCreateToken(`${args.db}.read-token`, { readFile, writeFile, mkdir })

  const service = createAgentService({
    store,
    apiKey: env.ONECHAT_API_KEY,
    baseUrl,
    command: args.agent,
    env,
    settings: args.settings,
    readToken,
    mcpUrl: null,
    log,
  })

  let server
  try {
    server = await listenLocal(service.proxy, args.mcpPort)
  } catch (error) {
    store.close()
    process.stderr.write(`${error.message}\n`)
    return 1
  }
  service.mcpUrl = server.url

  const s = service.settings
  process.stdout.write(
    `\nСлужба агента запущена.\n` +
      `  MCP:        ${server.url} (только 127.0.0.1)\n` +
      `  пачки:      пауза ${s.quietMs} мс, максимум ${s.maxWaitMs} мс\n` +
      `  запуски:    до ${s.concurrency} одновременно, предел ${s.runTimeoutMs} мс, попыток ${s.maxAttempts}\n` +
      `  состояние:  ${args.db}\n\n` +
      `Агент получает пароль запуска в ONECHAT_MCP_TOKEN — только с ним проходят изменяющие действия.\n` +
      `Пароль только на чтение (для сессий вне запусков) лежит в ${args.db}.read-token.\n\n`,
  )

  // Восстановление — после того, как MCP слушает: оно может сразу начать запуск.
  service.recover()

  const client = new OneChatClient({ apiKey: env.ONECHAT_API_KEY, baseUrl, log })

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    log('останавливаюсь', { signal })
    client.stop()
    await service.dispatcher.stop()
    await server.close()
    store.close()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal))

  const saved = store.getCursor()
  const since = saved ?? (args.from === 'begin' ? 0 : null)
  try {
    await client.run({ since, onPage: (page) => service.ingest(page, { dialogs: args.dialogs }) })
  } finally {
    if (!stopping) {
      stopping = true
      await service.dispatcher.stop()
      await server.close()
      store.close()
    }
  }
  return 0
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.errors.length) {
    process.stderr.write(`${args.errors.join('\n')}\n\nСм. --help\n`)
    return 1
  }
  if (!env.ONECHAT_API_KEY) {
    process.stderr.write('Не задан ONECHAT_API_KEY. Выпустите ключ на странице «API-ключи».\n')
    return 1
  }
  if (args.agent && (args.exec || args.serveMcp !== null)) {
    process.stderr.write(
      '--agent нельзя сочетать с --exec и --serve-mcp: в режиме --agent защищённый MCP ' +
        'поднимается всегда, порт задаётся через --mcp-port.\n',
    )
    return 1
  }
  if (!args.agent && !args.exec && args.serveMcp === null) {
    process.stderr.write('Нечего делать: задайте --agent (или старые --exec / --serve-mcp).\n')
    return 1
  }

  const log = makeLog(args.quiet)
  try {
    return args.agent ? await agentMain(args, env, log) : await legacyMain(args, env, log)
  } catch (error) {
    // Ожидаемые отказы объясняем словами. Стектрейс здесь бесполезен:
    // чинить их будет человек, у которого не тот ключ, не тот адрес или не
    // та версия Node, а не тот, кто писал этот код.
    if (error instanceof AuthError || error instanceof UnsupportedServerError || error instanceof SqliteUnavailableError) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
}

// Запускаем без проверки «вызван ли файл напрямую». Такая проверка
// сравнивает путь модуля с argv[1], а npm ставит команду через символическую
// ссылку — пути не совпадают, и программа молча ничего не делает.
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exit(1)
  })
