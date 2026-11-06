export function* objects(value) {
  if (!value || typeof value !== 'object') return;
  yield value;
  for (const child of Object.values(value)) yield* objects(child);
}
export function first(value, key) {
  for (const obj of objects(value)) if (obj[key] && typeof obj[key] === 'object') return obj[key];
  return null;
}
const text = value => value?.simpleText ?? value?.runs?.map(r => r.text || '').join('') ?? '';
function tokenOf(value) {
  const tokens = new Set();
  for (const obj of objects(value)) {
    const token = obj.nextContinuationData?.continuation || obj.continuationCommand?.token;
    if (token) tokens.add(token);
  }
  if (tokens.size > 1) throw new Error('RESPONSE_CHANGED');
  return [...tokens][0] || null;
}
export async function parseAccount(reply) {
  const header = first(reply.data, 'activeAccountHeaderRenderer');
  const name = text(header?.accountName), handle = text(header?.channelHandle);
  if (!name || (!handle && !reply.identity)) throw new Error('ACCOUNT_UNCLEAR');
  const identity = reply.identity || handle;
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))].map(b => b.toString(16).padStart(2, '0')).join('');
  return {name: name.slice(0, 200), handle: handle.slice(0, 200), fingerprint};
}
function continuationItems(data) {
  return first(data, 'appendContinuationItemsAction')?.continuationItems;
}
export function libraryPage(data) {
  const grid = first(data, 'gridRenderer') || first(data, 'gridContinuation');
  const rows = grid?.items || continuationItems(data);
  if (!Array.isArray(rows)) throw new Error('RESPONSE_CHANGED');
  const playlists = [];
  for (const row of rows) {
    const item = row.musicTwoRowItemRenderer || row.musicResponsiveListItemRenderer;
    if (!item) continue;
    const id = item.navigationEndpoint?.browseEndpoint?.browseId;
    const title = text(item.title) || text(item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
    if (id?.startsWith('VL') && title) playlists.push({id: id.slice(2), title});
  }
  return {playlists, continuation: tokenOf(grid || rows)};
}
export function playlistPage(data, initial = true) {
  const editable = first(data, 'musicEditablePlaylistDetailHeaderRenderer');
  const header = editable ? first(editable, 'musicResponsiveHeaderRenderer') : null;
  const shelf = first(data, 'musicPlaylistShelfRenderer') || first(data, 'musicPlaylistShelfContinuation');
  const emptyMessage = text(first(data, 'messageRenderer')?.text);
  const subtitle = text(header?.secondSubtitle) + ' ' + text(header?.subtitle);
  const explicitlyEmpty = /(?:no (?:songs|tracks|videos)|playlist is empty|empty playlist|add songs)/i.test(emptyMessage) || /\b0 (?:songs|tracks|videos)\b/i.test(subtitle);
  const rows = shelf?.contents || continuationItems(data) || (initial && shelf && editable && explicitlyEmpty ? [] : null);
  if (!Array.isArray(rows) || (initial && !editable)) throw new Error(initial ? 'WRONG_PLAYLIST' : 'RESPONSE_CHANGED');
  const ids = [];
  for (const row of rows) {
    if (row.continuationItemRenderer) continue;
    const item = row.musicResponsiveListItemRenderer;
    if (!item) throw new Error('RESPONSE_CHANGED');
    const id = item.playlistItemData?.videoId;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id)) ids.push(id);
    else if (item.musicItemRendererDisplayPolicy !== 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT') throw new Error('RESPONSE_CHANGED');
  }
  const description = text(first(header, 'musicDescriptionShelfRenderer')?.description);
  return {ids, description, continuation: tokenOf(shelf || rows)};
}
export class YouTubeClient {
  constructor(request) { this.request = request; }
  async account() { return parseAccount(await this.request('account/account_menu', {})); }
  async playlist(id, marker) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.readPlaylist(id, marker); }
      catch (error) {
        if (!['WRONG_PLAYLIST', 'RESPONSE_CHANGED'].includes(error.message) || attempt === 2) throw error;
        // YouTube can acknowledge creation before the editable header and empty shelf are visible.
        await new Promise(resolve => setTimeout(resolve, 900));
      }
    }
  }
  async readPlaylist(id, marker) {
    const result = new Set(), seen = new Set();
    let data = (await this.request('browse', {browseId: 'VL' + id})).data;
    let page = playlistPage(data);
    if (!page.description.includes(`[mood-atlas:${marker}]`)) throw new Error('WRONG_PLAYLIST');
    for (let n = 0; n < 200; n++) {
      for (const vid of page.ids) result.add(vid);
      if (!page.continuation) return result;
      if (seen.has(page.continuation)) throw new Error('RESPONSE_CHANGED');
      seen.add(page.continuation);
      data = (await this.request('browse', {continuation: page.continuation})).data;
      page = playlistPage(data, false);
    }
    throw new Error('RESPONSE_CHANGED');
  }
  async find(name, marker) {
    let page = libraryPage((await this.request('browse', {browseId: 'FEmusic_liked_playlists'})).data);
    const seen = new Set(), candidates = [];
    for (let n = 0; n < 200; n++) {
      candidates.push(...page.playlists.filter(p => p.title === name));
      if (!page.continuation) break;
      if (n === 199 || seen.has(page.continuation)) throw new Error('RESPONSE_CHANGED');
      seen.add(page.continuation);
      page = libraryPage((await this.request('browse', {continuation: page.continuation})).data);
    }
    const matches = [];
    for (const p of candidates) {
      try { await this.playlist(p.id, marker); matches.push(p.id); }
      catch (error) { if (error.message !== 'WRONG_PLAYLIST') throw error; }
    }
    if (matches.length > 1) throw new Error('JOB_CONFLICT');
    return matches[0] || null;
  }
  async create(name, marker) {
    const {data} = await this.request('playlist/create', {title: name, privacyStatus: 'PRIVATE',
      description: `Imported with Mood Atlas.\n[mood-atlas:${marker}]`});
    if (typeof data.playlistId !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(data.playlistId)) throw new Error('CREATE_UNCERTAIN');
    return data.playlistId;
  }
  async add(id, videos) {
    const videoIds = Array.isArray(videos) ? videos : [videos];
    const {data} = await this.request('browse/edit_playlist', {playlistId: id,
      actions: videoIds.map(videoId => ({action: 'ACTION_ADD_VIDEO', addedVideoId: videoId}))});
    if (data.status === 'STATUS_SUCCEEDED') return;
    const dialog = first(data, 'confirmDialogRenderer');
    const messages = (Array.isArray(dialog?.dialogMessages) ? dialog.dialogMessages : []).map(text);
    const duplicateDialog = text(dialog?.title) === 'Duplicates' && messages.some(message => /already in your playlist/i.test(message));
    const duplicateNotice = Array.isArray(data.actions) && data.actions.some(action => {
      const notification = action.addToToastAction?.item?.notificationActionRenderer;
      return /^this track is already in (?:the|your) playlist[.!]?$/i.test(text(notification?.responseText).trim());
    });
    if (duplicateDialog || duplicateNotice) throw new Error('DUPLICATE_TRACK');
    throw new Error('ADD_UNCERTAIN');
  }
}
