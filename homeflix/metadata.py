import json
import math
import os
import re
import threading
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from . import media, state
from .config import OMDB_KEYS, POSTERS_DIR, TMDB_IMG, TMDB_KEY, USER_AGENT
from .db import session
from . import library
from .library import poster_file
from .names import fold, search_candidates

http = requests.Session()
http.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])))
http.mount("http://", HTTPAdapter(max_retries=Retry(total=2, backoff_factor=1)))
http.headers.update({'User-Agent': USER_AGENT})
# For lookups made while a request waits (the pause screen): no retries, bounded timeouts.
quick_http = requests.Session()
quick_http.headers.update({'User-Agent': USER_AGENT})

GENRE_TR = {
    'action': 'Aksiyon', 'adventure': 'Macera', 'animation': 'Animasyon', 'comedy': 'Komedi', 'crime': 'Suç',
    'documentary': 'Belgesel', 'drama': 'Dram', 'family': 'Aile', 'fantasy': 'Fantastik', 'history': 'Tarih',
    'horror': 'Korku', 'music': 'Müzik', 'musical': 'Müzikal', 'mystery': 'Gizem', 'romance': 'Romantik',
    'sci-fi': 'Bilim-Kurgu', 'science fiction': 'Bilim-Kurgu', 'thriller': 'Gerilim', 'war': 'Savaş',
    'western': 'Vahşi Batı', 'biography': 'Biyografi', 'sport': 'Spor', 'short': 'Kısa',
}


class NetworkError(Exception):
    pass


def tmdb(path, quick=False, **params):
    params = {'api_key': TMDB_KEY, 'language': 'tr-TR', **params}
    try:
        r = (quick_http if quick else http).get(f"https://api.themoviedb.org/3{path}", params=params,
                                                timeout=(6, 15) if quick else 10)
    except requests.RequestException as e:
        raise NetworkError(str(e))
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise NetworkError(f"TMDb {r.status_code}")
    return r.json()


def download(url, dest):
    try:
        r = http.get(url, timeout=15)
        if r.status_code == 200 and len(r.content) > 1000:
            tmp = dest + '.part'
            with open(tmp, 'wb') as f:
                f.write(r.content)
            os.replace(tmp, dest)
            return True
    except (requests.RequestException, OSError):
        pass
    return False


def movie_cert(d):
    """'US:PG' / 'TR:7+' from a /movie response with release_dates appended; '' when TMDb has no rating."""
    by_country = {r.get('iso_3166_1'): [x.get('certification') for x in r.get('release_dates') or [] if x.get('certification')]
                  for r in (d.get('release_dates') or {}).get('results') or []}
    for country in ('US', 'TR'):
        if by_country.get(country):
            return f"{country}:{by_country[country][0]}"
    return ''


def tv_cert(d):
    by_country = {r.get('iso_3166_1'): r.get('rating') for r in (d.get('content_ratings') or {}).get('results') or [] if r.get('rating')}
    for country in ('US', 'TR'):
        if by_country.get(country):
            return f"{country}:{by_country[country]}"
    return ''


def translate_genres(genre):
    if not genre:
        return genre
    out = []
    for g in [x.strip() for x in genre.split(',') if x.strip()]:
        t = GENRE_TR.get(g.lower(), g)
        if t not in out:
            out.append(t)
    return ', '.join(out)


def clean_collection_name(name):
    name = re.sub(r'\s*\[(Seri|Koleksiyon)\]\s*', '', name or '', flags=re.I)
    name = re.sub(r'\s+(Serisi|Koleksiyonu|Collection)$', '', name, flags=re.I)
    return name.strip()


def _year_of(item, key):
    d = item.get(key) or ''
    return d[:4] if len(d) >= 4 else ''


def _norm(s):
    return re.sub(r'[^a-z0-9]', '', fold(s))


