"""Live TV tab: the viewer's own IPTV subscription (an M3U playlist link or an Xtream Codes login), next to the
built-in list of free channels.

The server only reads the provider's channel list (text) and keeps it, so a list of thousands of channels can be
paged and searched without sending it all to a TV. Video never goes through the server: each device plays the
provider's stream itself. Some providers send their playlists without a CORS header; then, like the built-in
channels, only the playlist text is passed through (/api/iptv/pl) and the video still comes straight from the
provider. The server never opens a stream on its own (no on-air check), so it doesn't use up one of the
subscription's connections."""
import ipaddress
import json
import os
import re
import socket
import threading
import time
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests

from .config import DATA_DIR, USER_AGENT
from .db import session

IPTV_DIR = os.path.join(DATA_DIR, 'iptv')
os.makedirs(IPTV_DIR, exist_ok=True)

# The channel list is read again when it is older than this (when someone opens it), so new channels appear.
REFRESH_EVERY = 24 * 3600
# Providers' full lists (with films and series) can be large; more than this is refused.
MAX_LIST_BYTES = 80 * 1024 * 1024
TIMEOUT = 40
PAGE = 120

_http = requests.Session()
# Many IPTV panels refuse unknown programs; this is what VLC sends.
_http.headers['User-Agent'] = 'VLC/3.0.20 LibVLC/3.0.20'
_lock = threading.Lock()
_cache = {}  # source id -> (file mtime, channel list)
_refreshing = set()
# Hosts a source's playlists were fetched from (redirects included), allowed for the playlist pass-through.
_hosts = {}


class IptvError(Exception):
    """A message the web app shows as it is (Turkish; the app translates the known ones)."""


# ---------------------------------------------------------------- storage

def _row(sid):
    with session() as c:
        return c.execute("SELECT * FROM iptv_sources WHERE id = ?", (sid,)).fetchone()


def visible(sid, viewer):
    """The source when this viewer may use it (their own, or shared with every device), else None."""
    r = _row(sid)
    return r if r and (r['viewer'] == viewer or r['shared']) else None


def _public(r, viewer):
    info = json.loads(r['info'] or '{}')
    return {'id': r['id'], 'name': r['name'], 'kind': r['kind'], 'count': r['count'] or 0, 'updated': r['updated_at'],
            'shared': bool(r['shared']), 'mine': r['viewer'] == viewer, 'error': r['error'] or '',
            'exp': info.get('exp'), 'max': info.get('max'), 'status': info.get('status'), 'dead': len(_dead(r['id'])),
            'checking': check_status(r['id'])}


def sources(viewer):
    with session() as c:
        rows = c.execute("SELECT * FROM iptv_sources WHERE viewer = ? OR shared = 1 ORDER BY added_at", (viewer,)).fetchall()
    return [_public(r, viewer) for r in rows]


def _list_file(sid):
    return os.path.join(IPTV_DIR, f'{int(sid)}.json')


def _save_list(sid, items):
    tmp = _list_file(sid) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, _list_file(sid))
    with _lock:
        _hosts.pop(sid, None)


def _load_list(sid):
    path = _list_file(sid)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    with _lock:
        hit = _cache.get(sid)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        with open(path, encoding='utf-8') as f:
            items = json.load(f)
    except (OSError, ValueError):
        return []
    with _lock:
        _cache[sid] = (mtime, items)
    return items


# ---------------------------------------------------------------- reading a provider's list

def _check_url(url):
    """Only http(s) links; the cloud metadata address (169.254.x) is never fetched."""
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise IptvError('Bağlantı http:// ya da https:// ile başlamalı.')
    try:
        for info in socket.getaddrinfo(parts.hostname, None):
            if ipaddress.ip_address(info[4][0].split('%')[0]).is_link_local:
                raise IptvError('Bu adres kullanılamaz.')
    except socket.gaierror:
        raise IptvError('Sunucu bulunamadı. Adresi kontrol edin.')


