// Поддельный агент для тестов запуска. Поведение — из FAKE_MODE.
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

let input = ''
for await (const chunk of process.stdin) input += chunk
const out = process.env.FAKE_OUT
const mode = process.env.FAKE_MODE ?? 'ok'

if (out) {
  writeFileSync(out, JSON.stringify({ input: JSON.parse(input), env: process.env, pid: process.pid }))
}

if (mode === 'fail') process.exit(3)
if (mode === 'orphan') {
  // Фоновый процесс, упрямый к SIGTERM, держит унаследованный stdout.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['ignore', 'inherit', 'inherit'] })
  writeFileSync(`${out}.child`, String(child.pid))
  child.unref()
  process.exit(0)
}
if (mode === 'hang' || mode === 'hang-with-child') {
  if (mode === 'hang-with-child') {
    // Внук, как у bridge, запускающего агента: должен умереть вместе с группой.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(`${out}.child`, String(child.pid))
  }
  process.on('SIGTERM', () => {}) // упрямый: SIGTERM игнорирует
  setInterval(() => {}, 1000)
}
