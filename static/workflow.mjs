export const STATUS = {pending: 'New', ready: 'Ready', review: 'Needs review', added: 'In YouTube Music', skipped: 'Deferred'};
export const searchKey = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
export const displayName = value => String(value || '').replace(/^\d+\s*[|｜]\s*/, '');
export const uniqueVideos = rows => [...new Set(rows.filter(t => t.choice).map(t => t.choice.videoId))];
export const transferLocked = (track, task) => track.status !== 'added' && task?.kind === 'transfer' && task.status !== 'complete' && task.trackIds.includes(track.id);
export function researchTargets(rows, {scope = 'all', keepManual = true, includeDeferred = true} = {}, isLocked = () => false) {
  return rows.filter(t => t.status !== 'added' && !isLocked(t) &&
    (!keepManual || !(t.decisionSource === 'manual' || t.choice?.reason === 'manual')) &&
    (includeDeferred || t.status !== 'skipped') &&
    (scope !== 'unresolved' || ['pending', 'review'].includes(t.status)));
}

export function summary(rows) {
  const result = {total: rows.length, pending: 0, ready: 0, review: 0, added: 0, skipped: 0, missing: 0};
  for (const row of rows) {
    if (Object.hasOwn(STATUS, row.status)) result[row.status]++;
    if (row.status === 'review' && !row.candidates?.length) result.missing++;
  }
  return result;
}

