/** Reassemble a FastCDC session snapshot. The browser does not choose the cut. */

export function decodeChunk(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function hashList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) return null
  return value
}

export function mergeChunkBodies(chunks: Map<string, Uint8Array>, incoming: unknown) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return
  for (const [hash, value] of Object.entries(incoming)) {
    if (typeof value !== 'string' || value === '') continue
    try {
      chunks.set(hash, decodeChunk(value))
    } catch {
      /* a bad body is a hole; assembly fails closed */
    }
  }
}

export function retainChunks(chunks: Map<string, Uint8Array>, hashes: readonly string[]) {
  const keep = new Set(hashes)
  for (const hash of chunks.keys()) if (!keep.has(hash)) chunks.delete(hash)
}

export function assembleDocument(
  hashes: readonly string[],
  chunks: ReadonlyMap<string, Uint8Array>,
  totalSize?: number,
): unknown | null {
  let size = 0
  const parts: Uint8Array[] = []
  for (const hash of hashes) {
    const part = chunks.get(hash)
    if (!part) return null
    parts.push(part)
    size += part.length
  }
  if (typeof totalSize === 'number' && size !== totalSize) return null
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (Array.isArray(parsed)) return parsed
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function missingHashes(wanted: readonly string[], have: ReadonlySet<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const hash of wanted) {
    if (hash === '' || have.has(hash) || seen.has(hash)) continue
    seen.add(hash)
    out.push(hash)
  }
  return out
}

export function hashBatches(hashes: readonly string[], size = 32): string[][] {
  const out: string[][] = []
  for (let index = 0; index < hashes.length; index += size) out.push(hashes.slice(index, index + size))
  return out
}
