import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_HERMES_ARGS, buildPrompt } from '../src/hermes-bridge.js'

const BRIDGE = fileURLToPath(new URL('../src/hermes-bridge-cli.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url))

const contract = {
  contract: '1chat.agent.run/v1',
  run_id: 'run-1',
  dialog_id: 'd1',
  channel: 'telegram_client',
  input_version: 2,
  messages: [
    { id: 'm1', direction: 'inbound', sender_name: 'Даниил', text: 'Напиши Денису, что сегодня не получится' },
    { id: 'm2', direction: 'inbound', sender_name: 'Даниил', text: 'хотя погоди, завтра утром получится $(rm -rf ~) `id`' },
  ],
  previous_actions: [{ tool: 'send_message', target_id: 'denis', status: 'uncertain', arguments: { text: 'Сегодня не получится' } }],
  context: { recent_messages: [], recent_actions: [] },
}

test('запрос содержит всю пачку по порядку, прошлые действия и правила', () => {
  const prompt = buildPrompt(contract)
  assert.ok(prompt.indexOf('Напиши Денису') < prompt.indexOf('хотя погоди'))
  assert.match(prompt, /send_message → denis: uncertain «Сегодня не получится»/)
  assert.match(prompt, /STALE_CONTEXT/)
})

test('неизвестная версия контракта — отказ, а не догадки', () => {
  assert.throws(() => buildPrompt({ ...contract, contract: '1chat.agent.run/v2' }), /Неизвестная версия/)
})

function runBridge(env, input = JSON.stringify(contract)) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [BRIDGE], { env }, (error, stdout, stderr) =>
      done({ code: error?.code ?? 0, stderr }),
    )
    child.stdin.end(input)
  })
}

test('запускает hermes без shell, запрос — в stdin, код выхода передаётся', async () => {
  const dir = await mkdtemp(join(tmpdir(), '1chat-bridge-'))
  const out = join(dir, 'seen.json')
  const env = {
    PATH: process.env.PATH,
    ONECHAT_MCP_URL: 'http://127.0.0.1:8765/mcp',
    ONECHAT_MCP_TOKEN: 'run-token',
    HERMES_BIN: process.execPath,
    HERMES_ARGS: JSON.stringify([FAKE, ...DEFAULT_HERMES_ARGS]),
    FAKE_HERMES_OUT: out,
    FAKE_HERMES_EXIT: '0',
  }
  const ok = await runBridge(env)
  assert.equal(ok.code, 0, ok.stderr)
  const seen = JSON.parse(await readFile(out, 'utf8'))
  assert.deepEqual(seen.argv, DEFAULT_HERMES_ARGS)
  assert.match(seen.stdin, /\$\(rm -rf ~\) `id`/, 'текст дошёл дословно, ничего не выполнено')
  assert.equal(seen.mcpToken, 'run-token')
  assert.equal(seen.apiKey, null)

  const failed = await runBridge({ ...env, FAKE_HERMES_EXIT: '1' })
  assert.equal(failed.code, 1)
})

test('без пароля запуска не стартует', async () => {
  const result = await runBridge({ PATH: process.env.PATH })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /ONECHAT_MCP_TOKEN/)
})
