export type PostingsV1 = { version: 1; postings: Record<string, number[]>; repairId?: string }

export type Query = {
  text?: string
  tagIds?: readonly string[]
  mediaKind?: 'photo' | 'video'
  fromDate?: string
  beforeDate?: string
  untagged?: boolean
}

export type QueryResult = { ids: string[]; total: number }