def _get(url, limit=MAX_LIST_BYTES):
    _check_url(url)
    try:
        r = _http.get(url, timeout=TIMEOUT, stream=True)
    except requests.RequestException:
        raise IptvError('IPTV sunucusuna bağlanılamadı.')
    try:
        if r.status_code in (401, 403):
            raise IptvError('IPTV sunucusu girişi kabul etmedi. Kullanıcı adı ve şifreyi kontrol edin.')
        if r.status_code != 200:
            raise IptvError(f'IPTV sunucusu hata verdi ({r.status_code}).')
        data = r.raw.read(limit + 1, decode_content=True)
        if len(data) > limit:
            raise IptvError('Kanal listesi çok büyük.')
        return data.decode('utf-8', 'replace'), r.url
    except (requests.RequestException, OSError):
        raise IptvError('Kanal listesi indirilemedi.')
    finally:
        r.close()


_ATTR = re.compile(r'([\w-]+)="([^"]*)"')
# Films and series in a provider's M3U (Xtream panels list them too); only live channels are kept.
_VOD = re.compile(r'/(movie|series)/', re.I)


def parse_m3u(text):
    if '#EXTM3U' not in text[:4096] and '#EXTINF' not in text[:65536]:
        raise IptvError('Bu bağlantı bir M3U kanal listesi değil.')
    items, cur = [], None
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if ln.startswith('#EXTINF'):
            head, _, name = ln.partition(',')
            attrs = dict(_ATTR.findall(head))
            cur = {'n': (name.strip() or attrs.get('tvg-name') or '').strip(), 'g': attrs.get('group-title', '').strip(),
                   'logo': attrs.get('tvg-logo', '').strip()}
        elif ln.startswith('#EXTGRP:') and cur is not None and not cur['g']:
            cur['g'] = ln[8:].strip()
        elif ln.startswith('#'):
            continue
        elif cur is not None:
            if not _VOD.search(ln) and not re.search(r'\.(mp4|mkv|avi)(\?|$)', ln, re.I):
                items.append({**cur, 'url': ln, 'n': cur['n'] or ln.rsplit('/', 1)[-1]})
            cur = None
    if not items:
        raise IptvError('Listede canlı kanal bulunamadı.')
    return items


def _xtream_base(server):
    server = server.strip().rstrip('/')
    if not re.match(r'https?://', server, re.I):
        server = 'http://' + server
    # People often paste the whole panel link; the base is scheme://host:port.
    p = urlsplit(server)
    return f'{p.scheme}://{p.netloc}'


def read_xtream(server, user, pw):
    base = _xtream_base(server)
    api = f'{base}/player_api.php?username={quote(user)}&password={quote(pw)}'
    text, _ = _get(api, 2 * 1024 * 1024)
    try:
        acc = json.loads(text)
    except ValueError:
        raise IptvError('Bu adres bir Xtream Codes sunucusu değil.')
    ui = acc.get('user_info') or {}
    if not ui or str(ui.get('auth', 1)) == '0':
        raise IptvError('IPTV sunucusu girişi kabul etmedi. Kullanıcı adı ve şifreyi kontrol edin.')
    info = {'status': ui.get('status'), 'max': ui.get('max_connections')}
    try:
        info['exp'] = int(ui['exp_date']) if ui.get('exp_date') else None
    except (TypeError, ValueError):
        info['exp'] = None
    try:
        cats = {str(c.get('category_id')): c.get('category_name', '') for c in json.loads(_get(api + '&action=get_live_categories', 8 * 1024 * 1024)[0]) or []}
        streams = json.loads(_get(api + '&action=get_live_streams')[0]) or []
    except (ValueError, TypeError, AttributeError):
        raise IptvError('Kanal listesi okunamadı.')
    items = []
    for s in streams:
        if not isinstance(s, dict) or not s.get('stream_id'):
            continue
        items.append({'n': str(s.get('name') or '').strip(), 'g': cats.get(str(s.get('category_id')), ''),
                      'logo': str(s.get('stream_icon') or '').strip(),
                      'url': f"{base}/live/{quote(user)}/{quote(pw)}/{s['stream_id']}.m3u8"})
    if not items:
        raise IptvError('Listede canlı kanal bulunamadı.')
    return items, info


