import assert from 'node:assert/strict'
import test from 'node:test'
import { botFields, composeBotPersona, composePersona, localRunAt, setupSteps, splitPersona } from './foundations.ts'

const empty = {
  name: '',
  personaText: '',
  fact: '',
  targetSessionId: '',
  message: '',
  runAt: '',
  timerNote: '',
}

test('a new session always binds a persona and skips blank optional steps', () => {
  assert.deepEqual(setupSteps(empty), ['persona'])
  assert.deepEqual(setupSteps({ ...empty, fact: ' The user is called Ada ' }), ['persona', 'fact'])
  assert.deepEqual(setupSteps({ ...empty, targetSessionId: 'session-b', message: 'just this line' }), [
    'persona',
    'message',
  ])
  assert.deepEqual(setupSteps({ ...empty, message: 'no target' }), ['persona'])
  assert.deepEqual(setupSteps({ ...empty, runAt: '2026-11-08T17:20' }), ['persona', 'timer'])
})

test('the assistant name is stored as its own persona line', () => {
  assert.equal(composePersona('Scout', 'Keep it short.'), 'Name: Scout\n\nKeep it short.')
  assert.deepEqual(splitPersona('Name: Scout\n\nKeep it short.'), { name: 'Scout', body: 'Keep it short.' })
  assert.deepEqual(splitPersona('名字：Scout\n\nKeep it short.'), { name: 'Scout', body: 'Keep it short.' })
  assert.equal(composePersona('', 'Keep it short.'), 'Keep it short.')
  assert.equal(composePersona('Scout', '名字：Old\n\nKeep it short.'), 'Name: Scout\n\nKeep it short.')
})

test('a bot persona keeps name, style, and task on their own lines', () => {
  const text = composeBotPersona('Scout', 'brief', 'shorten the line')
  assert.equal(text, 'Name: Scout\n\nStyle: brief\n\nTask: shorten the line')
  assert.deepEqual(botFields(text), { name: 'Scout', style: 'brief', task: 'shorten the line' })
  assert.deepEqual(botFields('名字：Scout\n\n风格：brief\n\n任务：shorten the line'), {
    name: 'Scout',
    style: 'brief',
    task: 'shorten the line',
  })
  assert.equal(composeBotPersona('Scout', '', ''), 'Name: Scout')
})

test('a local clock value becomes an absolute instant', () => {
  const iso = localRunAt('2026-11-08T17:20')
  assert.equal(Number.isNaN(Date.parse(iso)), false)
  assert.equal(new Date(iso).getTime(), new Date('2026-11-08T17:20').getTime())
  assert.equal(localRunAt('not-a-time'), '')
})
