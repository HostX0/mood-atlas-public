const temporary = new Set(['NETWORK', 'OFFLINE', 'THROTTLED', 'EXTENSION_TIMEOUT', 'MUSIC_LOADING', 'ADD_UNCERTAIN', 'SEARCH_TIMEOUT', 'SEARCH_BUSY', 'BUSY']);
export function retryPlan(error, attempt = 1, now = Date.now()) {
  const code = error.code || 'INTERNAL';
  if (code === 'CREATE_UNCERTAIN') return attempt <= 3 ? {retry: true, at: now + 15000} : {retry: false};
  if (!temporary.has(code)) return {retry: false};
  const interval = code === 'THROTTLED' ? 120000 : Math.min(60000, 2500 * 2 ** Math.min(Math.max(attempt - 1, 0), 5));
  return {retry: true, at: Math.max(now + interval, Number(error.retryAt) || 0)};
}
export function itemFailure(error, attempts) {
  return attempts >= 3 && !!error.trackId && (error.code === 'SEARCH_TIMEOUT' || error.code === 'NETWORK' && error.status >= 500);
}
export const canAutoContinue = task => task?.status === 'paused' && task.autoContinue !== false;
