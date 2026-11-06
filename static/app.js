import {columnIndex, readSheets, sheetTracks} from './sheets.mjs?v=1.0.0';
import {parseCSV, mapCSV, normaliseTracks, mergeTracks, videoId, playlistId, exportCSV, cleanBackup} from './core.mjs?v=1.0.0';
import {STATUS, searchKey, displayName, uniqueVideos, summary, suggestion, explain, versionConflict, transferLocked, researchTargets, applyMatches, auditChoices, editSnapshot, bulkEdit, filterTracks, nextStep, recovery} from './workflow.mjs?v=1.0.0';
import {extension} from './connector.mjs?v=1.0.0';
import {retryPlan, itemFailure, canAutoContinue} from './resilience.mjs?v=1.0.0';

const $ = id => document.getElementById(id);
const state = {version: 1, revision: 0, tracks: [], groups: Object.create(null), selected: null, settings: {matchMode: 'auto'}, task: null, tasks: Object.create(null), batch: null, receipts: [], savedAt: 0};
const selected = new Set();
let upload = null, readingSheets = false;
let displayCount = 'auto';
let db, channel, saveQueue = Promise.resolve(), filter = 'all', page = 0, running = false, stopRequested = false, blocked = false;
let account = null, connecting = false, csv = null, undo = null, toastTimer, issueAction = null, transferIds = [], reviewIds = [], reviewIndex = 0, reviewChoice = null, showAllCandidates = false;
let autoStarting = false, autoTimer;
const baseTitle = document.title;
let attention = false, lastWorkspaceRender = 0;
const searchWidth = 3;
const playlistIssues = new Set(['CREATE_UNCERTAIN', 'WRONG_PLAYLIST', 'JOB_CONFLICT', 'YOUTUBE_REJECTED', 'ADD_UNCERTAIN']);
let issueTaskName = null, issueFailedIds = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (code, message) => Object.assign(new Error(message || code), {code});
const quantity = (count, word) => `${count.toLocaleString('en')} ${word}${count === 1 ? '' : 's'}`;
const rowsFor = name => state.tracks.filter(t => t.playlist === name);
const rows = () => rowsFor(state.selected);
const editable = () => !running && !blocked;
const unfinishedBatch = () => state.batch && state.batch.status !== 'complete';
const batchTask = () => {
  const batch = state.batch;
  if (!batch) return null;
  if (batch.phase === 'search') return batch.search;
  return batch.index < batch.queue.length ? state.tasks[batch.queue[batch.index]] : null;
};
const showCurrentTask = () => { state.task = unfinishedBatch() ? batchTask() || null : state.tasks[state.selected] || null; };
const locked = track => transferLocked(track, state.task?.playlist === track.playlist ? state.task : state.tasks[track.playlist]);
const playlistURL = id => 'https://music.youtube.com/playlist?list=' + encodeURIComponent(id);
const videoURL = id => 'https://music.youtube.com/watch?v=' + encodeURIComponent(id);
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function link(text, href) {
  const a = node('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function open(id) { if (!$(id).open) $(id).showModal(); document.querySelectorAll('details.menu[open]').forEach(n => n.open = false); }
function close(id) { $(id).close(); }
function notify(message, canUndo = false) {
  $('toast-message').textContent = message; $('toast').hidden = false; $('undo-btn').hidden = !canUndo;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, canUndo ? 14000 : 7500);
}
function clearUndo() { undo = null; $('undo-btn').hidden = true; }
function showIssue(code, message) {
  const info = recovery(code, message); $('issue-title').textContent = info.title; $('issue-detail').textContent = info.detail;
  $('issue-action').textContent = info.label; $('issue').hidden = false;
  issueAction = info.action;
  issueTaskName = state.task?.playlist || state.selected; issueFailedIds = [...(state.task?.failedIds || [])];
  if (!['OFFLINE', 'THROTTLED', 'SEARCH_BUSY'].includes(code)) { attention = true; document.title = 'Action needed · Mood Atlas'; }
}
function clearIssue() { $('issue').hidden = true; attention = false; document.title = baseTitle; }
function fail(e) { if (e.code === 'INPUT') notify(e.message); else showIssue(e.code || (!navigator.onLine ? 'OFFLINE' : 'INTERNAL'), e.message); }
async function api(path, body) {
  if (!navigator.onLine) throw error('OFFLINE');
  let response;
  try {
    response = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST', credentials: 'omit',
      signal: AbortSignal.timeout(45000), headers: {'Content-Type': 'application/json', 'X-Atlas-Request': '1'},
      body: body === undefined ? undefined : JSON.stringify(body)});
  } catch (e) { throw error(!navigator.onLine ? 'OFFLINE' : e.name === 'TimeoutError' ? 'SEARCH_TIMEOUT' : 'NETWORK', 'The connection was interrupted. We will retry automatically.'); }
  let data;
  try { data = await response.json(); } catch { throw error('NETWORK', 'Could not reach the search service. Check your connection and try again.'); }
  if (!response.ok) {
    const message = typeof data.detail === 'string' ? data.detail : data.detail?.message;
    const e = error(data.detail?.code || (response.status === 429 ? 'THROTTLED' : response.status < 500 ? 'INVALID_TRACK' : 'NETWORK'), message || 'Could not complete the request.');
    e.status = response.status;
    if (response.status === 429) e.retryAt = Date.now() + (Number(response.headers.get('Retry-After')) || 120) * 1000;
    throw e;
  }
  return data;
}

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('mood-atlas-public-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); blocked = true; showIssue('STATE_CONFLICT'); }; resolve(request.result); };
    request.onerror = () => reject(error('STORAGE'));
  });
}
async function load() {
  if (!db) throw error('STORAGE');
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(error('STORAGE'));
  });
  if (value) Object.assign(state, cleanBackup(value));
  const reviewed = auditChoices(state.tracks.filter(t => !locked(t)));
  if (reviewed) notify(`Returned ${reviewed} matches to review because the recording versions differ.`);
  if (unfinishedBatch() || state.task?.status !== 'running') showCurrentTask();
  selected.clear(); blocked = false; clearUndo();
}
function save() {
  const operation = saveQueue.then(async () => {
    if (!db || blocked) throw error(blocked ? 'STATE_CONFLICT' : 'STORAGE');
    if (state.task && state.task.playlist !== null) state.tasks[state.task.playlist] = state.task;
    const expected = state.revision, snapshot = structuredClone(state);
    snapshot.revision = expected + 1; snapshot.savedAt = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite'), store = tx.objectStore('workspace');
      let conflict = false;
      const request = store.get('current');
      request.onsuccess = () => {
        if ((request.result?.revision || 0) !== expected) { conflict = true; tx.abort(); }
        else store.put(snapshot, 'current');
      };
      tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(error(conflict ? 'STATE_CONFLICT' : 'STORAGE'));
    });
    state.revision = snapshot.revision; state.savedAt = snapshot.savedAt;
    $('save-label').textContent = 'Saved in this browser'; channel?.postMessage({revision: state.revision});
  });
  saveQueue = operation.catch(() => {});
  return operation.catch(e => { blocked = true; $('save-label').textContent = 'Could not save progress'; fail(e); render(); throw e; });
}

