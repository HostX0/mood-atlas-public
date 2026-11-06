"""Conservative Unicode-aware ranking, not a probability of correctness."""
from __future__ import annotations
import re
import unicodedata
from difflib import SequenceMatcher

MIN_ARTIST_SIMILARITY = .80
VERSION_WORDS = ('live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'sped up', 'slowed', 'nightcore', 'rework')
DECORATION = re.compile(r'\b(official\s*(music\s*)?(video|audio)|audio\s+officiel|clip\s+officiel|official\s+visuali[sz]er)\b', re.I)
REMASTER = re.compile(r'\b(?:(?:19|20)\d{2}\s+)?(?:re[ -]?master(?:ed|ing)?|remasteris[eé](?:e)?)(?:\s+(?:version|stereo|mono))?(?:\s+(?:19|20)\d{2})?\b', re.I)
METADATA = re.compile(r'^(?:(?:official|music|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|officiel|version|stereo|mono|digital|digitally|remaster(?:ed)?|remasteris[eé])|\d{4}|[\s.,:!–—-])+$', re.I)

def normalise(text: str) -> str:
    text = unicodedata.normalize('NFKD', str(text or '')).casefold()
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return re.sub(r'[^\w]+', ' ', text).strip()

def title_norm(text: str) -> str:
    text = REMASTER.sub(' ', str(text or ''))
    text = re.sub(r'[\(\[]([^\)\]]*)[\)\]]', lambda m: ' ' if not m[1].strip() or METADATA.fullmatch(m[1].strip()) else m[0], text)
    text = DECORATION.sub(' ', text)
    text = re.sub(r'\s*[-–—|]\s*(?:lyrics?|visuali[sz]er|hd|hq|4k)\s*$', '', text, flags=re.I)
    return normalise(text)

def artist_norm(text: str) -> str:
    text = re.sub(r'(?:\s*[-–—]\s*Topic|\s*VEVO|\s+Official)\s*$', '', str(text or ''), flags=re.I)
    return normalise(text)

def recording_title(text: str, names: list[str]) -> str:
    # Video titles often credit the performer on either side of a separator.
    parts = re.split(r'\s+[-–—|:]\s+', text)
    known = {artist_norm(name) for name in names}
    if len(parts) > 1 and artist_norm(parts[0]) in known: parts.pop(0)
    if len(parts) > 1 and artist_norm(parts[-1]) in known: parts.pop()
    return ' - '.join(parts)

def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0

def rank_candidate(title: str, artist: str, item: dict) -> dict:
    actual_title = str(item.get('title') or '')
    names = [str(a.get('name') or '') for a in (item.get('artists') or []) if isinstance(a, dict)]
    joined = ', '.join(names)
    wanted_title, got_title = title_norm(title), title_norm(recording_title(actual_title, names))
    t = similarity(wanted_title, got_title)
    artist_n = artist_norm(artist)
    wanted_artists = [artist_norm(x) for x in re.split(r',|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+', artist, flags=re.I) if x.strip()]
    scores = [similarity(artist_n, artist_norm(joined))] + [similarity(artist_n, artist_norm(x)) for x in names]
    if len(wanted_artists) > 1:
        scores.extend(similarity(wanted_artists[0], artist_norm(name)) for name in names)
    a = max(scores, default=0.0)
    album = str((item.get('album') or {}).get('name', '')) if isinstance(item.get('album'), dict) else ''
    # Version evidence can appear only in the album (for example, Opera Karaoke).
    recording_text = normalise(actual_title + ' ' + album)
    versions = [w for w in VERSION_WORDS if (bool(re.search(r'\b'+w+r'\b', wanted_title)) != bool(re.search(r'\b'+w+r'\b', recording_text)))]
    if re.search(r'\b(karaoke|tribute|cover band)\b', normalise(joined)) and not re.search(r'\b(karaoke|tribute|cover band)\b', artist_n):
        versions.append('performer_substitution')
    score = .72*t + .28*a
    if versions: score = max(0, score-.22)
    confident = bool(artist_n) and t >= .90 and a >= MIN_ARTIST_SIMILARITY and score >= .91 and not versions
    available = item.get('isAvailable') is not False
    confident = confident and available
    automatic = bool(artist_n) and t >= .86 and a >= MIN_ARTIST_SIMILARITY and score >= .85 and not versions and available
    reason = 'unavailable' if not available else 'version_difference' if versions else ('artist_mismatch' if artist_n and a < MIN_ARTIST_SIMILARITY else ('high_similarity' if confident else 'review_required'))
    return {'videoId': item['videoId'], 'title': actual_title, 'artist': joined,
            'album': album,
            'duration': item.get('duration') or '', 'score': round(score, 3),
            'confident': confident, 'autoEligible': automatic, 'reason': reason,
            'url': 'https://music.youtube.com/watch?v=' + item['videoId']}

def rank_results(title: str, artist: str, items: list[dict]) -> list[dict]:
    unique = {}
    for item in items:
        vid = item.get('videoId')
        if isinstance(vid, str) and re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
            result = rank_candidate(title, artist, item)
            if vid not in unique or result['score'] > unique[vid]['score']: unique[vid] = result
    ranked = sorted(unique.values(), key=lambda x: x['score'], reverse=True)[:8]
    ambiguous = len(ranked) > 1 and ranked[0]['score'] - ranked[1]['score'] < .04
    for index, candidate in enumerate(ranked):
        if index or ambiguous:
            candidate['confident'] = False
            if candidate['reason'] == 'high_similarity': candidate['reason'] = 'ambiguous_recording'
    return ranked

def search_candidates(yt, title: str, artist: str) -> list[dict]:
    primary = re.split(r',|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+', artist, flags=re.I)[0].strip()
    query = f'{primary} {title}'.strip()
    items = yt.search(query, filter='songs', limit=12, ignore_spelling=True) or []
    ranked = rank_results(title, artist, items)
    if ranked and ranked[0]['autoEligible']: return ranked
    searches = [(title, 'songs'), (query, 'videos')]
    for text, category in searches:
        try:
            items += yt.search(text, filter=category, limit=12, ignore_spelling=True) or []
        except Exception:
            # Keep useful results if an optional fallback fails; propagate a total failure.
            if not items: raise
            break
        ranked = rank_results(title, artist, items)
        if ranked and ranked[0]['autoEligible']: break
    return ranked
