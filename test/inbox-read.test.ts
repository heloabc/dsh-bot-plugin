import { strict as assert } from 'node:assert'
import test from 'node:test'
import { liveAgent, sessionEvents } from '../src/inbox.ts'

function queryCtx(events: unknown[] | null, options: { resumed?: { count: number } } = {}) {
  const resumed = options.resumed ?? { count: 0 }
  return {
    agents: {
      get(_id?: string) {
        return undefined as any
      },
      resume() {
        resumed.count += 1
      },
    },
    sessionQuery: {
      async observeSession(id: string) {
        if (events == null) {
          const error = new Error('missing')
          error.name = 'SessionNotFoundError'
          throw error
        }
        return {
          events,
          cursor: Array.isArray(events) && events.length ? (events[events.length - 1] as { seq: number }).seq : -1,
          [Symbol.dispose]() {},
        }
      },
    },
    resumed,
  }
}

test('a log read uses sessionQuery and does not resume an agent', async () => {
  const ctx = queryCtx([{ type: 'user/message', seq: 1, time: 1, data: { id: 'm1' } }])
  const events = await sessionEvents(ctx, 'worker-1')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.seq, 1)
  assert.equal(ctx.resumed.count, 0)
})

test('an already entered agent is still read through sessionQuery', async () => {
  const ctx = queryCtx([{ type: 'turn/end', seq: 4, time: 4, data: {} }])
  ctx.agents.get = () => ({ session: { snapshotEvents: () => [{ type: 'ignored' }] } })
  const events = await sessionEvents(ctx, 'session-a')
  assert.deepEqual(
    events.map(event => event.seq),
    [4],
  )
  assert.equal(ctx.resumed.count, 0)
  assert.equal(liveAgent(ctx, 'session-a')?.session.snapshotEvents().length, 1)
})

test('a missing stored session is an empty log', async () => {
  const ctx = queryCtx(null)
  assert.deepEqual(await sessionEvents(ctx, 'session-gone'), [])
})
