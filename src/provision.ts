import { createHash } from 'node:crypto'
import { toolError, type ToolPayload } from './errors.ts'
import { toolDefinitions } from './tools.ts'

/**
 * Bind a new session to the current persona, and optionally record one fact.
 * An empty persona text keeps the latest confirmed SOUL. Facts are not copied
 * from another session. The model cannot call this.
 * @param {import('./engine.js').Engine} engine
 * @param {{ sessionId?: unknown, personaText?: unknown, fact?: unknown, idempotencyKey?: unknown }} input
 */
export async function provisionSession(
  engine: import('./engine.ts').Engine,
  input: { sessionId?: unknown; personaText?: unknown; fact?: unknown; idempotencyKey?: unknown },
): Promise<ToolPayload> {
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    return toolError('VALIDATION', 'sessionId is required.')
  }
  const sessionId = input.sessionId.trim()
  if (!engine.isBot(sessionId)) return toolError('FORBIDDEN', 'Only a bot session can apply a persona.')
  const personaText = typeof input.personaText === 'string' ? input.personaText.trim() : ''
  if (personaText !== '') {
    const persona = engine.confirmPersona(personaText)
    engine.bindPersona(sessionId, persona.id)
  } else {
    engine.ensureSession(sessionId)
    if (engine.binding(sessionId).persona_version_id == null && engine.latestPersona()) {
      engine.bindPersona(sessionId, engine.latestPersona().id)
    }
  }
  const factText = typeof input.fact === 'string' ? input.fact.trim() : ''
  if (factText === '') return { ok: true, sessionId, fact: null }
  const key =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() !== ''
      ? input.idempotencyKey.trim()
      : `provision:${sessionId}:${createHash('sha256').update(factText).digest('hex').slice(0, 16)}`
  const remember = toolDefinitions(engine).find(item => item.name === 'foundations_remember')
  if (!remember) throw new Error('foundations_remember is unavailable.')
  const fact = await remember.execute(
    {
      target: 'fact',
      content: factText,
      idempotencyKey: key,
    },
    { agent: { id: sessionId } },
  )
  if (fact?.ok === false) return fact
  return { ok: true, sessionId, fact }
}
