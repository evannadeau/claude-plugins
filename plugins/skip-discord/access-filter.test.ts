import { test, expect } from 'bun:test'
import { isOwnMessage, shouldDropBot, senderPassesGroupGate } from './access-filter'

test('isOwnMessage: true only when author equals self', () => {
  expect(isOwnMessage('123', '123')).toBe(true)
  expect(isOwnMessage('123', '456')).toBe(false)
  expect(isOwnMessage('123', undefined)).toBe(false)
})

test('shouldDropBot: drops untrusted bots, keeps humans and trusted bots', () => {
  expect(shouldDropBot(false, '111', [])).toBe(false)       // human → keep
  expect(shouldDropBot(true, '111', [])).toBe(true)         // untrusted bot → drop
  expect(shouldDropBot(true, '111', ['111'])).toBe(false)   // trusted bot → keep
  expect(shouldDropBot(true, '222', ['111'])).toBe(true)    // other bot → drop
})

test('senderPassesGroupGate: trusted bot bypasses, empty allowFrom is open', () => {
  expect(senderPassesGroupGate('999', [], [])).toBe(true)            // open channel
  expect(senderPassesGroupGate('999', ['111'], [])).toBe(false)      // not allowlisted
  expect(senderPassesGroupGate('111', ['111'], [])).toBe(true)       // allowlisted human
  expect(senderPassesGroupGate('bot1', ['111'], ['bot1'])).toBe(true) // trusted bot bypass
})
