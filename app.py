"""Public search for Mood Atlas. The extension handles all signed-in playlist operations."""
from __future__ import annotations

import io
import math
import os
import time
import zipfile
from collections import OrderedDict, deque
from pathlib import Path
from threading import BoundedSemaphore, Lock

import requests
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from matching import search_candidates

ROOT = Path(__file__).resolve().parent
VERSION = '1.0.0'
app = FastAPI(title='Mood Atlas', docs_url=None, redoc_url=None, openapi_url=None)
_search_slots = BoundedSemaphore(8)
_rate_lock = Lock()
_recent_searches: OrderedDict[str, deque[float]] = OrderedDict()
_SEARCH_LIMIT = 240
_SEARCH_WINDOW = 60
_MAX_VISITORS = 2048


class TimeoutSession(requests.Session):
    def request(self, method, url, **kwargs):
        kwargs.setdefault('timeout', 10)
        return super().request(method, url, **kwargs)


class Match(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=500)
    artist: str = Field(default='', max_length=500)


def search_busy(retry_after: int):
    return HTTPException(429, {'code': 'SEARCH_BUSY', 'message': 'Search is busy. Retrying shortly.'},
                         headers={'Retry-After': str(retry_after)})


def limit_search(request: Request):
    # Vercel sets this header at its edge. Local runs use the socket address.
    ip = request.headers.get('x-vercel-forwarded-for') if os.getenv('VERCEL') else None
    ip = ip or (request.client.host if request.client else 'unknown')
    now = time.monotonic()
    with _rate_lock:
        bucket = _recent_searches.setdefault(ip, deque())
        _recent_searches.move_to_end(ip)
        if len(_recent_searches) > _MAX_VISITORS:
            _recent_searches.popitem(last=False)
        while bucket and now - bucket[0] >= _SEARCH_WINDOW:
            bucket.popleft()
        if len(bucket) >= _SEARCH_LIMIT:
            raise search_busy(max(1, math.ceil(_SEARCH_WINDOW - (now - bucket[0]))))
        bucket.append(now)


@app.middleware('http')
async def security(request: Request, call_next):
    if request.method == 'POST':
        origin = request.headers.get('origin')
        host = request.headers.get('host')
        if request.headers.get('x-atlas-request') != '1' or (origin and origin not in {f'http://{host}', f'https://{host}'}):
            return JSONResponse({'detail': 'Use the same-origin Mood Atlas workspace.'}, status_code=403)
        try:
            if int(request.headers.get('content-length', '0')) > 8192:
                return JSONResponse({'detail': 'Search request is too large.'}, status_code=413)
        except ValueError:
            return JSONResponse({'detail': 'Invalid request.'}, status_code=400)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    response.headers['Cache-Control'] = 'no-store' if request.url.path.startswith('/api') or request.url.path == '/' else 'public, max-age=3600'
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse(status_code=422, content={'detail': 'Enter a song title and an optional artist.'})


@app.get('/api/health')
def health():
    return {'ok': True, 'app': 'Mood Atlas', 'version': VERSION}


@app.post('/api/match')
def match(body: Match, request: Request):
    limit_search(request)
    if not _search_slots.acquire(blocking=False):
        raise search_busy(5)
    try:
        from ytmusicapi import YTMusic
        with TimeoutSession() as session:
            ranked = search_candidates(YTMusic(requests_session=session), body.title, body.artist)
        return {'candidates': ranked, 'auto': ranked[0]['videoId'] if ranked and ranked[0]['confident'] else None}
    except Exception as exc:
        code = getattr(getattr(exc, 'response', None), 'status_code', None)
        if code in (401, 403):
            raise HTTPException(502, {'code': 'SEARCH_REJECTED', 'message': 'YouTube Music search is unavailable. Try again later.'}) from None
        if code == 429:
            raise HTTPException(429, 'YouTube Music asked us to slow down.', headers={'Retry-After': '120'}) from None
        raise HTTPException(502, 'Could not reach YouTube Music search. Your progress is saved.') from None
    finally:
        _search_slots.release()


@app.get('/api/extension-download')
def extension_download():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted((ROOT / 'extension').iterdir()):
            if path.is_file() and path.suffix in {'.json', '.js', '.mjs', '.html', '.css'}:
                bundle.write(path, 'Mood-Atlas-Connect/' + path.name)
    return Response(archive.getvalue(), media_type='application/zip', headers={
        'Content-Disposition': f'attachment; filename="Mood-Atlas-Connect-{VERSION}.zip"'
    })


@app.get('/')
def index():
    return FileResponse(ROOT / 'static' / 'index.html')


app.mount('/assets', StaticFiles(directory=ROOT / 'static'), name='assets')
