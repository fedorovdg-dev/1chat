/**
 * Локальный MCP для агента.
 *
 * Агент ходит сюда, а мы переправляем его вызовы в 1-chat, подставляя ключ.
 * Смысл не в удобстве: так ключ остаётся в одном месте — у этой службы — и
 * агент его не знает вовсе. Пока настроек было две, они разъезжались молча,
 * и «читает, но не отвечает» выглядело как поломка, а было опечаткой.
 *
 * Прослойка намеренно тупая: ничего не решает, ничего не кеширует, права
 * проверяет сервер. Список инструментов тоже приходит оттуда, поэтому новый
 * инструмент появляется у агента без обновления этого пакета.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'

/** Только петлевой адрес. Здесь не спрашивают ключ 1-chat, поэтому открыть
 *  этот порт в сеть — то же, что выложить ключ на запись. */
export const HOST = '127.0.0.1'

export const DEFAULT_PORT = 8765

/** Заголовки, которые имеет смысл передать наверх. Остальные — наши. */
const FORWARD_UP = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version']
const FORWARD_DOWN = ['content-type', 'mcp-session-id']

export function generateLocalToken() {
  return randomBytes(24).toString('hex')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * @param {object} options
 * @param {string} options.apiKey ключ 1-chat
 * @param {string} options.baseUrl
 * @param {string} options.token локальный пароль
 * @param {typeof fetch} [options.fetch]
 * @param {(msg: string, meta?: object) => void} [options.log]
 */
export function createMcpProxy({ apiKey, baseUrl, token, fetch: doFetch, log = () => {} }) {
  const upstream = `${baseUrl.replace(/\/$/, '')}/v1/mcp/`
  const call = doFetch ?? globalThis.fetch

  return async function handle(req, res) {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    // Петля пускает любой процесс на этой машине, в том числе чужого
    // пользователя. Пароль отделяет нашего агента от соседа по серверу.
    const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (provided !== token) {
      log('отклонён запрос без локального пароля')
      return reply(401, { error: 'Нужен локальный пароль. Он печатается при запуске службы.' })
    }

    if (req.method !== 'POST') {
      return reply(405, { error: 'Только POST' })
    }

    const body = await readBody(req)
    const headers = { Authorization: `Bearer ${apiKey}` }
    for (const name of FORWARD_UP) {
      if (req.headers[name]) headers[name] = req.headers[name]
    }

    let response
    try {
      response = await call(upstream, { method: 'POST', headers, body })
    } catch (error) {
      log('1-chat недоступен', { error: String(error) })
      return reply(502, { error: `1-chat недоступен: ${error}` })
    }

    const out = {}
    for (const name of FORWARD_DOWN) {
      const value = response.headers.get(name)
      if (value) out[name] = value
    }
    // Тело отдаём как есть: сервер отвечает потоком событий, и пересобирать
    // его здесь значило бы ломать то, что клиент умеет разбирать сам.
    const text = await response.text()
    res.writeHead(response.status, out)
    res.end(text)
  }
}

/**
 * Поднимает локальный MCP. Возвращает `{ port, token, close }`.
 *
 * Занятый порт — это ошибка с объяснением, а не молчаливый простой: иначе
 * агент будет получать отказ соединения и винить в этом себя.
 */
export function serveMcp({ apiKey, baseUrl, port = DEFAULT_PORT, token, log }) {
  const localToken = token ?? generateLocalToken()
  const server = createServer(createMcpProxy({ apiKey, baseUrl, token: localToken, log }))

  return new Promise((resolve, reject) => {
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Порт ${port} занят. Укажите другой через --serve-mcp <порт>.`))
        return
      }
      reject(error)
    })
    server.listen(port, HOST, () => {
      // Спрашиваем адрес у сокета, а не повторяем аргумент: при порте 0
      // его выбирает система, и запрошенное значение ничего не значит.
      const actual = server.address().port
      resolve({
        port: actual,
        token: localToken,
        url: `http://${HOST}:${actual}/mcp`,
        // close() сам по себе ждёт, пока отвалятся все открытые соединения,
        // а клиент MCP держит их живыми — служба не остановилась бы по
        // SIGTERM, пока агент не умрёт первым. Рвём их явно.
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(done)
          }),
      })
    })
  })
}

/**
 * Постоянный пароль рядом с позицией в потоке.
 *
 * Новый пароль на каждый запуск означал бы, что после перезапуска службы
 * конфиг агента протух и его надо править руками. Поэтому пароль создаётся
 * один раз и переживает перезапуск; файл доступен только владельцу.
 */
export async function loadOrCreateToken(file, { readFile, writeFile, mkdir }) {
  try {
    const saved = (await readFile(file, 'utf8')).trim()
    if (saved) return saved
  } catch {
    // файла нет — сейчас создадим
  }
  const token = generateLocalToken()
  await mkdir(dirname(resolve(file)), { recursive: true })
  await writeFile(file, token, { mode: 0o600 })
  return token
}
