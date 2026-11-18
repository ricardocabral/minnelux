import { sourceUrl } from './catalog-metadata.mjs'

function link(url: string | undefined, label: string) {
  const href = sourceUrl(url)
  if (!href) return document.createTextNode(label)
  const item = document.createElement('a')
  item.href = href
  item.textContent = label
  item.target = '_blank'
  item.rel = 'noopener noreferrer'
  return item
}

function clock(time: { wallTime: string, offsetMinutes?: number } | undefined) {
  if (!time) return undefined
  const value = time.wallTime.replace('T', ' ')
  if (time.offsetMinutes === undefined) return value
  const offset = Math.abs(time.offsetMinutes)
  const hours = String(Math.floor(offset / 60)).padStart(2, '0')
  const minutes = String(offset % 60).padStart(2, '0')
  return `${value} UTC${time.offsetMinutes < 0 ? '−' : '+'}${hours}:${minutes}`
}

function fields(rows: [string, Node | string | undefined][]) {
  const list = document.createElement('dl')
  for (const [label, value] of rows) {
    if (value === undefined || value === '') continue
    const name = document.createElement('dt')
    const entry = document.createElement('dd')
    name.textContent = label
    entry.append(value)
    list.append(name, entry)
  }
  return list
}

function recordList(label: string, records: Node[]) {
  const block = document.createDocumentFragment()
  if (!records.length) return block
  const heading = document.createElement('h4')
  heading.textContent = label
  const list = document.createElement('ul')
  for (const value of records) {
    const row = document.createElement('li')
    row.append(value)
    list.append(row)
  }
  block.append(heading, list)
  return block
}

function authored(record, bounds?: string) {
  const item = document.createDocumentFragment()
  const body = document.createElement('span')
  body.textContent = record.body
  item.append(body)
  const byline = [record.author, clock(record.createdAt), bounds].filter(Boolean).join(' · ')
  if (byline || record.sourceUrl) {
    const detail = document.createElement('small')
    if (byline) detail.textContent = byline
    if (record.sourceUrl) detail.append(byline ? ' · ' : '', link(record.sourceUrl, 'Flickr comment'))
    item.append(detail)
  }
  return item
}

export function photoDetails(metadata, tagTitles: ReadonlyMap<string, string>) {
  const { exif, iptc } = metadata.embedded ?? {}
  const camera = [exif?.make, exif?.model].filter(Boolean).join(' ')
  const lens = [exif?.lensMake, exif?.lensModel].filter(Boolean).join(' ')
  const rows = fields([
    ['License', metadata.license],
    ['Source', metadata.sourceUrl ? link(metadata.sourceUrl, 'Open on Flickr') : undefined],
    ['Camera', camera],
    ['Lens', lens],
    ['ISO', exif?.iso === undefined ? undefined : String(exif.iso)],
    ['Exposure', exif?.exposureSeconds === undefined ? undefined : `${exif.exposureSeconds} s`],
    ['Aperture', exif?.fNumber === undefined ? undefined : `f/${exif.fNumber}`],
    ['Focal length', exif?.focalLengthMm === undefined ? undefined : `${exif.focalLengthMm} mm`],
    ['Flash', exif?.flash === undefined ? undefined : exif.flash & 1 ? 'Fired' : 'Did not fire'],
    ['EXIF capture time', clock(exif?.capturedAt)],
    ['EXIF digitized time', clock(exif?.digitizedAt)],
    ['EXIF modified time', clock(exif?.modifiedAt)],
    ['IPTC caption', iptc?.caption],
    ['IPTC creation', [iptc?.dateCreated, iptc?.timeCreated].filter(Boolean).join(' ')],
    ['IPTC digital creation', [iptc?.digitalCreationDate, iptc?.digitalCreationTime].filter(Boolean).join(' ')],
  ])
  const lists = [
    recordList('Comments', (metadata.comments ?? []).map(record => authored(record))),
    recordList('Image annotations', (metadata.annotations ?? []).map(record => {
      const area = record.bounds
      return authored(record, area ? `Region (${area.x}, ${area.y}), ${area.width} × ${area.height}` : undefined)
    })),
    recordList('Flickr groups', (metadata.groupMemberships ?? []).map(group => link(group.sourceUrl, group.name ?? group.id))),
    recordList('Tag authors', (metadata.tagAttributions ?? []).map(attribution => document.createTextNode(
      [tagTitles.get(attribution.tagId), attribution.author, clock(attribution.createdAt)].filter(Boolean).join(' · '),
    ))),
  ]
  if (!rows.childElementCount && lists.every(list => !list.childElementCount)) return undefined
  const details = document.createElement('details')
  details.className = 'catalog-details'
  const summary = document.createElement('summary')
  summary.textContent = 'Photo details'
  details.append(summary, rows, ...lists)
  return details
}

export function albumDetails(album, localCover?: HTMLButtonElement) {
  const panel = document.createElement('div')
  panel.className = 'catalog-details'
  const cover = album.coverPhoto
  panel.append(fields([
    ['Description', album.description],
    ['Created', clock(album.createdAt)],
    ['Updated', clock(album.updatedAt)],
    ['Cover photo', localCover ?? (cover?.sourceUrl ? link(cover.sourceUrl, 'Open cover on Flickr') : cover?.photoId)],
  ]))
  return panel
}