def _score(r, query, year, date_key):
    title = r.get('title') or r.get('name') or ''
    orig = r.get('original_title') or r.get('original_name') or ''
    nq = _norm(query)
    s = 0.0
    if nq and nq in (_norm(title), _norm(orig)):
        s += 10
    elif nq and (_norm(title).startswith(nq) or _norm(orig).startswith(nq) or nq.startswith(_norm(title) or '#')):
        s += 4
    qw = set(re.sub(r'[^\w\s]', ' ', fold(query)).split())
    tw = set(re.sub(r'[^\w\s]', ' ', fold(title + ' ' + orig)).split())
    s += 4 * len(qw & tw) / max(1, len(qw))
    ry = _year_of(r, date_key)
    if year and str(year).isdigit() and ry.isdigit():
        s += 5 if abs(int(ry) - int(year)) <= 1 else -4
    s += min(3.5, math.log10(1 + (r.get('vote_count') or 0)))
    return s


def _pick(results, year, date_key, query=''):
    if not results:
        return None
    return max(results[:10], key=lambda r: _score(r, query, year, date_key))


def search_tmdb(kind, title, year='', original_title=''):
    path = '/search/movie' if kind == 'movie' else '/search/tv'
    date_key = 'release_date' if kind == 'movie' else 'first_air_date'
    year_param = 'year' if kind == 'movie' else 'first_air_date_year'
    queries = ([original_title] if original_title else []) + search_candidates(title)
    for q in dict.fromkeys(queries):
        params = {'query': q}
        if year and str(year).isdigit():
            params[year_param] = year
        res = tmdb(path, **params) or {}
        hit = _pick(res.get('results'), year, date_key, q)
        if not hit and year_param in params:
            res = tmdb(path, query=q) or {}
            hit = _pick(res.get('results'), year, date_key, q)
        if hit:
            return hit
    return None


def omdb_lookup(title, year='', imdb_id=''):
    for key in OMDB_KEYS[:2]:
        params = {'apikey': key}
        if imdb_id:
            params['i'] = imdb_id
        else:
            params['t'] = title
            if year:
                params['y'] = year
        try:
            d = http.get("http://www.omdbapi.com/", params=params, timeout=8).json()
        except (requests.RequestException, ValueError):
            continue
        if d.get('Response') == 'True':
            return d
    return None


def _ensure_poster(c, table, kind, row, tmdb_poster):
    current = poster_file(row['poster'])
    if (current and not library.is_tiny(current)) or not tmdb_poster:
        return
    dest = os.path.join(POSTERS_DIR, f"poster_{kind}_{row['id']}.jpg")
    if download(f"{TMDB_IMG}w780{tmdb_poster}", dest):
        c.execute(f"UPDATE {table} SET poster = ? WHERE id = ?", (f"/get_poster/{kind}_{row['id']}", row['id']))


def ensure_collection(c, col):
    cid = col['id']
    if c.execute("SELECT fetched FROM collections WHERE id = ?", (cid,)).fetchone():
        return
    c.execute("INSERT OR IGNORE INTO collections (id, name, poster, backdrop) VALUES (?, ?, ?, ?)",
              (cid, clean_collection_name(col.get('name')), col.get('poster_path'), col.get('backdrop_path')))


def fetch_collection_details(cid):
    d = tmdb(f"/collection/{cid}")
    if not d:
        return
    with session() as c:
        c.execute("UPDATE collections SET name = ?, overview = ?, poster = COALESCE(?, poster), "
                  "backdrop = COALESCE(?, backdrop), parts = ?, fetched = 1 WHERE id = ?",
                  (clean_collection_name(d.get('name')), d.get('overview') or '', d.get('poster_path'),
                   d.get('backdrop_path'), len(d.get('parts') or []), cid))


