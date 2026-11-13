import { createHash } from 'node:crypto'
import { chunkBuffer, type ChunkSpan } from '../cdc.ts'
import { eventNdjson } from './canonical.ts'

export interface EventChunk {
  fromSeq: number
  toSeq: number
  bytes: number
  hash: string
}

export interface EventChunkPlan {
  throughSeq: number
  count: number
  totalSize: number
  chunks: EventChunk[]
  epoch: string
  format: 'ndjson-v1'
}

/** FastCDC cuts, snapped forward to the next newline so each chunk is a whole event range. */
export function alignCutsToLines(data: Uint8Array, cuts: readonly ChunkSpan[]): ChunkSpan[] {
  const n = data.length
  const out: ChunkSpan[] = []
  let offset = 0
  for (const cut of cuts) {
    if (offset >= n) break
    let end = Math.max(offset, cut.offset + cut.length)
    if (end < n) {
      while (end < n && data[end - 1] !== 10) end += 1
    } else {
      end = n
    }
    if (end > offset) out.push({ offset, length: end - offset })
    offset = end
  }
  if (offset < n) out.push({ offset, length: n - offset })
  return out
}

export function planEventChunks(events: readonly unknown[]): EventChunkPlan {
  const { bytes, lines } = eventNdjson(events)
  if (bytes.length === 0 || lines.length === 0) {
    return { throughSeq: -1, count: 0, totalSize: 0, chunks: [], epoch: '', format: 'ndjson-v1' }
  }
  const cuts = alignCutsToLines(bytes, chunkBuffer(bytes))
  const chunks: EventChunk[] = []
  const hashes: string[] = []
  for (const cut of cuts) {
    const body = bytes.subarray(cut.offset, cut.offset + cut.length)
    const covered = lines.filter(line => line.start >= cut.offset && line.end <= cut.offset + cut.length)
    if (covered.length === 0) continue
    const hash = createHash('sha256').update(body).digest('hex')
    hashes.push(hash)
    chunks.push({
      fromSeq: covered[0]!.seq,
      toSeq: covered[covered.length - 1]!.seq,
      bytes: cut.length,
      hash,
    })
  }
  const epoch = createHash('sha256').update(hashes.join('\n')).digest('hex')
  return {
    throughSeq: lines[lines.length - 1]!.seq,
    count: lines.length,
    totalSize: bytes.length,
    chunks,
    epoch,
    format: 'ndjson-v1',
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
