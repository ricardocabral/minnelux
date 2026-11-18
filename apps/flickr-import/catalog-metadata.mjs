import { Parser } from "htmlparser2";

const list = value => Array.isArray(value) ? value : [];

// Parse text only. Parser callbacks never create DOM elements or load embedded resources.
const blockTags = new Set(["address", "article", "blockquote", "br", "div", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "li", "p", "pre", "section", "td", "th", "tr"]);
const hiddenTags = new Set(["script", "style", "template"]);
function plainText(source) {
  const text = [];
  let hidden = 0;
  new Parser({
    onopentag(name) {
      if (hiddenTags.has(name)) hidden++;
      if (!hidden && blockTags.has(name)) text.push(" ");
    },
    ontext(value) {
      if (!hidden) text.push(value);
    },
    onclosetag(name) {
      if (hiddenTags.has(name)) hidden--;
      if (!hidden && blockTags.has(name)) text.push(" ");
    },
  }).end(source);
  return text.join("").replace(/\s+/g, " ").trim();
}

function flickrTime(value) {
  if (typeof value !== "string") return;
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(Z|([+-])(\d\d):?(\d\d))?$/.exec(value);
  if (!match) return;
  const wallTime = match[1] + "T" + match[2];
  const date = new Date(wallTime + "Z");
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 19) !== wallTime) return;
  const result = { wallTime, precision: "second", provenance: "flickr" };
  if (match[3]) {
    if (Number(match[6]) > 59 || Number(match[5]) * 60 + Number(match[6]) > 14 * 60) return;
    result.offsetMinutes = match[3] === "Z" ? 0 : (match[4] === "-" ? -1 : 1) * (+match[5] * 60 + +match[6]);
  }
  return result;
}
export function metadataFor(photo) {
  const result = {};
  if (typeof photo?.name === "string") result.title = photo.name;
  if (typeof photo?.description === "string") result.description = plainText(photo.description);
  const captured = flickrTime(photo?.date_taken), imported = flickrTime(photo?.date_imported);
  if (captured) result.capturedAt = captured;
  if (imported) result.flickrImportedAt = imported;
  const geo = list(photo?.geo);
  const integer = x => typeof x === "string" && /^-?\d+$/.test(x);
  if (geo.length === 1 && integer(geo[0]?.latitude) && integer(geo[0]?.longitude)) {
    const latitude = Number(geo[0].latitude) / 1e6, longitude = Number(geo[0].longitude) / 1e6;
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) result.location = { latitude, longitude };
  }
  if ([0, 90, 180, 270, "0", "90", "180", "270"].includes(photo?.rotation)) result.flickrRotation = Number(photo.rotation);
  const license = textValue(photo?.license), page = sourceUrl(photo?.photopage);
  if (license) result.license = license;
  if (page) result.sourceUrl = page;
  const comments = list(photo?.comments).filter(comment => typeof comment?.comment === "string").map(comment => {
    const id = textValue(comment.id), author = textValue(comment.user);
    const createdAt = flickrTime(comment.date), url = sourceUrl(comment.url);
    return { body: plainText(comment.comment), ...(id && { id }), ...(author && { author }),
      ...(createdAt && { createdAt }), ...(url && { sourceUrl: url }) };
  });
  const annotations = list(photo?.notes).filter(note => typeof note?.text === "string").map(note => {
    const author = textValue(note.user), createdAt = flickrTime(note.date), bounds = annotationBounds(note);
    return { body: plainText(note.text), ...(author && { author }), ...(createdAt && { createdAt }), ...(bounds && { bounds }) };
  });
  const groupMemberships = list(photo?.groups).filter(group => textValue(group?.id)).map(group => {
    const name = textValue(group.name), url = sourceUrl(group.url);
    return { id: group.id.trim(), ...(name && { name }), ...(url && { sourceUrl: url }) };
  });
  if (comments.length) result.comments = comments;
  if (annotations.length) result.annotations = annotations;
  if (groupMemberships.length) result.groupMemberships = groupMemberships;
  return result;
}

const textValue = value => typeof value === "string" ? value.trim() || undefined : undefined;

export function sourceUrl(value) {
  const text = textValue(value);
  if (!text || !/^https:\/\//i.test(text) || /[\s\x00-\x1f\x7f]/.test(text)) return;
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && !url.username && !url.password) return text;
  } catch {
    // Malformed source URLs remain in the raw Flickr record.
  }
}

function annotationBounds(note) {
  const fields = ["x", "y", "width", "height"];
  const values = fields.map(field => {
    const value = note[field];
    return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  });
  if (values.every(value => Number.isSafeInteger(value) && value >= 0)) {
    return Object.fromEntries(fields.map((field, i) => [field, values[i]]));
  }
}

function epochTime(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) return;
  const date = new Date(value * 1000);
  if (Number.isFinite(+date)) return flickrTime(date.toISOString().replace(".000Z", "Z"));
}

function albumCover(value) {
  if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return { photoId: value };
  const url = sourceUrl(value);
  if (!url) return;
  const { hostname, pathname } = new URL(url);
  const photoId = ["www.flickr.com", "flickr.com"].includes(hostname)
    ? /^\/photos\/[^/]+\/(\d+)(?:\/|$)/.exec(pathname)?.[1] : undefined;
  return { ...(photoId && photoId !== "0" && { photoId }), sourceUrl: url };
}

export function albumMetadata(album) {
  const description = typeof album.description === "string" ? plainText(album.description) : undefined;
  const coverPhoto = albumCover(album.cover_photo);
  const createdAt = epochTime(album.created), updatedAt = epochTime(album.last_updated);
  return { ...(description !== undefined && { description }), ...(coverPhoto && { coverPhoto }),
    ...(createdAt && { createdAt }), ...(updatedAt && { updatedAt }) };
}

export function tagAttribution(tagId, tag) {
  const author = textValue(tag.user);
  if (!author) return;
  const createdAt = flickrTime(tag.date_create);
  return { tagId, author, ...(createdAt && { createdAt }) };
}