def _read_source(r):
    if r['kind'] == 'xtream':
        return read_xtream(r['url'], r['username'], r['password'])
    text, _ = _get(r['url'])
    return parse_m3u(text), {}


def _number(items):
    for i, it in enumerate(items):
        it['no'] = i + 1
    return items


def add(viewer, kind, name, url, username='', password='', shared=False):
    if kind not in ('m3u', 'xtream'):
        raise IptvError('Geçersiz liste türü.')
    url = (url or '').strip()
    if not url or (kind == 'xtream' and not (username and password)):
        raise IptvError('Lütfen tüm alanları doldurun.')
    if kind == 'm3u':
        # An Xtream panel's M3U link (get.php?username=..&password=..): its own API gives the categories and HLS links.
        m = re.search(r'[?&]username=([^&]+).*?[&]password=([^&]+)', url) if '/get.php' in url else None
        if m:
            kind, username, password = 'xtream', unquote(m.group(1)), unquote(m.group(2))
    m3u_url = url
    if kind == 'xtream':
        url = _xtream_base(url)
    try:
        items, info = _read_source({'kind': kind, 'url': url, 'username': username, 'password': password})
    except IptvError:
        if m3u_url == url or (kind == 'xtream' and '/get.php' not in m3u_url):
            raise
        # The panel's API is closed; the M3U link itself still works.
        kind, url, username, password = 'm3u', m3u_url, '', ''
        items, info = _read_source({'kind': kind, 'url': url})
    name = (name or '').strip()[:60] or urlsplit(url if '://' in url else 'http://' + url).hostname or 'IPTV'
    now = time.time()
    with session() as c:
        cur = c.execute("""INSERT INTO iptv_sources (viewer, name, kind, url, username, password, shared, added_at,
            updated_at, count, info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (viewer, name, kind, url, username, password, int(bool(shared)), now, now, len(items), json.dumps(info)))
        sid = cur.lastrowid
    _save_list(sid, _number(items))
    return _public(_row(sid), viewer)


def refresh(sid):
    r = _row(sid)
    if not r:
        return None
    try:
        items, info = _read_source(r)
    except IptvError as e:
        with session() as c:
            c.execute("UPDATE iptv_sources SET error = ? WHERE id = ?", (str(e), sid))
        raise
    _save_list(sid, _number(items))
    with session() as c:
        c.execute("UPDATE iptv_sources SET updated_at = ?, count = ?, info = ?, error = NULL WHERE id = ?",
                  (time.time(), len(items), json.dumps(info), sid))
    return r


def _refresh_quietly(sid):
    try:
        refresh(sid)
    except Exception as e:
        print(f"IPTV listesi yenilenemedi ({sid}): {e}")
    finally:
        _refreshing.discard(sid)


def refresh_if_old(r):
    if time.time() - (r['updated_at'] or 0) > REFRESH_EVERY and r['id'] not in _refreshing:
        _refreshing.add(r['id'])
        threading.Thread(target=_refresh_quietly, args=(r['id'],), daemon=True).start()


def update(sid, viewer, name=None, shared=None):
    r = _row(sid)
    if not r or r['viewer'] != viewer:
        return False
    with session() as c:
        if name is not None and name.strip():
            c.execute("UPDATE iptv_sources SET name = ? WHERE id = ?", (name.strip()[:60], sid))
        if shared is not None:
            c.execute("UPDATE iptv_sources SET shared = ? WHERE id = ?", (int(bool(shared)), sid))
    return True


def remove(sid, viewer):
    r = _row(sid)
    if not r or r['viewer'] != viewer:
        return False
    with session() as c:
        c.execute("DELETE FROM iptv_sources WHERE id = ?", (sid,))
    stop_check(sid)
    for path in (_list_file(sid), _dead_file(sid)):
        try:
            os.remove(path)
        except OSError:
            pass
    with _lock:
        _cache.pop(sid, None)
    return True


# ---------------------------------------------------------------- browsing

def _fold(s):
    return (s or '').replace('ı', 'i').replace('İ', 'i').casefold()


def groups(sid, show_dead=False):
    dead = {} if show_dead else _dead(sid)
    counts, order = {}, []
    for it in _load_list(sid):
        if it['url'] in dead:
            continue
        g = it.get('g') or ''
        if g not in counts:
            counts[g] = 0
            order.append(g)
        counts[g] += 1
    return [{'n': g, 'c': counts[g]} for g in order]


def channels(sid, group=None, q='', offset=0, limit=PAGE, number=None, show_dead=False):
    items = _load_list(sid)
    dead = _dead(sid)
    if number:
        hit = items[number - 1] if 0 < number <= len(items) else None
        return {'items': [hit] if hit else [], 'total': 1 if hit else 0}
    f = _fold(q.strip())
    out = [it for it in items if (group is None or (it.get('g') or '') == group) and (not f or f in _fold(it['n']))
           and (show_dead or it['url'] not in dead)]
    page = [{**it, 'dead': 1} if it['url'] in dead else it for it in out[offset:offset + limit]]
    return {'items': page, 'total': len(out)}


# ---------------------------------------------------------------- broken channels
# A channel whose stream is gone (the provider answers "not found", the server is unreachable, or the playlist is
# empty) is hidden from the list. The mark is kept for DEAD_DAYS, then the channel is shown and checked again, so a
# channel that comes back reappears by itself. Answers that only say "not now" (login refused, too many
# connections, server busy) never hide a channel: with a full connection limit every channel would look broken.

DEAD_DAYS = 7
CHECK_GAP = 1.5  # seconds between two channels, so the provider doesn't see a flood of requests
_dead_cache = {}
_checks = {}  # source id -> {'running', 'done', 'total', 'dead', 'stop'}


def _dead_file(sid):
    return os.path.join(IPTV_DIR, f'{int(sid)}.dead.json')


def _dead(sid):
    with _lock:
        hit = _dead_cache.get(sid)
    if hit is None:
        try:
            with open(_dead_file(sid), encoding='utf-8') as f:
                hit = json.load(f)
        except (OSError, ValueError):
            hit = {}
        cutoff = time.time() - DEAD_DAYS * 86400
        hit = {u: t for u, t in hit.items() if t > cutoff}
        with _lock:
            _dead_cache[sid] = hit
    return hit


def _save_dead(sid, dead):
    with _lock:
        _dead_cache[sid] = dead
    tmp = _dead_file(sid) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(dead, f)
    os.replace(tmp, _dead_file(sid))


def _mark(sid, url, broken):
    dead = dict(_dead(sid))
    if broken:
        dead[url] = time.time()
    elif url in dead:
        del dead[url]
    else:
        return
    _save_dead(sid, dead)


def clear_dead(sid):
    _save_dead(sid, {})


def _hls_link(u):
    """Xtream channels also come as HLS (/live/user/pass/id.m3u8): a few KB of text to read instead of video."""
    m = re.match(r'^(https?://[^/]+)/(?:live/)?([^/]+)/([^/]+)/(\d+)(?:\.ts)?$', u)
    return f'{m.group(1)}/live/{m.group(2)}/{m.group(3)}/{m.group(4)}.m3u8' if m else u


def probe(url):
    """True = on air, False = broken, None = can't tell now. Reads at most a few KB (a playlist, or the first bytes
    of a TS stream) and closes the connection at once."""
    try:
        _check_url(url)
    except IptvError:
        return None
    try:
        r = _http.get(_hls_link(url), timeout=15, stream=True)
    except requests.exceptions.ConnectionError:
        return False
    except requests.RequestException:
        return None
    try:
        if r.status_code in (404, 410):
            return False
        if r.status_code != 200:
            return None
        head = r.raw.read(4096, decode_content=True)
    except (requests.RequestException, OSError):
        return None
    finally:
        r.close()
    if not head:
        return False
    text = head.decode('utf-8', 'replace')
    if '#EXTM3U' in text[:1024]:
        return '#EXTINF' in text or '#EXT-X-STREAM-INF' in text or '.ts' in text or '.m3u8' in text
    return head[:1] == b'\x47' or len(head) >= 1024  # MPEG-TS starts with 0x47


def report_failure(sid, url):
    """A device couldn't play a channel: the server tries it once itself and hides it only if it is really gone."""
    if any(it['url'] == url for it in _load_list(sid)):
        threading.Thread(target=lambda: probe(url) is False and _mark(sid, url, True), daemon=True).start()