function visibleRows() { return filterTracks(rows(), filter, $('track-search').value); }
function pageSize() { return displayCount === 'all' || displayCount === 'auto' && rows().length <= 500 ? Math.max(1, visibleRows().length) : displayCount === 'auto' ? 100 : Number(displayCount); }
function pageRows() { const size = pageSize(); return visibleRows().slice(page * size, (page + 1) * size); }
function setFilter(value) { filter = value; page = 0; selected.clear(); render(); }
async function chooseCollection(name) {
  if (blocked) throw error('STATE_CONFLICT');
  state.selected = name; filter = 'all'; page = 0; selected.clear(); $('track-search').value = '';
  if (!running) showCurrentTask();
  if (!running) await save(); render(); if ($('library-modal').open) close('library-modal');
}
function renderLibrary() {
  const grouped = new Map(), host = $('groups');
  for (const track of state.tracks) {
    if (!grouped.has(track.playlist)) grouped.set(track.playlist, []);
    grouped.get(track.playlist).push(track);
  }
  const names = [...grouped.keys()];
  const q = searchKey($('collection-search').value), mode = $('collection-filter').value;
  const scroll = host.scrollTop; host.replaceChildren(); $('group-count').textContent = names.length;
  names.forEach((name, index) => {
    const s = summary(grouped.get(name));
    if (q && !searchKey(name).includes(q)) return;
    if (mode === 'ready' && !s.ready || mode === 'done' && (s.pending || s.ready || s.review || !s.added) || mode === 'unfinished' && !(s.pending || s.ready || s.review)) return;
    const item = node('div', 'collection-item'), button = node('button', 'collection-button' + (state.selected === name ? ' selected' : ''));
    button.setAttribute('aria-current', state.selected === name ? 'page' : 'false'); button.disabled = blocked;
    button.append(node('span', 'mini-cover color-' + index % 5, String(index + 1).padStart(2, '0')));
    const copy = node('span', 'collection-copy'), title = node('strong', '', displayName(name)); title.dir = 'auto';
    const paused = state.tasks[name]?.status === 'paused';
    copy.append(title, node('small', '', paused ? `${quantity(s.total, 'track')} · Paused` : s.added === s.total ? `${quantity(s.total, 'track')} · Complete` : `${quantity(s.total, 'track')}${s.ready ? ' · ' + s.ready + ' ready' : s.added ? ' · ' + s.added + ' in YouTube Music' : ''}`));
    button.append(copy); if (s.added === s.total) { const check = node('span', 'collection-complete'); check.append(icon('check')); button.append(check); }
    button.addEventListener('click', () => chooseCollection(name).catch(fail)); item.append(button); host.append(item);
  });
  if (!host.children.length) host.append(node('p', 'collections-empty', names.length ? 'No playlists match your search or filter.' : 'Your playlists will appear here.'));
  host.scrollTop = scroll; $('library-total').textContent = `${quantity(names.length, 'playlist')} · ${quantity(state.tracks.length, 'track')}`;
}
function renderAccount() {
  $('account-label').textContent = connecting ? 'Checking account…' : account?.name || 'Connect YouTube Music';
  $('account-dot').classList.toggle('connected', !!account); $('connect-btn').disabled = connecting || running;
  $('disconnect-btn').hidden = !account; $('verify-account').disabled = connecting || running;
  $('verify-account').textContent = account ? 'Verify account' : 'Connect account';
}
function renderTask() {
  const task = state.task; $('task-panel').hidden = !task || task.status === 'complete' || !!unfinishedBatch();
  if (!attention) document.title = running && task ? `${task.done}/${task.total} · Mood Atlas` : baseTitle;
  if ($('task-panel').hidden) return;
  $('task-kind').textContent = task.kind === 'matching' ? 'Matching tracks' : 'Transferring to YouTube Music';
  const waiting = !!task.retryAt && (running || canAutoContinue(task));
  $('task-title').textContent = displayName(task.playlist) + (waiting ? ' — Retrying automatically' : running ? ' — In progress' : ' — Saved and ready to resume');
  $('task-count').textContent = `${task.done} / ${task.total}`;
  $('task-progress').value = task.total ? task.done / task.total * 100 : 0;
  $('task-detail').textContent = task.status === 'complete' ? (task.kind === 'matching' ? 'Matching finished. Review exceptions or transfer ready tracks.' : 'Recordings were verified in the playlist.') :
    stopRequested && running ? 'Pausing after the current request is verified.' : waiting ? (task.code === 'OFFLINE' ? 'Waiting for your connection. This task will resume automatically.' : task.code === 'SEARCH_BUSY' ? 'Search is busy. It will resume automatically.' : task.code === 'THROTTLED' ? 'YouTube Music asked us to slow down. The transfer will resume automatically.' : 'Retrying from the last verified step.') : task.code ? recovery(task.code).detail : running ? (task.kind === 'matching' ? 'Searching for matches and saving progress automatically.' : 'Verifying tracks as they are added. You can switch tabs.') : 'Resume from your last saved step.';
  $('pause-btn').hidden = !running && !waiting; $('pause-btn').disabled = stopRequested;
  $('resume-btn').hidden = running || waiting || task.status === 'complete'; $('resume-btn').disabled = blocked;
  $('task-goto').hidden = task.playlist === state.selected;
  $('task-options').hidden = task.kind !== 'transfer' || running || task.status === 'complete';
}
function renderNext() {
  const task = state.task, ownTask = !unfinishedBatch() && task?.playlist === state.selected && task.status !== 'complete';
  const waiting = ownTask && !!task.retryAt && (running || canAutoContinue(task));
  const next = nextStep(rows()), primary = $('primary-action'), secondary = $('secondary-action'); secondary.hidden = true;
  $('next-title').textContent = ownTask ? (running ? 'Working on this playlist' : 'Your progress is saved') : next.title;
  $('next-detail').textContent = ownTask ? (task.kind === 'matching' ? 'Search the remaining tracks.' : 'Check the existing playlist before adding more tracks.') : next.detail;
  primary.disabled = !editable(); primary.dataset.action = ownTask ? 'resume' : next.kind;
  primary.textContent = ownTask ? (running ? 'In progress…' : 'Resume') : ({transfer: 'Transfer ready tracks', prepare: 'Match playlist', review: 'Review exceptions', complete: 'Open playlist', deferred: 'View deferred tracks', empty: 'Add music'})[next.kind];
  if (next.kind === 'complete' && !state.groups[state.selected]?.playlistId) { primary.dataset.action = 'history'; primary.textContent = 'Transfer history'; }
  const s = summary(rows());
  if (!ownTask && s.pending && s.ready) { secondary.hidden = false; secondary.dataset.action = 'prepare'; secondary.textContent = 'Match the rest'; }
  else if (!ownTask && s.review && next.kind !== 'review') { secondary.hidden = false; secondary.dataset.action = 'review'; secondary.textContent = 'Review exceptions (' + s.review + ')'; }
  secondary.disabled = !editable();
  if (waiting) {
    $('next-title').textContent = 'This task will resume automatically';
    $('next-detail').textContent = task.code === 'THROTTLED' ? 'Waiting for YouTube Music before resuming.' : 'Retrying from the last saved step.';
    primary.textContent = 'Waiting to retry'; primary.disabled = true; secondary.hidden = true;
  }
}
function renderSelection() {
  const visible = visibleRows().filter(t => t.status !== 'added' && !locked(t));
  const selectable = rows().filter(t => t.status !== 'added' && !locked(t));
  const picked = state.tracks.filter(t => selected.has(t.id) && t.playlist === state.selected && t.status !== 'added' && !locked(t));
  const all = visible.length > 0 && visible.every(t => selected.has(t.id));
  $('select-page').checked = all; $('select-page').indeterminate = !all && visible.some(t => selected.has(t.id)); $('select-page').disabled = !editable() || !visible.length;
  $('select-all-tracks').textContent = `Select entire playlist (${selectable.length})`; $('select-all-tracks').disabled = !editable() || !selectable.length;
  $('select-all-notice').hidden = !picked.length;
  $('select-page-summary').textContent = `Selected ${picked.length} of ${selectable.length} editable tracks.`; $('select-all-results').textContent = `Select all search results (${visible.length})`;
  $('bulk-bar').hidden = !picked.length; $('selected-count').textContent = `${picked.length} selected`;
  $('bulk-transfer').hidden = !picked.some(t => t.status === 'ready');
  $('bulk-accept').hidden = !picked.some(t => t.status !== 'ready');
  ['bulk-accept', 'bulk-transfer', 'bulk-skip', 'bulk-retry', 'bulk-review'].forEach(id => $(id).disabled = !editable());
  document.querySelectorAll('#tracks tr').forEach(tr => { const checked = selected.has(tr.dataset.id); tr.classList.toggle('is-selected', checked); const input = tr.querySelector('input'); if (input) input.checked = checked; });
}
function renderTracks() {
  const visible = visibleRows(), host = $('tracks'), size = pageSize(); page = Math.max(0, Math.min(page, Math.ceil(visible.length / size) - 1)); host.replaceChildren();
  for (const t of pageRows()) {
    const tr = node('tr'); tr.dataset.id = t.id;
    const selection = node('td', 'selection-cell'), check = node('input'); check.type = 'checkbox'; check.checked = selected.has(t.id); check.disabled = !editable() || t.status === 'added' || locked(t); check.setAttribute('aria-label', 'Select ' + t.title);
    check.addEventListener('change', () => { check.checked ? selected.add(t.id) : selected.delete(t.id); renderSelection(); }); selection.append(check);
    const original = node('td'), title = node('div', 'song-title', t.title), artist = node('div', 'song-artist', t.artist || 'Unknown artist'); title.dir = artist.dir = 'auto'; original.append(title, artist);
    const match = node('td', 'match-column'), offered = t.choice || t.candidates?.[0];
    if (offered) {
      const info = explain(t, offered), mtitle = node('div', 'match-title', offered.title), martist = node('div', 'match-artist', offered.artist); mtitle.dir = martist.dir = 'auto';
      match.append(mtitle, martist, node('span', 'choice-note' + (info.tone === 'warning' ? ' warning' : ''), t.status === 'ready' && t.decisionSource === 'manual' ? 'Your choice' : info.label));
      const mobile = node('div', 'mobile-match', (t.choice ? '↳ ' : 'Suggested: ') + offered.title); mobile.dir = 'auto'; original.append(mobile);
    } else match.append(node('span', 'no-choice', t.status === 'skipped' ? 'Available for review' : t.status === 'pending' ? 'Waiting to match' : 'Search again or paste a link'));
    const status = node('td', 'status-column'); status.append(node('span', 'status ' + t.status, STATUS[t.status]));
    const action = node('td'), button = node('button', 'row-review', t.status === 'added' || locked(t) ? 'View' : t.status === 'ready' ? 'Change' : 'Review'); button.disabled = running || blocked;
    button.setAttribute('aria-label', (t.status === 'added' ? 'View ' : 'Review ') + t.title); button.addEventListener('click', () => review([t.id])); action.append(button);
    tr.append(selection, original, match, status, action); host.append(tr);
  }
  $('track-empty').hidden = !!visible.length; $('track-empty-title').textContent = $('track-search').value ? 'No tracks match your search.' : 'No tracks with this status.';
  $('track-empty-detail').textContent = 'Change your search or show all tracks.';
  const first = visible.length ? page * size + 1 : 0, last = Math.min((page + 1) * size, visible.length);
  $('visible-count').textContent = `${first}–${last} of ${visible.length} tracks`; $('page-label').textContent = `${page + 1} / ${Math.max(1, Math.ceil(visible.length / size))}`;
  $('page-prev').disabled = !page; $('page-next').disabled = (page + 1) * size >= visible.length;
  $('page-size').value = displayCount === 'auto' ? rows().length <= 500 ? 'all' : '100' : displayCount;
  $('pagination').hidden = visible.length <= size;
  renderSelection();
}
function render() {
  renderAccount(); renderLibrary(); const ts = rows(), s = summary(ts), hasTracks = !!state.tracks.length;
  $('empty-workspace').hidden = hasTracks; $('library-actions').hidden = !hasTracks; $('collection-workspace').hidden = !hasTracks;
  $('collection-title').textContent = displayName(state.selected); $('collection-index').textContent = String([...new Set(state.tracks.map(t => t.playlist))].indexOf(state.selected) + 1).padStart(2, '0');
  $('collection-description').textContent = `${quantity(s.total, 'track')}${s.skipped ? ' · ' + s.skipped + ' deferred' : ''}`;
  $('coverage-label').textContent = `Searched ${s.total - s.pending} of ${s.total} tracks`;
  $('coverage-progress').value = s.total ? (s.total - s.pending) / s.total * 100 : 0;
  const transferring = state.tasks[state.selected]?.kind === 'transfer' && state.tasks[state.selected].status !== 'complete';
  $('research-all').disabled = !editable() || transferring || !rows().some(t => t.status !== 'added' && !locked(t));
  $('research-all').title = transferring ? 'Resume the paused transfer or open its options before starting another search.' : '';
  $('flow-review').disabled = !editable() || !s.review; $('flow-review-count').textContent = s.review;
  const group = state.groups[state.selected]; $('playlist-link').hidden = !group?.playlistId; if (group?.playlistId) $('playlist-link').href = playlistURL(group.playlistId);
  $('destination-options').hidden = !group; $('destination-options').disabled = !editable();
  ['pending', 'ready', 'review', 'added'].forEach(key => $('count-' + key).textContent = s[key]);
  document.querySelectorAll('[data-count]').forEach(n => n.textContent = s[n.dataset.count]);
  document.querySelectorAll('[data-filter]').forEach(n => { n.classList.toggle('active', n.dataset.filter === filter); n.setAttribute('aria-pressed', String(n.dataset.filter === filter)); });
  const approvable = ts.filter(t => t.status === 'review' && !locked(t) && suggestion(t, state.settings.matchMode));
  $('review-shortcut').hidden = !s.review; $('review-summary').textContent = s.missing ? `${s.review} need review · ${s.missing} without a suitable match` : `${s.review} need review`;
  $('approve-suggestions').hidden = !approvable.length; $('approve-suggestions').textContent = `Approve suitable matches (${approvable.length})`; $('approve-suggestions').disabled = !editable(); $('review-queue').disabled = !editable();
  $('match-mode').value = state.settings.matchMode; $('match-mode').disabled = !editable();
  $('mode-detail').textContent = state.settings.matchMode === 'safe' ? 'Close matches and different versions stay in review.' : 'Suitable matches are approved. Artist and version differences stay in review.';
  $('mode-apply').hidden = !approvable.length; $('mode-apply').disabled = !editable();
  $('deferred-open').hidden = !s.skipped; $('deferred-open').textContent = `${s.skipped} deferred · Review`;
  document.querySelectorAll('[data-load-sample], [data-open="add-dialog"]').forEach(n => n.disabled = !editable());
  ['csv-file', 'sheet-files', 'upload-open', 'start-upload', 'restore-file', 'confirm-csv'].forEach(id => $(id).disabled = !editable());
  renderNext(); renderTask(); renderBatch(); renderTracks();
  lastWorkspaceRender = performance.now();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type})), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function backup() { download('Mood_Atlas_Backup.json', JSON.stringify(cleanBackup(state), null, 2), 'application/json'); }