def enrich_movie(row):
    with session() as c:
        tmdb_id = row['tmdb_id']
        if not tmdb_id:
            hit = search_tmdb('movie', row['title'], row['year'], row['original_title'])
            tmdb_id = hit['id'] if hit else None
        if not tmdb_id:
            fields = {}
            if not row['rating'] or not poster_file(row['poster']):
                o = omdb_lookup(row['title'], row['year'])
                if o:
                    if not row['rating'] and o.get('imdbRating') not in (None, 'N/A'):
                        fields['rating'] = o['imdbRating']
                    if not row['plot'] and o.get('Plot') not in (None, 'N/A'):
                        fields['plot'] = o['Plot']
                    if not row['genre'] and o.get('Genre') not in (None, 'N/A'):
                        fields['genre'] = translate_genres(o['Genre'])
                    if o.get('imdbID'):
                        fields['imdb_id'] = o['imdbID']
                    poster = o.get('Poster')
                    if poster and poster != 'N/A' and not poster_file(row['poster']):
                        if download(poster, os.path.join(POSTERS_DIR, f"poster_movie_{row['id']}.jpg")):
                            fields['poster'] = f"/get_poster/movie_{row['id']}"
            tries = (row['meta_tries'] or 0) + 1
            fields['meta_tries'] = tries
            fields['enriched'] = 2 if tries >= 3 else 0
            c.execute(f"UPDATE movies SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                      list(fields.values()) + [row['id']])
            return
        d = tmdb(f"/movie/{tmdb_id}", append_to_response='release_dates') or {}
        fields = {'tmdb_id': tmdb_id, 'enriched': 1, 'cert': movie_cert(d)}
        if row['tmdb_id'] != tmdb_id:
            fields['title_en'] = None  # another title now: its English text is fetched again
        if d.get('runtime'):
            fields['runtime'] = d['runtime']
        if d.get('imdb_id') and not row['imdb_id']:
            fields['imdb_id'] = d['imdb_id']
        if d.get('original_title'):
            fields['original_title'] = d['original_title']
        fields['backdrop'] = d.get('backdrop_path')
        genres = ', '.join(g['name'] for g in d.get('genres') or [])
        if genres and not row['genre']:
            fields['genre'] = genres
        elif row['genre'] and translate_genres(row['genre']) != row['genre']:
            fields['genre'] = translate_genres(row['genre'])
        if not row['plot'] and d.get('overview'):
            fields['plot'] = d['overview']
        if not row['rating'] or row['rating'] == 'N/A':
            va = d.get('vote_average') or 0
            if va:
                fields['rating'] = f"{va:.1f}"
        if not row['year'] and d.get('release_date'):
            fields['year'] = d['release_date'][:4]
        tmdb_title = (d.get('title') or '').strip()
        if tmdb_title and fold(tmdb_title) != fold(row['title']) and len(tmdb_title) < len(row['title']):
            cur = re.sub(r'\W+', ' ', fold(row['title'])).strip()
            short = re.sub(r'\W+', ' ', fold(tmdb_title)).strip()
            if short and cur.startswith(short + ' '):
                fields['title'] = tmdb_title
        col = d.get('belongs_to_collection')
        fields['collection_id'] = col['id'] if col else None
        if col:
            ensure_collection(c, col)
        c.execute(f"UPDATE movies SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                  list(fields.values()) + [row['id']])
        folder, base, generic_ok = library.movie_folder_info(library.settings_ref, row['path'])
        if d.get('poster_path') and not library.find_poster(folder, [base], generic_ok):
            dest = os.path.join(POSTERS_DIR, f"poster_movie_{row['id']}.jpg")
            if download(f"{TMDB_IMG}w780{d['poster_path']}", dest):
                c.execute("UPDATE movies SET poster = ? WHERE id = ?", (f"/get_poster/movie_{row['id']}", row['id']))


def enrich_series(row):
    with session() as c:
        tmdb_id = row['tmdb_id']
        if not tmdb_id:
            hit = search_tmdb('tv', row['title'], row['year'], row['original_title'])
            tmdb_id = hit['id'] if hit else None
        if not tmdb_id:
            tries = (row['meta_tries'] or 0) + 1
            c.execute("UPDATE series SET meta_tries = ?, enriched = ? WHERE id = ?", (tries, 2 if tries >= 3 else 0, row['id']))
            return
        d = tmdb(f"/tv/{tmdb_id}", append_to_response='content_ratings') or {}
        fields = {'tmdb_id': tmdb_id, 'enriched': 1, 'cert': tv_cert(d)}
        if row['tmdb_id'] != tmdb_id:
            fields['title_en'] = None
        if d.get('backdrop_path'):
            fields['backdrop'] = d['backdrop_path']
        if d.get('original_name'):
            fields['original_title'] = d['original_name']
        if d.get('name'):
            fields['display_title'] = d['name']
        genres = ', '.join(g['name'] for g in d.get('genres') or [])
        if genres and not row['genre']:
            fields['genre'] = genres
        if not row['plot'] and d.get('overview'):
            fields['plot'] = d['overview']
        if not row['rating'] and d.get('vote_average'):
            fields['rating'] = f"{d['vote_average']:.1f}"
        if not row['year'] and d.get('first_air_date'):
            fields['year'] = d['first_air_date'][:4]
        c.execute(f"UPDATE series SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                  list(fields.values()) + [row['id']])
        _ensure_poster(c, 'series', 'series', row, d.get('poster_path'))


# ---- English text (for the web app's English mode): titles, plots and taglines in TMDb's en-US, saved next
# to the Turkish ones. Fetched slowly in the background after the main enrichment, once per title.

EN_LANG = 'en-US'


def _english_fields(d):
    title = (d.get('title') or d.get('name') or d.get('original_title') or d.get('original_name') or '').strip()
    return [title, d.get('overview') or '', d.get('tagline') or '']


def fetch_english(kind, tmdb_id):
    """kind: 'movie' or 'tv'. A title TMDb doesn't know (404) is saved empty, so it isn't asked for again."""
    d = tmdb(f"/{kind}/{tmdb_id}", language=EN_LANG) or {}
    table = 'movies' if kind == 'movie' else 'series'
    with session() as c:
        c.execute(f"UPDATE {table} SET title_en = ?, plot_en = ?, tagline_en = ? WHERE tmdb_id = ?",
                  (*_english_fields(d), tmdb_id))


def fetch_english_collection(cid):
    d = tmdb(f"/collection/{cid}", language=EN_LANG) or {}
    with session() as c:
        c.execute("UPDATE collections SET name_en = ?, overview_en = ? WHERE id = ?",
                  (clean_collection_name(d.get('name')), d.get('overview') or '', cid))


def english_pass():
    """Fetches the English text of every title that doesn't have it yet. Stops quietly when TMDb can't be reached."""
    with session() as c:
        jobs = [('movie', r['tmdb_id']) for r in c.execute(
            "SELECT DISTINCT tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND title_en IS NULL")]
        jobs += [('tv', r['tmdb_id']) for r in c.execute(
            "SELECT DISTINCT tmdb_id FROM series WHERE tmdb_id IS NOT NULL AND title_en IS NULL")]
        jobs += [('collection', r['id']) for r in c.execute("SELECT id FROM collections WHERE name_en IS NULL")]
    if not jobs:
        return
    state.enrich.update(done=0, total=len(jobs))
    failures = 0
    for i, (kind, ident) in enumerate(jobs):
        try:
            if kind == 'collection':
                fetch_english_collection(ident)
            else:
                fetch_english(kind, ident)
            failures = 0
        except NetworkError as e:
            failures += 1
            if failures >= 5:
                print(f"İngilizce bilgiler: ağ hatası, sonra tekrar denenecek ({e})")
                return
        except Exception as e:
            print(f"İngilizce bilgi hatası ({kind} {ident}): {e}")
        state.enrich['done'] = i + 1
        if (i + 1) % 100 == 0:
            state.bump()
        time.sleep(0.1)



def enricher_loop():
    while True:
        state.enrich_wake.wait()
        state.enrich_wake.clear()
        with session() as c:
            movies = c.execute("SELECT * FROM movies WHERE COALESCE(enriched, 0) = 0 AND (COALESCE(meta_tries, 0) < 3 OR tmdb_id IS NOT NULL) "
                               "ORDER BY added_at DESC").fetchall()
            shows = c.execute("SELECT * FROM series WHERE COALESCE(enriched, 0) = 0 AND (COALESCE(meta_tries, 0) < 3 OR tmdb_id IS NOT NULL)").fetchall()
        jobs = [(enrich_series, r) for r in shows] + [(enrich_movie, r) for r in movies]
        state.enrich.update(done=0, total=len(jobs))
        failures = 0
        for i, (fn, row) in enumerate(jobs):
            try:
                fn(row)
                failures = 0
            except NetworkError as e:
                failures += 1
                if failures >= 5:
                    print(f"Metadata: ağ hatası, sonra tekrar denenecek ({e})")
                    break
            except Exception as e:
                print(f"Metadata hatası ({row['title']}): {e}")
            state.enrich['done'] = i + 1
            if (i + 1) % 40 == 0:
                state.bump()
            time.sleep(0.05)
        try:
            with session() as c:
                pending = [r['id'] for r in c.execute("SELECT id FROM collections WHERE fetched = 0")]
            for cid in pending:
                fetch_collection_details(cid)
                time.sleep(0.05)
        except Exception as e:
            print(f"Koleksiyon hatası: {e}")
        try:
            english_pass()
        except Exception as e:
            print(f"İngilizce bilgi hatası: {e}")
        state.enrich.update(done=0, total=0)
        state.bump()
        state.credits_wake.set()


CREDITS_MAX_AGE = 30 * 86400
CREDITS_RETRY_AFTER = 60
_credits_failed = {}


WATCH_REGION = 'TR'
LOGO_SIZE = 'w92'


PROV_VERSION = 3  # bump when providers() changes, so cached credits are fetched again

# Words after which a provider name only names a plan or a reseller ("Paramount+ with Showtime",
# "AMC+ Amazon Channel", "Netflix Standard with Ads"): the service is the part before them.
_PLAN_WORDS = {'with', 'premium', 'basic', 'standard', 'essential', 'ads', 'channel', 'channels', 'amazon', 'roku', 'apple'}
# Networks that are streaming services. Other networks (BBC One, AMC, Syfy) only say where a series first aired.
_STREAMING_NETWORKS = {'netflix', 'hulu', 'appletv', 'appletvplus', 'primevideo', 'disneyplus', 'hbo', 'max', 'paramountplus',
                       'peacock', 'showtime', 'starz', 'blutv', 'exxen', 'gain', 'tabii', 'tod', 'mubi', 'crunchyroll'}


def _service(name):
    """'Amazon Prime Video' -> 'primevideo', 'HBO Max' -> 'max', 'Paramount+ Amazon Channel' -> 'paramountplus'."""
    words = ''.join(ch if ch.isalnum() else ' ' for ch in (name or '').lower().replace('+', ' plus ')).split()
    if len(words) > 1 and words[0] in ('amazon', 'hbo'):
        words = words[1:]
    out = []
    for w in words:
        if out and w in _PLAN_WORDS:
            break
        out.append(w)
    return ''.join(out)


def _region_providers(d, region):
    region = ((d.get('watch/providers') or {}).get('results') or {}).get(region) or {}
    out = []
    for group in ('flatrate', 'free', 'ads'):
        # A reseller's channel ("... Amazon Channel") only after the service's own app.
        for p in sorted(region.get(group) or [], key=lambda p: ('channel' in (p.get('provider_name') or '').lower(),
                                                                 p.get('display_priority', 99))):
            if p.get('logo_path'):
                out.append({'n': p.get('provider_name') or '', 'l': p['logo_path']})
    return out


def _same_service(a, b):
    if _service(a) == _service(b):
        return True
    a, b = (''.join(ch for ch in x.lower() if ch.isalnum()) for x in (a, b))
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


def providers(d):
    """Logos of where the title is watched: for series their own streaming service first (TMDb networks, e.g. Hulu,
    Apple TV+), then the services that carry it in Turkey (TMDb watch providers, data from JustWatch).
    When Turkey has none, the US list is used, so titles of services that aren't sold here still show one.
    Each service shows once, whatever plan or reseller it is listed under. Network logos are wide ('w': 1) and
    are drawn on a light tile. At most six."""
    nets = [{'n': n.get('name') or '', 'l': n['logo_path'], 'w': 1} for n in d.get('networks') or []
            if n.get('logo_path') and _service(n.get('name')) in _STREAMING_NETWORKS]
    region = _region_providers(d, WATCH_REGION) or _region_providers(d, 'US')
    # TMDb can list the same network twice (MobLand: Paramount+ twice).
    uniq = []
    for n in nets:
        if not any(_same_service(n['n'], q['n']) for q in uniq):
            uniq.append(n)
    nets = uniq[:2]
    out = []
    for p in region:
        if not any(_same_service(p['n'], q['n']) for q in out):
            out.append(p)
    # A network that is also a streaming service in the list shows once, with the square app logo.
    nets = [n for n in nets if not any(_same_service(n['n'], p['n']) for p in out)]
    return (nets + out)[:6]


# Names of one service that _service() doesn't join on its own: the HBO network is HBO Max's app, Apple TV is Apple TV+.
_SERVICE_ALIASES = {'hbo': 'max', 'hbomax': 'max', 'appletv': 'appletvplus', 'amazonprimevideo': 'primevideo',
                    'disney': 'disneyplus', 'paramount': 'paramountplus', 'blu': 'blutv', 'todtv': 'tod'}


def _strip_the(name):
    name = (name or '').strip()
    return name[4:] if name.lower().startswith('the ') else name


def service_id(name):
    """A platform's id in links (/api/platforms, the platform page): 'Disney Plus' -> 'disneyplus',
    'The Roku Channel' -> 'roku'."""
    s = _service(_strip_the(name))
    return _SERVICE_ALIASES.get(s, s)


def service_name(name):
    """A platform's name without its plan or reseller: 'Paramount Plus Premium' -> 'Paramount Plus',
    'Lionsgate+ Amazon Channel' -> 'Lionsgate+'."""
    words = (name or '').split()
    first = 2 if words and words[0].lower() == 'the' else 1
    for i, w in enumerate(words):
        if i >= first and ''.join(ch for ch in w.lower() if ch.isalnum()) in _PLAN_WORDS:
            return ' '.join(words[:i])
    return ' '.join(words)


def with_ids(prov):
    """Platform logos as the detail pages get them: each with the id of its platform page."""
    return [{**p, 'id': service_id(p.get('n'))} for p in prov or []]


_platforms_cache = {'sig': None, 'data': None}


def platforms():
    """Every platform (Netflix, Disney+...) that carries a title of the library, with those titles' TMDb ids, built
    from the logos saved for the detail pages (credits table, filled in the background for the whole library).
    Kept in memory until the credits change."""
    with session() as c:
        sig = tuple(c.execute("SELECT COUNT(*), MAX(fetched_at) FROM credits").fetchone())
        if sig == _platforms_cache['sig']:
            return _platforms_cache['data']
        rows = c.execute(
            "SELECT c.kind, c.tmdb_id, c.data FROM credits c WHERE "
            "(c.kind = 'movie' AND c.tmdb_id IN (SELECT tmdb_id FROM movies WHERE tmdb_id IS NOT NULL)) OR "
            "(c.kind = 'tv' AND c.tmdb_id IN (SELECT tmdb_id FROM series WHERE tmdb_id IS NOT NULL))").fetchall()
    out = {}
    for r in rows:
        try:
            prov = json.loads(r['data'] or '{}').get('prov') or []
        except ValueError:
            continue
        for p in prov:
            pid = service_id(p.get('n'))
            if not pid or not p.get('l'):
                continue
            name = service_name(p['n'])
            e = out.setdefault(pid, {'id': pid, 'n': name, 'l': '', 'wl': '', 'm': [], 's': [], '_names': {}})
            # The square app logo heads the page; a network's wide logo is kept for when there is no square one.
            if p.get('w'):
                e['wl'] = e['wl'] or p['l']
            elif not e['l']:
                e['l'] = p['l']
            if not p.get('w'):
                e['_names'][name] = e['_names'].get(name, 0) + 1
            ids = e['m' if r['kind'] == 'movie' else 's']
            if r['tmdb_id'] not in ids:
                ids.append(r['tmdb_id'])
    data = []
    for e in out.values():
        names = e.pop('_names')
        if names:
            e['n'] = max(names, key=lambda n: (names[n], -len(n)))  # the name most titles use, the shorter on a tie
        data.append(e)
    data.sort(key=lambda e: -(len(e['m']) + len(e['s'])))
    _platforms_cache.update(sig=sig, data=data)
    return data


def _parse_credits(kind, d):
    if kind == 'movie':
        crew = (d.get('credits') or {}).get('crew') or []
        cast = [{'n': p.get('name') or '', 'c': p.get('character') or '', 'p': p.get('profile_path') or ''}
                for p in ((d.get('credits') or {}).get('cast') or [])[:15]]
        directors = [p['name'] for p in crew if p.get('job') == 'Director']
        writers = [p['name'] for p in crew if p.get('department') == 'Writing']
        date = d.get('release_date') or ''
    else:
        cast = [{'n': p.get('name') or '', 'c': next((r['character'] for r in p.get('roles') or [] if r.get('character')), ''),
                 'p': p.get('profile_path') or ''}
                for p in ((d.get('aggregate_credits') or {}).get('cast') or [])[:15]]
        directors = [p['name'] for p in d.get('created_by') or [] if p.get('name')]
        writers = []
        date = d.get('first_air_date') or ''
    recs = [r['id'] for r in ((d.get('recommendations') or {}).get('results') or []) + ((d.get('similar') or {}).get('results') or [])
            if r.get('id')]
    return {'cast': cast, 'directors': list(dict.fromkeys(directors))[:3], 'writers': list(dict.fromkeys(writers))[:3],
            'prov': providers(d), 'pv': PROV_VERSION,
            'tagline': d.get('tagline') or '', 'date': date,
            'countries': [c['iso_3166_1'] for c in d.get('production_countries') or [] if c.get('iso_3166_1')][:3],
            'rec': list(dict.fromkeys(recs))[:40]}


def credits(kind, tmdb_id):
    """Cast, crew, tagline and TMDb recommendations for the pause screen; fetched on first use and kept in the db.
    None when TMDb can't be reached and nothing is cached yet."""
    with session() as c:
        r = c.execute("SELECT data, fetched_at FROM credits WHERE kind = ? AND tmdb_id = ?", (kind, tmdb_id)).fetchone()
    cached = json.loads(r['data']) if r else None
    key = (kind, tmdb_id)
    # Saved before the current platform list ('pv'): fetch once more to get it.
    fresh = cached is not None and time.time() - r['fetched_at'] < CREDITS_MAX_AGE and cached.get('pv') == PROV_VERSION
    if fresh or time.time() - _credits_failed.get(key, 0) < CREDITS_RETRY_AFTER:
        return cached
    try:
        return fetch_credits(kind, tmdb_id, quick=True)
    except NetworkError:
        _credits_failed[key] = time.time()
        return cached


def fetch_credits(kind, tmdb_id, quick=False):
    credits_part = 'credits' if kind == 'movie' else 'aggregate_credits'
    d = tmdb(f"/{kind}/{tmdb_id}", quick=quick, append_to_response=f"{credits_part},recommendations,similar,watch/providers")
    data = _parse_credits(kind, d) if d else {}
    with session() as c:
        c.execute("INSERT OR REPLACE INTO credits (kind, tmdb_id, data, fetched_at) VALUES (?, ?, ?, ?)",
                  (kind, tmdb_id, json.dumps(data, ensure_ascii=False), time.time()))
    return data


PHOTO_SIZE = 'w185'
PREFETCH_RETRY_AFTER = 1800


def _missing_photos(data):
    """Actor photos and platform logos not saved on the server yet, as (path, size)."""
    want = [(p['p'], PHOTO_SIZE) for p in (data or {}).get('cast') or [] if p.get('p')]
    want += [(p['l'], LOGO_SIZE) for p in (data or {}).get('prov') or [] if p.get('l')]
    return [(path, size) for path, size in want if not os.path.exists(media.image_path(path, size))]


def prefetch_credits():
    """Downloads credits and actor photos for the whole library ahead of time, titles rated 8+ first, so the pause
    screen opens instantly and works offline. Skips what is fresh and complete; False if the internet is down."""
    with session() as c:
        titles = c.execute("SELECT 'movie' AS kind, tmdb_id, MAX(CAST(rating AS REAL)) AS r FROM movies "
                           "WHERE tmdb_id IS NOT NULL GROUP BY tmdb_id UNION ALL "
                           "SELECT 'tv', tmdb_id, MAX(CAST(rating AS REAL)) FROM series "
                           "WHERE tmdb_id IS NOT NULL GROUP BY tmdb_id").fetchall()
        have = {(r['kind'], r['tmdb_id']): json.loads(r['data']) for r in c.execute(
            "SELECT kind, tmdb_id, data FROM credits WHERE fetched_at > ?", (time.time() - CREDITS_MAX_AGE,))}
    have = {k: v for k, v in have.items() if v.get('pv') == PROV_VERSION}  # older platform lists: fetch them again
    jobs = [t for t in titles if (t['kind'], t['tmdb_id']) not in have or _missing_photos(have[(t['kind'], t['tmdb_id'])])]
    jobs.sort(key=lambda t: ((t['r'] or 0) < 8, -(t['r'] or 0)))
    state.credits.update(done=0, total=len(jobs))
    api_failures = photo_failures = 0
    for i, t in enumerate(jobs):
        state.credits['done'] = i
        key = (t['kind'], t['tmdb_id'])
        data = have.get(key)
        if data is None:
            try:
                data = fetch_credits(*key)
                api_failures = 0
            except NetworkError:
                api_failures += 1
                if api_failures >= 5:
                    return False
                continue
        for path, size in _missing_photos(data):
            if media.remote_image(path, size):
                photo_failures = 0
            else:
                photo_failures += 1
                if photo_failures >= 10:
                    return False
        time.sleep(0.05)
    return True


def credits_loop():
    while True:
        state.credits_wake.wait()
        state.credits_wake.clear()
        try:
            complete = prefetch_credits()
        except Exception as e:
            print(f"Oyuncu bilgileri hatası: {e}")
            complete = True
        state.credits.update(done=0, total=0)
        if not complete:
            print("Oyuncu bilgileri: TMDb'ye ulaşılamıyor, 30 dakika sonra tekrar denenecek")
            timer = threading.Timer(PREFETCH_RETRY_AFTER, state.credits_wake.set)
            timer.daemon = True
            timer.start()


_season_jobs = set()
_season_lock = threading.Lock()


def fetch_season(series_id, tmdb_id, season, ids=None, lang='tr'):
    """Episode names, descriptions, stills and runtimes of a season, in Turkish or (lang='en') English."""
    key = (series_id, season, lang)
    with _season_lock:
        if key in _season_jobs:
            return
        _season_jobs.add(key)
    en = lang == 'en'
    try:
        d = tmdb(f"/tv/{tmdb_id}/season/{season}", language=EN_LANG) if en else tmdb(f"/tv/{tmdb_id}/season/{season}")
        with session() as c:
            for ep in (d or {}).get('episodes') or []:
                for sid in ids or [series_id]:
                    if en:
                        c.execute("UPDATE episodes SET ep_name_en = ?, ep_overview_en = ? "
                                  "WHERE series_id = ? AND season = ? AND episode = ? AND episode < 1000",
                                  (ep.get('name') or '', ep.get('overview') or '', sid, season, ep.get('episode_number')))
                    else:
                        c.execute("UPDATE episodes SET ep_name = ?, ep_overview = ?, still = ?, runtime = ? "
                                  "WHERE series_id = ? AND season = ? AND episode = ? AND episode < 1000",
                                  (ep.get('name'), ep.get('overview'), ep.get('still_path'), ep.get('runtime'),
                                   sid, season, ep.get('episode_number')))
            col = 'en_at' if en else 'fetched_at'
            c.execute(f"INSERT INTO season_fetch (series_id, season, {col}) VALUES (?, ?, ?) "
                      f"ON CONFLICT(series_id, season) DO UPDATE SET {col} = excluded.{col}",
                      (series_id, season, time.time()))
    except Exception as e:
        print(f"Sezon bilgisi alınamadı: {e}")
    finally:
        with _season_lock:
            _season_jobs.discard(key)


def start():
    threading.Thread(target=enricher_loop, daemon=True, name="enricher").start()
    threading.Thread(target=credits_loop, daemon=True, name="credits").start()
