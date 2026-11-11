import { strict as assert } from 'node:assert'
import test from 'node:test'
import { liveAgent, sessionEvents } from '../src/inbox.ts'

test('a log read uses the stored session and does not resume an agent', async () => {
  let resumed = 0
  let closed = 0
  const ctx = {
    agents: {
      get() {
        return undefined
      },
      resume() {
        resumed += 1
      },
    },
    sessionPersistence: {
      async open(id: any, access: any) {
        assert.equal(id, 'worker-1')
        assert.equal(access, 'read')
        return {
          async read() {
            return { events: [{ type: 'user/message', seq: 1, data: { id: 'm1' } }] }
          },
          async close() {
            closed += 1
          },
        }
      },
    },
  }
  const events = await sessionEvents(ctx, 'worker-1')
  assert.equal(events.length, 1)
  assert.equal(events[0].seq, 1)
  assert.equal(resumed, 0)
  assert.equal(closed, 1)
})

test('an already entered agent is read in place', async () => {
  let opened = 0
  const ctx = {
    agents: {
      get(id: any) {
        assert.equal(id, 'session-a')
        return { session: { snapshotEvents: () => [{ type: 'turn/end', seq: 4 }] } }
      },
    },
    sessionPersistence: {
      async open() {
        opened += 1
      },
    },
  }
  const events = await sessionEvents(ctx, 'session-a')
  assert.deepEqual(events, [{ type: 'turn/end', seq: 4 }])
  assert.equal(opened, 0)
  assert.equal(liveAgent(ctx, 'session-a')?.session.snapshotEvents().length, 1)
})

test('a missing stored session is an empty log', async () => {
  const missing = new Error('missing')
  missing.name = 'SessionPersistenceNotFoundError'
  const ctx = {
    agents: {
      get() {
        return undefined
      },
    },
    sessionPersistence: {
      async open() {
        throw missing
      },
    },
  }
  assert.deepEqual(await sessionEvents(ctx, 'session-gone'), [])
})
