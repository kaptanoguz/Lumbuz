import gzip
import json
import os
import re
import secrets
import subprocess
import threading
import time
from collections import defaultdict

from urllib.parse import quote

from flask import Flask, Response, abort, g, jsonify, render_template, request, send_file

from . import activity, clipmeta, clips, downloads, iptv, library, livetv, media, metadata, online, state, subsync, subtitles
from .config import BASE_DIR, ONLINE_EMBED, POSTERS_DIR
from .db import LOCAL_VIEWER, library_dirs, load_settings, save_settings, session
from .names import EXTRA_BASE, extra_title, fold, sequel_key
from .version import get_version

app = Flask(__name__, template_folder=os.path.join(BASE_DIR, 'templates'),
            static_folder=os.path.join(BASE_DIR, 'static'))
settings = load_settings()
library.settings_ref = settings
downloads.set_limit(settings.get('download_mbps', downloads.DEFAULT_MBPS))
downloads.set_per_device(settings.get('download_per_device', downloads.DEFAULT_PER_DEVICE))


VIEWER_COOKIE = 'hf_viewer'


_LEAD_WORDS = {'and', 'the', 'of', 'a', 'an', '&', 'in', 'to', 'for', 'vs', 'vs.'}


def _common_words(titles):
    """The words every title starts with ('Toy Story', 'Toy Story 2' -> 'Toy Story'), without dangling 'and', 'the'..."""
    split = [t.split() for t in titles if t]
    if len(split) != len(titles) or not split:
        return ''
    n = 0
    for words in zip(*split):
        if len({w.lower() for w in words}) > 1:
            break
        n += 1
    out = split[0][:n]
    while out and (out[-1].lower().strip(':-–,.') in _LEAD_WORDS or not out[-1].strip(':-–,.')):
        out.pop()
    return ' '.join(out).strip(' :-–,.')


def request_lang():
    """'en' when this device's web app is switched to English (it keeps the choice in the hf_lang cookie), else 'tr'."""
    return 'en' if request.cookies.get('hf_lang') == 'en' else 'tr'


def epcode(season, episode):
    return f"S{season}:{'E' if request_lang() == 'en' else 'B'}{episode}"


def viewer():
    """Whose watch history this request reads and writes: the server computer, or the device's own cookie id."""
    if 'viewer' not in g:
        if is_local_request():
            g.viewer = LOCAL_VIEWER
        else:
            vid = request.cookies.get(VIEWER_COOKIE, '')
            if len(vid) != 32 or not all(ch in '0123456789abcdef' for ch in vid):
                vid = g.new_viewer = secrets.token_hex(16)
            g.viewer = vid
    return g.viewer


_seen = {}  # viewer -> (time written, ip, user agent): last_seen goes to the database at most once a minute


@app.before_request
def identify():
    vid = viewer()
    # Remember the device for Settings › Connected devices, and log its visit. A request without the cookie yet is
    # recorded only when it opens the app or downloads a file (a player that sends no cookies would otherwise add a new
    # device with every request); the cookie it gets now makes its next requests count as the same device.
    p = request.path
    if vid == LOCAL_VIEWER or not (p == '/' or p.startswith(('/api/', '/download/'))):
        return
    if 'new_viewer' in g and p != '/' and not p.startswith('/download/'):
        return
    now, ip, ua = time.time(), client_ip(), request.headers.get('User-Agent', '')[:300]
    activity.visit(vid, ip)
    last = _seen.get(vid)
    if last and now - last[0] < 60 and last[1:] == (ip, ua):
        return
    _seen[vid] = (now, ip, ua)
    try:
        with session() as c:
            c.execute("INSERT INTO devices (viewer, ua, ip, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) "
                      "ON CONFLICT(viewer) DO UPDATE SET ua = excluded.ua, ip = excluded.ip, last_seen = excluded.last_seen",
                      (vid, ua, ip, now, now))
    except Exception:
        pass


@app.after_request
def finish(response):
    p = request.path
    if 'new_viewer' in g:
        response.set_cookie(VIEWER_COOKIE, g.new_viewer, max_age=10 * 365 * 86400, samesite='Lax', httponly=True)
    if p == '/' or p.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    elif p.startswith('/img/') and response.status_code == 200:
        response.headers['Cache-Control'] = 'public, max-age=86400'
    elif p.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache'
    if (response.mimetype in ('application/json', 'text/vtt', 'text/html', 'text/css', 'application/javascript',
                              'text/javascript')
            and not response.direct_passthrough and 'gzip' in request.headers.get('Accept-Encoding', '')
            and response.status_code == 200 and 'Content-Encoding' not in response.headers):
        data = response.get_data()
        if len(data) > 1400:
            response.set_data(gzip.compress(data, 5))
            response.headers['Content-Encoding'] = 'gzip'
            response.headers['Vary'] = 'Accept-Encoding'
    return response


def _pv(poster):
    p = library.poster_file(poster)
    return int(os.path.getmtime(p)) if p else 0


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- library

KIDS_GENRES = ('Animasyon', 'Aile', 'Çocuk')
NOT_KIDS_GENRES = ('Korku', 'Suç', 'Savaş', 'Gerilim')
KIDS_RATINGS = {'US': {'G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'},
                'TR': {'G', '0+', '6+', '7+', '6A', '7A'}}
