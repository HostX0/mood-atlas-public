import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pytest
from fastapi.testclient import TestClient
import app as module
from matching import rank_results
HEADERS={'X-Atlas-Request':'1'}
A, B = 'aaaaaaaaaaa', 'bbbbbbbbbbb'


@pytest.fixture
def web(monkeypatch):
    monkeypatch.delenv('VERCEL', raising=False)
    module._recent_searches.clear()
    with TestClient(module.app) as client:
        yield client


class FakeYT:
    def search(self, *args, **kwargs):
        return [{'videoId': A, 'title': 'Aria', 'artists': [{'name': 'Argy'}]}]


def test_anonymous_workspace_and_sample(web):
    page = web.get('/')
    assert page.status_code == 200
    assert '<html lang="en" dir="ltr">' in page.text
    assert 'login-dialog' not in page.text
    assert "script-src 'self'" in page.headers['Content-Security-Policy']
    assert 'set-cookie' not in page.headers
    assert web.get('/api/health').json()['ok']
    assert web.get('/assets/sample.csv').text.splitlines()[0] == 'Title,Artist'
    assert web.get('/assets/Mood-Atlas-Template.xlsx').content.startswith(b'PK')
    assert web.get('/api/catalog').status_code == 404


def test_public_search(web, monkeypatch):
    import ytmusicapi
    monkeypatch.setattr(ytmusicapi, 'YTMusic', lambda **_: FakeYT())
    data = {'title': 'Aria', 'artist': 'Argy'}
    assert web.post('/api/match', json=data).status_code == 403
    assert web.post('/api/match', json=data, headers={**HEADERS, 'Origin': 'https://other.example'}).status_code == 403
    response = web.post('/api/match', json=data, headers=HEADERS)
    assert response.status_code == 200 and response.json()['auto'] == A
    assert 'set-cookie' not in response.headers


def test_public_search_rate_limit(web, monkeypatch):
    import ytmusicapi
    monkeypatch.setattr(ytmusicapi, 'YTMusic', lambda **_: FakeYT())
    monkeypatch.setattr(module, '_SEARCH_LIMIT', 1)
    data = {'title': 'Aria'}
    assert web.post('/api/match', json=data, headers=HEADERS).status_code == 200
    limited = web.post('/api/match', json=data, headers=HEADERS)
    assert limited.status_code == 429
    assert 1 <= int(limited.headers['retry-after']) <= 60
    assert limited.json()['detail']['code'] == 'SEARCH_BUSY'


def test_server_has_no_account_or_write_endpoint(web):
    for route in ['login', 'logout', 'account', 'ensure-playlist', 'add']:
        assert web.post('/api/' + route, json={}, headers=HEADERS).status_code == 404


def test_public_extension_download(web):
    import io, json, zipfile
    response = web.get('/api/extension-download')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        expected = {f'Mood-Atlas-Connect/{path.name}' for path in (module.ROOT / 'extension').iterdir() if path.is_file()}
        assert set(archive.namelist()) == expected
        manifest = json.loads(archive.read('Mood-Atlas-Connect/manifest.json'))
        assert manifest['version'] == module.VERSION
        assert manifest['host_permissions'] == ['https://music.youtube.com/*']
        assert 'https://mood-atlas-public.vercel.app/*' in manifest['content_scripts'][0]['matches']


def test_safe_search_errors(web, monkeypatch):
    import ytmusicapi
    response = web.post('/api/match', json={'title': 'Aria', 'auth': 'test-cookie-marker'}, headers=HEADERS)
    assert response.status_code == 422 and 'test-cookie-marker' not in response.text

    def fail(**_):
        raise RuntimeError('test-cookie-marker')

    monkeypatch.setattr(ytmusicapi, 'YTMusic', fail)
    response = web.post('/api/match', json={'title': 'Aria'}, headers=HEADERS)
    assert response.status_code == 502 and 'test-cookie-marker' not in response.text