def check_status(sid):
    st = _checks.get(sid)
    return {k: st[k] for k in ('running', 'done', 'total', 'dead')} if st else {'running': False}


def start_check(sid, group=None):
    """Checks every channel of the list (or one group) one by one in the background."""
    if _checks.get(sid, {}).get('running'):
        return check_status(sid)
    items = [it for it in _load_list(sid) if group is None or (it.get('g') or '') == group]
    st = _checks[sid] = {'running': True, 'done': 0, 'total': len(items), 'dead': 0, 'stop': False}

    def run():
        try:
            for it in items:
                if st['stop']:
                    break
                ok = probe(it['url'])
                if ok is False:
                    st['dead'] += 1
                if ok is not None:
                    _mark(sid, it['url'], not ok)
                st['done'] += 1
                time.sleep(CHECK_GAP)
        finally:
            st['running'] = False
    threading.Thread(target=run, daemon=True).start()
    return check_status(sid)


def stop_check(sid):
    if sid in _checks:
        _checks[sid]['stop'] = True


# ---------------------------------------------------------------- playlist pass-through

def _base_domain(host):
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        return '.'.join(host.split('.')[-2:])


def _source_domains(sid):
    with _lock:
        known = _hosts.get(sid)
    if known is None:
        known = {_base_domain(urlsplit(it['url']).hostname or '') for it in _load_list(sid)}
        r = _row(sid)
        if r:
            known.add(_base_domain(urlsplit(r['url']).hostname or ''))
        with _lock:
            known = _hosts.setdefault(sid, known)
    return known


