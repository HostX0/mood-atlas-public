import {PROTOCOL, RELEASE, requireSender, validateMarker, safeFailure} from './protocol.mjs';
import {musicRequest} from './music-request.mjs';
import {YouTubeClient} from './youtube.mjs';
import {JobEngine, snapshot} from './jobs.mjs';

const busy = new Set();
const connectionKey = origin => `connection:${origin}`;
const jobKey = (origin, marker) => `job:${origin}:${marker}`;
async function readJob(origin, marker) {
  const key = jobKey(origin, marker);
  return (await chrome.storage.local.get(key))[key] || null;
}
async function findMusicTab() {
  const tabs = await chrome.tabs.query({url: 'https://music.youtube.com/*'});
  const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (!tab) { await chrome.tabs.create({url: 'https://music.youtube.com/'}); throw new Error('LOGIN_REQUIRED'); }
  if (tab.status !== 'complete') throw new Error('MUSIC_LOADING');
  return tab;
}
function youtubeFor(tabId, expectedAccount = null) {
  return new YouTubeClient(async (endpoint, payload) => {
    let results;
    try {
      results = await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN',
        func: musicRequest, args: [endpoint, payload, expectedAccount]});
    } catch { throw new Error('LOGIN_REQUIRED'); }
    const reply = results?.[0]?.result;
    if (!reply?.ok) throw new Error(reply?.code || 'RESPONSE_CHANGED');
    return reply;
  });
}
async function connection(origin) {
  const key = connectionKey(origin), conn = (await chrome.storage.session.get(key))[key];
  if (!conn) throw new Error('CONNECT_FIRST');
  let tab;
  try { tab = await chrome.tabs.get(conn.tabId); } catch { throw new Error('CONNECT_FIRST'); }
  if (!tab.url?.startsWith('https://music.youtube.com/')) throw new Error('CONNECT_FIRST');
  return conn;
}
async function handle(message, sender) {
  if (message?.protocol !== PROTOCOL) throw new Error('UNTRUSTED_ORIGIN');
  const origin = requireSender(sender);
  if (message.action === 'hello') {
    try { const conn = await connection(origin); return {version: RELEASE, account: conn.display || null}; }
    catch { return {version: RELEASE, account: null}; }
  }
  if (message.action === 'disconnect') { await chrome.storage.session.remove(connectionKey(origin)); return {}; }
  if (message.action === 'connect') {
    const tab = await findMusicTab(), account = await youtubeFor(tab.id).account();
    await chrome.storage.session.set({[connectionKey(origin)]: {tabId: tab.id, account: account.fingerprint, display: account}});
    return {account};
  }
  const conn = await connection(origin);
  const youtube = youtubeFor(conn.tabId, conn.account);
  const engine = new JobEngine({youtube, batchSize: 10,
    read: marker => readJob(origin, marker),
    write: job => chrome.storage.local.set({[jobKey(origin, job.marker)]: job})});
  if (!['job.start', 'job.adopt', 'job.step', 'job.status'].includes(message.action)) throw new Error('INVALID_JOB');
  const marker = validateMarker(message.payload?.marker);
  if (message.action === 'job.status') {
    const job = await readJob(origin, marker);
    if (!job) throw new Error('JOB_NOT_FOUND');
    if (job.account !== conn.account) throw new Error('ACCOUNT_CHANGED');
    return {job: snapshot(job)};
  }
  if (busy.has(conn.tabId)) throw new Error('BUSY');
  busy.add(conn.tabId);
  try {
    if (['job.start', 'job.adopt'].includes(message.action)) {
      if (message.payload.account !== conn.account) throw new Error('ACCOUNT_CHANGED');
      return {job: await engine[message.action === 'job.adopt' ? 'adopt' : 'start'](message.payload)};
    }
    const job = await readJob(origin, marker);
    if (job && job.account !== conn.account) throw new Error('ACCOUNT_CHANGED');
    return {job: await engine.step(marker)};
  } finally { busy.delete(conn.tabId); }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(data => reply({ok: true, ...data}), error => reply(safeFailure(error)));
  return true;
});
chrome.runtime.onInstalled.addListener(async () => {
  // Restrict job storage to extension contexts; content scripts only receive sanitized snapshots.
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
});
chrome.action.setTitle({title: `Mood Atlas Connect ${RELEASE}`});
