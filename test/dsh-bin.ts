import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function nodeBin(): string {
  if (process.env.DSH_NODE) return process.env.DSH_NODE
  const pinned = join(homedir(), '.nvm/versions/node/v24.22.2/bin/node')
  if (existsSync(pinned)) return pinned
  return process.execPath
}

/** Resolve the pinned @deepseek-ai/dsh launcher. CI sets DSH_BIN. */
export function dshBin(root: string): string {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const candidates = [
    '/tmp/dsh-probe/node_modules/@deepseek-ai/dsh/lib/bin.js',
    join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(root, '../../node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  return candidates.find(path => existsSync(path)) ?? ''
}
