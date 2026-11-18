export type StoreErrorCode = 'missing' | 'denied' | 'expired' | 'conflict' | 'transport' | 'aborted' | 'limit' | 'invalidResponse'
export type ByteRange = { start: number; endInclusive: number }
export type RequestOptions = { signal?: AbortSignal }
export type ObjectStat = { byteLength: number; mimeType?: string; observedVersion?: string }
export type WriteCondition = { kind: 'create' } | { kind: 'match'; token: string }

export interface ObjectStore {
  list(prefix: string, options?: RequestOptions & { cursor?: string }):
    Promise<{ entries: ReadonlyArray<ObjectStat & { key: string }>; nextCursor?: string }>
  stat(key: string, options?: RequestOptions): Promise<ObjectStat>
  read(key: string, options?: RequestOptions & { range?: ByteRange }):
    Promise<{
      body: ReadableStream<Uint8Array>
      mimeType?: string
      byteLength?: number
      range?: ByteRange & { objectByteLength: number }
    }>
  readForUpdate(key: string, options: RequestOptions & { maxBytes: number }):
    Promise<{ body: Uint8Array; token: string } | null>
  write(key: string, body: Blob, condition: WriteCondition, options?: RequestOptions):
    Promise<{ observedVersion?: string }>
}
