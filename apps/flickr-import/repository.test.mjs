import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createFlickrRepository } from './repository.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const part = hash('part');
const sourceKey = 'synthetic-flickr';
const member = [part, 0];
const catalogId = (kind, value) => 'flickr:' + hash(JSON.stringify([sourceKey, kind, value]));
const photoId = '9007199254740993';
const tagId = catalogId('album', '001');
const assetId = catalogId('asset', photoId);
const original = await readFile(new URL('../../spikes/flickr/fixtures/photo.jpg', import.meta.url));
const raw = Buffer.from(JSON.stringify({ id: photoId, title: 'Forêt' }, null, 2));

function memoryStore() {
  const objects = new Map();
  let counter = 0;
  return {
    libraryId: 'synthetic-library', objects,
    async get(key) { await this.beforeGet?.(key); return objects.get(key) ?? null; },
    async put(key, body, {match}) {
      await this.beforePut?.(key, match);
      const current = objects.get(key)?.generation ?? '0';
      if (match !== current) throw Object.assign(new Error('precondition'), {status: 412});
      const record = {body, generation: String(++counter)};
      objects.set(key, record);
      await this.afterPut?.(key);
      return { generation: record.generation };
    },
  };
}
function state(key = sourceKey) {
  return {version: 1, binding: {sourceKey: key, label: 'Fixture'}, parts: {}, photos: {},
    albums: {}, candidates: [], links: {}, ownerFields: {}, ownerTagNames: {}, memberships: {}};
}
function plan(base, source = base.source) {
  return {version: 1, sourceKey: base.sourceKey, baseToken: base.baseToken, operationId: crypto.randomUUID(),
    source, assets: [], tags: [], uploads: []};
}
function upload(id, kind, mimeType, bytes) {
  return {uploadId: id, kind, mimeType, byteLength: bytes.length, sha256: hash(bytes),
    openBytes: async () => new Blob([bytes]).stream()};
}
function completePlan(base) {
  const record = state();
  const p = plan(base, record);
  record.binding.flickrAccountId = 'test@N01';
  record.parts[part] = {members: {0:'stored', 1:'stored', 2:'deferred'}};
  record.photos[photoId] = {variants: [{member: [part, 1], raw: {uploadId: 'raw'}}], selected: [part, 1]};
  record.candidates = [{member, filename:'source.jpg', photoId, original:{uploadId:'jpg'}, review:'confirmed'}];
  record.links[photoId] = {assetId, member};
  record.memberships[photoId] = {[tagId]: {owner:'inherit', source:'authoritative'}};
  p.assets.push({id:assetId, source:{sourceKey, photoId}, original:{uploadId:'jpg'}, filename:'source.jpg',
    mediaKind:'photo', addedAt:'2026-11-18T00:00:00.000Z', previews:[], metadata:{title:'Forêt'}, tagIds:[tagId]});
  p.tags.push({id:tagId, title:'Album', source:{sourceKey, kind:'album', value:'001'}});
  p.uploads = [upload('jpg','original','image/jpeg', original), upload('raw','photo-json','application/json',raw)];
  return p;
}

