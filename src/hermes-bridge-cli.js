#!/usr/bin/env node
/**
 *     npx @1chat/agent --agent "1chat-hermes-bridge"
 *
 * Контракт запуска — в stdin. См. hermes-bridge.js.
 */

import process from 'node:process'

import { runBridge } from './hermes-bridge.js'

let input = ''
for await (const chunk of process.stdin) input += chunk

runBridge({ input, env: process.env })
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exit(1)
  })
