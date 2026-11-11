import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const base = '0.1.0'
const pattern = new RegExp(`^${base.replaceAll('.', '\\.')}-beta\\.(\\d+)$`)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const bump = process.argv.includes('--bump')
let next = 0
if (bump) {
  const current = pattern.exec(pkg.version)?.[1]
  if (current == null) throw new Error(`cannot bump ${pkg.version}`)
  next = Number(current) + 1
} else {
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 404) {
    if (!response.ok) throw new Error(`registry returned ${response.status}`)
    const published = await response.json()
    const numbers = Object.keys(published.versions ?? {})
      .map((version) => pattern.exec(version)?.[1])
      .filter((value) => value != null)
      .map(Number)
    if (numbers.length > 0) next = Math.max(...numbers) + 1
  }
}
pkg.version = `${base}-beta.${next}`
const result = spawnSync('npm', ['version', pkg.version, '--no-git-tag-version', '--allow-same-version'], {
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(pkg.version)
