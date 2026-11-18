import { record } from '../storage/io.ts'
import type { AssetV1, CatalogV1, StoredObjectRef } from './contract.ts'

export const hashPattern = /^[a-f0-9]{64}$/
export const addedDatePattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/
export const previewTypes = ['image/jpeg', 'image/webp', 'image/png']
const originalImage = /^image\/(jpeg|png|gif|webp|avif|heif|heic|tiff)$/
const originalVideo = /^video\/(mp4|webm|quicktime|x-msvideo|3gpp)$/
const digits = /^\d+$/
const dateOnly = /^\d{4}-\d\d-\d\d$/
const timeOnly = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:[+-](?:0\d|1[0-4]):[0-5]\d)?$/
const wallTime = /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/

const isText = (value: unknown): value is string => typeof value === 'string'
const nonempty = (value: unknown): value is string => isText(value) && value.length > 0
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const numeric = (value: unknown, test: (number: number) => boolean) =>
  typeof value === 'number' && Number.isFinite(value) && test(value)
const optional = (value: unknown, test: (value: unknown) => boolean) => value === undefined || test(value)

function arrayOf(value: unknown, test: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(test)
}

export function relativeKey(value: unknown): value is string {
  return nonempty(value) && !/[\u0000-\u001f\u007f\\]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..')
}

