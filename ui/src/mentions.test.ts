import assert from 'node:assert/strict'
import test from 'node:test'
import { filterMentions, insertMention, mentionQuery, mentionToken } from './mentions.ts'

const bots = [
  { sessionId: 'session-er', label: 'Ernie' },
  { sessionId: 'session-hi', label: 'Greeting' },
]

test('an @ after whitespace opens a query and a finished token does not', () => {
  assert.deepEqual(mentionQuery('ask @Er', 7), { start: 4, query: 'Er' })
  assert.equal(mentionQuery('ask@Er', 6), null)
  assert.equal(mentionQuery('@Ernie (session-er) ', 20), null)
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
})

test('choosing a bot replaces the query with its name and session id', () => {
  const next = insertMention('ask @E more', 6, 4, 'Ernie', 'session-er')
  assert.equal(next.text, 'ask @Ernie (session-er)  more')
  assert.equal(next.cursor, 'ask @Ernie (session-er) '.length)
  assert.equal(mentionToken('Greeting (old)', 'session-hi'), '@Greeting old (session-hi)')
})

test('the menu filters by the visible name', () => {
  assert.deepEqual(
    filterMentions(bots, 'ern').map(item => item.label),
    ['Ernie'],
  )
  assert.deepEqual(
    filterMentions(bots, 'gree').map(item => item.sessionId),
    ['session-hi'],
  )
  assert.equal(filterMentions(bots, '').length, 2)
})
