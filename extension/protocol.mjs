export const PROTOCOL = 'mood-atlas-public-connect-v1';
export const RELEASE = '1.0.0';
export const APP_ORIGIN = 'https://mood-atlas-public.vercel.app';
export const LOCAL_ORIGIN = 'http://127.0.0.1:8765';
export function allowedOrigin(value) {
  try { const u = new URL(value); return [APP_ORIGIN, LOCAL_ORIGIN].includes(u.origin) && !u.username && !u.password; }
  catch { return false; }
}
export function requireSender(sender) {
  if (!sender.tab?.id || sender.frameId !== 0 || !allowedOrigin(sender.url) ||
      new URL(sender.tab.url).origin !== new URL(sender.url).origin) throw new Error('UNTRUSTED_ORIGIN');
  return new URL(sender.url).origin;
}
export function validateJob(value) {
  if (!value || !/^[a-f0-9]{32}$/.test(value.marker) || typeof value.name !== 'string' ||
      !value.name.trim() || value.name.length > 150 || /[<>]/.test(value.name) ||
      !/^[a-f0-9]{64}$/.test(value.account) || !Array.isArray(value.videoIds) ||
      !value.videoIds.length || value.videoIds.length > 20000 ||
      value.videoIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id))) throw new Error('INVALID_JOB');
  return {marker: value.marker, name: value.name.trim(), account: value.account,
    videoIds: [...new Set(value.videoIds)]};
}
export function validateMarker(marker) {
  if (typeof marker !== 'string' || !/^[a-f0-9]{32}$/.test(marker)) throw new Error('INVALID_JOB');
  return marker;
}
export const messages = {
  UNTRUSTED_ORIGIN: 'This site cannot use Mood Atlas Connect.',
  INVALID_JOB: 'The transfer data is invalid. Refresh Mood Atlas and try again.',
  LOGIN_REQUIRED: 'Sign in to YouTube Music in this Chrome profile, then connect your account in Mood Atlas.',
  MUSIC_LOADING: 'YouTube Music is still loading. Wait a moment and connect again.',
  CONNECT_FIRST: 'Connect your YouTube Music account. Your progress is saved.',
  ACCOUNT_CHANGED: 'Switch to the YouTube Music account linked to this task to resume the transfer.',
  ACCOUNT_UNCLEAR: 'Open the account menu in YouTube Music to verify the active channel, then reconnect.',
  NETWORK: 'The YouTube Music connection was interrupted. The transfer can resume from its last saved step.',
  THROTTLED: 'YouTube Music requested a pause. The transfer will retry after the wait.',
  YOUTUBE_REJECTED: 'YouTube Music rejected the request. Check the receiving account and try again.',
  RESPONSE_CHANGED: 'YouTube Music returned an incomplete or unexpected response. Progress is saved.',
  WRONG_PLAYLIST: 'Could not verify that this playlist belongs to the saved transfer.',
  CREATE_UNCERTAIN: 'Playlist creation is unconfirmed. Resume to look for the existing playlist.',
  ADD_UNCERTAIN: 'The addition could not be verified. Resume to check the existing tracks.',
  JOB_NOT_FOUND: 'This browser has no saved transfer for that playlist.',
  JOB_CONFLICT: 'The task is linked to another account or playlist.',
  BUSY: 'A transfer request is already running. Wait for it to finish.',
  PAUSED: 'The transfer is paused. Progress is saved.',
  INTERNAL: 'Could not complete the request. Reconnect and resume. Progress is saved.'
};
export function safeFailure(error) {
  const code = Object.hasOwn(messages, error?.message) ? error.message : 'INTERNAL';
  return {ok: false, code, error: messages[code]};
}
