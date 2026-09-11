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