def test_match_exact_and_wrong_artist():
 items=[{'videoId':A,'title':'Aria','artists':[{'name':'Argy'}]},{'videoId':B,'title':'Aria','artists':[{'name':'Wrong Singer'}]}];r=rank_results('Aria','Argy',items);assert r[0]['videoId']==A and r[0]['confident'];assert not r[1]['confident']
@pytest.mark.parametrize('version',['Live','Remix','Cover','Karaoke','Slowed','Instrumental'])
def test_versions_need_review(version):
 r=rank_results('Aria','Argy',[{'videoId':A,'title':f'Aria ({version})','artists':[{'name':'Argy'}]}])[0];assert not r['confident'] and r['reason']=='version_difference'
def test_non_latin_and_absent_artist():
 assert rank_results('أغنية عراقية','فنان عراقي',[{'videoId':A,'title':'أغنية عراقية','artists':[{'name':'فنان عراقي'}]}])[0]['confident']
 assert not rank_results('Aria','',[{'videoId':A,'title':'Aria','artists':[{'name':'Argy'}]}])[0]['confident']
def test_malicious_id_ignored():assert rank_results('Title','Artist',[{'videoId':'<script>alert(1)</script>','title':'Title'}])==[]

def test_album_only_karaoke_and_tribute_artist_are_never_automatic():
 for item in [{'videoId':A,'title':'Aria','artists':[{'name':'Argy'}],'album':{'name':'Opera Karaoke'}}, {'videoId':A,'title':'Aria','artists':[{'name':'Argy Tribute Cover Band'}]}]:
  result=rank_results('Aria','Argy',[item])[0]
  assert result['reason']=='version_difference' and not result['autoEligible'] and not result['confident']

def test_primary_artist_credit_and_ambiguous_recordings():
 item={'videoId':A,'title':'Aria','artists':[{'name':'Argy'}]}
 assert rank_results('Aria','Argy, Omnya',[item])[0]['autoEligible']
 result=rank_results('Aria','Argy',[item,{**item,'videoId':B}])
 assert all(not candidate['confident'] for candidate in result)
 assert result[0]['reason']=='ambiguous_recording' and result[0]['autoEligible']

@pytest.mark.parametrize('actual',["La vie en rose (2011 Remastered)","La vie en rose - Remastered 2015","Édith Piaf - La vie en rose (Official Audio)"])
def test_harmless_recording_metadata_does_not_hide_an_exact_match(actual):
 result=rank_results('La vie en rose','Édith Piaf',[{'videoId':A,'title':actual,'artists':[{'name':'Édith Piaf - Topic'}]}])[0]
 assert result['autoEligible'] and result['confident']

def test_credits_can_be_reordered_but_other_artists_and_unavailable_recordings_stay_unapproved():
 item={'videoId':A,'title':'Aria','artists':[{'name':'Omnya'},{'name':'Argy'}]}
 assert rank_results('Aria','Argy, Omnya',[item])[0]['autoEligible']
 assert not rank_results('Aria','Argy',[{**item,'artists':[{'name':'Another Singer'}]}])[0]['autoEligible']
 assert not rank_results('Aria','Argy',[{**item,'isAvailable':False}])[0]['autoEligible']

def test_search_fallback_uses_original_title_and_does_not_replace_partial_results_on_failure():
 from matching import search_candidates
 class Search:
  def __init__(self):self.calls=[]
  def search(self,query,**options):
   self.calls.append((query,options))
   return [] if len(self.calls)==1 else [{'videoId':A,'title':'La vie en rose (Remastered)','artists':[{'name':'Édith Piaf'}]}]
 yt=Search();result=search_candidates(yt,'La vie en rose','Édith Piaf')
 assert result[0]['autoEligible'] and len(yt.calls)==2
 assert yt.calls[1][0]=='La vie en rose' and yt.calls[0][1]['ignore_spelling']


def test_same_title_with_similar_performer_is_not_automatically_approved():
    cover = {'videoId': A, 'title': 'Get Lucky', 'artists': [{'name': 'Funk Punk'}]}
    candidate = rank_results('Get Lucky', 'Daft Punk', [cover])[0]
    assert candidate['reason'] == 'artist_mismatch'
    assert not candidate['autoEligible']