def proxy_allowed(sid, url):
    p = urlsplit(url)
    return p.scheme in ('http', 'https') and _base_domain(p.hostname or '') in _source_domains(sid)


_URI_ATTR = re.compile(r'URI="([^"]+)"')


def proxy_playlist(sid, url):
    """A playlist's text with its links made absolute (video segments) or pointed back here (other playlists), so
    a browser can read it without the provider's CORS header. Returns (status, text)."""
    try:
        r = _http.get(url, timeout=20, stream=True)
        try:
            body = r.raw.read(2 * 1024 * 1024, decode_content=True).decode('utf-8', 'replace')
        finally:
            r.close()
    except (requests.RequestException, OSError):
        return 502, ''
    if r.status_code != 200 or '#EXTM3U' not in body[:1024]:
        return r.status_code if r.status_code != 200 else 502, ''
    final = r.url
    host = _base_domain(urlsplit(final).hostname or '')
    with _lock:
        _hosts.setdefault(sid, set()).add(host)  # a provider's load balancer redirects to its stream servers

    def link(u, playlist):
        absolute = urljoin(final, u.strip())
        return f'/api/iptv/pl/{sid}?u={quote(absolute, safe="")}' if playlist else absolute

    out, next_is_playlist = [], False
    for ln in body.splitlines():
        if ln.startswith('#'):
            if ln.startswith('#EXT-X-STREAM-INF'):
                next_is_playlist = True
            is_pl = ln.startswith(('#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF'))
            ln = _URI_ATTR.sub(lambda m: f'URI="{link(m.group(1), is_pl or ".m3u8" in m.group(1))}"', ln)
            out.append(ln)
        elif ln.strip():
            out.append(link(ln, next_is_playlist or '.m3u8' in ln.split('?')[0]))
            next_is_playlist = False
        else:
            out.append(ln)
    return 200, '\n'.join(out) + '\n'