TEEN_RATINGS = {'US': {'G', 'PG', 'PG-13', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'},
                'TR': {'G', '0+', '6+', '7+', '6A', '7A', '10+', '10A', '13+', '13A'}}
# Hand-picked additions / removals (TMDb ids), editable in the config table as JSON lists.
KIDS_INCLUDE_DEFAULT = [671, 672, 673, 674, 675, 767, 12444, 12445, 522402]   # Harry Potter 1-8, Finch
KIDS_EXCLUDE_SERIES_DEFAULT = [228853, 122186]                                # Prens, Doğu


def _rating_in(cert, table):
    country, _, rating = (cert or '').partition(':')
    return rating in table.get(country, ()) or (country == 'TR' and rating.lower().startswith('genel'))


def is_kids(genre, cert, tmdb_id=0, include=(), exclude=()):
    """Kids Zone: 1 for animation/family rated G/PG (or unrated Family), 2 for PG/PG-13 comedies and hand-picked
    titles (ages up to ~13), 0 otherwise. Horror/crime/war/thriller never qualify. The page shows 1 and 2 together."""
    genre = genre or ''
    if tmdb_id and tmdb_id in exclude:
        return 0
    if tmdb_id and tmdb_id in include:
        return 1 if _rating_in(cert, KIDS_RATINGS) else 2
    if any(g in genre for g in NOT_KIDS_GENRES):
        return 0
    if any(g in genre for g in KIDS_GENRES) and (_rating_in(cert, KIDS_RATINGS) if cert else 'Aile' in genre):
        return 1
    if 'Komedi' in genre and 'Romantik' not in genre and cert and _rating_in(cert, TEEN_RATINGS):
        return 2
    return 0


def kids_lists():
    """(movie include, movie exclude, series include, series exclude) TMDb id sets; movie and TV ids are separate."""
    import json
    defaults = {'kids_include': KIDS_INCLUDE_DEFAULT, 'kids_exclude': [], 'kids_include_series': [],
                'kids_exclude_series': KIDS_EXCLUDE_SERIES_DEFAULT}
    with session() as c:
        conf = {r['key']: r['value'] for r in c.execute(
            f"SELECT key, value FROM config WHERE key IN ({','.join('?' * len(defaults))})", list(defaults))}
    out = []
    for key, default in defaults.items():
        try:
            out.append(set(json.loads(conf[key])) if key in conf else set(default))
        except ValueError:
            out.append(set(default))
    return tuple(out)


def build_library(lang='tr'):
    with session() as c:
        movies = c.execute("SELECT id, title, original_title, year, rating, genre, plot, runtime, added_at, size, "
                           "tmdb_id, collection_id, poster, backdrop, cert, title_en, plot_en FROM movies").fetchall()
        shows = c.execute("SELECT s.*, COUNT(e.id) AS eps FROM series s LEFT JOIN episodes e ON e.series_id = s.id "
                          "GROUP BY s.id").fetchall()
        ep_keys = defaultdict(set)
        for e in c.execute("SELECT series_id, season, episode FROM episodes"):
            ep_keys[e['series_id']].add((e['season'], e['episode']))
        cols = {r['id']: r for r in c.execute("SELECT * FROM collections")}
    kids_in, kids_out, kids_in_tv, kids_out_tv = kids_lists()

    out_movies = []
    by_col = defaultdict(list)
    loose = []
    for m in movies:
        item = {'id': m['id'], 't': m['title'], 'ot': m['original_title'] or '', 'y': m['year'] or '',
                'r': m['rating'] if m['rating'] not in (None, '', 'N/A') else '', 'g': m['genre'] or '',
                'p': m['plot'] or '', 'rt': m['runtime'] or 0, 'add': m['added_at'] or 0, 'sz': m['size'] or 0,
                'tm': m['tmdb_id'] or 0, 'ph': _pv(m['poster']), 'bd': bool(m['backdrop']), 'c': None,
                'k': is_kids(m['genre'], m['cert'], m['tmdb_id'], kids_in, kids_out)}
        item['_en'] = (m['title_en'], m['plot_en'])
        out_movies.append(item)
        if m['collection_id'] and m['collection_id'] in cols:
            by_col[m['collection_id']].append(item)
        else:
            loose.append(item)

    collections = []

    def add_collection(cid, name, items, overview='', parts=0, poster=False, backdrop=False):
        distinct = {i['tm'] or f"id{i['id']}" for i in items}
        if len(distinct) < 2:
            return
        items.sort(key=lambda i: (i['y'] or '9999', i['t']))
        for i in items:
            i['c'] = cid
        collections.append({'id': cid, 'name': name, 'ov': overview, 'parts': parts, 'poster': poster,
                            'backdrop': backdrop, 'items': [i['id'] for i in items], 'owned': len(distinct)})

    for cid, items in by_col.items():
        col = cols[cid]
        add_collection(cid, col['name'] or items[0]['t'], items, col['overview'] or '', col['parts'] or 0,
                       bool(col['poster']), bool(col['backdrop']))

    groups = defaultdict(list)
    exact = {}
    for i in loose:
        key = sequel_key(i['t'])
        if key:
            groups[key[0]].append(i)
        exact.setdefault(fold(i['t']).strip(), []).append(i)
    for base, items in groups.items():
        items = items + [i for i in exact.get(base, []) if i not in items]
        if len({fold(i['t']) for i in items}) < 2:
            continue
        first = min(items, key=lambda i: (i['y'] or '9999'))
        name = next((i['t'] for i in items if fold(i['t']).strip() == base), None) or \
            ' '.join(first['t'].split()[:len(base.split())])
        add_collection(f"h-{base.replace(' ', '-')}", name, items)
    by_id = {i['id']: i for i in out_movies}
    if lang == 'en':
        for col in collections:
            row = cols.get(col['id'])
            if row is not None:  # a TMDb collection
                col['name'] = row['name_en'] or col['name']
                col['ov'] = row['overview_en'] or col['ov']
            else:  # a group made from the titles: the words its English titles share
                col['name'] = _common_words([(by_id[x]['_en'][0] or '').strip() for x in col['items']]) or col['name']
    for i in out_movies:
        t_en, p_en = i.pop('_en')
        if lang == 'en':
            i['t'] = t_en or i['t']
            i['p'] = p_en or i['p']
    collections.sort(key=lambda c: fold(c['name']))

    show_groups = defaultdict(list)
    for s in shows:
        show_groups[f"t{s['tmdb_id']}" if s['tmdb_id'] else f"i{s['id']}"].append(s)
    out_series = []
    for group in show_groups.values():
        group.sort(key=lambda s: -s['eps'])
        s = group[0]
        keys = set().union(*(ep_keys[g['id']] for g in group))
        out_series.append({
            'id': s['id'], 'ids': [g['id'] for g in group],
            't': (s['title_en'] if lang == 'en' and s['title_en'] else s['display_title'] or s['title']),
            'ot': s['original_title'] or '', 'y': s['year'] or '',
            'r': s['rating'] if s['rating'] not in (None, '', 'N/A') else '',
            'g': s['genre'] or '',
            'p': ((s['plot_en'] or s['plot'] or '') if lang == 'en' else s['plot'] or ''),
            'add': max(g['added_at'] or 0 for g in group), 'tm': s['tmdb_id'] or 0,
            'ph': _pv(s['poster']), 'bd': bool(s['backdrop']),
            'eps': len([k for k in keys if k[0]]) or len(keys), 'seasons': len({k[0] for k in keys if k[0]}) or 1, 'k': is_kids(s['genre'], s['cert'], s['tmdb_id'], kids_in_tv, kids_out_tv)})
    return {'movies': out_movies, 'series': out_series, 'collections': collections,
            'version': state.snapshot()['version']}


@app.route('/')
def index():
    # The newest of the page's own files, so browsers fetch them again after an update.
    v = max(os.path.getmtime(os.path.join(BASE_DIR, 'static', f)) for f in ('app.js', 'i18n.js', 'app.css'))
    return render_template('index.html', v=int(v))


@app.route('/api/library')
def api_library():
    return jsonify(build_library(request_lang()))


@app.route('/api/status')
def api_status():
    return jsonify(state.snapshot())


@app.route('/api/series/<int:sid>')
def api_series(sid):
    with session() as c:
        s = c.execute("SELECT * FROM series WHERE id = ?", (sid,)).fetchone()
        if not s:
            abort(404)
        ids = [sid]
        if s['tmdb_id']:
            ids += [r['id'] for r in c.execute("SELECT id FROM series WHERE tmdb_id = ? AND id != ?", (s['tmdb_id'], sid))]
        order = {v: i for i, v in enumerate(ids)}
        rows = c.execute(f"SELECT id, series_id, season, episode, filename, ep_name, ep_overview, ep_name_en, ep_overview_en, "
                         f"still, runtime FROM episodes "
                         f"WHERE series_id IN ({','.join('?' * len(ids))})", ids).fetchall()
        rows = sorted(rows, key=lambda e: (e['season'], e['episode'], order[e['series_id']], e['filename']))
        seen, eps = set(), []
        for e in rows:
            if (e['season'], e['episode'], e['filename']) in seen:
                continue
            seen.add((e['season'], e['episode'], e['filename']))
            eps.append(e)
        en = request_lang() == 'en'
        fetched = {r['season'] for r in c.execute(
            f"SELECT season FROM season_fetch WHERE series_id = ? AND {'en_at' if en else 'fetched_at'} IS NOT NULL", (sid,))}
        prog = {r['key']: r for r in c.execute("SELECT * FROM progress WHERE viewer = ? AND key LIKE 'e:%'", (viewer(),))}
    seasons = defaultdict(list)
    for e in eps:
        p = prog.get(f"e:{e['id']}")
        # English mode shows the English name and description; until they are fetched, the Turkish ones.
        name = (e['ep_name_en'] if en else '') or e['ep_name'] or ''
        if not name and e['season'] == 0 and e['episode'] >= EXTRA_BASE:
            name = extra_title(e['filename'])
        seasons[e['season']].append({
            'id': e['id'], 'n': e['episode'], 'x': e['episode'] >= EXTRA_BASE, 'name': name, 'file': e['filename'],
            'ov': (e['ep_overview_en'] if en else '') or e['ep_overview'] or '', 'still': bool(e['still']), 'rt': e['runtime'] or 0,
            'pos': p['position'] if p else 0, 'dur': p['duration'] if p else 0, 'fin': bool(p and p['finished']),
            'at': p['updated_at'] if p else 0})
    pending = []
    if s['tmdb_id']:
        pending = [n for n in seasons if n not in fetched]
        for n in pending:
            threading.Thread(target=metadata.fetch_season, args=(sid, s['tmdb_id'], n, ids, 'en' if en else 'tr'),
                             daemon=True).start()
    # Season 0 (specials and extras) comes last.
    order_s = sorted(seasons, key=lambda n: (n == 0, n))
    return jsonify({'id': sid, 'seasons': [{'n': n, 'eps': seasons[n]} for n in order_s], 'pending': bool(pending)})


@app.route('/api/credits/<kind>/<int:iid>')
def api_credits(kind, iid):
    table = {'m': 'movies', 's': 'series'}.get(kind)
    if not table:
        abort(404)
    with session() as c:
        r = c.execute(f"SELECT tmdb_id, tagline_en FROM {table} WHERE id = ?", (iid,)).fetchone()
    if not r:
        abort(404)
    data = metadata.credits('movie' if kind == 'm' else 'tv', r['tmdb_id']) if r['tmdb_id'] else {}
    if data is None:
        abort(503)
    if request_lang() == 'en' and r['tagline_en']:
        data = {**data, 'tagline': r['tagline_en']}
    if data.get('prov'):
        data = {**data, 'prov': metadata.with_ids(data['prov'])}
    return jsonify(data)


@app.route('/api/platforms')
def api_platforms():
    """Streaming platforms with the library's titles on them (TMDb ids), for the platform pages."""
    return jsonify(metadata.platforms())


# ---------------------------------------------------------------- user state

def sibling_ids(c, series_id):
    r = c.execute("SELECT tmdb_id FROM series WHERE id = ?", (series_id,)).fetchone()
    if not r or not r['tmdb_id']:
        return [series_id]
    return [x['id'] for x in c.execute("SELECT id FROM series WHERE tmdb_id = ?", (r['tmdb_id'],))]


def next_episode(c, e):
    ids = sibling_ids(c, e['series_id'])
    q = ','.join('?' * len(ids))
    # Autoplay stays within the episodes or within the extras: the last episode doesn't roll into the specials.
    if e['season'] == 0:
        return c.execute(f"SELECT * FROM episodes WHERE series_id IN ({q}) AND season = 0 AND episode > ? "
                         f"ORDER BY episode, id LIMIT 1", (*ids, e['episode'])).fetchone()
    return c.execute(f"SELECT * FROM episodes WHERE series_id IN ({q}) AND (season > ? OR (season = ? AND episode > ?)) "
                     f"ORDER BY season, episode, id LIMIT 1", (*ids, e['season'], e['season'], e['episode'])).fetchone()


@app.route('/api/user')
def api_user():
    with session() as c:
        prog = {r['key']: [round(r['position'] or 0), round(r['duration'] or 0), r['finished'] or 0, r['updated_at'] or 0]
                for r in c.execute("SELECT * FROM progress WHERE viewer = ? AND key LIKE 'm:%'", (viewer(),))}
        mylist = [r['key'] for r in c.execute("SELECT key FROM mylist WHERE viewer = ? ORDER BY added_at DESC", (viewer(),))]
        # Online titles on My List, with the TMDb info remembered when they were opened.
        listed = {}
        for key in mylist:
            k = online.parse_key(key)
            if k and key[:3] in ('om:', 'os:'):
                info = online.known(c, k[0], k[1], request_lang())
                if info:
                    listed[key] = info
    return jsonify({'progress': prog, 'mylist': mylist, 'continue': continue_watching(), 'online': listed,
                    'embed': ONLINE_EMBED})


def continue_watching():
    out = []
    en = request_lang() == 'en'
    with session() as c:
        rows = c.execute("SELECT * FROM progress WHERE viewer = ? ORDER BY updated_at DESC LIMIT 60", (viewer(),)).fetchall()
        seen_series = set()
        for r in rows:
            if r['key'].startswith('o'):
                entry = _online_continue(c, r, seen_series)
                if entry:
                    out.append(entry)
                if len(out) >= 20:
                    break
                continue
            kind, _, sid = r['key'].partition(':')
            if not sid.isdigit():
                continue
            iid = int(sid)
            if kind == 'm':
                if r['finished'] or (r['position'] or 0) < 60:
                    continue
                m = c.execute("SELECT id, title, title_en FROM movies WHERE id = ?", (iid,)).fetchone()
                if m:
                    out.append({'kind': 'm', 'id': iid, 'mid': iid, 'title': (m['title_en'] if en else '') or m['title'], 'sub': '',
                                'pos': r['position'], 'dur': r['duration'], 'at': r['updated_at']})
            elif kind == 'e':
                e = c.execute("SELECT e.*, COALESCE(s.display_title, s.title) AS stitle, s.title_en AS stitle_en FROM episodes e "
                              "JOIN series s ON s.id = e.series_id WHERE e.id = ?", (iid,)).fetchone()
                if not e:
                    continue
                group = tuple(sibling_ids(c, e['series_id']))
                if group in seen_series:
                    continue
                seen_series.add(group)
                target, pos, dur = e, r['position'], r['duration']
                if r['finished'] or (r['position'] or 0) < 60:
                    if not r['finished']:
                        continue
                    target = next_episode(c, e)
                    if not target:
                        continue
                    pos, dur = 0, 0
                label = epcode(target['season'], target['episode'])
                ep_name = (target['ep_name_en'] if en else '') or target['ep_name']
                if ep_name:
                    label += f" · {ep_name}"
                out.append({'kind': 'e', 'id': target['id'], 'sid': e['series_id'],
                            'title': (e['stitle_en'] if en else '') or e['stitle'], 'sub': label,
                            'pos': pos, 'dur': dur, 'at': r['updated_at'], 'up_next': target['id'] != e['id']})
            if len(out) >= 20:
                break
    return out


def _online_continue(c, r, seen_series):
    """Continue Watching entry for an online movie ('om:') or episode ('oe:'), or None."""
    k = online.parse_key(r['key'])
    if not k or r['key'].startswith('os:'):
        return None
    kind, tm, s, e = k
    info = online.known(c, kind, tm, request_lang())
    if not info:
        return None
    base = {'kind': 'o' + ('m' if kind == 'm' else 'e'), 'tm': tm, 'pkey': r['key'], 'title': info.get('t', ''),
            'ob': info.get('ob', ''), 'op': info.get('op', ''), 'pos': r['position'], 'dur': r['duration'],
            'at': r['updated_at'], 's': s, 'e': e, 'sub': ''}
    if kind == 'm':
        if r['finished'] or (r['position'] or 0) < 60:
            return None
        return base
    if ('o', tm) in seen_series:
        return None
    seen_series.add(('o', tm))
    up_next = False
    if r['finished'] or (r['position'] or 0) < 60:
        if not r['finished']:
            return None
        nxt = online.next_episode(info, s, e)
        if not nxt:
            return None
        s, e = nxt
        up_next = True
        base.update(pos=0, dur=0)
    return {**base, 's': s, 'e': e, 'sub': f"S{s}:B{e}", 'up_next': up_next}


@app.route('/api/progress', methods=['POST'])
def api_progress():
    d = request.get_json(force=True, silent=True) or {}
    key, pos, dur = d.get('key', ''), _num(d.get('position')), _num(d.get('duration'))
    online_ok = key[:3] in ('om:', 'oe:') and online.parse_key(key)
    if not online_ok and (key[:1] not in ('m', 'e') or ':' not in key):
        abort(400)
    finished = 1 if dur > 0 and (pos >= dur * 0.93 or dur - pos < 90) else 0
    with session() as c:
        c.execute("INSERT OR REPLACE INTO progress (viewer, key, position, duration, finished, updated_at) "
                  "VALUES (?, ?, ?, ?, ?, ?)", (viewer(), key, 0 if finished else pos, dur, finished, time.time()))
    if pos > 0:
        activity.watch(viewer(), client_ip(), key, lambda: item_title(key), pos, dur)
    return jsonify({'ok': True, 'finished': bool(finished)})


def item_title(key):
    """'Film (2020)', 'Dizi S1:B2' or an Online title, for the activity log. '' when it is not known."""
    try:
        kind, _, rest = key.partition(':')
        with session() as c:
            if kind == 'm':
                r = c.execute("SELECT title, year FROM movies WHERE id = ?", (int(rest),)).fetchone()
                return f"{r['title']} ({r['year']})" if r and r['year'] else (r['title'] if r else '')
            if kind == 'e':
                r = c.execute("SELECT e.season, e.episode, COALESCE(s.display_title, s.title) AS st FROM episodes e "
                              "JOIN series s ON s.id = e.series_id WHERE e.id = ?", (int(rest),)).fetchone()
                return f"{r['st']} S{r['season']:02d}E{r['episode']:02d}" if r else ''
            pk = online.parse_key(key)
            if pk:
                info = online.known(c, pk[0], pk[1]) or {}
                name = info.get('t') or info.get('ot') or ''
                return f"{name} S{pk[2]:02d}E{pk[3]:02d}" if name and pk[0] == 's' and pk[2] else name
    except Exception:
        pass
    return ''


@app.route('/api/progress/<key>', methods=['DELETE'])
def api_progress_delete(key):
    with session() as c:
        c.execute("DELETE FROM progress WHERE viewer = ? AND key = ?", (viewer(), key))
    return jsonify({'ok': True})


@app.route('/api/mylist', methods=['POST'])
def api_mylist():
    d = request.get_json(force=True, silent=True) or {}
    key = d.get('key', '')
    online_ok = key[:3] in ('om:', 'os:') and online.parse_key(key)
    if not online_ok and key[:1] not in ('m', 's'):
        abort(400)
    with session() as c:
        if d.get('on'):
            c.execute("INSERT OR IGNORE INTO mylist (viewer, key, added_at) VALUES (?, ?, ?)", (viewer(), key, time.time()))
        else:
            c.execute("DELETE FROM mylist WHERE viewer = ? AND key = ?", (viewer(), key))
    return jsonify({'ok': True})


@app.route('/api/migrate', methods=['POST'])
def api_migrate():
    """Imports v1 favourites/resume positions that lived in the browser's localStorage."""
    d = request.get_json(force=True, silent=True) or {}
    now = time.time()
    with session() as c:
        for fav in d.get('favorites') or []:
            fav = str(fav)
            if fav.startswith('m_') and fav[2:].isdigit():
                c.execute("INSERT OR IGNORE INTO mylist (viewer, key, added_at) VALUES (?, ?, ?)", (viewer(), f"m:{fav[2:]}", now))
            elif fav.startswith('s_'):
                r = c.execute("SELECT id FROM series WHERE title = ? OR CAST(id AS TEXT) = ?", (fav[2:], fav[2:])).fetchone()
                if r:
                    c.execute("INSERT OR IGNORE INTO mylist (viewer, key, added_at) VALUES (?, ?, ?)", (viewer(), f"s:{r['id']}", now))
        for vid, pos in (d.get('positions') or {}).items():
            if not str(vid).isdigit() or _num(pos) < 30:
                continue
            kind = 'm' if c.execute("SELECT 1 FROM movies WHERE id = ?", (int(vid),)).fetchone() else 'e'
            c.execute("INSERT OR IGNORE INTO progress (viewer, key, position, duration, finished, updated_at) "
                      "VALUES (?, ?, ?, 0, 0, ?)", (viewer(), f"{kind}:{vid}", _num(pos), now))
    return jsonify({'ok': True})


# ---------------------------------------------------------------- playback

def media_path(kind, iid):
    table = {'m': 'movies', 'e': 'episodes', 'v': 'music_videos'}.get(kind)
    if not table:
        abort(404)
    with session() as c:
        r = c.execute(f"SELECT path FROM {table} WHERE id = ?", (iid,)).fetchone()
    if not r or not os.path.exists(r['path']):
        abort(404)
    return r['path']


@app.route('/api/media/<kind>/<int:iid>')
def api_media(kind, iid):
    path = media_path(kind, iid)
    info = media.probe(path)
    en = request_lang() == 'en'
    out = {'kind': kind, 'id': iid, 'direct': info['direct'], 'duration': info['duration'], 'audio': info['audio'],
           'subs': [s for s in info['subs'] if s['text']],
           'local_subs': [{'index': s['index'], 'label': s['label'], 'lang': s['lang']} for s in subtitles.local_subtitles(path)],
           'auto_sub': bool(subtitles.auto_cached(path)),
           'video': info['video'], 'file': os.path.basename(path), 'size': os.path.getsize(path)}
    with session() as c:
        p = c.execute("SELECT * FROM progress WHERE viewer = ? AND key = ?", (viewer(), f"{kind}:{iid}")).fetchone()
        out['resume'] = p['position'] if p and not p['finished'] else 0
        if kind == 'v':
            v = c.execute("SELECT artist, title FROM music_videos WHERE id = ?", (iid,)).fetchone()
            out.update(title=v['title'], sub=v['artist'] or '', resume=0)
        elif kind == 'm':
            m = c.execute("SELECT title, year, title_en FROM movies WHERE id = ?", (iid,)).fetchone()
            out.update(title=(m['title_en'] if en else '') or m['title'], sub=m['year'] or '')
        else:
            e = c.execute("SELECT e.*, COALESCE(s.display_title, s.title) AS stitle, s.title_en AS stitle_en FROM episodes e "
                          "JOIN series s ON s.id = e.series_id WHERE e.id = ?", (iid,)).fetchone()
            ep_name = (e['ep_name_en'] if en else '') or e['ep_name']
            out.update(title=(e['stitle_en'] if en else '') or e['stitle'], sid=e['series_id'],
                       sub=epcode(e['season'], e['episode']) + (f" · {ep_name}" if ep_name else ''))
            nxt = next_episode(c, e)
            if nxt:
                out['next'] = {'id': nxt['id'], 'label': epcode(nxt['season'], nxt['episode']),
                               'name': (nxt['ep_name_en'] if en else '') or nxt['ep_name'] or '', 'still': bool(nxt['still'])}
    return jsonify(out)


@app.route('/play/<kind>/<int:iid>')
def play(kind, iid):
    path = media_path(kind, iid)
    audio = request.args.get('a', 0, type=int)
    if request.args.get('mode') != 'stream' and audio == 0 and media.probe(path)['direct']:
        mime = 'video/webm' if path.lower().endswith('.webm') else 'video/mp4'
        return send_file(path, mimetype=mime, conditional=True)
    return media.stream(path, max(0.0, request.args.get('t', 0, type=float)), audio)


@app.route('/api/seek/<kind>/<int:iid>')
def api_seek(kind, iid):
    """The time a stream asked to start at `t` really starts at (the keyframe before it), so the player's clock and
    subtitles line up with the picture."""
    path = media_path(kind, iid)
    return jsonify({'start': media.seek_point(path, max(0.0, request.args.get('t', 0, type=float)))})


def _download_name(kind, iid, path):
    """A readable file name for the saved copy: "Title (Year).mkv" or "Series S01E02.mkv"."""
    ext = os.path.splitext(path)[1].lower()
    if kind == 'v':
        return os.path.basename(path)
    with session() as c:
        if kind == 'm':
            r = c.execute("SELECT title, year FROM movies WHERE id = ?", (iid,)).fetchone()
            base = f"{r['title']} ({r['year']})" if r and r['year'] else (r['title'] if r else '')
        else:
            r = c.execute("SELECT e.season, e.episode, COALESCE(s.display_title, s.title) AS stitle FROM episodes e "
                          "JOIN series s ON s.id = e.series_id WHERE e.id = ?", (iid,)).fetchone()
            base = f"{r['stitle']} S{r['season']:02d}E{r['episode']:02d}" if r else ''
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', (base or '').replace(': ', ' - '))
    base = re.sub(r'\s+', ' ', base).strip(' .')
    return (base + ext) if base else os.path.basename(path)


@app.route('/api/download/status')
def api_download_status():
    return jsonify(downloads.status(viewer()))


@app.route('/api/devices')
def api_devices():
    """The devices that used this server in the last 90 days, with what each is downloading now. Server computer only."""
    if not is_local_request():
        abort(403)
    now = time.time()
    dls = {}
    for d in downloads.active():
        dls.setdefault(d['viewer'], []).append({k: d[k] for k in ('name', 'size', 'sent')})
    with session() as c:
        rows = c.execute("SELECT viewer, name, ua, ip, first_seen, last_seen FROM devices WHERE last_seen > ? "
                         "ORDER BY last_seen DESC", (now - 90 * 86400,)).fetchall()
    out = [{'id': r['viewer'], 'name': r['name'] or '', 'ua': r['ua'] or '', 'ip': r['ip'] or '',
            'first_seen': r['first_seen'], 'ago': max(0, int(now - (r['last_seen'] or now))),
            'downloads': dls.pop(r['viewer'], [])} for r in rows]
    # A download from a device that is not in the list yet still shows up.
    out += [{'id': v, 'name': '', 'ua': '', 'ip': '', 'first_seen': now, 'ago': 0, 'downloads': d} for v, d in dls.items()]
    return jsonify({'devices': out, 'activity': _activity_rows(activity.recent(limit=40))})


def _activity_rows(rows):
    now = time.time()
    return [{'id': r['id'], 'device': r['viewer'], 'ip': r['ip'] or '', 'kind': r['kind'], 'key': r['key'] or '',
             'title': r['title'] or '', 'at': r['at'], 'ago': max(0, int(now - (r['at'] or now))),
             'pos': r['pos'] or 0, 'dur': r['dur'] or 0, 'size': r['size'] or 0, 'sent': r['sent'] or 0,
             'secs': max(0, int((r['until'] or r['at'] or now) - (r['at'] or now)))} for r in rows]


@app.route('/api/activity')
def api_activity():
    """The activity log, newest first: ?device=<id> for one device, ?before=<time> for older rows. Server computer only."""
    if not is_local_request():
        abort(403)
    before = _num(request.args.get('before')) or None
    rows = activity.recent(viewer=request.args.get('device') or None, limit=_num(request.args.get('limit')) or 100,
                           before=before)
    return jsonify({'activity': _activity_rows(rows)})


@app.route('/api/devices/<vid>', methods=['POST', 'DELETE'])
def api_device(vid):
    """Name a device (an empty name goes back to the guessed one), or forget it. Server computer only."""
    if not is_local_request():
        abort(403)
    with session() as c:
        if request.method == 'DELETE':
            c.execute("DELETE FROM devices WHERE viewer = ?", (vid,))
            _seen.pop(vid, None)
        else:
            name = str((request.get_json(force=True, silent=True) or {}).get('name', '')).strip()[:40]
            # A device seen only through a download (or before this list existed) has no row yet: make one, so the
            # name is kept.
            now = time.time()
            c.execute("INSERT INTO devices (viewer, name, ua, ip, first_seen, last_seen) VALUES (?, ?, '', '', ?, ?) "
                      "ON CONFLICT(viewer) DO UPDATE SET name = excluded.name", (vid[:64], name, now, now))
    return jsonify({'ok': True})


@app.route('/download/<kind>/<int:iid>')
def download(kind, iid):
    """The original file as an attachment: a set number of downloads at a time per device, throttled to the shared limit.
    Supports a single byte range so browsers can resume a broken download."""
    path = media_path(kind, iid)
    size = os.path.getsize(path)
    name = _download_name(kind, iid, path)
    start, end = 0, size - 1
    rng = re.match(r'bytes=(\d*)-(\d*)$', request.headers.get('Range', '').strip())
    if rng and (rng.group(1) or rng.group(2)):
        if rng.group(1):
            start = int(rng.group(1))
            end = min(int(rng.group(2)), size - 1) if rng.group(2) else size - 1
        else:
            start = max(0, size - int(rng.group(2)))
        if start > end or start >= size:
            return Response(status=416, headers={'Content-Range': f'bytes */{size}'})
    token = downloads.claim(viewer(), name, size)
    if token is None:
        n = downloads.per_device()
        msg = ('Bu cihazda zaten bir indirme sürüyor. O bitince yenisini başlatabilirsiniz.' if n == 1 else
               f'Bu cihazda zaten {n} indirme sürüyor. Biri bitince yenisini başlatabilirsiniz.')
        return Response(msg, status=429,
                        mimetype='text/plain', headers={'Retry-After': '30'})
    length = end - start + 1
    ascii_name = name.encode('ascii', 'replace').decode().replace('?', '_').replace('"', '')
    headers = {'Content-Disposition': f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}",
               'Content-Length': str(length), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'}
    if rng and (rng.group(1) or rng.group(2)):
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    rid = activity.download_start(viewer(), client_ip(), f"{kind}:{iid}", name, size, start)
    return Response(_logged(downloads.reader(path, viewer(), token, start, length), rid),
                    status=206 if 'Content-Range' in headers else 200,
                    mimetype='application/octet-stream', headers=headers, direct_passthrough=True)


def _logged(chunks, rid):
    """Pass a download through and write to its log row how much was sent: every ~50 MB and when it ends."""
    sent = mark = 0
    try:
        for data in chunks:
            sent += len(data)
            if sent - mark >= 50 * 1024 * 1024:
                mark = sent
                activity.download_end(rid, sent)
            yield data
    finally:
        activity.download_end(rid, sent)


@app.route('/api/hls/<kind>/<int:iid>')
def api_hls(kind, iid):
    path = media_path(kind, iid)
    t = max(0.0, request.args.get('t', 0, type=float))
    sid = media.hls_start(path, t, request.args.get('a', 0, type=int), request.args.get('c', '')[:64])
    if not sid:
        abort(503)
    return jsonify({'url': f'/hls/{sid}/index.m3u8', 'start': media.seek_point(path, t)})


@app.route('/api/hls/stop', methods=['POST'])
def api_hls_stop():
    client = request.args.get('c', '')[:64]
    if client:
        media.hls_stop(client, request.args.get('s', ''))
    return jsonify({'ok': True})


@app.route('/hls/<sid>/<name>')
def hls_file(sid, name):
    p = media.hls_file(sid, name)
    if not p:
        abort(404)
    playlist = name.endswith('.m3u8')
    r = send_file(p, mimetype='application/vnd.apple.mpegurl' if playlist else 'video/mp2t', conditional=not playlist)
    r.headers['Cache-Control'] = 'no-cache' if playlist else 'max-age=3600'
    return r


@app.route('/api/client_error', methods=['POST'])
def api_client_error():
    d = request.get_json(force=True, silent=True) or {}
    print(f"Oynatma hatası [{request.remote_addr}] {str(d.get('item', ''))[:20]} mod={str(d.get('mode', ''))[:10]} "
          f"kod={str(d.get('code', ''))[:10]} t={_num(d.get('t')):.0f} deneme={_num(d.get('retry')):.0f} "
          f"{str(d.get('msg', ''))[:120]} | {request.headers.get('User-Agent', '')[:160]}")
    return jsonify({'ok': True})


@app.route('/sub/<kind>/<int:iid>/local/<int:n>')
def sub_local(kind, iid, n):
    subs = subtitles.local_subtitles(media_path(kind, iid))
    if n >= len(subs):
        abort(404)
    return app.response_class(subtitles.read_subtitle(subs[n]['path']), mimetype='text/vtt')


@app.route('/sub/<kind>/<int:iid>/embedded/<int:n>')
def sub_embedded(kind, iid, n):
    try:
        text = subtitles.extract_embedded(media_path(kind, iid), n)
    except subprocess.TimeoutExpired:
        text = None
    if not text:
        abort(404)
    return app.response_class(text, mimetype='text/vtt')


def sub_lookup(kind, iid):
    """Search terms for a library video: a name query, and the TMDb/IMDb ids OpenSubtitles knows titles by."""
    with session() as c:
        if kind == 'm':
            r = c.execute("SELECT title, year, original_title, tmdb_id, imdb_id FROM movies WHERE id = ?", (iid,)).fetchone()
            query = f"{r['original_title'] or r['title']} {r['year'] or ''}".strip()
            imdb = re.sub(r'\D', '', r['imdb_id'] or '')
            ids = {'tmdb_id': r['tmdb_id']} if r['tmdb_id'] else ({'imdb_id': int(imdb)} if imdb else {})
        else:
            r = c.execute("SELECT e.season, e.episode, s.title, s.original_title, s.tmdb_id FROM episodes e JOIN series s "
                          "ON s.id = e.series_id WHERE e.id = ?", (iid,)).fetchone()
            query = f"{r['original_title'] or r['title']} S{r['season']:02d}E{r['episode']:02d}"
            ids = {'parent_tmdb_id': r['tmdb_id'], 'season_number': r['season'],
                   'episode_number': r['episode']} if r['tmdb_id'] else {}
    return query, ids


@app.route('/api/subs/search/<kind>/<int:iid>')
def subs_search(kind, iid):
    path = media_path(kind, iid)
    return jsonify(subtitles.search_online(path, sub_lookup(kind, iid)[0]))


# Played without a Turkish subtitle: the server looks one up on OpenSubtitles (it, not the TV, needs internet).
@app.route('/sub/<kind>/<int:iid>/auto')
def sub_auto(kind, iid):
    path = media_path(kind, iid)
    if kind == 'v':
        return '', 204
    query, ids = sub_lookup(kind, iid)
    found = subtitles.auto_turkish(path, ids, query)
    if not found:
        return '', 204
    return app.response_class(found[0], mimetype='text/vtt')


# Lines a subtitle up with the film's sound (see subsync.py). The first subtitle for a video takes about a minute,
# so this only starts the job; the player asks for the result every few seconds.
@app.route('/api/subs/align/<kind>/<int:iid>', methods=['POST'])
def subs_align(kind, iid):
    path = media_path(kind, iid)
    text = (request.get_json(force=True, silent=True) or {}).get('text') or ''
    if len(text) > 2_000_000:
        abort(413)
    key, st = subsync.request(path, max(0, request.args.get('a', 0, type=int)), text)
    return jsonify({'key': key, **st})


@app.route('/api/subs/align/status/<key>')
def subs_align_status(key):
    return jsonify(subsync.status(key))


@app.route('/api/subs/download', methods=['POST'])
def subs_download():
    fid = (request.get_json(force=True, silent=True) or {}).get('file_id')
    if not fid:
        abort(400)
    try:
        vtt = subtitles.download_online(fid)
    except Exception:
        vtt = None
    if not vtt:
        abort(502)
    return app.response_class(vtt, mimetype='text/vtt')


# ---------------------------------------------------------------- online (TMDb catalog, frameXTV player)

def _online(fn, *args):
    try:
        data = fn(*args, request_lang())
    except online.Unavailable as e:
        return jsonify({'error': str(e)}), 503
    if data is None:
        abort(404)
    return jsonify(data)


@app.route('/api/online/home')
def api_online_home():
    return _online(lambda lang: {'rows': online.home(lang), 'embed': ONLINE_EMBED})


@app.route('/api/online/search')
def api_online_search():
    return _online(online.search, request.args.get('q', ''))


@app.route('/api/online/title/<kind>/<int:tm>')
def api_online_title(kind, tm):
    if kind not in ('m', 's'):
        abort(404)
    try:
        data = online.title(kind, tm, request_lang())
    except online.Unavailable as e:
        return jsonify({'error': str(e)}), 503
    if not data:
        abort(404)
    data = dict(data)
    data['prov'] = metadata.with_ids(data.get('prov'))
    with session() as c:
        table = 'movies' if kind == 'm' else 'series'
        local = c.execute(f"SELECT id FROM {table} WHERE tmdb_id = ? LIMIT 1", (tm,)).fetchone()
        data['local'] = f"{kind}:{local['id']}" if local else ''
        if kind == 'm':
            p = c.execute("SELECT * FROM progress WHERE viewer = ? AND key = ?", (viewer(), f"om:{tm}")).fetchone()
            data['progress'] = [p['position'] or 0, p['duration'] or 0, p['finished'] or 0, p['updated_at'] or 0] if p else None
        else:
            data['progress'] = {r['key'].split(':', 2)[2]: [r['position'] or 0, r['duration'] or 0, r['finished'] or 0,
                                                            r['updated_at'] or 0]
                                for r in c.execute("SELECT * FROM progress WHERE viewer = ? AND key LIKE ?",
                                                   (viewer(), f"oe:{tm}:%"))}
    data['embed'] = ONLINE_EMBED
    return jsonify(data)


@app.route('/api/online/season/<int:tm>/<int:n>')
def api_online_season(tm, n):
    return _online(online.season, tm, n)


# ---------------------------------------------------------------- live TV (broadcasters' own free streams)

# ---------------------------------------------------------------- music videos

@app.route('/api/clips')
def api_clips():
    en = request_lang() == 'en'
    artists = {k: {**{x: v for x, v in a.items() if not x.startswith('bio_')}, 'bio': (a['bio_en'] if en else a['bio_tr']) or a['bio_en']}
               for k, a in clipmeta.artists().items()}
    return jsonify({'clips': clips.listing(), 'artists': artists})


@app.route('/img/clipart/<name>')
def img_clipart(name):
    if not re.fullmatch(r'[pb]_[0-9a-f]{16}\.jpg', name) or not os.path.exists(clipmeta.art_path(name)):
        abort(404)
    w = request.args.get('w', 0, type=int)
    return _send_image(clipmeta.art_path(name), w if 0 < w < 1280 else None)


@app.route('/img/clip/<int:cid>')
def img_clip(cid):
    p = clips.thumb_path(cid)
    if not os.path.exists(p):
        abort(404)
    w = request.args.get('w', 0, type=int)
    return _send_image(p, w if 0 < w < 640 else None)


@app.route('/api/live')
def api_live():
    return jsonify(livetv.channels())


@app.route('/api/live/status')
def api_live_status():
    return jsonify(livetv.status_report())


@app.route('/api/live/fail', methods=['POST'])
def api_live_fail():
    d = request.get_json(force=True, silent=True) or {}
    livetv.report_failure(str(d.get('id', ''))[:64], str(d.get('code', ''))[:40], request.headers.get('User-Agent', ''))
    return ('', 204)


@app.route('/api/live/pl/<cid>')
def api_live_playlist(cid):
    """A channel's playlist text passed through for browsers (the broadcaster sends no CORS header). Never video."""
    url = request.args.get('u', '')
    if not livetv.proxy_allowed(cid, url):
        abort(404)
    status, text = livetv.proxy_playlist(cid, url)
    if status != 200:
        abort(502)
    resp = app.response_class(text, mimetype='application/vnd.apple.mpegurl')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


# ---------------------------------------------------------------- live TV: the viewer's own IPTV subscription

def _iptv_source(sid):
    r = iptv.visible(sid, viewer())
    if not r:
        abort(404)
    return r


@app.route('/api/iptv', methods=['GET', 'POST'])
def api_iptv():
    if request.method == 'POST':
        d = request.get_json(force=True, silent=True) or {}
        try:
            src = iptv.add(viewer(), str(d.get('kind', '')), str(d.get('name', '')), str(d.get('url', '')),
                           str(d.get('username', '')).strip(), str(d.get('password', '')).strip(), bool(d.get('shared')))
        except iptv.IptvError as e:
            return jsonify({'error': str(e)}), 400
        return jsonify(src)
    return jsonify({'sources': iptv.sources(viewer())})


@app.route('/api/iptv/<int:sid>', methods=['POST', 'DELETE'])
def api_iptv_source(sid):
    if request.method == 'DELETE':
        return ('', 204) if iptv.remove(sid, viewer()) else abort(404)
    d = request.get_json(force=True, silent=True) or {}
    if not iptv.update(sid, viewer(), d.get('name'), d.get('shared')):
        abort(404)
    return ('', 204)


@app.route('/api/iptv/<int:sid>/refresh', methods=['POST'])
def api_iptv_refresh(sid):
    _iptv_source(sid)
    try:
        iptv.refresh(sid)
    except iptv.IptvError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(next(s for s in iptv.sources(viewer()) if s['id'] == sid))


@app.route('/api/iptv/<int:sid>/groups')
def api_iptv_groups(sid):
    iptv.refresh_if_old(_iptv_source(sid))
    return jsonify(iptv.groups(sid, request.args.get('dead') == '1'))


@app.route('/api/iptv/<int:sid>/channels')
def api_iptv_channels(sid):
    _iptv_source(sid)
    g = request.args.get('g')
    return jsonify(iptv.channels(sid, g, request.args.get('q', '')[:80], max(0, request.args.get('off', 0, type=int)),
                                 min(500, max(1, request.args.get('lim', iptv.PAGE, type=int))),
                                 request.args.get('no', 0, type=int), request.args.get('dead') == '1'))


@app.route('/api/iptv/<int:sid>/fail', methods=['POST'])
def api_iptv_fail(sid):
    _iptv_source(sid)
    d = request.get_json(force=True, silent=True) or {}
    iptv.report_failure(sid, str(d.get('url', ''))[:2000])
    return ('', 204)


@app.route('/api/iptv/<int:sid>/check', methods=['GET', 'POST', 'DELETE'])
def api_iptv_check(sid):
    """Checks the list's channels in the background (POST, optional group), its progress (GET), stop (DELETE)."""
    _iptv_source(sid)
    if request.method == 'DELETE':
        iptv.stop_check(sid)
    elif request.method == 'POST':
        d = request.get_json(force=True, silent=True) or {}
        return jsonify(iptv.start_check(sid, d.get('g')))
    return jsonify(iptv.check_status(sid))


@app.route('/api/iptv/<int:sid>/dead', methods=['DELETE'])
def api_iptv_dead(sid):
    """Shows every hidden channel again."""
    _iptv_source(sid)
    iptv.clear_dead(sid)
    return ('', 204)


@app.route('/api/iptv/pl/<int:sid>')
def api_iptv_playlist(sid):
    """An IPTV playlist's text passed through for browsers (the provider sends no CORS header). Never video."""
    _iptv_source(sid)
    url = request.args.get('u', '')
    if not iptv.proxy_allowed(sid, url):
        abort(404)
    status, text = iptv.proxy_playlist(sid, url)
    if status != 200:
        abort(502)
    resp = app.response_class(text, mimetype='application/vnd.apple.mpegurl')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/img/live/<cid>')
def img_live(cid):
    path = livetv.logo_file(cid) if re.fullmatch(r'[A-Za-z0-9.]{2,64}', cid) else None
    if not path:
        abort(404)
    mime = {'svg': 'image/svg+xml', 'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}[path.rsplit('.', 1)[1]]
    return send_file(path, mimetype=mime, conditional=True, max_age=86400)


# ---------------------------------------------------------------- images

def _send_image(path, width=None):
    if not path:
        abort(404)
    if width:
        path = media.thumbnail(path, width) or path
    return send_file(path, mimetype='image/jpeg', conditional=True)


@app.route('/img/poster/<kind>/<iid>')
def img_poster(kind, iid):
    w = min(max(request.args.get('w', 0, type=int), 0), 1000) or None
    with session() as c:
        if kind in ('m', 's') and iid.isdigit():
            r = c.execute(f"SELECT poster FROM {'movies' if kind == 'm' else 'series'} WHERE id = ?", (int(iid),)).fetchone()
            return _send_image(library.poster_file(r['poster']) if r else None, w)
        if kind == 'c' and iid.isdigit():
            r = c.execute("SELECT poster FROM collections WHERE id = ?", (int(iid),)).fetchone()
            return _send_image(media.remote_image(r['poster'] if r else None, 'w780'), w)
    abort(404)


@app.route('/img/backdrop/<kind>/<iid>')
def img_backdrop(kind, iid):
    w = min(max(request.args.get('w', 1280, type=int), 300), 1920)
    if not iid.isdigit():
        abort(404)
    iid = int(iid)
    with session() as c:
        if kind == 'm':
            r = c.execute("SELECT path, backdrop FROM movies WHERE id = ?", (iid,)).fetchone()
            if not r:
                abort(404)
            folder, base, generic_ok = library.movie_folder_info(settings, r['path'])
            local = library.find_backdrop(folder, [base], generic_ok)
            return _send_image(local or media.remote_image(r['backdrop'], 'w1280'), w)
        if kind == 's':
            r = c.execute("SELECT title, backdrop FROM series WHERE id = ?", (iid,)).fetchone()
            if not r:
                abort(404)
            folder = library.series_folder(settings, r['title'])
            local = library.find_backdrop(folder) if folder else None
            return _send_image(local or media.remote_image(r['backdrop'], 'w1280'), w)
        if kind == 'c':
            r = c.execute("SELECT backdrop FROM collections WHERE id = ?", (iid,)).fetchone()
            return _send_image(media.remote_image(r['backdrop'] if r else None, 'w1280'), w)
    abort(404)


@app.route('/img/still/<int:eid>')
def img_still(eid):
    with session() as c:
        r = c.execute("SELECT still FROM episodes WHERE id = ?", (eid,)).fetchone()
    return _send_image(media.remote_image(r['still'] if r else None, 'w300'))


@app.route('/img/tmdb/<size>/<name>')
def img_tmdb(size, name):
    """Online tab images, saved on the server (see online.prefetch_images) so devices without internet see them."""
    if size not in (online.POSTER_SIZE, online.BACKDROP_SIZE, 'w300', metadata.LOGO_SIZE) or \
            not re.fullmatch(r'[A-Za-z0-9_-]{4,64}\.(jpg|jpeg|png)', name):
        abort(404)
    return _send_image(media.remote_image('/' + name, size))


@app.route('/img/person/<name>')
def img_person(name):
    if not re.fullmatch(r'[A-Za-z0-9_-]{4,64}\.(jpg|jpeg|png)', name):
        abort(404)
    return _send_image(media.remote_image('/' + name, 'w185'))


@app.route('/get_poster/<path:vid>')
def legacy_poster(vid):
    p = os.path.join(POSTERS_DIR, f"poster_{vid.replace('/', '_')}.jpg")
    return send_file(p) if os.path.exists(p) else ('', 404)


# ---------------------------------------------------------------- admin

def lan_ips():
    skip = ('docker', 'br-', 'virbr', 'lxc', 'veth', 'tun', 'tap', 'wg', 'proton', 'lo')
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'], capture_output=True, text=True,
                             timeout=3).stdout
        return [ln.split()[3].split('/')[0] for ln in out.splitlines() if len(ln.split()) > 3 and not ln.split()[1].startswith(skip)]
    except Exception:
        return []


def client_ip():
    """The device's own address, also behind the HTTPS proxy (see activity.client_ip)."""
    if 'client_ip' not in g:
        g.client_ip = activity.client_ip(request)
    return g.client_ip


def is_local_request():
    """True only for requests from this computer (app window, 127.0.0.1 or its own LAN address). A device that comes
    through the HTTPS name (Caddy on this computer) counts by its own address, not as this computer."""
    addr = client_ip()
    if request.headers.get('X-Forwarded-For') and (addr.startswith('127.') or addr == '::1'):
        # Came through a proxy that hid the device's address (e.g. a TLS pass-through in front of Caddy): it could be
        # any device, so it is never treated as this computer.
        return False
    return addr in ('127.0.0.1', '::1') or addr.startswith('127.') or addr in lan_ips()


@app.route('/api/settings', methods=['GET', 'POST'])
def api_settings():
    local = is_local_request()
    if request.method == 'POST':
        if not local:
            abort(403)
        d = request.get_json(force=True, silent=True) or {}
        values = {k: str(v).strip() for k, v in d.items() if k in ('movie_dir', 'series_dir', 'omdb_api_key') and str(v).strip()}
        for kind in ('movie', 'series', 'music'):
            if isinstance(d.get(f'{kind}_dirs'), list):
                dirs = []
                for p in d[f'{kind}_dirs']:
                    p = os.path.normpath(str(p).strip()) if str(p).strip() else ''
                    if p and p not in dirs:
                        dirs.append(p)
                values[f'{kind}_dirs'] = json.dumps(dirs, ensure_ascii=False)
                if kind != 'music':
                    values[f'{kind}_dir'] = dirs[0] if dirs else ''  # read by older versions
        if 'download_mbps' in d:
            values['download_mbps'] = str(downloads.set_limit(d['download_mbps']))
        if 'download_per_device' in d:
            values['download_per_device'] = str(downloads.set_per_device(d['download_per_device']))
        settings.update(values)
        save_settings(values)
    with session() as c:
        stats = {'movies': c.execute("SELECT COUNT(*) FROM movies").fetchone()[0],
                 'series': c.execute("SELECT COUNT(*) FROM series").fetchone()[0],
                 'episodes': c.execute("SELECT COUNT(*) FROM episodes").fetchone()[0],
                 'collections': c.execute("SELECT COUNT(*) FROM collections").fetchone()[0],
                 'clips': c.execute("SELECT COUNT(*) FROM music_videos").fetchone()[0]}
    from .config import PORT
    # Folder paths and the API key are only shown to (and editable from) this computer, not other devices on the LAN.
    private = {k: settings.get(k, '') if local else '' for k in ('movie_dir', 'series_dir', 'omdb_api_key')}
    for kind in ('movie', 'series', 'music'):
        private[f'{kind}_dirs'] = library_dirs(settings, kind) if local else []
    return jsonify({**private, 'local': local, 'stats': stats, 'download_mbps': downloads.limit_mbps(), 'download_per_device': downloads.per_device(), 'version': get_version(), 'urls': [f"http://{ip}:{PORT}" for ip in lan_ips()]})


def _browse_roots():
    """Where the folder picker starts: the drives on Windows; the disk, home and plugged-in drives elsewhere."""
    if os.name == 'nt':
        import string
        return [(f'{d}:\\', f'{d}:\\') for d in string.ascii_uppercase if os.path.isdir(f'{d}:\\')]
    roots = [('/', '/'), (os.path.expanduser('~'), os.path.expanduser('~'))]
    user = os.path.basename(os.path.expanduser('~'))
    for base in (f'/media/{user}', '/media', '/mnt', '/run/media/' + user, '/Volumes'):
        try:
            for name in sorted(os.listdir(base)):
                path = os.path.join(base, name)
                if os.path.isdir(path) and not name.startswith('.') and path not in (r[1] for r in roots) and path != f'/media/{user}':
                    roots.append((name, path))
        except OSError:
            pass
    return roots


@app.route('/api/browse')
def api_browse():
    """Subfolders of a folder, for picking library folders in Settings. Only from this computer."""
    if not is_local_request():
        abort(403)
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'path': '', 'parent': None, 'dirs': [{'name': n, 'path': p} for n, p in _browse_roots()]})
    path = os.path.normpath(os.path.expanduser(path))
    try:
        names = sorted((n for n in os.listdir(path) if not n.startswith(('.', '$')) and n != 'System Volume Information'
                        and os.path.isdir(os.path.join(path, n))), key=str.lower)
    except OSError:
        return jsonify({'error': 'Bu klasör açılamadı'}), 400
    parent = os.path.dirname(path)
    return jsonify({'path': path, 'parent': parent if parent != path else '',
                    'dirs': [{'name': n, 'path': os.path.join(path, n)} for n in names]})


@app.route('/api/scan', methods=['POST'])
@app.route('/api/rescan', methods=['POST'])
def api_scan():
    threading.Thread(target=library.scan_library, args=(settings,), daemon=True).start()
    return jsonify({'status': 'started'})


@app.route('/api/sync_emby', methods=['POST'])
def api_sync_emby():
    m, s = library.sync_emby(settings)
    state.bump()
    return jsonify({'status': 'ok', 'movies': m, 'series': s})


@app.route('/api/enrich', methods=['POST'])
def api_enrich():
    with session() as c:
        c.execute("UPDATE movies SET meta_tries = 0, enriched = 0 WHERE COALESCE(enriched, 0) != 1")
        c.execute("UPDATE series SET meta_tries = 0, enriched = 0 WHERE COALESCE(enriched, 0) != 1")
    state.wake_enricher()
    return jsonify({'status': 'started'})
