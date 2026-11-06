// This function runs entirely in the signed-in music.youtube.com tab. Never return headers or cookies.
export async function musicRequest(endpoint, payload, expectedAccount = null) {
  try {
    if (location.origin !== 'https://music.youtube.com' ||
        !['account/account_menu', 'browse', 'playlist/create', 'browse/edit_playlist'].includes(endpoint)) throw new Error('RESPONSE_CHANGED');
    const cfg = key => window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];
    const context = structuredClone(cfg('INNERTUBE_CONTEXT') || {});
    if (!context.client?.clientVersion) throw new Error('MUSIC_LOADING');
    if (cfg('LOGGED_IN') === false) throw new Error('LOGIN_REQUIRED');
    const jar = Object.fromEntries(document.cookie.split(';').map(s => s.trim().split(/=(.*)/s).slice(0, 2)));
    const sapisid = jar.SAPISID || jar['__Secure-3PAPISID'] || jar['__Secure-1PAPISID'];
    if (!sapisid) throw new Error('LOGIN_REQUIRED');
    const digest = async (algorithm, value) => [...new Uint8Array(await crypto.subtle.digest(algorithm,
      new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const identityValue = cfg('DATASYNC_ID') || cfg('DELEGATED_SESSION_ID') || '';
    const identity = identityValue ? await digest('SHA-256', String(identityValue)) : null;
    if (expectedAccount && !identity) throw new Error('ACCOUNT_UNCLEAR');
    if (expectedAccount && await digest('SHA-256', identity) !== expectedAccount) throw new Error('ACCOUNT_CHANGED');
    const stamp = Math.floor(Date.now() / 1000);
    const signature = await digest('SHA-1', `${stamp} ${sapisid} ${location.origin}`);
    context.client.hl = 'en';
    const headers = {'Content-Type': 'application/json', 'Authorization': `SAPISIDHASH ${stamp}_${signature}`,
      'X-Origin': location.origin, 'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? '0'),
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '67'),
      'X-Youtube-Client-Version': context.client.clientVersion};
    if (cfg('DELEGATED_SESSION_ID')) headers['X-Goog-PageId'] = String(cfg('DELEGATED_SESSION_ID'));
    const url = new URL(`/youtubei/v1/${endpoint}`, location.origin);
    url.searchParams.set('prettyPrint', 'false');
    if (cfg('INNERTUBE_API_KEY')) url.searchParams.set('key', cfg('INNERTUBE_API_KEY'));
    const response = await fetch(url, {method: 'POST', credentials: 'include', redirect: 'error',
      headers, body: JSON.stringify({...payload, context}), signal: AbortSignal.timeout(20000)});
    if ([401, 403].includes(response.status)) throw new Error('LOGIN_REQUIRED');
    if (response.status === 429) throw new Error('THROTTLED');
    if (!response.ok) throw new Error(response.status >= 500 ? 'NETWORK' : 'YOUTUBE_REJECTED');
    const data = await response.json();
    if (data?.responseContext?.mainAppWebResponseContext?.loggedOut) throw new Error('LOGIN_REQUIRED');
    if (!data || data.error) throw new Error('YOUTUBE_REJECTED');
    // Channel/session identifiers are hashed locally; no Google authentication material leaves this tab.
    return {ok: true, data, identity};
  } catch (error) {
    const allowed = ['RESPONSE_CHANGED', 'MUSIC_LOADING', 'LOGIN_REQUIRED', 'THROTTLED', 'YOUTUBE_REJECTED', 'ACCOUNT_CHANGED', 'ACCOUNT_UNCLEAR'];
    return {ok: false, code: allowed.includes(error?.message) ? error.message : 'NETWORK'};
  }
}
