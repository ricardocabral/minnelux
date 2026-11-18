import { type ReactNode, useState } from 'react'
import type { AssetV1, FlickrTime, TagV1 } from '../library/contract.ts'
import type { LibraryClient } from '../library/worker-contract.ts'
import { SourceLink, useStoredImage, wallTime } from './components.tsx'

type Detail = readonly [label: string, value: string | number | undefined]

function Fields({ items }: { items: readonly Detail[] }) {
  const available = items.filter(([, value]) => value !== undefined && value !== '')
  if (!available.length) return null
  return <dl>{available.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function Attribution({ author, time }: { author?: string; time?: FlickrTime }) {
  const date = wallTime(time)
  if (!author && !date) return null
  return <p className="context">{[author, date].filter(Boolean).join(' · ')}</p>
}

export function AssetDetails({ asset, tags, onBrowseTag }: {
  asset: AssetV1
  tags: readonly TagV1[]
  onBrowseTag: (tagId: string) => void
}) {
  const metadata = asset.metadata
  const tagsById = new Map(tags.map(tag => [tag.id, tag.title]))
  const currentTags = asset.tagIds.flatMap(id => {
    const title = tagsById.get(id)
    return title === undefined ? [] : [{ id, title }]
  })
  const exif = metadata.embedded?.exif
  const iptc = metadata.embedded?.iptc
  const exifFields: Detail[] = exif ? [
    ['Camera make', exif.make],
    ['Camera model', exif.model],
    ['Lens make', exif.lensMake],
    ['Lens model', exif.lensModel],
    ['ISO', exif.iso],
    ['Exposure', exif.exposureSeconds === undefined ? undefined : `${exif.exposureSeconds} s`],
    ['Aperture', exif.fNumber === undefined ? undefined : `f/${exif.fNumber}`],
    ['Flash (EXIF value)', exif.flash],
    ['Focal length', exif.focalLengthMm === undefined ? undefined : `${exif.focalLengthMm} mm`],
    ['Captured', wallTime(exif.capturedAt)],
    ['Digitized', wallTime(exif.digitizedAt)],
    ['Modified', wallTime(exif.modifiedAt)],
  ] : []
  const iptcFields: Detail[] = iptc ? [
    ['Caption', iptc.caption],
    ['Creation date', iptc.dateCreated],
    ['Creation time', iptc.timeCreated],
    ['Digital creation date', iptc.digitalCreationDate],
    ['Digital creation time', iptc.digitalCreationTime],
  ] : []
  const sourceFields: Detail[] = [
    ['Captured', wallTime(metadata.capturedAt)],
    ['Imported from Flickr', wallTime(metadata.flickrImportedAt)],
    ['License', metadata.license],
    ['Location', metadata.location && `${metadata.location.latitude}, ${metadata.location.longitude}`],
  ]
  const comments = metadata.comments?.length ? metadata.comments.map((comment, index) =>
    <li key={`${comment.id ?? 'comment'}-${index}`}>
      <p>{comment.body}</p>
      <Attribution author={comment.author} time={comment.createdAt} />
      <SourceLink url={comment.sourceUrl}>View source comment</SourceLink>
    </li>
  ) : undefined
  const annotations = metadata.annotations?.length ? metadata.annotations.map((annotation, index) =>
    <li key={index}>
      <p>{annotation.body}</p>
      <Attribution author={annotation.author} time={annotation.createdAt} />
    </li>
  ) : undefined
  const groups = metadata.groupMemberships?.length ? metadata.groupMemberships.map((group, index) =>
    <li key={`${group.id}-${index}`}>
      {group.name || group.id}
      {group.sourceUrl ? <> · <SourceLink url={group.sourceUrl}>View source group</SourceLink></> : null}
    </li>
  ) : undefined
  const authors = metadata.tagAttributions?.length ? metadata.tagAttributions.map((tag, index) =>
    <li key={`${tag.tagId}-${index}`}>
      <p>{tagsById.get(tag.tagId) ?? tag.tagId}</p>
      <Attribution author={tag.author} time={tag.createdAt} />
    </li>
  ) : undefined

  return <>
    <h2>Details</h2>
    {metadata.description ? <p>{metadata.description}</p> : null}
    <Fields items={[[ 'Filename', asset.filename ], ...sourceFields]} />
    <SourceLink url={metadata.sourceUrl}>View source photo</SourceLink>
    <dl>
      <div>
        <dt>Collections</dt>
        <dd className="viewer-tags">
          {currentTags.length ? currentTags.map(tag => <button type="button" key={tag.id} className="control" onClick={() => onBrowseTag(tag.id)}>
            {tag.title}
          </button>) : 'Untagged'}
        </dd>
      </div>
    </dl>
    <DetailList title="Comments" items={comments} />
    <DetailList title="Annotations" items={annotations} />
    <DetailList title="Flickr groups" items={groups} />
    <DetailList title="Source tag authors" items={authors} />
    {exifFields.some(([, value]) => value !== undefined && value !== '') ? <section>
      <h3>EXIF Camera and lens</h3>
      <Fields items={exifFields} />
    </section> : null}
    {iptcFields.some(([, value]) => value !== undefined && value !== '') ? <section>
      <h3>IPTC</h3>
      <Fields items={iptcFields} />
    </section> : null}
  </>
}

function DetailList({ title, items }: { title: string; items?: ReactNode }) {
  return items ? <section><h3>{title}</h3><ul>{items}</ul></section> : null
}

export function AlbumDetails({ client, tag }: { client: LibraryClient; tag: TagV1 }) {
  const album = tag.album
  const [failed, setFailed] = useState(false)
  const { url, loading } = useStoredImage(client, 'cover', tag.source?.kind === 'album' && album?.coverPhoto?.photoId ? tag.id : undefined)
  if (!album || ![album.description, album.createdAt, album.updatedAt, album.coverPhoto?.photoId, album.coverPhoto?.sourceUrl].some(Boolean)) return null

  return <section className="album-info" aria-label="Album details">
    {url && !failed ? <img alt={`${tag.title} cover`} src={url} onError={() => setFailed(true)} /> : null}
    <div>
      <h2>Album details</h2>
      {album.description ? <p>{album.description}</p> : null}
      <Fields items={[
        ['Created', wallTime(album.createdAt)],
        ['Updated', wallTime(album.updatedAt)],
      ]} />
      {loading ? <p role="status">Loading album cover…</p> : null}
      {!loading && (!url || failed) ? <SourceLink url={album.coverPhoto?.sourceUrl}>View source cover</SourceLink> : null}
    </div>
  </section>
}
