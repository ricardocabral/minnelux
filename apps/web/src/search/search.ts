import type { AssetV1, CatalogV1 } from '../library/contract.ts'
import type { PostingsV1, Query, QueryResult } from './contract.ts'

export function searchTerms(value: string): Set<string> {
  return new Set(value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

export function buildPostings(catalog: CatalogV1): { text: PostingsV1; tags: PostingsV1 } {
  const text: Record<string, number[]> = Object.create(null)
  const tags: Record<string, number[]> = Object.create(null)
  for (const [ordinal, asset] of catalog.assets.entries()) {
    const weights = new Map<string, number>()
    const fields = [[asset.filename, 1], [asset.metadata.title, 4], [asset.metadata.description, 2]] as const
    for (const [field, weight] of fields) {
      for (const term of searchTerms(field ?? '')) weights.set(term, (weights.get(term) ?? 0) + weight)
    }
    for (const [term, weight] of weights) (text[term] ??= []).push(ordinal, weight)
    for (const id of asset.tagIds) (tags[id] ??= []).push(ordinal)
  }
  return {text: {version: 1, postings: text}, tags: {version: 1, postings: tags}}
}

const repairId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const termKey = /^[\p{L}\p{N}]+$/u

function dictionary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validatePostings(kind: 'text' | 'tags', value: unknown, catalog: CatalogV1): value is PostingsV1 {
  if (!dictionary(value) || value.version !== 1 || !dictionary(value.postings) ||
      (value.repairId !== undefined && (typeof value.repairId !== 'string' || !repairId.test(value.repairId)))) {
    return false
  }
  const tagIds = kind === 'tags' ? new Set(catalog.tags.map(tag => tag.id)) : undefined
  const stride = tagIds ? 1 : 2
  for (const [key, list] of Object.entries(value.postings)) {
    if (tagIds ? !tagIds.has(key) : !termKey.test(key) || !searchTerms(key).has(key)) return false
    if (!Array.isArray(list) || list.length === 0 || list.length % stride !== 0) return false
    let last = -1
    for (let i = 0; i < list.length; i += stride) {
      const ordinal = list[i]
      if (!Number.isInteger(ordinal) || ordinal <= last || ordinal >= catalog.assets.length) return false
      if (kind === 'text') {
        const weight = list[i + 1]
        if (!Number.isInteger(weight) || weight < 1 || weight > 7) return false
      }
      last = ordinal
    }
  }
  return true
}

function ownPosting(index: PostingsV1, key: string): readonly number[] {
  return Object.hasOwn(index.postings, key) ? index.postings[key]! : []
}

function captureTime(asset: AssetV1): number {
  const capture = asset.metadata.capturedAt
  if (!capture) return Date.parse(asset.addedAt)
  return Date.parse(capture.wallTime + 'Z') - (capture.offsetMinutes ?? 0) * 60_000
}

export function queryCatalog(
  catalog: CatalogV1,
  query: Query,
  indexes: {text?: PostingsV1; tags?: PostingsV1},
): QueryResult {
  const queryTerms = searchTerms(query.text ?? '')
  const {text, tags} = indexes
  if ((queryTerms.size && (!text || !tags)) || (query.tagIds?.length && !tags)) {
    throw Object.assign(new Error('Required index is unavailable'), {code: 'missing'})
  }

  const scores = new Map<number, number>()
  if (queryTerms.size && text && tags) {
    const matchingTags = new Map<string, string[]>()
    for (const tag of catalog.tags) {
      for (const term of searchTerms(tag.title)) {
        if (!queryTerms.has(term)) continue
        const ids = matchingTags.get(term) ?? []
        ids.push(tag.id)
        matchingTags.set(term, ids)
      }
    }

    let first = true
    for (const term of queryTerms) {
      const hits = new Map<number, number>()
      const posting = ownPosting(text, term)
      for (let i = 0; i < posting.length; i += 2) hits.set(posting[i]!, posting[i + 1]!)
      for (const tagId of matchingTags.get(term) ?? []) {
        for (const ordinal of ownPosting(tags, tagId)) hits.set(ordinal, (hits.get(ordinal) ?? 0) + 3)
      }
      if (first) {
        for (const [ordinal, score] of hits) scores.set(ordinal, score)
        first = false
      } else {
        for (const [ordinal, score] of scores) {
          const hit = hits.get(ordinal)
          if (hit === undefined) scores.delete(ordinal)
          else scores.set(ordinal, score + hit)
        }
      }
      if (scores.size === 0) break
    }
  }

  const selectedTags = tags ? (query.tagIds ?? []).map(id => new Set(ownPosting(tags, id))) : []
  const candidates = queryTerms.size ? scores.keys() : catalog.assets.keys()
  const rows: {id: string; score: number; time: number}[] = []
  for (const ordinal of candidates) {
    const asset = catalog.assets[ordinal]!
    if (query.mediaKind && asset.mediaKind !== query.mediaKind) continue
    if (query.untagged && asset.tagIds.length) continue
    if (!selectedTags.every(posting => posting.has(ordinal))) continue
    const date = (asset.metadata.capturedAt?.wallTime ?? asset.addedAt).slice(0, 10)
    if ((query.fromDate && date < query.fromDate) || (query.beforeDate && date >= query.beforeDate)) continue
    rows.push({id: asset.id, score: scores.get(ordinal) ?? 0, time: captureTime(asset)})
  }
  rows.sort((a, b) => b.score - a.score || b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {ids: rows.map(row => row.id), total: rows.length}
}