test('publishes real originals, exact raw bytes, and both searchable snapshots as one revision', async () => {
  const store = memoryStore();
  const a = createFlickrRepository(store);
  const initial = await a.readFlickrImport(sourceKey);
  assert.deepEqual(await a.publishFlickrImport(plan(initial)), {status:'unchanged', revisionId:null});
  assert.equal(store.objects.size, 0);
  const p = completePlan(initial);
  const published = await a.publishFlickrImport(p);
  assert.equal(published.status, 'published');
  const b = createFlickrRepository(store);
  assert.deepEqual(await b.listFlickrSources(), [p.source.binding]);
  const saved = await b.readFlickrImport(sourceKey);
  assert.equal(saved.revisionId, published.revisionId);
  assert.deepEqual(saved.assets[0].original, saved.source.candidates[0].original);
  for (const [ref, bytes] of [[saved.assets[0].original,original],[saved.source.photos[photoId].variants[0].raw,raw]]) {
    const stream = await b.openImportObject(saved.baseToken, ref);
    assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), bytes);
  }
  const head = JSON.parse(await store.objects.get('library/head.json').body.text());
  const manifest = JSON.parse(await store.objects.get('library/' + head.manifest.key).body.text());
  const snapshot = async ref => JSON.parse(gunzipSync(await store.objects.get('library/' + ref.key).body.arrayBuffer()));
  assert.equal((await snapshot(manifest.catalog)).assets[0].id,assetId);
  assert.deepEqual((await snapshot(manifest.textIndex)).postings.foret,[0,4]);
  assert.deepEqual((await snapshot(manifest.tagIndex)).postings[tagId],[0]);
  assert.deepEqual(await b.publishFlickrImport(plan(saved)),{status:'unchanged',revisionId:saved.revisionId});
  const foreign = await b.readFlickrImport('other');
  await assert.rejects(b.openImportObject(foreign.baseToken,saved.assets[0].original),{code:'invalidReference'});
  await assert.rejects(b.openImportObject(saved.baseToken,{...saved.assets[0].original,key:'../originals/x'}),{code:'invalidReference'});
  const foreignPlan = plan(foreign,state('other'));
  foreignPlan.source.candidates = saved.source.candidates;
  foreignPlan.source.parts = saved.source.parts;
  assert.equal((await b.publishFlickrImport(foreignPlan)).status, 'failed');
  foreignPlan.source.candidates = [];
  foreignPlan.source.binding.flickrAccountId = p.source.binding.flickrAccountId;
  assert.deepEqual(await b.publishFlickrImport(foreignPlan), {status:'failed',code:'invalidPlan'});
});

test('rejects malformed plans, corrupted uploads and existing immutable collisions before publishing', async () => {
  const store = memoryStore();
  const repo = createFlickrRepository(store);
  const base = await repo.readFlickrImport(sourceKey);
  for (const [change,code] of [
    [p => {p.uploads[0].sha256 = hash('wrong');},'integrity'],
    [p => {p.source.photos[photoId].variants[0].raw = {uploadId:'jpg'};},'invalidReference'],
    [p => {p.assets[0].id = 'foreign';},'invalidPlan'],
    [p => {p.source.links[photoId].member = [part, 2];},'invalidPlan'],
    [p => {p.assets[0].tagIds = ['missing'];},'invalidPlan'],
    [p => {p.source.ownerFields[photoId] = {title:'cleared'};},'invalidPlan'],
    [p => {p.uploads[0].openBytes = async () => {throw Error('unreadable');};},'unreadableBytes'],
  ]) {
    const p = completePlan(base);
    change(p);
    assert.deepEqual(await repo.publishFlickrImport(p),{status:'failed',code});
    assert.equal(store.objects.has('library/head.json'),false);
  }
  const p = completePlan(base);
  const key = 'library/originals/' + p.uploads[0].sha256;
  store.objects.set(key,{generation:'999',body:new Blob(['corrupt'])});
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'failed',code:'integrity'});
});

test('competing initialization pins the head and retains an earlier receipt through later publication', async () => {
  const store = memoryStore();
  const a = createFlickrRepository(store), b = createFlickrRepository(store);
  const left = plan(await a.readFlickrImport('left'),state('left'));
  const right = plan(await b.readFlickrImport('right'),state('right'));
  const results = await Promise.all([a.publishFlickrImport(left),b.publishFlickrImport(right)]);
  assert.deepEqual(results.map(x=>x.status).sort(),['published','stale']);
  const winner = results[0].status === 'published' ? left : right;
  const loser = winner === left ? right : left;
  assert.deepEqual(await b.publishFlickrImport(loser,{mode:'recover'}),{status:'outcomeUnknown',operationId:loser.operationId});
  const later = plan(await b.readFlickrImport(loser.sourceKey),state(loser.sourceKey));
  assert.equal((await b.publishFlickrImport(later)).status,'published');
  const receipt = await b.publishFlickrImport(winner,{mode:'recover'});
  assert.deepEqual(receipt,results.find(x=>x.status==='published'));
  winner.source.binding.label = 'different';
  assert.deepEqual(await b.publishFlickrImport(winner,{mode:'recover'}),{status:'failed',code:'invalidPlan'});
});

