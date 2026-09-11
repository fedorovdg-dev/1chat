import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

/**
 * Эти тесты запускают команду как процесс, а не импортируют её.
 *
 * Импорт проверяет, что код разбирается; запуск проверяет, что он вообще
 * что-то делает. Первый выпуск прошёл все проверки и при установке из npm
 * молчал: точка входа не срабатывала, потому что npm ставит команду через
 * символическую ссылку.
 */

test('--help печатает подсказку, а не молчит', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help'])
  assert.match(stdout, /--exec/)
  assert.ok(stdout.length > 100, 'подсказка должна быть содержательной')
})

test('без ключа объясняет, чего не хватает', async () => {
  const result = await run(process.execPath, [CLI, '--exec', 'true'], {
    env: { ...process.env, ONECHAT_API_KEY: '' },
  }).catch((e) => e)
  assert.match(result.stderr, /ONECHAT_API_KEY/)
  assert.equal(result.code, 1)
})

test('без --exec объясняет, чего не хватает', async () => {
  const result = await run(process.execPath, [CLI], {
    env: { ...process.env, ONECHAT_API_KEY: 'sk_1chat_ro_x' },
  }).catch((e) => e)
  assert.match(result.stderr, /--exec/)
  assert.equal(result.code, 1)
})

test('недоступный сервер — понятная ошибка, а не стектрейс', async () => {
  // Заведомо закрытый порт на локальной машине: тест проверяет наше
  // поведение, а не чужую сеть, и не должен зависеть от интернета.
  const result = await run(
    process.execPath,
    [CLI, '--exec', 'true', '--state', '/tmp/1chat-test-cursor'],
    {
      env: {
        ...process.env,
        ONECHAT_API_KEY: 'sk_1chat_ro_dead',
        ONECHAT_BASE_URL: 'http://127.0.0.1:9',
      },
    },
  ).catch((e) => e)
  assert.equal(result.code, 1)
  assert.ok(!result.stderr.includes('at OneChatClient'), 'человеку стектрейс не нужен')
})

test('--serve-mcp поднимает порт, который без пароля молчит', async (t) => {
  const { spawn } = await import('node:child_process')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), '1chat-cli-'))
  const child = spawn(
    process.execPath,
    [CLI, '--serve-mcp', '0', '--state', join(dir, 'cursor')],
    {
      env: {
        ...process.env,
        ONECHAT_API_KEY: 'sk_1chat_rw_x',
        // Несуществующий адрес: нам важно, что запрос ушёл наверх, а не то,
        // что кто-то на него ответил.
        ONECHAT_BASE_URL: 'http://127.0.0.1:1/api',
      },
    },
  )
  t.after(() => child.kill())

  // Ждём напечатанный конфиг — он же и есть то, что человек копирует.
  const config = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`не дождались конфига: ${out}`)), 15000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('Authorization')) {
        clearTimeout(timer)
        resolve(out)
      }
    })
    child.on('exit', (code) => reject(new Error(`процесс вышел с кодом ${code}: ${out}`)))
  })

  const url = config.match(/url: "(\S+)"/)[1]
  const token = config.match(/Bearer (\S+)"/)[1]
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

  const closed = await fetch(url, { method: 'POST', body: '{}' })
  assert.equal(closed.status, 401)

  const opened = await fetch(url, {
    method: 'POST',
    body: '{}',
    headers: { Authorization: `Bearer ${token}` },
  })
  // 502: пароль подошёл, запрос ушёл наверх и там никого нет. Это и требуется.
  assert.equal(opened.status, 502)
})
