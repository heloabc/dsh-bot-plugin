/**
 * File tools for a worker. Plugin-created agents do not inherit the web preset,
 * so their request header otherwise lists only host tools.
 * This preset is tool-fs only: read, write, and edit. It does not add bash,
 * and it does not change the sandbox mode or add writable roots.
 * The session cwd copied at create remains the workspace-write boundary.
 */

export const WORKER_FILE_PRESET = 'foundations-files'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function presetsOf(ctx: import('./host.ts').HostContext) {
  try {
    if (typeof ctx.get === 'function') return ctx.get('agentPresets') ?? null
  } catch {
    /* preset service is optional until a worker is created */
  }
  try {
    return ctx.agentPresets ?? null
  } catch {
    return null
  }
}

/**
 * Register the worker file preset once per process. A duplicate from a reload
 * is the same preset and is not an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function ensureWorkerFilePreset(ctx: import('./host.ts').HostContext) {
  const presets = presetsOf(ctx)
  if (!presets?.register || !presets?.mount) return Promise.resolve(null)
  return presets
    .register({
      id: WORKER_FILE_PRESET,
      plugins: [
        {
          id: 'tool-fs',
          name: '@deepseek-ai/dsh-tool-fs',
          config: { applyPatch: false, readImage: false },
        },
      ],
    })
    .then(() => WORKER_FILE_PRESET)
    .catch((error: any) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Duplicate')) return WORKER_FILE_PRESET
      throw error
    })
}

/**
 * Bind the file preset before the agent is published. Resume uses the id
 * recorded on the session header, because select() refuses a session that
 * has already started a turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string | null} presetId
 */
export function workerFileSetup(ctx: import('./host.ts').HostContext, presetId: string | null) {
  return async (agentCtx: any, agent: any) => {
    const presets = presetsOf(ctx)
    if (!presets?.mount) return
    const recorded =
      agent?.session && typeof presets.presetForSession === 'function' ? presets.presetForSession(agent.session) : null
    const id = presetId || recorded || presets.defaultId
    if (!id) return
    const resolved = typeof presets.resolve === 'function' ? await presets.resolve(id) : { id }
    if (resolved?.broken) throw new Error(`worker file-tool preset is unavailable: ${resolved.broken}`)
    await presets.mount(agentCtx, resolved?.id ?? id)
  }
}