const versionWords = ['live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'sped up', 'slowed', 'nightcore', 'rework'];
function versionMarkers(value) {
  const text = searchKey(value);
  return versionWords.filter(word => new RegExp('\\b' + word + '\\b', 'i').test(text));
}
export function versionConflict(track, candidate) {
  const wanted = new Set(versionMarkers(track.title));
  const offered = new Set(versionMarkers((candidate.title || '') + ' ' + (candidate.album || '')));
  if (/\b(karaoke|tribute|cover band)\b/i.test(candidate.artist || '') && !/\b(karaoke|tribute|cover band)\b/i.test(track.artist || '')) return true;
  return [...offered].some(word => !wanted.has(word)) || [...wanted].some(word => !offered.has(word));
}
export function eligible(track, candidate, mode = 'auto') {
  if (!candidate || versionConflict(track, candidate) || candidate.reason === 'version_difference') return false;
  if (mode === 'safe') return candidate.confident === true;
  // Legacy results lack the new recording checks; only explicit new eligibility can broaden approval.
  return candidate.autoEligible === true || (candidate.reason === 'high_similarity' && candidate.score >= .91);
}
export function suggestion(track, mode = 'auto') {
  return (track.candidates || []).find(candidate => eligible(track, candidate, mode)) || null;
}
export function explain(track, candidate = track.candidates?.[0]) {
  if (track.error === 'YOUTUBE_DUPLICATE') return {label: 'Reported as duplicate', tone: 'warning', detail: 'YouTube Music reported a duplicate. Open the playlist to verify the version, or select another recording.'};
  if (!candidate) return {label: 'No suitable match', tone: 'muted', detail: 'Search again or paste the recording link.'};
  if (candidate.reason === 'unavailable') return {label: 'Unavailable', tone: 'warning', detail: 'YouTube Music reports this recording as unavailable. Choose another result or search again.'};
  if (versionConflict(track, candidate) || candidate.reason === 'version_difference') return {label: 'Different version', tone: 'warning', detail: 'This may be a live recording, remix, or a different version.'};
  if (candidate.reason === 'artist_mismatch') return {label: 'Different artist', tone: 'warning', detail: 'The artist differs from the original track.'};
  if (candidate.confident) return {label: 'Clear match', tone: 'good', detail: 'The song title and artist match, and the recording details appear consistent.'};
  if (eligible(track, candidate)) return {label: 'Suitable match', tone: 'accent', detail: 'This is a suitable recording from the available results. You can choose another.'};
  return {label: 'Needs a closer look', tone: 'warning', detail: 'Review the available details before approving this match.'};
}
export function applyMatches(track, candidates, mode = 'auto') {
  track.candidates = candidates;
  track.choice = suggestion(track, mode);
  track.status = track.choice ? 'ready' : 'review';
  track.decisionSource = track.choice ? (mode === 'safe' ? 'confident' : 'automatic') : null;
  track.error = null;
  return track;
}
export function auditChoices(rows) {
  let changed = 0;
  for (const track of rows) {
    if (track.status !== 'ready' || !track.choice || track.decisionSource === 'manual' || track.choice.reason === 'manual') continue;
    if (versionConflict(track, track.choice) || track.choice.reason === 'version_difference') {
      track.choice = null; track.status = 'review'; track.decisionSource = null; changed++;
    }
  }
  return changed;
}
export function editSnapshot(rows) {
  return rows.map(({id, status, choice, decisionSource, error}) => ({id, status, choice, decisionSource, error}));
}
export function bulkEdit(rows, action, mode = 'auto') {
  let changed = 0, unresolved = 0;
  for (const track of rows) {
    if (track.status === 'added') continue;
    if (action === 'accept') {
      if (track.status === 'ready') continue;
      const choice = suggestion(track, mode);
      if (!choice) { unresolved++; continue; }
      Object.assign(track, {choice, status: 'ready', decisionSource: 'bulk', error: null});
    } else if (action === 'skip') Object.assign(track, {choice: null, status: 'skipped', decisionSource: null, error: null});
    else if (action === 'review') Object.assign(track, {status: 'review', decisionSource: null, error: null});
    else if (action === 'retry') Object.assign(track, {choice: null, status: 'pending', decisionSource: null, error: null});
    else continue;
    changed++;
  }
  return {changed, unresolved};
}
export function filterTracks(rows, filter, query = '') {
  const q = searchKey(query);
  return rows.filter(t => (filter === 'all' || (filter === 'missing' ? t.status === 'review' && !t.candidates?.length : t.status === filter)) &&
    (!q || searchKey(t.title + ' ' + t.artist + ' ' + (t.choice?.title || '')).includes(q)));
}
export function nextStep(rows) {
  const s = summary(rows);
  if (!s.total) return {kind: 'empty', title: 'Add your music', detail: 'Upload a spreadsheet or try the sample.'};
  if (s.ready) return {kind: 'transfer', title: s.ready + ' tracks ready to transfer', detail: [s.pending ? s.pending + ' still to match' : '', s.review ? s.review + ' need review' : ''].filter(Boolean).join(' · ') || 'Review the destination and confirm your transfer.'};
  if (s.pending) return {kind: 'prepare', title: 'Find matches for this playlist', detail: 'Search for each song and approve suitable matches automatically.'};
  if (s.review) return {kind: 'review', title: s.review + ' tracks need review', detail: 'Approve suitable matches together or review individual tracks.'};
  if (s.added) return {kind: 'complete', title: 'Your playlist is ready', detail: s.skipped ? s.skipped + ' deferred tracks are available to review.' : 'Open your playlist in YouTube Music.'};
  return {kind: 'deferred', title: 'Tracks deferred', detail: 'You can return these tracks to review.'};
}
export function recovery(code, fallback = '') {
  if (code === 'SEARCH_ITEMS_FAILED') return {title: 'Some tracks need attention', detail: fallback, action: 'failed', label: 'Review affected tracks'};
  if (code === 'SEARCH_REJECTED') return {title: 'YouTube Music search is unavailable', detail: 'Your choices are saved. Try the search again later.', action: 'resume', label: 'Retry search'};
  if (['LOGIN_REQUIRED', 'CONNECT_FIRST', 'EXTENSION_RELOADED', 'MUSIC_LOADING', 'EXTENSION_MISSING', 'EXTENSION_TIMEOUT'].includes(code)) return {title: 'Connect YouTube Music', detail: fallback || 'Open YouTube Music in the same Chrome profile and reconnect. Your progress is saved.', action: 'connect', label: 'Reconnect'};
  if (code === 'ACCOUNT_CHANGED') return {title: 'The YouTube Music account changed', detail: 'Switch to the account linked to this task in YouTube Music, then verify it here.', action: 'connect', label: 'Verify account'};
  if (code === 'THROTTLED') return {title: 'YouTube Music requested a pause', detail: 'Progress is saved. The transfer can resume after the wait.', action: 'resume', label: 'Resume'};
  if (code === 'CREATE_UNCERTAIN') return {title: 'Link your existing playlist', detail: 'Open your YouTube Music library and paste the playlist link so Mood Atlas can verify it and resume.', action: 'recover', label: 'Link existing playlist'};
  if (['WRONG_PLAYLIST', 'JOB_CONFLICT'].includes(code)) return {title: 'This playlist could not be verified', detail: 'Verify the existing playlist in Transfer options or choose to start a new copy.', action: 'recover', label: 'Transfer options'};
  if (code === 'BUSY') return {title: 'A task is running in another tab', detail: 'Continue in that tab, or refresh progress here after it finishes.', action: 'reload', label: 'Refresh progress'};
  if (code === 'STORAGE' || code === 'STATE_CONFLICT') return {title: code === 'STORAGE' ? 'Progress could not be saved' : 'Progress changed in another tab', detail: code === 'STORAGE' ? 'Download a backup before closing, then use a browser that allows local storage.' : 'Refresh progress before making more changes.', action: code === 'STORAGE' ? 'backup' : 'reload', label: code === 'STORAGE' ? 'Download backup' : 'Refresh progress'};
  if (code === 'YOUTUBE_REJECTED') return {title: 'YouTube Music rejected an addition', detail: 'Check that the recording is available in YouTube Music, then try again. Confirmed tracks are saved.', action: 'resume', label: 'Retry transfer'};
  if (code === 'ADD_UNCERTAIN') return {title: 'The addition could not be verified', detail: 'Open the playlist in YouTube Music to check it. Resuming adds only the missing tracks.', action: 'resume', label: 'Verify and resume'};
  if (code === 'OFFLINE') return {title: 'Waiting for a connection', detail: 'Keep this tab open. The saved task will resume when you are back online.', action: 'resume', label: 'Check again'};
  return {title: code === 'ADD_UNCERTAIN' ? 'The addition could not be verified' : 'This task is paused', detail: fallback || 'Progress is saved. Resuming checks the playlist before adding tracks.', action: 'resume', label: 'Resume'};
}
