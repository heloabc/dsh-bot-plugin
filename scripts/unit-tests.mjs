import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function collect(dir) {
  return readdirSync(join(root, dir))
    .filter(name => name.endsWith('.test.ts') && !name.includes('host'))
    .map(name => join(dir, name))
}

const files = [...collect('test'), ...collect('ui/src')].sort()
if (files.length === 0) {
  console.error('no unit tests found')
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
