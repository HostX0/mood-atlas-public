import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JobEngine} from '../extension/jobs.mjs';
import {validateJob, requireSender, safeFailure} from '../extension/protocol.mjs';
import {YouTubeClient, libraryPage, playlistPage} from '../extension/youtube.mjs';
import {musicRequest} from '../extension/music-request.mjs';

const marker = 'a'.repeat(32), account = 'b'.repeat(64);
const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'];
const spec = {marker, account, name: 'Mood Atlas — five songs', videoIds: ids};
function fixture() {
  let saved;
  const yt = {created: 0, writes: [], tracks: new Set(), exists: false,
    async account() { return {fingerprint: account}; },
    async find() { return this.exists ? 'PLabcdefghijk' : null; },
    async create() { this.created++; this.exists = true; return 'PLabcdefghijk'; },
    async playlist() { return new Set(this.tracks); },
    async add(_playlist, id) { this.writes.push(id); this.tracks.add(id); }
  };
  const deps = {youtube: yt, read: async () => structuredClone(saved), write: async value => {saved = structuredClone(value);}};
  return {yt, deps, engine: () => new JobEngine(deps), saved: () => saved};
}
test('five-song transfer resumes after two songs in a fresh worker without duplicates', async () => {
  const f = fixture(); let engine = f.engine();
  await engine.start(spec); await engine.step(marker); await engine.step(marker);
  assert.equal(f.saved().confirmed.length, 2);
  engine = f.engine(); await engine.start(spec);
  for (let n = 0; n < 3; n++) await engine.step(marker);
  assert.equal(f.saved().state, 'complete'); assert.deepEqual(f.yt.writes, ids); assert.equal(f.yt.created, 1);
  await engine.start(spec); await engine.step(marker); assert.equal(f.yt.writes.length, 5);
});
test('a lost add response is reconciled before another write', async () => {
  const f = fixture(), original = f.yt.add;
  f.yt.add = async function (...args) { await original.apply(this, args); throw new Error('NETWORK'); };
  await f.engine().start(spec); await assert.rejects(f.engine().step(marker), /NETWORK/);
  assert.equal(f.saved().inflight, ids[0]); f.yt.add = original;
  await f.engine().step(marker);
  assert.deepEqual(f.yt.writes, ids.slice(0, 2)); assert.equal(f.saved().confirmed.length, 2);
});
test('legacy jobs adopt only an owned, marked playlist and retain existing tracks', async () => {
  const f = fixture(); f.yt.tracks.add(ids[0]);
  const adopted = await f.engine().adopt({...spec, playlistId: 'PLabcdefghijk'});
  assert.deepEqual(adopted.confirmed, [ids[0]]);
  await f.engine().step(marker); assert.equal(f.yt.created, 0); assert.deepEqual(f.yt.writes, [ids[1]]);
  const g = fixture(); g.yt.playlist = async () => { throw new Error('WRONG_PLAYLIST'); };
  await assert.rejects(g.engine().adopt({...spec, playlistId: 'PLabcdefghijk'}), /WRONG_PLAYLIST/);
  assert.equal(g.saved(), undefined);
});
test('a lost create response recovers the marked playlist', async () => {
  const f = fixture(), original = f.yt.create;
  f.yt.create = async function () { await original.call(this); throw new Error('NETWORK'); };
  await f.engine().start(spec); await assert.rejects(f.engine().step(marker), /NETWORK/);
  await f.engine().step(marker); assert.equal(f.yt.created, 1); assert.equal(f.saved().confirmed.length, 1);
});
test('an uncertain creation can adopt the verified existing list without creating a duplicate', async () => {
  const f = fixture(); await f.engine().start(spec);
  f.yt.create = async function () { this.created++; this.exists = true; throw new Error('NETWORK'); };
  await assert.rejects(f.engine().step(marker), /NETWORK/);
  const job = await f.engine().adopt({...spec, playlistId: 'PLabcdefghijk'});
  assert.equal(job.playlistId, 'PLabcdefghijk'); await f.engine().step(marker);
  assert.equal(f.yt.created, 1); assert.equal(f.saved().confirmed.length, 1);
});
test('uncertain creation never creates a second playlist when library visibility lags', async () => {
  const f = fixture(); f.yt.create = async function () { this.created++; throw new Error('NETWORK'); };
  await f.engine().start(spec); await assert.rejects(f.engine().step(marker), /NETWORK/);
  await assert.rejects(f.engine().step(marker), /CREATE_UNCERTAIN/); assert.equal(f.yt.created, 1);
});
test('account changes before creation or before add prevent the write', async () => {
  const f = fixture(); let calls = 0;
  f.yt.account = async () => ({fingerprint: ++calls < 2 ? account : 'c'.repeat(64)});
  await f.engine().start(spec); await assert.rejects(f.engine().step(marker), /ACCOUNT_CHANGED/);
  assert.equal(f.yt.created, 0); assert.equal(f.yt.writes.length, 0);
  const g = fixture(); await g.engine().start(spec); await g.engine().step(marker);
  g.yt.account = async () => ({fingerprint: 'c'.repeat(64)});
  await assert.rejects(g.engine().step(marker), /ACCOUNT_CHANGED/); assert.equal(g.yt.writes.length, 1);
});
test('unrelated playlists and unconfirmed writes never count as transferred', async () => {
  const f = fixture(); f.yt.playlist = async () => {throw new Error('WRONG_PLAYLIST');};
  await f.engine().start(spec); await assert.rejects(f.engine().step(marker), /WRONG_PLAYLIST/);
  assert.equal(f.yt.writes.length, 0);
  const g = fixture(); g.yt.add = async () => {};
  await g.engine().start(spec); await assert.rejects(g.engine().step(marker), /ADD_UNCERTAIN/);
  assert.equal(g.saved().confirmed.length, 0);
});
test('origins, subframes, marker conflicts and invalid video IDs are rejected', async () => {
  const sender = {frameId: 0, tab: {id: 1, url: 'https://mood-atlas-public.vercel.app/'}, url: 'https://mood-atlas-public.vercel.app/'};
  assert.equal(requireSender(sender), 'https://mood-atlas-public.vercel.app');
  for (const change of [{frameId: 1}, {url: 'https://evil.test/'}, {url: 'http://127.0.0.1:8000/'}]) assert.throws(() => requireSender({...sender, ...change}));
  assert.throws(() => validateJob({...spec, videoIds: ['https://evil.test']}));
  const f = fixture(); await f.engine().start(spec);
  await assert.rejects(f.engine().start({...spec, account: 'c'.repeat(64)}), /JOB_CONFLICT/);
  assert.ok(!JSON.stringify(safeFailure(new Error('cookie=PRIVATE'))).includes('PRIVATE'));
});
const row = id => ({musicResponsiveListItemRenderer: {playlistItemData: {videoId: id}}});
function playlist(ids, continuation) {
  return {header: {musicEditablePlaylistDetailHeaderRenderer: {header: {musicResponsiveHeaderRenderer: {
    description: {musicDescriptionShelfRenderer: {description: {runs: [{text: `[mood-atlas:${marker}]`}]}}}}}}},
    contents: {musicPlaylistShelfRenderer: {contents: ids.map(row), ...(continuation ? {continuations: [{nextContinuationData: {continuation}}]} : {})}}};
}
test('playlist pagination reads every page and refuses loops and incomplete pages', async () => {
  const client = new YouTubeClient(async (_path, body) => ({data: body.browseId ? playlist(ids.slice(0, 2), 'next') :
    {onResponseReceivedActions: [{appendContinuationItemsAction: {continuationItems: ids.slice(2).map(row)}}]}}));
  assert.deepEqual([...await client.playlist('PLabcdefghijk', marker)], ids);
  assert.throws(() => playlistPage({contents: {}}));
  assert.throws(() => libraryPage({contents: {}}));
  const loop = new YouTubeClient(async () => ({data: playlist(ids, 'next')}));
  await assert.rejects(loop.playlist('PLabcdefghijk', marker), /RESPONSE_CHANGED/);
});
test('a positively identified empty playlist can be read without mistaking partial data for an empty list', () => {
  const empty = playlist([]); delete empty.contents.musicPlaylistShelfRenderer.contents;
  assert.throws(() => playlistPage(empty));
  empty.message = {messageRenderer: {text: {runs: [{text: 'Add songs to this playlist'}]}}};
  assert.deepEqual(playlistPage(empty).ids, []);
});
test('session material stays inside the injected YouTube request and never appears in its result', async () => {
  const captured = [];
  const config = {LOGGED_IN: true, DATASYNC_ID: 'local-channel', SESSION_INDEX: '0',
    INNERTUBE_CONTEXT: {client: {clientVersion: '1.test'}}};
  const context = vm.createContext({location: {origin: 'https://music.youtube.com'},
    window: {ytcfg: {get: key => config[key]}}, document: {cookie: 'SAPISID=PRIVATE_COOKIE; other=PRIVATE_OTHER'},
    crypto, TextEncoder, URL, structuredClone, AbortSignal, Date,
    fetch: async (url, options) => {captured.push({url: String(url), options});return {ok: true, status: 200, json: async () => ({status: 'STATUS_SUCCEEDED'})};}});
  const call = vm.runInContext(`(${musicRequest.toString()})`, context);
  const reply = await call('browse', {browseId: 'FEmusic_liked_playlists'});
  assert.equal(reply.ok, true); assert.equal(captured[0].options.credentials, 'include');
  assert.ok(captured[0].options.headers.Authorization.startsWith('SAPISIDHASH '));
  assert.ok(!JSON.stringify(reply).includes('PRIVATE')); assert.ok(!JSON.stringify(captured[0].options.body).includes('PRIVATE'));
  const before = captured.length;
  assert.equal((await call('browse/edit_playlist', {}, 'f'.repeat(64))).code, 'ACCOUNT_CHANGED');
  assert.equal(captured.length, before);
  assert.equal((await call('https://evil.test/', {})).ok, false);
});
test('manifest limits access and contains no cookie-export permission or remote code', async () => {
  const m = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.permissions, ['storage', 'scripting']); assert.deepEqual(m.host_permissions, ['https://music.youtube.com/*']);
  assert.equal(m.content_scripts[0].all_frames, false); assert.ok(!JSON.stringify(m).includes('<all_urls>'));
});