test('lost head response checks receipts and preserves an unresolved outcome across reauthorization', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const p = plan(await repo.readFlickrImport(sourceKey),state());
  store.afterPut = key => {
    if (key.endsWith('/head.json')) {
      store.beforeGet = () => {throw Object.assign(Error(),{status:401});};
      throw Error('connection lost after commit');
    }
  };
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'outcomeUnknown',operationId:p.operationId,code:'expired'});
  assert.deepEqual(await repo.publishFlickrImport(p,{mode:'recover'}),{status:'outcomeUnknown',operationId:p.operationId,code:'expired'});
  delete store.beforeGet;
  delete store.afterPut;
  const fresh = createFlickrRepository(store);
  assert.equal((await fresh.publishFlickrImport(p,{mode:'recover'})).status,'published');
});

test('refuses a valid-digest raw object assigned to another Flickr photo ID', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const p = completePlan(await repo.readFlickrImport(sourceKey));
  p.uploads[1] = upload('raw','photo-json','application/json',Buffer.from('{"id":"88"}'));
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'failed',code:'invalidPlan'});
  assert.equal(store.objects.has('library/head.json'),false);
});

test('verifies immutable bytes when provider denies replacement before evaluating create-only match', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const p = completePlan(await repo.readFlickrImport(sourceKey));
  const key = 'library/originals/' + hash(original);
  store.objects.set(key,{generation:'99',body:new Blob([original])});
  store.beforePut = name => { if (name === key) throw Object.assign(Error(),{status:403}); };
  assert.equal((await repo.publishFlickrImport(p)).status,'published');
  assert.equal((await repo.readFlickrImport(sourceKey)).assets[0].original.observedVersion,'99');
});

test('an evicted receipt preserves uncertainty without duplicating the linked asset', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const first = completePlan(await repo.readFlickrImport(sourceKey));
  const published = await repo.publishFlickrImport(first);
  assert.equal(published.status,'published');
  for (let index = 0; index < 64; index++) {
    const base = await repo.readFlickrImport('other');
    const other = state('other');
    other.binding.label = String(index);
    assert.equal((await repo.publishFlickrImport(plan(base,other))).status,'published');
  }
  const fresh = createFlickrRepository(store);
  const base = await fresh.readFlickrImport(sourceKey);
  assert.deepEqual(base.receipts,[]);
  assert.equal(base.assets.length,1);
  assert.deepEqual(await fresh.publishFlickrImport(first,{mode:'recover'}),{status:'outcomeUnknown',operationId:first.operationId});
});