function safeUrl(value: unknown): boolean {
  if (!isText(value) || !/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function date(value: unknown): value is string {
  if (!isText(value) || !dateOnly.test(value)) return false
  const day = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value
}

function timestamp(value: unknown, provenance?: string): boolean {
  return record(value) && isText(value.wallTime) && wallTime.test(value.wallTime) &&
    date(value.wallTime.slice(0, 10)) && value.precision === 'second' &&
    (provenance ? value.provenance === provenance : value.provenance === 'flickr' || value.provenance === 'exif') &&
    optional(value.offsetMinutes, offset => numeric(offset, n => Number.isInteger(n) && Math.abs(n) <= 14 * 60))
}

function albumMetadata(value: unknown): boolean {
  return record(value) && optional(value.description, isText) &&
    optional(value.createdAt, time => timestamp(time, 'flickr')) &&
    optional(value.updatedAt, time => timestamp(time, 'flickr')) &&
    optional(value.coverPhoto, cover => record(cover) &&
      (cover.photoId !== undefined || cover.sourceUrl !== undefined) &&
      optional(cover.photoId, id => isText(id) && id !== '0' && digits.test(id)) && optional(cover.sourceUrl, safeUrl))
}

function embeddedMetadata(value: unknown): boolean {
  return record(value) &&
    optional(value.exif, exif => record(exif) &&
      ['make', 'model', 'lensMake', 'lensModel'].every(key => optional(exif[key], nonempty)) &&
      ['exposureSeconds', 'fNumber', 'focalLengthMm'].every(key => optional(exif[key], v => numeric(v, n => n > 0))) &&
      optional(exif.iso, iso => size(iso) && iso > 0) &&
      optional(exif.flash, flash => size(flash) && flash <= 0xffff) &&
      ['capturedAt', 'digitizedAt', 'modifiedAt'].every(key => optional(exif[key], v => timestamp(v, 'exif')))) &&
    optional(value.iptc, iptc => record(iptc) && optional(iptc.caption, isText) &&
      ['dateCreated', 'digitalCreationDate'].every(key => optional(iptc[key], date)) &&
      ['timeCreated', 'digitalCreationTime'].every(key => optional(iptc[key], v => isText(v) && timeOnly.test(v))))
}

function metadata(value: unknown, mimeType: string, key: string | undefined, tags: ReadonlyMap<string, Record<string, unknown>>): boolean {
  if (!record(value) || !['title', 'description', 'license'].every(field => optional(value[field], isText)) ||
      !optional(value.sourceUrl, safeUrl) || !optional(value.capturedAt, timestamp) ||
      !optional(value.flickrImportedAt, time => timestamp(time, 'flickr')) ||
      !optional(value.flickrRotation, rotation => rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) ||
      !optional(value.exifOrientation, orientation => size(orientation) && orientation >= 1 && orientation <= 8) ||
      !optional(value.location, location => record(location) &&
        numeric(location.latitude, n => Math.abs(n) <= 90) && numeric(location.longitude, n => Math.abs(n) <= 180))) return false

  const contributor = (row: Record<string, unknown>) =>
    optional(row.author, nonempty) && optional(row.createdAt, time => timestamp(time, 'flickr'))
  return optional(value.comments, rows => arrayOf(rows, row => record(row) && isText(row.body) &&
      contributor(row) && optional(row.id, nonempty) && optional(row.sourceUrl, safeUrl))) &&
    optional(value.annotations, rows => arrayOf(rows, row => record(row) && isText(row.body) &&
      contributor(row) && optional(row.bounds, bounds => record(bounds) && ['x', 'y', 'width', 'height'].every(field => size(bounds[field]))))) &&
    optional(value.groupMemberships, rows => arrayOf(rows, row => record(row) && nonempty(row.id) &&
      optional(row.name, nonempty) && optional(row.sourceUrl, safeUrl))) &&
    optional(value.tagAttributions, rows => arrayOf(rows, row => {
      if (!record(row) || !nonempty(row.tagId) || !nonempty(row.author) || !contributor(row)) return false
      const tagSource = tags.get(row.tagId)?.source
      return record(tagSource) && tagSource.kind === 'keyword' && tagSource.sourceKey === key
    })) &&
    optional(value.embedded, embedded => mimeType === 'image/jpeg' && embeddedMetadata(embedded))
}

export function validateMediaReference(
  value: unknown,
  kind: 'original' | 'preview',
  mediaRoots: ReadonlyMap<string, string>,
): value is StoredObjectRef {
  if (!record(value) || value.kind !== kind || !nonempty(value.root) || !relativeKey(value.key) ||
      !nonempty(value.mimeType) || !size(value.byteLength) || !optional(value.observedVersion, nonempty) ||
      !optional(value.sha256, hash => isText(hash) && hashPattern.test(hash))) return false
  if (kind === 'preview' && !previewTypes.includes(value.mimeType)) return false
  if (kind === 'original' && !originalImage.test(value.mimeType) && !originalVideo.test(value.mimeType)) return false
  if (value.root !== 'library') return kind === 'original' && mediaRoots.has(value.root)

  const directory = kind === 'original' ? 'originals/' : 'previews/'
  return nonempty(value.sha256) && value.key === directory + value.sha256
}

export function validateCatalog(
  value: unknown,
  sources: ReadonlySet<string>,
  mediaRoots: ReadonlyMap<string, string>,
): value is CatalogV1 {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.tags) || !Array.isArray(value.assets)) return false
  const tags = new Map<string, Record<string, unknown>>()
  const identities = new Set<string>()
  const register = (identity: string) => {
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  }

  for (const tag of value.tags) {
    if (!record(tag) || !nonempty(tag.id) || tags.has(tag.id) || !nonempty(tag.title)) return false
    const {source} = tag
    if (source !== undefined) {
      if (!record(source) || !nonempty(source.sourceKey) || !sources.has(source.sourceKey) ||
          (source.kind !== 'album' && source.kind !== 'keyword') || !nonempty(source.value) ||
          (source.kind === 'album' && !digits.test(source.value)) ||
          !register(JSON.stringify([source.sourceKey, source.kind, source.value]))) return false
    }
    if (tag.album !== undefined && (!record(source) || source.kind !== 'album' || !albumMetadata(tag.album))) return false
    tags.set(tag.id, tag)
  }

  const ids = new Set<string>()
  for (const asset of value.assets) {
    if (!record(asset) || !nonempty(asset.id) || ids.has(asset.id) || !nonempty(asset.filename) ||
        (asset.mediaKind !== 'photo' && asset.mediaKind !== 'video') || !isText(asset.addedAt) ||
        !addedDatePattern.test(asset.addedAt) || !Number.isFinite(Date.parse(asset.addedAt)) ||
        !validateMediaReference(asset.original, 'original', mediaRoots) ||
        asset.original.mimeType.split('/')[0] !== (asset.mediaKind === 'photo' ? 'image' : 'video') ||
        !arrayOf(asset.previews, ref => validateMediaReference(ref, 'preview', mediaRoots)) ||
        !Array.isArray(asset.tagIds) || new Set(asset.tagIds).size !== asset.tagIds.length ||
        !asset.tagIds.every(id => typeof id === 'string' && tags.has(id))) return false
    const {source} = asset
    let sourceKey: string | undefined
    if (source !== undefined) {
      if (!record(source) || !nonempty(source.sourceKey) || !sources.has(source.sourceKey) || !nonempty(source.photoId) ||
          !digits.test(source.photoId) || !register(JSON.stringify([source.sourceKey, 'asset', source.photoId]))) return false
      sourceKey = source.sourceKey
    }
    if (!metadata(asset.metadata, asset.original.mimeType, sourceKey, tags)) return false
    ids.add(asset.id)
  }
  return true
}

export function resolveAlbumCover(catalog: CatalogV1, tagId: string): AssetV1 | undefined {
  const album = catalog.tags.find(tag => tag.id === tagId)
  const coverId = album?.album?.coverPhoto?.photoId
  const sourceKey = album?.source?.sourceKey
  if (album?.source?.kind !== 'album' || !coverId || !sourceKey) return undefined
  return catalog.assets.find(asset =>
    asset.source?.sourceKey === sourceKey && asset.source.photoId === coverId && asset.previews.length > 0)
}
