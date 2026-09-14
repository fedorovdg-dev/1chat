import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runAgentProcess, sanitizeEnv } from '../src/runner.js'
import { until } from './helpers.js'

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
const command = `"${process.execPath}" "${AGENT}"`

async function outFile() {
  return join(await mkdtemp(join(tmpdir(), '1chat-runner-')), 'out.json')
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('успешное завершение и контракт в stdin', async () => {
  const out = await outFile()
  const run = runAgentProcess({
    command,
    input: { contract: '1chat.agent.run/v1', messages: [{ text: 'привет «с кавычками» $(rm -rf /)' }] },
    env: { ...process.env, FAKE_OUT: out },
    timeoutMs: 10_000,
  })
  assert.deepEqual(await run.promise, { kind: 'exit', code: 0, signal: null })
  const seen = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(seen.input.messages[0].text, 'привет «с кавычками» $(rm -rf /)')
})

test('ненулевой код — это не успех', async () => {
  const run = runAgentProcess({ command, input: {}, env: { ...process.env, FAKE_MODE: 'fail' }, timeoutMs: 10_000 })
  const outcome = await run.promise
  assert.equal(outcome.kind, 'exit')
  assert.equal(outcome.code, 3)
})

test('несуществующая команда — отказ запуска', async () => {
  const run = runAgentProcess({ command: 'definitely-not-a-command-1chat', input: {}, env: process.env, timeoutMs: 10_000 })
  const outcome = await run.promise
  assert.equal(outcome.kind, 'spawn_error')
})

test('зависший агент убивается по таймауту вместе с дочерними процессами', async () => {
  const out = await outFile()
  const run = runAgentProcess({
    command,
    input: {},
    env: { ...process.env, FAKE_MODE: 'hang-with-child', FAKE_OUT: out },
    timeoutMs: 500,
    killGraceMs: 300,
  })
  await until(async () => {
    try {
      await readFile(`${out}.child`, 'utf8')
      return true
    } catch {
      return false
    }
  })
  const grandchild = Number(await readFile(`${out}.child`, 'utf8'))
  const outcome = await run.promise
  assert.equal(outcome.kind, 'timeout')
  // SIGTERM проигнорирован — сработал SIGKILL по всей группе.
  await until(() => !alive(grandchild), { message: 'внук пережил таймаут' })
})

test('ключ 1-chat не попадает в окружение агента', async () => {
  const key = 'sk_1chat_rw_0123456789abcdef'
  const env = sanitizeEnv({ PATH: '/bin', ONECHAT_API_KEY: key, COPY: `Bearer ${key}`, SAFE: 'ok' }, { apiKey: key })
  assert.deepEqual(env, { PATH: '/bin', SAFE: 'ok' })

  const out = await outFile()
  const run = runAgentProcess({ command, input: {}, env: { ...env, FAKE_OUT: out }, timeoutMs: 10_000 })
  await run.promise
  const seen = JSON.parse(await readFile(out, 'utf8'))
  assert.ok(!JSON.stringify(seen.env).includes(key))
})

test('после таймаута добивается вся группа, даже если шелл умер первым', async () => {
  const out = await outFile()
  // «true; …» не даёт шеллу заменить себя командой: так ведёт себя dash на
  // Ubuntu. Шелл умирает от SIGTERM сразу, агент SIGTERM игнорирует — и
  // раньше отложенный SIGKILL отменялся вместе с завершением шелла.
  const run = runAgentProcess({
    command: `true; ${command}`,
    input: {},
    env: { ...process.env, FAKE_MODE: 'hang', FAKE_OUT: out },
    timeoutMs: 500,
    killGraceMs: 300,
  })
  await until(async () => readFile(out, 'utf8').then(() => true, () => false))
  const agentPid = JSON.parse(await readFile(out, 'utf8')).pid
  const outcome = await run.promise
  assert.equal(outcome.kind, 'timeout')
  await until(() => !alive(agentPid), { message: 'агент пережил таймаут' })
})

test('процессы, оставленные агентом после выхода, не переживают запуск', async () => {
  const out = await outFile()
  const run = runAgentProcess({
    command,
    input: {},
    env: { ...process.env, FAKE_MODE: 'orphan', FAKE_OUT: out },
    timeoutMs: 10_000,
    killGraceMs: 300,
  })
  const outcome = await run.promise
  assert.deepEqual(outcome, { kind: 'exit', code: 0, signal: null })
  const orphan = Number(await readFile(`${out}.child`, 'utf8'))
  await until(() => !alive(orphan), { message: 'осиротевший процесс остался жить' })
})