test('batched transfer reconciles a partial write after a lost response', async () => {
  const f = fixture();
  const client = new YouTubeClient(async (path, payload) => {
    assert.equal(path, 'browse/edit_playlist');
    assert.equal(payload.playlistId, 'PLabcdefghijk');
    const batch = payload.actions.map(action => action.addedVideoId);
    if (!f.yt.writes.length) {
      assert.deepEqual(batch, ids);
      for (const id of batch.slice(0, 2)) { f.yt.writes.push(id); f.yt.tracks.add(id); }
      throw new Error('NETWORK');
    }
    assert.deepEqual(batch, ids.slice(2));
    for (const id of batch) { f.yt.writes.push(id); f.yt.tracks.add(id); }
    return {data: {status: 'STATUS_SUCCEEDED'}};
  });
  f.yt.add = client.add.bind(client);
  let engine = new JobEngine({...f.deps, batchSize: 10});
  await engine.start(spec);
  await assert.rejects(engine.step(marker), /NETWORK/);
  engine = new JobEngine({...f.deps, batchSize: 10});
  const job = await engine.step(marker);
  assert.equal(job.state, 'complete');
  assert.deepEqual(job.confirmed, ids);
  assert.deepEqual(f.yt.writes, ids);
  assert.equal(f.yt.created, 1);
});

