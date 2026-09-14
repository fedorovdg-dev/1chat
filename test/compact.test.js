import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BINARY_PLACEHOLDER,
  compactConversation,
  compactEvent,
  compactMessage,
  compactToolResult,
  compactToolsList,
  compactToolText,
  isBinaryString,
  scrub,
} from '../src/compact.js'

const AVATAR = `data:image/jpeg;base64,${'/9j/4AAQSkZJRg'.repeat(900)}`

// Форма — как у реального ответа стейджа, данные вымышленные.
const conversation = {
  id: 'c1',
  tenant_id: 't1',
  channel: 'telegram_client',
  integration_account_id: 'acc1',
  external_conversation_id: '342327929',
  provider_conversation_kind: 'private',
  title: 'Иван',
  participant: { display_name: 'Иван', username: 'ivan', avatar_url: AVATAR, external_user_id: '342327929' },
  avatar_url: AVATAR,
  last_message: {
    id: 'm1', text: 'Привет', direction: 'inbound', is_own: false, sender_user_id: null,
    sender_name: 'Иван', sent_at: '2026-09-14T08:00:00Z', created_at: '2026-09-14T08:00:01Z', attachment: null,
  },
  unread_count: 1,
  updated_at: '2026-09-14T08:00:02Z',
  last_message_at: '2026-09-14T08:00:00Z',
  created_at: '2026-05-01T00:00:00Z',
  metadata: { internal: true },
}

const message = {
  id: 'm2', tenant_id: 't1', conversation_id: 'c1', conversation_seq: 44, direction: 'outbound',
  channel: 'telegram_client', external_message_id: '289005239:2195', client_id: 'cid',
  sender_participant_id: null, sender_user_id: 'u1', sender_name: 'Оператор', text: 'Ответ',
  is_own: true, status: 'delivered', sent_at: '2026-09-13T12:39:57Z', received_at: null,
  created_at: '2026-09-13T12:39:56Z', edited_at: null, deleted_at: null, metadata: null,
  attachments: [{ id: 'a1', kind: 'image', name: 'photo.jpg', mime_type: 'image/jpeg', size: 1024, url: AVATAR }],
  reactions: [],
}

test('base64 и data: распознаются, обычный текст — нет', () => {
  assert.equal(isBinaryString(AVATAR), true)
  assert.equal(isBinaryString('A'.repeat(300)), true)
  assert.equal(isBinaryString('Обычное длинное сообщение '.repeat(30)), false)
  assert.equal(isBinaryString('https://app.1-chat.ru/api/v1/attachments/a1'), false)
})

test('диалог: без аватарок и служебных полей, нужное для вызовов осталось', () => {
  const out = compactConversation(conversation)
  const text = JSON.stringify(out)
  assert.ok(!text.includes('base64'))
  assert.ok(!('tenant_id' in out) && !('metadata' in out) && !('avatar_url' in out))
  assert.equal(out.id, 'c1')
  assert.equal(out.integration_account_id, 'acc1')
  assert.deepEqual(out.participant, { display_name: 'Иван', username: 'ivan', external_user_id: '342327929' })
  assert.equal(out.last_message.text, 'Привет')
  assert.ok(text.length < JSON.stringify(conversation).length / 20)
})

test('сообщение: одно время, client_id сохранён, вложение помечено, а не выброшено', () => {
  const out = compactMessage(message)
  assert.equal(out.at, '2026-09-13T12:39:57Z')
  assert.equal(out.client_id, 'cid')
  assert.equal(out.attachments[0].url, BINARY_PLACEHOLDER)
  assert.equal(out.attachments[0].name, 'photo.jpg')
  for (const dropped of ['tenant_id', 'external_message_id', 'sender_participant_id', 'received_at', 'reactions', 'metadata']) {
    assert.ok(!(dropped in out), dropped)
  }
})

test('событие ленты: dialog:updated без аватарок', () => {
  const out = compactEvent({ type: 'dialog:updated', dialog_id: 'c1', channel_id: 'telegram_client', seq: 7, payload: conversation })
  assert.equal(out.seq, 7)
  assert.ok(!JSON.stringify(out).includes('base64'))
})

test('неизвестный инструмент и неизвестные поля проходят через страховку', () => {
  const text = compactToolText('future_tool', JSON.stringify({ tenant_id: 't', picture: AVATAR, nested: [{ avatar_url: 'x', ok: 1, empty: null }] }))
  assert.deepEqual(JSON.parse(text), { picture: BINARY_PLACEHOLDER, nested: [{ ok: 1 }] })
})

test('текст ошибки не JSON — показывается модели дословно', () => {
  assert.equal(compactToolText('send_message', 'Ключ выдан только на чтение'), 'Ключ выдан только на чтение')
})

test('structuredContent убирается, outputSchema — тоже', () => {
  const result = compactToolResult('get_conversation', {
    jsonrpc: '2.0', id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(conversation) }], structuredContent: { result: JSON.stringify(conversation) }, isError: false },
  })
  assert.equal(result.result.structuredContent, undefined)
  assert.equal(result.result.isError, false)
  const list = compactToolsList({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'x', inputSchema: {}, outputSchema: {} }] } })
  assert.deepEqual(list.result.tools, [{ name: 'x', inputSchema: {} }])
})

test('scrub не трогает числа, булевы и нули', () => {
  assert.deepEqual(scrub({ a: 0, b: false, c: '', d: [] }), { a: 0, b: false, c: '' })
})
