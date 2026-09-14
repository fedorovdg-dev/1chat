// Поддельный hermes: записывает argv, stdin и нужные переменные, выходит с FAKE_HERMES_EXIT.
import { writeFileSync } from 'node:fs'
let input = ''
for await (const chunk of process.stdin) input += chunk
writeFileSync(process.env.FAKE_HERMES_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  stdin: input,
  mcpUrl: process.env.ONECHAT_MCP_URL,
  mcpToken: process.env.ONECHAT_MCP_TOKEN,
  apiKey: process.env.ONECHAT_API_KEY ?? null,
}))
process.exit(Number(process.env.FAKE_HERMES_EXIT ?? 0))
