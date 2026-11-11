import { createHash } from 'node:crypto'

/**
 * FastCDC, same gear table and normalized masks as the weterm runner.
 * Min 4KB, average 16KB, max 64KB. A buffer at or under the minimum is one chunk.
 * Boundaries come from the bytes, so an insert changes only the chunks around it.
 */

export const CDC_MIN = 4096
export const CDC_AVG = 16384
export const CDC_MAX = 65536

export const GEAR = new Uint32Array(256)
let seed = 1
for (let i = 0; i < 256; i++) {
  seed = Math.imul(seed, 1664525) + 1013904223
  GEAR[i] = seed
}

export interface ChunkSpan {
  offset: number
  length: number
}

export function chunkBuffer(data: Uint8Array): ChunkSpan[] {
  const chunks: ChunkSpan[] = []
  const maskStrict = (1 << 16) - 1
  const maskNormal = (1 << 14) - 1
  const maskLenient = (1 << 12) - 1
  let offset = 0
  const n = data.length
  while (offset < n) {
    if (n - offset <= CDC_MIN) {
      chunks.push({ offset, length: n - offset })
      break
    }
    let hash = 0
    let chunkLen = CDC_MIN
    while (chunkLen < CDC_MAX && offset + chunkLen < n) {
      const b = data[offset + chunkLen]
      hash = ((hash << 1) + GEAR[b]) | 0
      let mask = maskNormal
      if (chunkLen < CDC_AVG / 2) mask = maskStrict
      else if (chunkLen >= CDC_AVG * 1.5) mask = maskLenient
      if ((hash & mask) === 0) {
        chunkLen++
        break
      }
      chunkLen++
    }
    chunks.push({ offset, length: chunkLen })
    offset += chunkLen
  }
  return chunks
}

/** Content-addressed cut of one buffer. The epoch is the hash of the ordered chunk hashes. */
export function planChunks(data: Uint8Array): {
  epoch: string
  hashes: string[]
  chunks: Map<string, Buffer>
  totalSize: number
} {
  const parts = chunkBuffer(data)
  const hashes: string[] = []
  const chunks = new Map<string, Buffer>()
  for (const part of parts) {
    const bytes = Buffer.from(data.subarray(part.offset, part.offset + part.length))
    const hash = createHash('sha256').update(bytes).digest('hex')
    hashes.push(hash)
    if (!chunks.has(hash)) chunks.set(hash, bytes)
  }
  const epoch = createHash('sha256').update(hashes.join('\n')).digest('hex')
  return { epoch, hashes, chunks, totalSize: data.length }
}

export function assembleChunks(hashes: readonly string[], chunks: ReadonlyMap<string, Buffer>): Buffer | null {
  const parts: Buffer[] = []
  for (const hash of hashes) {
    const body = chunks.get(hash)
    if (!body) return null
    parts.push(body)
  }
  return Buffer.concat(parts)
}
