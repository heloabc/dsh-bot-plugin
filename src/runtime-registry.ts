/** @type {Map<string, any>} */
const runtimes: Map<string, any> = new Map()

/**
 * @param {string} dataDir
 * @param {any} runtime
 */
export function publishRuntime(dataDir: string, runtime: any) {
  if (runtime) runtimes.set(dataDir, runtime)
  else runtimes.delete(dataDir)
}

/**
 * @param {string} dataDir
 */
export function runtimeFor(dataDir: string) {
  return runtimes.get(dataDir) ?? null
}

/** @type {Map<string, any>} */
const workRuntimes: Map<string, any> = new Map()

/**
 * @param {string} dataDir
 * @param {any} runtime
 */
export function publishWorkRuntime(dataDir: string, runtime: any) {
  if (runtime) workRuntimes.set(dataDir, runtime)
  else workRuntimes.delete(dataDir)
}

/**
 * @param {string} dataDir
 */
export function workRuntimeFor(dataDir: string) {
  return workRuntimes.get(dataDir) ?? null
}