test('a separate owner edit wins a race and later imports preserve cleared fields, renamed tags and removals', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const initial = completePlan(await repo.readFlickrImport(sourceKey));
  assert.equal((await repo.publishFlickrImport(initial)).status,'published');
  const before = await repo.readFlickrImport(sourceKey);
  const action = plan(before);
  const headRecord = await store.get('library/head.json');
  const oldHead = JSON.parse(await headRecord.body.text());
  const revision = JSON.parse(await (await store.get('library/' + oldHead.manifest.key)).body.text());
  const ownerRevision = crypto.randomUUID();
  // An ordinary writer publishes the changed values, owner choices and indexes together, with real storage preconditions.
  async function replace(ref, edit) {
    const original = await store.get('library/' + ref.key);
    const value = JSON.parse(gunzipSync(await original.body.arrayBuffer()));
    edit(value);
    const body = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const sha256 = hash(Buffer.from(await body.arrayBuffer()));
    const key = ref.key.replace(ref.sha256,sha256);
    await store.put('library/' + key,body,{match:'0'});
    return {key,sha256,byteLength:body.size};
  }
  revision.catalog = await replace(revision.catalog,c => {
    c.assets[0].tagIds = ['owner-tag'];
    c.tags[0].title = 'Owner name';
    c.tags.push({id:'owner-tag',title:'Owner only'});
  });
  revision.tagIndex = await replace(revision.tagIndex,i => { i.postings = {'owner-tag':[0]}; });
  revision.sources[0].state = await replace(revision.sources[0].state,s => {
    s.ownerFields[photoId] = {description:'cleared'};
    s.ownerTagNames[tagId] = 'set';
    s.memberships[photoId][tagId].owner = 'remove';
    s.memberships[photoId]['owner-tag'] = {owner:'add'};
  });
  revision.parentRevisionId = revision.revisionId;
  revision.revisionId = ownerRevision;
  const body = new Blob([JSON.stringify(revision)]);
  const ref = {key:'revisions/' + ownerRevision + '.json',sha256:hash(Buffer.from(await body.arrayBuffer())),byteLength:body.size};
  await store.put('library/' + ref.key,body,{match:'0'});
  await store.put('library/head.json',new Blob([JSON.stringify({version:1,revisionId:ownerRevision,manifest:ref})]),{match:headRecord.generation});
  assert.deepEqual(await repo.publishFlickrImport(action),{status:'stale'});
  const fresh = createFlickrRepository(store);
  const edited = await fresh.readFlickrImport(sourceKey);
  assert.deepEqual(edited.assets[0].tagIds,['owner-tag']);
  assert.equal(edited.tags[0].title,'Owner name');
  const attempt = plan(edited);
  attempt.assets = [{...edited.assets[0],metadata:{...edited.assets[0].metadata,description:'from source'}}];
  assert.deepEqual(await fresh.publishFlickrImport(attempt),{status:'failed',code:'invalidPlan'});
  attempt.assets = edited.assets;
  attempt.tags = [{...edited.tags[0],title:'from source'}];
  assert.deepEqual(await fresh.publishFlickrImport(attempt),{status:'failed',code:'invalidPlan'});
  attempt.tags = edited.tags;
  attempt.source.binding.label = 'New source label';
  assert.equal((await fresh.publishFlickrImport(attempt)).status,'published');
  const reopened = await repo.readFlickrImport(sourceKey);
  assert.deepEqual(reopened.source.ownerFields,edited.source.ownerFields);
  assert.deepEqual(reopened.source.memberships,edited.source.memberships);
  assert.deepEqual(reopened.assets[0],edited.assets[0]);
});

test('distinguishes an immutable upload transport failure from an unknown head outcome', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const p = completePlan(await repo.readFlickrImport(sourceKey));
  store.beforePut = () => {throw new TypeError('network interrupted');};
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'failed',code:'storage'});
  assert.equal(store.objects.has('library/head.json'),false);
  store.beforePut = key => {if (key.endsWith('/head.json')) throw new TypeError('network interrupted');};
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'outcomeUnknown',operationId:p.operationId,code:'storage'});
});

test('requires valid source records and unique media members for the recovered catalog', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store);
  const base = await repo.readFlickrImport(sourceKey);
  const p = completePlan(base);
  p.source.photos[photoId].variants[0].member = member;
  p.source.photos[photoId].selected = member;
  delete p.source.parts[part].members[1];
  assert.deepEqual(await repo.publishFlickrImport(p),{status:'failed',code:'invalidPlan'});
});