test('a duplicate reported for a different recording ID does not block the rest of the list', async () => {
  const f = fixture();
  const firstTwenty = Array.from({length: 20}, (_, i) => String(i).padStart(11, '0'));
  const alternate = 'zzzzzzzzzzz';
  const existing = [...firstTwenty, alternate];
  for (const id of existing) f.yt.tracks.add(id);
  const client = new YouTubeClient(async (_path, payload) => {
    const batch = payload.actions.map(action => action.addedVideoId);
    if (batch.includes(ids[0])) {
      const notification = {addToToastAction: {item: {notificationActionRenderer: {
        responseText: {runs: [{text: 'This track is already in the playlist'}]}
      }}}};
      const dialog = {confirmDialogEndpoint: {content: {confirmDialogRenderer: {
        title: {runs: [{text: 'Duplicates'}]},
        dialogMessages: [{runs: [{text: 'One or more of the tracks are already in your playlist'}]}]
      }}}};
      return {data: {status: 'STATUS_FAILED', actions: [batch.length === 1 ? notification : dialog]}};
    }
    for (const id of batch) { f.yt.tracks.add(id); f.yt.writes.push(id); }
    return {data: {status: 'STATUS_SUCCEEDED'}};
  });
  f.yt.add = client.add.bind(client);
  const engine = new JobEngine({...f.deps, batchSize: 10});
  await engine.adopt({...spec, playlistId: 'PLabcdefghijk', videoIds: [...firstTwenty, ...ids]});
  let job;
  for (let step = 0; step < 6; step++) {
    job = await engine.step(marker);
    if (job.state === 'complete') break;
  }
  assert.equal(job.state, 'complete');
  assert.deepEqual(job.duplicates, [ids[0]]);
  assert.deepEqual(job.confirmed, [...firstTwenty, ...ids.slice(1)]);
  assert.deepEqual(f.yt.writes, ids.slice(1));
  assert.equal(f.yt.tracks.size, 25);
});