function confirmAction(title, detail, {backupFirst = false, label = 'Continue'} = {}) {
  $('confirm-title').textContent = title; $('confirm-detail').textContent = detail; $('confirm-accept').textContent = label;
  $('confirm-backup-label').hidden = !backupFirst; $('confirm-backup').checked = true; open('confirm-dialog');
  return new Promise(resolve => {
    let accepted = false;
    const accept = () => { accepted = true; if (backupFirst && $('confirm-backup').checked) backup(); close('confirm-dialog'); };
    $('confirm-accept').addEventListener('click', accept, {once: true});
    $('confirm-dialog').addEventListener('close', () => { $('confirm-accept').removeEventListener('click', accept); resolve(accepted); }, {once: true});
  });
}
async function importTracks(incoming, replace = false) {
  if (!editable()) throw error(blocked ? 'STATE_CONFLICT' : 'BUSY');
  const clean = normaliseTracks(incoming); if (!clean.length) throw error('INPUT', 'The file has no valid track titles.');
  if (replace && state.tracks.length && !await confirmAction('Replace this library?', 'This replaces the tracks and choices in this browser. Your YouTube Music playlists stay in your account.', {backupFirst: true, label: 'Replace library'})) return false;
  clearUndo(); selected.clear(); let added, duplicates;
  if (replace) { Object.assign(state, {tracks: clean, groups: Object.create(null), task: null, tasks: Object.create(null), batch: null, selected: clean[0].playlist, receipts: []}); added = clean.length; duplicates = incoming.length - clean.length; }
  else { const merged = mergeTracks(state.tracks, incoming); state.tracks = merged.tracks; added = merged.added; duplicates = merged.duplicates; state.selected ||= state.tracks[0]?.playlist; }
  await save(); filter = 'all'; page = 0; render();
  notify(added ? `Added ${added} tracks${duplicates ? ' · Skipped ' + duplicates + ' duplicates' : ''}. Your previous progress is saved.` : 'All tracks in this file are already in your library.'); return true;
}
function pickedRows() { return rows().filter(t => selected.has(t.id) && t.status !== 'added' && !locked(t)); }
async function editRows(targets, action) {
  if (!editable()) throw error(blocked ? 'STATE_CONFLICT' : 'BUSY');
  targets = targets.filter(t => t && !locked(t));
  const before = editSnapshot(targets), result = bulkEdit(targets, action, state.settings.matchMode);
  if (!result.changed) { notify(result.unresolved ? 'No suitable suggestions to approve automatically. Review the tracks or paste recording links.' : 'No changes to apply.'); return; }
  await save(); undo = before; selected.clear(); render();
  notify(`${result.changed} tracks ${ {accept: 'approved', skip: 'deferred', review: 'returned to review', retry: 'queued to search again'}[action]}${result.unresolved ? ' · ' + result.unresolved + ' need your choice' : ''}.`, true);
}
async function undoEdit() {
  if (!editable() || !undo) return;
  const previous = undo; clearUndo(); for (const record of previous) { const t = state.tracks.find(t => t.id === record.id); if (t && t.status !== 'added') Object.assign(t, record); }
  await save(); render(); notify('Previous choices restored.');
}