test('an interrupted head write never starts an unabortable read after disconnect', async () => {
  const store = memoryStore(), repo = createFlickrRepository(store), controller = new AbortController();
  const p = plan(await repo.readFlickrImport(sourceKey),state());
  let readsAfterAbort = 0;
  store.beforeGet = () => { if (controller.signal.aborted) readsAfterAbort++; };
  store.afterPut = key => {
    if (key.endsWith('/head.json')) {controller.abort(); controller.signal.throwIfAborted();}
  };
  assert.deepEqual(await repo.publishFlickrImport(p,{signal:controller.signal}),
    {status:'outcomeUnknown',operationId:p.operationId,code:'aborted'});
  assert.equal(readsAfterAbort,0);
  const recovered = await repo.publishFlickrImport(p,{mode:'recover'});
  assert.equal(recovered.status,'published');
});

test('rejects unusable extended metadata without advancing the head', async () => {
  const store = memoryStore();
  const repo = createFlickrRepository(store);
  const base = await repo.readFlickrImport(sourceKey);
  const cases = [
    p => { p.assets[0].metadata.sourceUrl = 'javascript:alert(1)'; },
    p => { p.assets[0].metadata.annotations = [{body:'bad', bounds:{x:0,y:1,width:-1,height:3}}]; },
    p => { p.assets[0].metadata.tagAttributions = [{tagId, author:'fixture'}]; },
    p => { p.assets[0].metadata.embedded = {exif:{flash:'not a bitfield'}}; },
    p => { p.tags[0].album = {coverPhoto:{sourceUrl:'https://person:pass@example.com/photo'}}; },
  ];
  for (const change of cases) {
    const input = completePlan(base);
    change(input);
    assert.deepEqual(await repo.publishFlickrImport(input), {status:'failed',code:'invalidPlan'});
    assert.equal(store.objects.has('library/head.json'), false);
  }
});

test('published v1 catalogs reopen with additional optional photo and album fields', async () => {
  const store = memoryStore();
  const repo = createFlickrRepository(store);
  const old = await repo.readFlickrImport(sourceKey);
  assert.equal((await repo.publishFlickrImport(completePlan(old))).status, 'published');
  const base = await repo.readFlickrImport(sourceKey);
  const originalWrites = [...store.objects.keys()].filter(key => key.includes('/originals/'));
  const update = plan(base);
  const keywordId = catalogId('keyword','Architecture');
  const { metadata } = base.assets[0];
  update.assets = [{...base.assets[0], metadata: {...metadata, license: 'All Rights Reserved',
    sourceUrl: 'https://www.flickr.com/photos/account/42/',
    comments: [{body:'Fixture',author:'sample@N04'}],
    annotations: [{body:'Bridge',bounds:{x:0,y:1,width:2,height:3}}],
    groupMemberships: [{id:'7@N05',name:'Travel'}],
    tagAttributions: [{tagId:keywordId,author:'sample@N04'}],
    embedded: {exif:{iso:100,exposureSeconds:0.01,flash:0},iptc:{caption:'Fixture'}} }}];
  update.tags = [
    {id:keywordId,title:'Architecture',source:{sourceKey,kind:'keyword',value:'Architecture'}},
    {...base.tags[0],album:{description:'Travel',coverPhoto:{photoId:'98'},createdAt:{wallTime:'2024-12-01T12:00:00',
      precision:'second',provenance:'flickr',offsetMinutes:0}}},
  ];
  assert.equal((await repo.publishFlickrImport(update)).status, 'published');
  const reopened = await createFlickrRepository(store).readFlickrImport(sourceKey);
  assert.deepEqual(reopened.assets, update.assets);
  assert.deepEqual(reopened.tags.find(tag=>tag.id===tagId).album, update.tags[1].album);
  assert.deepEqual([...store.objects.keys()].filter(key=>key.includes('/originals/')), originalWrites);
});

test('passes the head byte limit to storage and refuses an oversized head from an adapter', async () => {
  const head = new Blob([' '.repeat(64 * 1024), '{"version":1}']);
  const store = {
    async get(key, {maxBytes}) {
      assert.equal(key, 'library/head.json');
      assert.equal(maxBytes, 64 * 1024);
      return {body:head,generation:'3'};
    },
  };
  await assert.rejects(createFlickrRepository(store).listFlickrSources(), {code:'corrupt'});
});