async function withWorkspaceTask(operation) {
  if (!editable()) throw error(blocked ? 'STATE_CONFLICT' : 'BUSY');
  if (!navigator.locks) throw error('STORAGE', 'This browser cannot coordinate background tasks. Open Mood Atlas in an up-to-date Chrome browser.');
  return navigator.locks.request('mood-atlas-public-import', {ifAvailable: true}, async lock => {
    if (!lock) throw error('BUSY');
    running = true; stopRequested = false; clearUndo(); selected.clear(); clearIssue();
    let wake;
    try {
      try { wake = await navigator.wakeLock?.request('screen'); } catch {}
      return await operation();
    } finally {
      await wake?.release().catch(() => {});
      running = false; stopRequested = false; showCurrentTask(); render();
    }
  });
}
function renderProgress() {
  if (performance.now() - lastWorkspaceRender >= 750) render();
  else { renderTask(); renderBatch(); }
}
async function executeTask(input, operation, inBatch = false) {
  const task = state.task = {...input, status: 'running', updated: Date.now(), code: '', retryAt: 0, autoContinue: true, failedIds: input.failedIds || []};
  if (task.playlist === null) state.batch.search = task;
  else state.tasks[task.playlist] = task;
  render();
  try {
    await save();
    const attempts = new Map();
    while (!stopRequested) {
      try { await operation(task); break; }
      catch (e) {
        const key = e.trackId || `${e.code || 'NETWORK'}:${task.done}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);
        if (task.kind === 'matching' && (itemFailure(e, attempt) || e.code === 'INVALID_TRACK' && e.trackId)) {
          const track = state.tracks.find(t => t.id === e.trackId);
          if (track) { if (!track.choice) track.status = 'review'; track.error = 'SEARCH_FAILED'; }
          if (!task.failedIds.includes(e.trackId)) task.failedIds.push(e.trackId);
          task.done++; await save(); renderProgress(); continue;
        }
        if (task.kind === 'transfer' && e.code === 'ADD_UNCERTAIN' && attempt >= 4) throw e;
        const plan = retryPlan(e, attempt);
        if (!plan.retry) throw e;
        task.code = !navigator.onLine ? 'OFFLINE' : e.code || 'NETWORK'; task.retryAt = plan.at; task.updated = Date.now();
        await save(); renderProgress();
        while (!stopRequested && (!navigator.onLine || Date.now() < task.retryAt)) await delay(500);
        if (stopRequested) break;
        task.code = ''; task.retryAt = 0; await save(); renderProgress();
      }
    }
    task.status = stopRequested && task.done < task.total ? 'paused' : 'complete';
    task.code = ''; task.updated = Date.now(); await save();
    if (!stopRequested && !inBatch) {
      reportSearchFailures(task);
      const duplicates = task.kind === 'transfer' && rowsFor(task.playlist).some(track => track.error === 'YOUTUBE_DUPLICATE');
      notify(task.kind === 'matching' ? 'Matching finished. You can confirm a transfer for ready tracks.' :
        duplicates ? 'Transfer finished. Review tracks that YouTube Music reported as duplicates.' : 'Transfer finished and the recordings were verified in YouTube Music.');
    }
  } catch (e) {
    task.status = 'paused'; task.code = e.code || (!navigator.onLine ? 'OFFLINE' : 'NETWORK'); task.updated = Date.now();
    task.autoContinue = !stopRequested && ['CONNECT_FIRST', 'LOGIN_REQUIRED', 'EXTENSION_MISSING', 'MUSIC_LOADING'].includes(e.code);
    task.retryAt = 0;
    if (!blocked) await save().catch(() => {});
    if (!(inBatch && task.kind === 'transfer' && playlistIssues.has(task.code))) fail(e);
  }
  return task.status === 'complete';
}
function runTask(task, operation) {
  if (unfinishedBatch()) throw error('INPUT', 'Resume or end the library batch before starting another task.');
  return withWorkspaceTask(() => executeTask(task, operation));
}

function reportSearchFailures(task) {
  if (!task?.failedIds.length) return;
  showIssue('SEARCH_ITEMS_FAILED', `Search failed for ${task.failedIds.length} tracks. The other tracks were processed. Search again or paste recording links for the affected tracks.`);
  issueFailedIds = [...task.failedIds]; issueTaskName = task.playlist;
}
async function beforeTask() {
  if (state.task?.status !== 'complete' && state.task?.playlist && state.task.playlist !== state.selected) {
    return confirmAction('Another playlist is paused', `Progress for “${displayName(state.task.playlist)}” is saved. Start a task for this playlist?`, {label: 'Start this playlist'});
  }
  return true;
}
function searchTracks(targets, mode, refresh = true) {
  const results = new Map(), queries = new Map();
  const byId = new Map(targets.map(t => [t.id, t]));
  async function lookup(track) {
    const key = JSON.stringify([track.title, track.artist]);
    if (!queries.has(key)) {
      if (queries.size >= 256) queries.delete(queries.keys().next().value);
      queries.set(key, api('match', {title: track.title, artist: track.artist}).catch(e => {
        queries.delete(key);
        throw e;
      }));
    }
    try { return await queries.get(key); }
    catch (e) { throw Object.assign(error(e.code, e.message), {trackId: track.id, status: e.status, retryAt: e.retryAt}); }
  }
  return async task => {
    const remaining = refresh ? task.trackIds.slice(task.done) : task.trackIds.filter(id => byId.get(id)?.status === 'pending' && !task.failedIds.includes(id));
    for (let offset = 0; offset < remaining.length && !stopRequested; offset += searchWidth) {
      const ids = remaining.slice(offset, offset + searchWidth);
      const window = await Promise.allSettled(ids.map(async id => {
        const track = byId.get(id);
        if (!track || track.status === 'added' || locked(track)) return null;
        if (!results.has(id)) results.set(id, await lookup(track));
        return results.get(id);
      }));
      let failure, changed = false;
      for (const [index, result] of window.entries()) {
        if (result.status === 'rejected') { failure = result.reason; break; }
        const id = ids[index];
        if (result.value) applyMatches(byId.get(id), result.value.candidates || [], mode);
        results.delete(id);
        task.done++; changed = true;
      }
      if (changed) { task.updated = Date.now(); await save(); renderProgress(); }
      // Wait for all in-flight requests and honor a provider cooldown before dispatching more.
      const throttled = window.filter(r => r.status === 'rejected' && r.reason.code === 'THROTTLED')
        .reduce((latest, r) => !latest || r.reason.retryAt > latest.retryAt ? r.reason : latest, null);
      if (throttled || failure) throw throttled || failure;
    }
  };
}
async function prepare(ids = null, showSummary = true) {
  if (state.task?.kind === 'transfer' && state.task.status !== 'complete') { notify('Resume the paused transfer or open its options before starting another search.'); return; }
  if (!await beforeTask()) return;
  const name = state.selected, selection = ids && new Set(ids);
  const targets = rows().filter(t => t.status === 'pending' && (!selection || selection.has(t.id)));
  if (!targets.length) { notify('These tracks have already been searched. Review exceptions or transfer ready tracks.'); return; }
  const previous = state.task?.kind === 'matching' && state.task.playlist === name && state.task.status !== 'complete' ? state.task : null;
  const targetIds = [...new Set([...(previous?.trackIds || []), ...targets.map(t => t.id)])];
  const failedIds = previous?.failedIds || [];
  const done = targetIds.length - targets.filter(t => !failedIds.includes(t.id)).length;
  const complete = await runTask({kind: 'matching', playlist: name, trackIds: targetIds, done, total: targetIds.length, failedIds},
    searchTracks(targets, state.settings.matchMode, false));
  if (showSummary && complete && state.selected === name && rowsFor(name).some(t => t.status === 'ready')) showTransfer();
}
function showResearch() {
  if (!editable()) return;
  $('research-scope').value = 'all'; $('research-manual').checked = true; $('research-deferred').checked = true; $('research-mode').value = 'auto';
  updateResearch(); open('research-dialog');
}
function updateResearch() {
  const targets = researchTargets(rows(), {scope: $('research-scope').value, keepManual: $('research-manual').checked, includeDeferred: $('research-deferred').checked}, locked);
  $('research-summary').textContent = `Search ${targets.length} tracks again. Results update as they arrive and progress is saved.`;
  $('research-submit').disabled = !targets.length || !editable(); $('research-submit').textContent = `Search ${targets.length} tracks`;
}
async function research(ids = null, mode = 'auto', done = 0) {
  if (state.task?.kind === 'transfer' && state.task.status !== 'complete') { notify('Resume the paused transfer or open its options before starting another search.'); return; }
  const name = state.selected, trackIds = ids || researchTargets(rows(), {scope: $('research-scope').value, keepManual: $('research-manual').checked, includeDeferred: $('research-deferred').checked}, locked).map(t => t.id);
  if (!trackIds.length || !await beforeTask()) return;
  const failedIds = done > 0 && state.task?.playlist === name ? state.task.failedIds || [] : [];
  const complete = await runTask({kind: 'matching', playlist: name, trackIds, done, total: trackIds.length, refresh: true, matchMode: mode, failedIds},
    searchTracks(rowsFor(name), mode));
  if (complete) notify('Search finished. Review exceptions or transfer ready tracks.');
}
async function connect() {
  if (connecting) return account;
  connecting = true; renderAccount(); $('connection-result').textContent = 'Checking the signed-in YouTube Music account…';
  try {
    await extension('hello', null, 2000); const result = await extension('connect'); account = result.account;
    const g = state.groups[state.task?.playlist];
    if (unfinishedBatch() && state.batch.code === 'ACCOUNT_CHANGED' && state.batch.account === account.fingerprint) {
      state.batch.autoContinue = true;
      if (state.task) state.task.autoContinue = true;
      await save();
    } else if (state.task?.code === 'ACCOUNT_CHANGED' && g?.account === account.fingerprint) {
      state.task.autoContinue = true; await save();
    }
    $('connection-result').textContent = 'Connected: ' + account.name + ' · Your session stays in this browser.'; if (issueAction === 'connect') clearIssue(); renderAccount(); scheduleAutoResume(); return account;
  } catch (e) { account = null; $('connection-result').textContent = e.message; throw e; }
  finally { connecting = false; renderAccount(); }
}
async function connectButton() {
  if (account && !$('connect-dialog').open) { open('connect-dialog'); return; }
  try { await connect(); if ($('connect-dialog').open) close('connect-dialog'); if ($('transfer-dialog').open) renderTransfer(); notify('Connected as ' + account.name + '.'); }
  catch (e) { open('connect-dialog'); $('connection-result').textContent = e.message; }
}
function showTransfer(targetIds = null) {
  if (!editable()) throw error(blocked ? 'STATE_CONFLICT' : 'BUSY');
  transferIds = rows().filter(t => t.status === 'ready' && (!targetIds || targetIds.includes(t.id))).map(t => t.id);
  if (!transferIds.length) { notify('No selected tracks are ready to transfer.'); return; }
  const g = state.groups[state.selected]; $('destination-name').value = g?.destinationName || displayName(state.selected); $('destination-name').readOnly = !!g;
  $('transfer-error').textContent = ''; renderTransfer(); open('transfer-dialog');
}
function renderTransfer() {
  const targets = rows().filter(t => transferIds.includes(t.id) && t.status === 'ready'), count = uniqueVideos(targets).length, g = state.groups[state.selected], all = summary(rows());
  $('transfer-summary').textContent = `${targets.length} ready tracks · ${count} unique recordings${all.review || all.pending || all.skipped ? ' · Remaining tracks are saved for later' : ''}.`;
  $('transfer-account').textContent = account?.name || 'Connect account first';
  const warnings = [];
  if (count < targets.length) warnings.push('Some tracks point to the same recording. We add it once and update each matching row.');
  if (g?.accountName && g.account !== account?.fingerprint) warnings.push('This task belongs to ' + g.accountName + '. Verify the receiving account before you continue.');
  $('transfer-warnings').hidden = !warnings.length; $('transfer-warnings').textContent = warnings.join(' ');
  $('transfer-detail').textContent = g?.playlistId ? 'We will add the missing tracks to the linked playlist.' : g ? 'We will resume the saved task using its original playlist name.' : 'We will create a private playlist with this name and keep your track order.';
  $('transfer-submit').textContent = account ? 'Confirm transfer' : 'Connect account first'; $('transfer-submit').disabled = !targets.length || !editable() || connecting;
}
async function submitTransfer() {
  $('transfer-error').textContent = '';
  if (!account) { try { await connect(); renderTransfer(); } catch (e) { open('connect-dialog'); $('connection-result').textContent = e.message; } return; }
  const expected = account.fingerprint;
  try {
    await connect(); renderTransfer();
    if (expected !== account.fingerprint) { $('transfer-error').textContent = 'The account changed. Check the name above and confirm the transfer again.'; return; }
    const name = $('destination-name').value.trim(); if (!name || /[<>]/.test(name)) throw error('INPUT', 'Enter a playlist name without angle brackets.');
    const g = state.groups[state.selected]; if (g?.transport === 'extension' && g.account !== account.fingerprint) throw error('ACCOUNT_CHANGED');
    if (!await beforeTask()) return;
    close('transfer-dialog'); await transfer(transferIds, name);
  } catch (e) { $('transfer-error').textContent = e.message; fail(e); }
}
async function transfer(ids, destinationName, name = state.selected, inBatch = false) {
  const selectedIds = new Set(ids);
  const targets = rowsFor(name).filter(t => selectedIds.has(t.id) && ['ready', 'added'].includes(t.status) && t.choice);
  if (!targets.length) return true;
  const run = inBatch ? (task, operation) => executeTask(task, operation, true) : runTask;
  return run({kind: 'transfer', playlist: name, trackIds: targets.map(t => t.id), done: targets.filter(t => t.status === 'added').length, total: targets.length}, async task => {
    if (!account) throw error('CONNECT_FIRST');
    let g = state.groups[name];
    if (!g) { g = state.groups[name] = {marker: crypto.randomUUID().replaceAll('-', ''), playlistId: null, account: account.fingerprint, accountName: account.name, destinationName, transport: 'extension'}; await save(); }
    if (g.transport === 'extension' && g.account !== account.fingerprint) throw error('ACCOUNT_CHANGED');
    const spec = {name: g.destinationName || name, marker: g.marker, account: account.fingerprint, videoIds: uniqueVideos(targets)};
    if (g.playlistId) {
      await extension('job.adopt', {...spec, playlistId: g.playlistId});
      g.account = account.fingerprint; g.accountName = account.name; g.transport = 'extension'; await save();
    }
    let {job} = await extension('job.start', spec);
    const sync = async () => {
      g.playlistId = job.playlistId; g.transport = 'extension';
      // Only confirmed recordings become completed; never infer completion from a write response.
      const confirmed = new Set(job.confirmed), duplicates = new Set(job.duplicates || []);
      for (const t of rowsFor(name)) {
        if (!t.choice || !['ready', 'added'].includes(t.status) && t.error !== 'YOUTUBE_DUPLICATE') continue;
        if (confirmed.has(t.choice.videoId)) { t.status = 'added'; t.error = null; }
        else if (t.status === 'ready' && duplicates.has(t.choice.videoId)) {
          t.status = 'review'; t.error = 'YOUTUBE_DUPLICATE';
        }
      }
      task.done = targets.filter(t => t.status === 'added' || t.error === 'YOUTUBE_DUPLICATE').length; task.updated = Date.now(); await save(); renderProgress();
    };
    await sync();
    while (!stopRequested && job.state !== 'complete') {
      if (!navigator.onLine) throw error('OFFLINE');
      try { ({job} = await extension('job.step', {marker: g.marker})); }
      catch (e) { try { ({job} = await extension('job.status', {marker: g.marker}, 5000)); await sync(); } catch {} throw e; }
      await sync();
    }
    if (job.state === 'complete') {
      task.done = task.total;
      const previous = state.receipts.find(r => r.playlistId === g.playlistId);
      const receipt = {playlistId: g.playlistId, name: g.destinationName, count: uniqueVideos(rowsFor(name).filter(t => t.status === 'added')).length, at: Date.now()};
      if (previous) Object.assign(previous, receipt); else state.receipts.push(receipt); state.receipts = state.receipts.slice(-20);
    }
  });
}
async function resume() {
  if (unfinishedBatch()) return runBatch();
  const task = state.task;
  if (!task || task.status === 'complete') return;
  if (task.retryAt > Date.now()) { notify('Waiting about ' + Math.ceil((task.retryAt - Date.now()) / 1000) + ' seconds before resuming.'); return; }
  if (state.selected !== task.playlist) await chooseCollection(task.playlist);
  if (task.kind === 'matching') {
    if (task.refresh) { await research([...task.trackIds], task.matchMode || 'auto', task.done); return; }
    const ids = task.trackIds.filter(id => state.tracks.some(t => t.id === id && t.status === 'pending'));
    if (!ids.length) { task.status = 'complete'; await save(); render(); return; }
    await prepare(ids);
  } else {
    const ids = [...task.trackIds];
    if (!account) { open('connect-dialog'); notify('Reconnect your account to resume.'); return; }
    await connect(); const g = state.groups[task.playlist];
    if (g?.transport === 'extension' && g.account !== account.fingerprint) throw error('ACCOUNT_CHANGED');
    await transfer(ids, g?.destinationName || displayName(task.playlist));
  }
}
function scheduleAutoResume() {
  clearTimeout(autoTimer);
  const continuation = () => unfinishedBatch() ? state.batch : state.task;
  if (running || autoStarting || blocked || !canAutoContinue(continuation())) return;
  autoTimer = setTimeout(async () => {
    if (running || blocked || !navigator.onLine || !canAutoContinue(continuation())) return;
    autoStarting = true;
    try {
      if (!unfinishedBatch() && state.task.kind === 'transfer' && !account) await connect();
      await resume();
    } catch (e) { fail(e); }
    finally { autoStarting = false; }
  }, Math.max(100, (state.task?.retryAt || 0) - Date.now()));
}

function batchTargets(mode) {
  const tracks = researchTargets(state.tracks, {scope: mode, includeDeferred: false}, locked);
  const groups = new Map();
  for (const track of tracks) {
    if (!groups.has(track.playlist)) groups.set(track.playlist, []);
    groups.get(track.playlist).push(track.id);
  }
  // Rotate across lists so the first requests can serve several different uploads.
  const ids = [];
  for (let active = [...groups.values()], row = 0; active.length; row++) {
    for (const group of active) ids.push(group[row]);
    active = active.filter(group => group.length > row + 1);
  }
  return ids;
}
function renderBatch() {
  const batch = state.batch;
  $('batch-open').hidden = !state.tracks.length;
  $('batch-open').disabled = !editable() || !!unfinishedBatch();
  $('batch-panel').hidden = !batch;
  if (!batch) return;
  const complete = batch.status === 'complete', searching = batch.phase === 'search', task = batchTask();
  const waiting = !complete && task?.retryAt > 0 && (running || canAutoContinue(batch));
  const listErrors = $('batch-errors');
  listErrors.replaceChildren(); listErrors.hidden = !complete || !batch.issues.length;
  if (!listErrors.hidden) for (const name of batch.issues) {
    const item = node('li'), button = node('button', 'text-button', displayName(name));
    button.dir = 'auto'; button.addEventListener('click', async () => {
      try { await chooseCollection(name); if (state.task?.code) showIssue(state.task.code); }
      catch (e) { fail(e); }
    });
    item.append(button); listErrors.append(item);
  }
  const reviewCount = complete ? state.tracks.filter(t => t.status === 'review').length : 0;
  $('batch-stage').textContent = complete ? 'BATCH COMPLETE' : searching ? '1 / SEARCH AND MATCH' : '2 / TRANSFER TO YOUTUBE MUSIC';
  $('batch-title').textContent = complete ? 'Library batch complete' : searching ? 'Searching your library' : displayName(batch.queue[batch.index] || 'Library playlists');
  const done = searching ? task?.done || 0 : batch.index, total = searching ? task?.total || 0 : batch.queue.length;
  $('batch-count').textContent = `${done} / ${total} ${searching ? 'tracks' : 'playlists'}`;
  const current = !searching && !complete && task?.kind === 'transfer' && task.total ? task.done / task.total : 0;
  $('batch-progress').value = total ? 100 * (done + current) / total : Number(complete) * 100;
  $('batch-detail').textContent = complete ? [
    batch.account ? `${batch.index - batch.issues.length} playlists transferred or verified on YouTube Music.` : 'Search results are saved in your library.',
    reviewCount ? `${reviewCount} tracks need review.` : '',
    batch.issues.length ? `${batch.issues.length} playlists were deferred. Select a playlist to see the next step.` : '',
    batch.excluded.length ? `${batch.excluded.length} playlists are linked to another account. Switch accounts to transfer them.` : ''
  ].filter(Boolean).join(' ') : stopRequested ? 'Pausing after the current request is verified.' :
    waiting ? task.code === 'SEARCH_BUSY' ? 'Search is busy. It will resume automatically.' : task.code === 'THROTTLED' ? 'YouTube Music asked us to wait. The batch will resume automatically.' : 'Waiting to retry. The batch will resume automatically.' :
    batch.code ? recovery(batch.code).detail : !running ? 'Progress is saved. Resume to continue.' :
    searching ? `Matching tracks across ${batch.names.length} playlists. Unclear matches stay in review.` :
    `${task?.kind === 'transfer' ? `Processed ${task.done} of ${task.total} tracks in this playlist. ` : ''}The next playlist starts automatically.`;
  $('batch-pause').hidden = complete || !running; $('batch-pause').disabled = stopRequested;
  $('batch-resume').hidden = complete || running || waiting; $('batch-resume').disabled = blocked;
  $('batch-dismiss').hidden = running; $('batch-dismiss').disabled = blocked;
  $('batch-dismiss').textContent = complete ? 'Dismiss summary' : 'End batch';
  $('batch-review').hidden = !complete || !reviewCount || running;
  $('batch-history').hidden = !complete || !batch.account || batch.index <= batch.issues.length || running;
}
function updateBatchDialog() {
  const mode = $('batch-mode').value, transfer = mode !== 'search';
  const count = mode === 'ready' ? 0 : batchTargets($('batch-scope').value).length;
  const ready = state.tracks.filter(t => t.status === 'ready').length;
  $('batch-scope-field').hidden = mode === 'ready';
  $('batch-destination').hidden = !transfer;
  $('batch-account').textContent = account?.name || 'Connect your account';
  $('batch-preview').textContent = `${new Set(state.tracks.map(t => t.playlist)).size} playlists · ${count} to match · ${ready} ready`;
  $('batch-submit').disabled = !editable() || connecting || (!count && (!transfer || !ready));
  $('batch-submit').textContent = transfer ? (account ? 'Confirm and start batch' : 'Connect YouTube Music') : 'Search library';
}
async function startBatch() {
  if (!editable() || unfinishedBatch() || connecting) return;
  const mode = $('batch-mode').value, expected = account?.fingerprint;
  $('batch-error').textContent = '';
  if (mode !== 'search') {
    $('batch-submit').disabled = true;
    try { await connect(); }
    catch (e) { $('batch-error').textContent = e.message; return; }
    finally { updateBatchDialog(); }
    if (!expected || expected !== account.fingerprint) {
      $('batch-error').textContent = 'Check the account above and confirm to start the batch.';
      return;
    }
  }
  const trackIds = mode === 'ready' ? [] : batchTargets($('batch-scope').value);
  const names = [...new Set(state.tracks.map(t => t.playlist))];
  const search = trackIds.length ? {kind: 'matching', playlist: null, status: 'paused', trackIds, done: 0, total: trackIds.length,
    refresh: true, matchMode: state.settings.matchMode, failedIds: []} : null;
  close('batch-dialog');
  await runBatch({phase: 'search', status: 'paused', autoContinue: true, code: '', names, queue: [], index: 0, excluded: [], issues: [], search,
    account: mode === 'search' ? null : account.fingerprint, accountName: mode === 'search' ? '' : account.name});
}
async function runBatch(input = state.batch) {
  if (!input || input.status === 'complete') return;
  if (!editable()) throw error('BUSY');
  const previousTask = input === state.batch ? batchTask() : null;
  if (previousTask?.retryAt > Date.now()) return;
  await withWorkspaceTask(async () => {
    const batch = state.batch = input;
    batch.status = 'running'; batch.autoContinue = true; batch.code = '';
    showCurrentTask(); await save(); render();
    try {
      if (batch.phase === 'search') {
        if (batch.search && batch.search.status !== 'complete') {
          const complete = await executeTask(batch.search, searchTracks(state.tracks, batch.search.matchMode), true);
          if (!complete || stopRequested) return;
        }
        if (!batch.account) { batch.status = 'complete'; return; }
        const ready = new Set(state.tracks.filter(t => t.status === 'ready').map(t => t.playlist));
        const candidates = batch.names.filter(name => ready.has(name));
        batch.excluded = candidates.filter(name => state.groups[name]?.transport === 'extension' && state.groups[name].account !== batch.account);
        const excluded = new Set(batch.excluded);
        batch.queue = candidates.filter(name => !excluded.has(name));
        batch.phase = 'transfer'; showCurrentTask(); await save(); render();
      }
      if (batch.index < batch.queue.length) {
        if (!account) await connect();
        if (account?.fingerprint !== batch.account) throw error('ACCOUNT_CHANGED');
      }
      while (!stopRequested && batch.index < batch.queue.length) {
        const name = batch.queue[batch.index], group = state.groups[name], previous = state.tasks[name];
        if (group?.transport === 'extension' && group.account !== batch.account) throw error('ACCOUNT_CHANGED');
        const ids = rowsFor(name).filter(t => t.status === 'ready').map(t => t.id);
        const pending = previous?.kind === 'transfer' && previous.status !== 'complete' ? previous.trackIds : [];
        const destination = group?.destinationName || displayName(name).replace(/[<>]/g, '').trim() || 'Mood Atlas Playlist';
        const transferred = await transfer([...new Set([...pending, ...ids])], destination, name, true);
        if (!transferred) {
          if (stopRequested || !playlistIssues.has(state.tasks[name]?.code)) return;
          if (!batch.issues.includes(name)) batch.issues.push(name);
        }
        batch.index++; showCurrentTask(); await save(); renderProgress();
      }
      if (batch.index === batch.queue.length) batch.status = 'complete';
    } catch (e) {
      batch.code = e.code || 'INTERNAL';
      batch.autoContinue = ['CONNECT_FIRST', 'LOGIN_REQUIRED', 'EXTENSION_MISSING'].includes(batch.code);
      fail(e);
    } finally {
      if (batch.status !== 'complete') {
        batch.status = 'paused';
        const task = batchTask();
        batch.code ||= task?.status === 'paused' ? task.code : '';
        batch.autoContinue &&= !stopRequested && (task?.status !== 'paused' || task.autoContinue);
      }
      if (!blocked) await save();
      if (batch.status === 'complete') { reportSearchFailures(batch.search); notify('Batch complete. See the summary for results.'); }
    }
  });
}

function review(ids) {
  reviewIds = ids; reviewIndex = 0; showAllCandidates = false; renderReview(); open('review-dialog');
}
function reviewTrack() { return state.tracks.find(t => t.id === reviewIds[reviewIndex]); }
function renderReview() {
  const t = reviewTrack(); if (!t) { close('review-dialog'); return; }
  reviewChoice = t.choice || suggestion(t, state.settings.matchMode); const added = t.status === 'added' || locked(t);
  $('review-position').textContent = `${reviewIndex + 1} / ${reviewIds.length} · ${STATUS[t.status]}`;
  $('review-title').textContent = t.title; $('review-artist').textContent = t.artist || 'Unknown artist';
  $('manual-url').value = ''; $('manual-error').textContent = ''; $('review-info').textContent = locked(t) ? 'This choice belongs to a paused transfer. Resume it or open Transfer options to create a new copy.' : added ? 'This recording was verified in the playlist.' : explain(t, reviewChoice || t.candidates?.[0]).detail;
  $('review-info').classList.toggle('good', added || !!reviewChoice && explain(t, reviewChoice).tone === 'good');
  $('review-prev').disabled = reviewIndex === 0; $('review-next').disabled = reviewIndex === reviewIds.length - 1;
  $('review-undo').hidden = !undo;
  $('retry-match').disabled = added || running; $('manual-save').disabled = added; $('manual-url').disabled = added;
  $('review-edit-controls').hidden = added; $('review-viewlink').hidden = !added;
  if (added && t.choice) $('review-viewlink').href = videoURL(t.choice.videoId);
  $('review-accept').disabled = !reviewChoice || running; $('review-skip').disabled = running;
  $('review-accept').firstChild.textContent = reviewIndex === reviewIds.length - 1 ? 'Approve and finish ' : 'Approve and next ';
  const host = $('candidates'); host.replaceChildren();
  const candidates = [...t.candidates]; if (t.choice && !candidates.some(c => c.videoId === t.choice.videoId)) candidates.unshift(t.choice);
  if (!candidates.length) host.append(node('p', 'candidate-empty', 'No matches saved. Search again or paste the recording link.'));
  const shown = showAllCandidates ? candidates : candidates.slice(0, 3);
  for (const c of shown) {
    const info = explain(t, c), label = node('label', 'candidate' + (reviewChoice?.videoId === c.videoId ? ' selected' : '') + (versionConflict(t, c) ? ' blocked' : ''));
    const input = node('input'); input.type = 'radio'; input.name = 'recording'; input.value = c.videoId; input.checked = reviewChoice?.videoId === c.videoId; input.disabled = added;
    input.setAttribute('aria-label', c.title + ' — ' + c.artist);
    input.addEventListener('change', () => {
      reviewChoice = c; $('review-accept').disabled = false; host.querySelectorAll('.candidate').forEach(n => n.classList.toggle('selected', n.querySelector('input').checked)); $('review-info').textContent = info.detail;
    });
    const body = node('div', 'candidate-body'), title = node('strong', '', c.title), by = node('p', '', [c.artist, c.album, c.duration].filter(Boolean).join(' · ')); title.dir = by.dir = 'auto';
    const meta = node('div', 'candidate-meta'); meta.append(node('span', 'badge ' + info.tone, info.label), link('Listen ↗', videoURL(c.videoId))); body.append(title, by, meta); label.append(input, body); host.append(label);
  }
  $('review-more').hidden = showAllCandidates || candidates.length <= 3;
}
function nextReview() {
  if (reviewIndex < reviewIds.length - 1) { reviewIndex++; showAllCandidates = false; renderReview(); $('review-dialog').scrollTop = 0; }
  else { close('review-dialog'); notify('Review finished. You can transfer the ready tracks.'); }
}
async function acceptReview(choice) {
  const t = reviewTrack(); if (!editable() || !t || t.status === 'added' || locked(t) || !choice) return;
  const before = editSnapshot([t]); Object.assign(t, {choice, status: 'ready', decisionSource: 'manual', error: null});
  await save(); undo = before; render(); nextReview(); notify('Choice saved.', true);
}
function showHistory() {
  const receipts = new Map(state.receipts.map(r => [r.playlistId, r]));
  for (const [name, g] of Object.entries(state.groups)) if (g.playlistId && !receipts.has(g.playlistId)) receipts.set(g.playlistId, {playlistId: g.playlistId, name: g.destinationName || displayName(name), count: uniqueVideos(rowsFor(name).filter(t => t.status === 'added')).length, at: 0});
  const host = $('receipt-list'); host.replaceChildren();
  if (!receipts.size) host.append(node('p', '', 'Transferred playlists will appear here.'));
  for (const r of [...receipts.values()].reverse()) {
    const item = node('div', 'receipt'), info = node('div'), title = node('strong', '', r.name); title.dir = 'auto';
    info.append(title, node('small', '', `${r.count} verified tracks${r.at ? ' · ' + new Intl.DateTimeFormat('en', {day: 'numeric', month: 'short'}).format(r.at) : ''}`));
    item.append(icon('check'), info, link('Open playlist ↗', playlistURL(r.playlistId))); host.append(item);
  }
  open('history-dialog');
}
async function recoverExisting() {
  const g = state.groups[state.selected], id = playlistId($('recover-url').value.trim());
  if (!g || !id) throw error('INPUT', 'Enter a valid YouTube Music playlist link.');
  if (!account) { open('connect-dialog'); return; }
  await connect();
  const {job} = await extension('job.adopt', {name: g.destinationName || state.selected, marker: g.marker, playlistId: id, account: account.fingerprint, videoIds: uniqueVideos(rows().filter(t => t.choice && ['ready', 'added'].includes(t.status)))});
  g.playlistId = job.playlistId; g.account = account.fingerprint; g.accountName = account.name; g.transport = 'extension'; if (state.task?.playlist === state.selected) state.task.autoContinue = true; await save(); close('recover-dialog'); render(); notify('Playlist linked. The saved task will resume automatically.'); scheduleAutoResume();
}
async function newCopy() {
  if (!await confirmAction('Create a new playlist copy?', 'The previous playlist stays in YouTube Music. Review and confirm the new transfer.', {label: 'Prepare a new copy'})) return;
  const g = state.groups[state.selected];
  if (g?.playlistId) state.receipts.push({playlistId: g.playlistId, name: g.destinationName || displayName(state.selected), count: uniqueVideos(rows().filter(t => t.status === 'added')).length, at: Date.now()});
  delete state.groups[state.selected]; for (const t of rows()) if (t.status === 'added' && t.choice) t.status = 'ready';
  if (state.task?.playlist === state.selected) state.task = null;
  delete state.tasks[state.selected];
  clearUndo(); await save(); close('recover-dialog'); render(); if (!unfinishedBatch()) showTransfer();
}
function showUpload() {
  if (!editable()) return;
  if ($('add-dialog').open) close('add-dialog');
  open('upload-dialog');
}
function renderUpload() {
  const preview = $('upload-preview'), errors = $('upload-errors');
  preview.replaceChildren(); errors.replaceChildren();
  for (const list of upload?.lists || []) {
    const item = node('li'), title = node('span', '', list.name); title.dir = 'auto';
    item.append(title, node('small', '', quantity(list.count, 'track'))); preview.append(item);
  }
  for (const message of upload?.errors || []) errors.append(node('li', '', message));
  preview.hidden = !preview.children.length; errors.hidden = !errors.children.length;
  $('upload-status').textContent = readingSheets ? 'Reading spreadsheets…' : upload?.tracks.length ? `${quantity(upload.lists.length, 'playlist')} · ${quantity(upload.tracks.length, 'track')}. Check the preview before adding them.` : '';
  $('upload-actions').hidden = readingSheets || !upload?.tracks.length;
  $('upload-and-plan').hidden = !!unfinishedBatch();
}
async function previewSheets(files) {
  if (!editable() || readingSheets || !files.length) return;
  showUpload(); readingSheets = true;
  upload = {lists: [], tracks: [], errors: []};
  renderUpload();
  const names = new Set();
  let size = 0;
  try {
    for (const file of files.slice(0, 40)) {
      try {
        size += file.size;
        if (size > 30 * 1024 * 1024) { upload.errors.push('Choose up to 30 MB of files per import.'); break; }
        for (const sheet of await readSheets(file)) {
          let name = sheet.name.slice(0, 150), suffix = 2;
          while (names.has(name.toLowerCase())) name = sheet.name.slice(0, 140) + ' (' + suffix++ + ')';
          try {
            const tracks = sheetTracks(sheet, name);
            if (upload.tracks.length + tracks.length > 20000) throw error('INPUT', 'Import up to 20,000 tracks at once.');
            names.add(name.toLowerCase()); upload.lists.push({name, count: tracks.length});
            upload.tracks.push(...tracks);
          } catch (e) { upload.errors.push(`${file.name} · ${sheet.name} — ${e.message}`); }
        }
      } catch (e) { upload.errors.push(`${file.name} — ${e.message}`); }
    }
    if (files.length > 40) upload.errors.push('Only the first 40 files were read. Import the rest in another batch.');
  } finally { readingSheets = false; renderUpload(); }
}
async function submitSheets(plan) {
  if (readingSheets || !upload?.tracks.length) return;
  readingSheets = true;
  try {
    if (!await importTracks(upload.tracks)) return;
    upload = null; close('upload-dialog');
    if (plan) openBatchDialog();
  } catch (e) { upload.errors.push(e.message); }
  finally { readingSheets = false; renderUpload(); }
}
function openBatchDialog() {
  $('batch-mode').value = 'both'; $('batch-scope').value = 'unresolved';
  $('batch-error').textContent = ''; updateBatchDialog(); open('batch-dialog');
}
function previewCSV() {
  $('csv-error').textContent = '';
  try {
    const mapped = mapCSV(csv, Number($('title-column').value), Number($('artist-column').value), Number($('playlist-column').value), $('default-playlist').value);
    const host = $('csv-preview'); host.replaceChildren(); for (const r of mapped.slice(0, 3)) { const row = node('div'), title = node('span', '', r.title); title.dir = 'auto'; row.append(title, node('small', '', r.artist || 'Unknown artist')); host.append(row); }
    if (!mapped.length) host.append(node('div', '', 'No tracks in this column.'));
    $('csv-summary').textContent = `${csv.rows.length} rows · ${mapped.length} valid tracks · Existing tracks are preserved`;
  } catch (e) { $('csv-error').textContent = e.message; }
}

function bind(id, fn, event = 'click') {
  $(id).addEventListener(event, async e => { try { await fn(e); } catch (err) { fail(err); } });
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(b.dataset.close)));
document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => open(b.dataset.open)));
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => setFilter(b.dataset.filter)));
document.querySelectorAll('[data-load-sample]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const response = await fetch('/assets/sample.csv');
    if (!response.ok) throw error('NETWORK', 'Could not load the sample. Try again in a moment.');
    await importTracks(mapCSV(parseCSV(await response.text()), 0, 1, -1, 'First Mix'));
    if ($('add-dialog').open) close('add-dialog');
  } catch (e) { fail(e); } finally { render(); }
}));
bind('collection-search', renderLibrary, 'input'); bind('collection-filter', renderLibrary, 'change');
bind('track-search', () => { page = 0; selected.clear(); renderTracks(); }, 'input');
bind('page-prev', () => { page--; renderTracks(); }); bind('page-next', () => { page++; renderTracks(); });
bind('track-empty-action', () => { $('track-search').value = ''; setFilter('all'); }); bind('deferred-open', () => setFilter('skipped'));
bind('select-page', () => { for (const t of visibleRows()) if (t.status !== 'added' && !locked(t)) $('select-page').checked ? selected.add(t.id) : selected.delete(t.id); renderSelection(); }, 'change');
bind('select-all-tracks', () => { for (const t of rows()) if (t.status !== 'added' && !locked(t)) selected.add(t.id); renderSelection(); });
bind('page-size', () => { displayCount = $('page-size').value; page = 0; renderTracks(); }, 'change');
bind('research-all', showResearch);
bind('batch-open', openBatchDialog);
bind('start-upload', showUpload); bind('upload-open', showUpload); bind('add-sheets', showUpload);
bind('sheet-drop', () => $('sheet-files').click());
bind('sheet-files', async e => {
  const files = [...e.target.files]; e.target.value = '';
  await previewSheets(files);
}, 'change');
bind('sheet-drop', e => { e.preventDefault(); $('sheet-drop').classList.add('dragging'); }, 'dragover');
bind('sheet-drop', () => $('sheet-drop').classList.remove('dragging'), 'dragleave');
bind('sheet-drop', async e => {
  e.preventDefault(); $('sheet-drop').classList.remove('dragging');
  await previewSheets([...e.dataTransfer.files]);
}, 'drop');
bind('upload-submit', () => submitSheets(false)); bind('upload-and-plan', () => submitSheets(true));
bind('batch-mode', updateBatchDialog, 'change');
bind('batch-scope', updateBatchDialog, 'change');
bind('batch-submit', startBatch);
bind('batch-connect-help', () => { close('batch-dialog'); open('connect-dialog'); });
bind('batch-pause', async () => {
  stopRequested = true; state.batch.autoContinue = false; clearTimeout(autoTimer);
  if (state.task) state.task.autoContinue = false;
  await save(); renderBatch();
});
bind('batch-resume', () => runBatch());
bind('batch-dismiss', async () => {
  if (running) return;
  if (unfinishedBatch() && !await confirmAction('End this batch?', 'Completed search results and confirmed transfers will stay saved.', {label: 'End batch'})) return;
  const task = batchTask();
  if (task?.status === 'paused') task.autoContinue = false;
  state.batch = null; showCurrentTask(); await save(); clearIssue(); render();
});
bind('batch-review', () => review(state.tracks.filter(t => t.status === 'review' && !locked(t)).map(t => t.id)));
bind('batch-history', showHistory);
bind('flow-review', () => review(rows().filter(t => t.status === 'review').map(t => t.id)));
['research-scope', 'research-manual', 'research-deferred'].forEach(id => bind(id, updateResearch, 'change'));
bind('research-submit', async () => { const mode = $('research-mode').value; close('research-dialog'); await research(null, mode); });
bind('select-all-results', () => { for (const t of visibleRows()) if (t.status !== 'added' && !locked(t)) selected.add(t.id); renderSelection(); });
bind('clear-selection', () => { selected.clear(); renderSelection(); });
bind('bulk-accept', () => editRows(pickedRows(), 'accept')); bind('bulk-skip', () => editRows(pickedRows(), 'skip'));
bind('bulk-review', () => editRows(pickedRows(), 'review')); bind('bulk-retry', async () => { const ids = pickedRows().map(t => t.id); await editRows(pickedRows(), 'retry'); await prepare(ids); });
bind('bulk-transfer', () => showTransfer([...selected]));
bind('approve-suggestions', () => editRows(rows().filter(t => t.status === 'review'), 'accept')); bind('mode-apply', () => editRows(rows().filter(t => t.status === 'review'), 'accept'));
bind('match-mode', async () => { state.settings.matchMode = $('match-mode').value === 'safe' ? 'safe' : 'auto'; await save(); render(); notify('This mode applies to your next search. Existing choices are preserved.'); }, 'change');
async function action(kind) {
  if (kind === 'resume') await resume(); else if (kind === 'prepare') await prepare(); else if (kind === 'transfer') showTransfer();
  else if (kind === 'review') review(rows().filter(t => t.status === 'review').map(t => t.id)); else if (kind === 'deferred') setFilter('skipped');
  else if (kind === 'complete') window.open(playlistURL(state.groups[state.selected].playlistId), '_blank', 'noopener,noreferrer'); else if (kind === 'history') showHistory(); else open('add-dialog');
}
bind('primary-action', e => action(e.currentTarget.dataset.action)); bind('secondary-action', e => action(e.currentTarget.dataset.action));
bind('pause-btn', async () => { stopRequested = true; state.task.autoContinue = false; clearTimeout(autoTimer); await save(); renderTask(); }); bind('resume-btn', resume); bind('task-goto', () => chooseCollection(state.task.playlist));
bind('task-options', async () => { if (state.selected !== state.task.playlist) await chooseCollection(state.task.playlist); $('recover-error').textContent = ''; open('recover-dialog'); });
bind('review-queue', () => review(rows().filter(t => t.status === 'review').map(t => t.id)));
bind('review-prev', () => { reviewIndex--; showAllCandidates = false; renderReview(); }); bind('review-next', () => { reviewIndex++; showAllCandidates = false; renderReview(); });
bind('review-more', () => { showAllCandidates = true; renderReview(); }); bind('review-accept', () => acceptReview(reviewChoice));
bind('review-undo', async () => { const previous = undo?.[0]?.id; await undoEdit(); const index = reviewIds.indexOf(previous); if (index >= 0) reviewIndex = index; renderReview(); });
bind('review-skip', async () => { await editRows([reviewTrack()], 'skip'); nextReview(); });
bind('manual-save', async () => { const id = videoId($('manual-url').value.trim()); if (!id) { $('manual-error').textContent = 'Paste the link to a single recording.'; return; } const t = reviewTrack(); await acceptReview({videoId: id, title: t.title, artist: t.artist, score: 0, reason: 'manual'}); });
bind('retry-match', async () => {
  const t = reviewTrack(); if (unfinishedBatch() || t.status === 'added' || locked(t) || !editable()) return;
  close('review-dialog'); if (state.selected !== t.playlist) await chooseCollection(t.playlist); await editRows([t], 'retry'); await prepare([t.id], false); review([t.id]);
});
bind('connect-btn', connectButton); bind('verify-account', connectButton);
bind('disconnect-btn', async () => { await extension('disconnect', null, 2000).catch(() => {}); account = null; renderAccount(); $('connection-result').textContent = 'Disconnected from Mood Atlas. Your YouTube Music session and progress are saved.'; });
bind('transfer-submit', submitTransfer);
bind('backup-btn', backup); bind('undo-btn', undoEdit); bind('toast-close', () => $('toast').hidden = true);
bind('issue-dismiss', clearIssue);
bind('issue-action', async () => {
  if (['connect', 'recover', 'failed', 'resume'].includes(issueAction) && issueTaskName && issueTaskName !== state.selected && rowsFor(issueTaskName).length) await chooseCollection(issueTaskName);
  if (issueAction === 'backup') backup(); else if (issueAction === 'connect') open('connect-dialog');
  else if (issueAction === 'failed') { if (issueFailedIds.length) review(issueFailedIds); }
  else if (issueAction === 'reload') { if (running) throw error('BUSY'); await load(); await recoverInterrupted(); $('issue').hidden = false; if (!blocked) $('issue').hidden = true; render(); }
  else if (issueAction === 'recover') { if (state.task?.playlist && state.task.playlist !== state.selected) await chooseCollection(state.task.playlist); $('recover-error').textContent = ''; open('recover-dialog'); }
  else await resume();
});
bind('recover-submit', async () => { $('recover-error').textContent = ''; try { await recoverExisting(); } catch (e) { $('recover-error').textContent = e.message; } });
bind('recover-retry', async () => { close('recover-dialog'); await resume(); }); bind('recover-copy', newCopy);
bind('history-open', showHistory); bind('help-btn', () => open('help-dialog'));
bind('destination-options', () => { $('recover-error').textContent = ''; open('recover-dialog'); });
bind('report-btn', () => download('Mood_Atlas_Report.csv', exportCSV([['Playlist', 'Title', 'Artist', 'Status', 'Matched title', 'Matched artist', 'Video ID', 'Playlist URL'], ...state.tracks.map(t => [t.playlist, t.title, t.artist, STATUS[t.status], t.choice?.title, t.choice?.artist, t.choice?.videoId, state.groups[t.playlist]?.playlistId ? playlistURL(state.groups[t.playlist].playlistId) : ''])]), 'text/csv;charset=utf-8'));
bind('csv-file', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw error('INPUT', 'Choose a file of 10 MB or less.'); csv = parseCSV(await file.text());
  for (const field of ['title', 'artist', 'playlist']) {
    const select = $(field + '-column'); select.replaceChildren(); if (field !== 'title') { const option = node('option', '', 'None'); option.value = '-1'; select.append(option); }
    csv.headers.forEach((header, index) => { const option = node('option', '', header || `Column ${index + 1}`); option.value = String(index); select.append(option); });
    const found = columnIndex(csv.headers, field); if (found >= 0) select.value = String(found);
  }
  $('default-playlist').value = file.name.replace(/\.csv$/i, '').slice(0, 150); $('import-mode').value = 'merge'; previewCSV();
  if ($('add-dialog').open) close('add-dialog'); if ($('upload-dialog').open) close('upload-dialog'); open('mapping-dialog');
}, 'change');
['title-column', 'artist-column', 'playlist-column', 'default-playlist'].forEach(id => bind(id, previewCSV, id === 'default-playlist' ? 'input' : 'change'));
bind('confirm-csv', async () => { $('csv-error').textContent = ''; try { const incoming = mapCSV(csv, Number($('title-column').value), Number($('artist-column').value), Number($('playlist-column').value), $('default-playlist').value); if (await importTracks(incoming, $('import-mode').value === 'replace')) close('mapping-dialog'); } catch (e) { $('csv-error').textContent = e.message; } });
bind('restore-file', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (!editable()) throw error('BUSY'); if (file.size > 15 * 1024 * 1024) throw error('INPUT', 'Choose a backup of 15 MB or less.');
  let clean; try { clean = cleanBackup(JSON.parse(await file.text())); } catch { throw error('INPUT', 'This is not a valid Mood Atlas backup. Your current progress is saved.'); }
  if (state.tracks.length && !await confirmAction('Restore this library?', `${clean.tracks.length} tracks will replace this browser library. Your YouTube Music playlists will remain in your account.`, {backupFirst: true, label: 'Restore backup'})) return;
  const revision = state.revision; Object.assign(state, clean, {revision}); for (const task of Object.values(state.tasks)) if (task.status === 'running') task.status = 'paused';
  if (unfinishedBatch()) { state.batch.status = 'paused'; state.batch.autoContinue = false; }
  if (state.batch?.search?.status === 'running') state.batch.search.status = 'paused';
  showCurrentTask(); clearUndo(); selected.clear(); await save(); render(); notify('Library restored. Connect the original YouTube Music account to resume transfers.');
}, 'change');
bind('library-open', () => { $('library-modal').append($('library-sidebar')); open('library-modal'); }); bind('library-close', () => close('library-modal'));
$('library-modal').addEventListener('close', () => $('app-shell').prepend($('library-sidebar')));
matchMedia('(min-width:901px)').addEventListener('change', e => { if (e.matches && $('library-modal').open) close('library-modal'); });
window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('offline', () => { if (running && state.task) { if (state.task.code !== 'THROTTLED') { state.task.code = 'OFFLINE'; state.task.retryAt = Date.now(); } renderTask(); } else showIssue('OFFLINE'); });
window.addEventListener('online', () => { if (running && state.task?.code === 'OFFLINE') state.task.retryAt = Date.now(); notify('Back online. Saved tasks can resume automatically.'); scheduleAutoResume(); });
async function recoverInterrupted() {
  if (state.batch?.status !== 'running' && !Object.values(state.tasks).some(task => task.status === 'running')) return;
  await navigator.locks.request('mood-atlas-public-import', {ifAvailable: true}, async lock => {
    if (!lock) { blocked = true; showIssue('BUSY'); return; }
    for (const task of Object.values(state.tasks)) if (task.status === 'running') task.status = 'paused';
    if (state.batch?.status === 'running') {
      state.batch.status = 'paused';
      if (state.batch.search?.status === 'running') state.batch.search.status = 'paused';
    }
    await save();
  });
}
try {
  db = await database(); await load(); await recoverInterrupted();
  channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('mood-atlas-public-workspace') : null;
  if (channel) channel.onmessage = async event => {
    if (event.data?.revision <= state.revision) return;
    if (running) { stopRequested = true; showIssue('STATE_CONFLICT'); }
    else {
      try {
        for (const id of ['review-dialog', 'transfer-dialog', 'recover-dialog', 'confirm-dialog', 'batch-dialog', 'upload-dialog']) if ($(id).open) close(id);
        await load(); await recoverInterrupted(); if (!blocked && issueAction === 'reload') $('issue').hidden = true; render();
      } catch (e) { fail(e); }
    }
  };
} catch (e) { blocked = true; fail(e); }
render();
scheduleAutoResume();
extension('hello', null, 1800).then(result => { if (result.account) { account = result.account; renderAccount(); scheduleAutoResume(); } }).catch(() => {});
