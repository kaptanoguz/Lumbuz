import json
import os
import re
import shutil
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict

from . import clips, state
from .config import IMG_EXTS, POSTERS_DIR, VIDEO_EXTS
from .db import library_dirs, session
from .names import (EXTRA_BASE, VTS_RE, clean_display_title, clean_series_name, parse_season_episode, series_year,
                    smart_title)

NON_POSTER_WORDS = ('backdrop', 'fanart', 'landscape', 'banner', 'thumb', 'logo', 'clearart', 'disc', 'background')
scan_lock = threading.Lock()
settings_ref = {}
emby_lock = threading.Lock()


def poster_file(poster_value):
    """'/get_poster/movie_12' -> absolute path of the cached poster, or None."""
    if not poster_value or not poster_value.startswith('/get_poster/'):
        return None
    p = os.path.join(POSTERS_DIR, f"poster_{poster_value[len('/get_poster/'):]}.jpg")
    return p if os.path.exists(p) else None


def is_movie_file(name):
    if name.startswith('._') or not name.lower().endswith(VIDEO_EXTS):
        return False
    if re.search(r'[Ss]\d+[Ee]\d+', name):
        return False
    if name.upper() == 'VIDEO_TS.VOB':
        return False
    vm = VTS_RE.match(name)
    return not (vm and vm.group(2) != '1')


# ---------------------------------------------------------------- scanning

def scan_library(settings):
    if not scan_lock.acquire(blocking=False):
        return
    state.set_task('scan', 'Kütüphane taranıyor')
    try:
        _scan(settings)
    except Exception as e:
        print(f"Tarama hatası: {e}")
    finally:
        state.clear_task('scan')
        scan_lock.release()
    sync_emby(settings)
    clips.scan(settings)
    state.wake_enricher()


def _file_info(path):
    try:
        st = os.stat(path)
        return st.st_mtime, st.st_size
    except OSError:
        return time.time(), 0


def _under(path, roots):
    return any(path == r or path.startswith(r.rstrip(os.sep) + os.sep) for r in roots)


def _scan(settings):
    movie_dirs, series_dirs = library_dirs(settings, 'movie'), library_dirs(settings, 'series')
    # A folder that is missing or empty (a drive that isn't plugged in) keeps its titles until it is back.
    # Titles from a folder that was taken out of the list are removed.
    with session() as c:
        found, scanned = set(), []
        existing = {r['path']: r for r in c.execute("SELECT id, path, added_at FROM movies")}
        for movie_dir in movie_dirs:
            if not os.path.isdir(movie_dir):
                continue
            n = 0
            for root, _, files in os.walk(movie_dir):
                for f in files:
                    if not is_movie_file(f):
                        continue
                    path = os.path.join(root, f)
                    n += 1
                    if path in found:
                        continue
                    found.add(path)
                    mtime, size = _file_info(path)
                    row = existing.get(path)
                    if row:
                        if not row['added_at']:
                            c.execute("UPDATE movies SET added_at = ?, size = ? WHERE id = ?", (mtime, size, row['id']))
                        continue
                    title, year = smart_title(path)
                    c.execute("INSERT INTO movies (title, year, path, poster, rating, plot, genre, candidates, added_at, size) "
                              "VALUES (?, ?, ?, '', '', '', '', ?, ?, ?)",
                              (title, year, path, json.dumps([title]), mtime, size))
            if n:
                scanned.append(movie_dir)
        for r in c.execute("SELECT id, path FROM movies").fetchall():
            if r['path'] not in found and (_under(r['path'], scanned) or not _under(r['path'], movie_dirs)):
                c.execute("DELETE FROM movies WHERE id = ?", (r['id'],))

        shows, years, seen, scanned = defaultdict(list), {}, set(), []
        for series_dir in series_dirs:
            if not os.path.isdir(series_dir):
                continue
            n = 0
            for root, _, files in os.walk(series_dir):
                for f in files:
                    if f.startswith('._') or not f.lower().endswith(VIDEO_EXTS):
                        continue
                    path = os.path.join(root, f)
                    n += 1
                    if path in seen:
                        continue
                    seen.add(path)
                    rel = os.path.relpath(path, series_dir)
                    season, episode = parse_season_episode(rel)
                    folder = rel.split(os.sep)[0]
                    name = clean_series_name(folder)
                    shows[name].append((season, episode, path, f))
                    if not years.get(name):
                        years[name] = series_year(folder)
            if n:
                scanned.append(series_dir)
        ep_paths = set()
        for name, eps in shows.items():
            # Extras without an S00Exx number: numbered in file-name order, so they keep their place across scans.
            loose = sorted((e for e in eps if e[0] == 0 and e[1] == 0), key=lambda e: e[3].lower())
            if loose:
                eps = [e for e in eps if not (e[0] == 0 and e[1] == 0)]
                eps += [(0, EXTRA_BASE + i, path, f) for i, (_, _, path, f) in enumerate(loose, 1)]
            year = years.get(name) or ''
            row = c.execute("SELECT id, year FROM series WHERE title = ?", (name,)).fetchone()
            if not row:
                added = min(_file_info(p)[0] for _, _, p, _ in eps)
                c.execute("INSERT INTO series (title, year, poster, rating, plot, genre, candidates, added_at) "
                          "VALUES (?, ?, '', '', '', '', ?, ?)", (name, year, json.dumps([name]), added))
                row = c.execute("SELECT id, year FROM series WHERE title = ?", (name,)).fetchone()
            elif year and not row['year']:
                # The folder's year is what picks the right show among namesakes on TMDb.
                c.execute("UPDATE series SET year = ? WHERE id = ?", (year, row['id']))
            sid = row['id']
            for season, episode, path, fname in eps:
                ep_paths.add(path)
                c.execute("INSERT INTO episodes (series_id, series_name, season, episode, title, path, filename) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET series_id = excluded.series_id, "
                          "series_name = excluded.series_name, season = excluded.season, episode = excluded.episode, "
                          "title = excluded.title, filename = excluded.filename, "
                          # A file that moved to another season/episode (an extra that used to count as 1x1) drops the
                          # TMDb details of its old number; the season fetch fills in the right ones.
                          "ep_name = CASE WHEN episodes.season = excluded.season AND episodes.episode = excluded.episode "
                          "THEN episodes.ep_name END, ep_overview = CASE WHEN episodes.season = excluded.season AND "
                          "episodes.episode = excluded.episode THEN episodes.ep_overview END, still = CASE WHEN "
                          "episodes.season = excluded.season AND episodes.episode = excluded.episode THEN episodes.still END, "
                          "ep_name_en = CASE WHEN episodes.season = excluded.season AND episodes.episode = excluded.episode "
                          "THEN episodes.ep_name_en END, ep_overview_en = CASE WHEN episodes.season = excluded.season AND "
                          "episodes.episode = excluded.episode THEN episodes.ep_overview_en END",
                          (sid, name, season, episode, fname, path, fname))
        for r in c.execute("SELECT id, path FROM episodes").fetchall():
            if r['path'] not in ep_paths and (_under(r['path'], scanned) or not _under(r['path'], series_dirs)):
                c.execute("DELETE FROM episodes WHERE id = ?", (r['id'],))
        for r in c.execute("SELECT id, title FROM series").fetchall():
            if r['title'] not in shows and not c.execute("SELECT 1 FROM episodes WHERE series_id = ?", (r['id'],)).fetchone():
                c.execute("DELETE FROM series WHERE id = ?", (r['id'],))


def fill_file_info():
    with session() as c:
        for r in c.execute("SELECT id, path FROM movies WHERE added_at IS NULL").fetchall():
            mtime, size = _file_info(r['path'])
            c.execute("UPDATE movies SET added_at = ?, size = ? WHERE id = ?", (mtime, size, r['id']))
        for r in c.execute("SELECT id FROM series WHERE added_at IS NULL").fetchall():
            e = c.execute("SELECT path FROM episodes WHERE series_id = ? LIMIT 1", (r['id'],)).fetchone()
            c.execute("UPDATE series SET added_at = ? WHERE id = ?", (_file_info(e['path'])[0] if e else time.time(), r['id']))


def tr_title_case(text):
    def word(w):
        if any(ch.isdigit() for ch in w) or len(w) <= 1:
            return w
        low = w.replace('I', 'ı').replace('İ', 'i').lower()
        first = {'i': 'İ', 'ı': 'I'}.get(low[0], low[0].upper())
        return first + low[1:]
    return ' '.join(word(w) for w in text.split(' '))


def cleanup_titles():
    with session() as c:
        for r in c.execute("SELECT id, title FROM movies").fetchall():
            new = clean_display_title(r['title'])
            if new.isupper() and len(new.replace(' ', '')) > 4 and ' ' in new:
                new = tr_title_case(new)
            if new and new != r['title']:
                c.execute("UPDATE movies SET title = ? WHERE id = ?", (new, r['id']))


# ---------------------------------------------------------------- Emby / Jellyfin .nfo

def read_nfo(path, root_tag):
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
        if data.startswith(b'\xef\xbb\xbf'):
            data = data[3:]
        root = ET.fromstring(data)
    except Exception:
        return None
    if root.tag != root_tag:
        return None

    def txt(tag):
        e = root.find(tag)
        return (e.text or '').strip() if e is not None and e.text else ''

    rating = ''
    try:
        rv = float(txt('rating').replace(',', '.'))
        if rv > 0:
            rating = f"{rv:.1f}"
    except ValueError:
        pass
    tmdb = txt('tmdbid')
    set_el = root.find('set')
    set_name = ''
    if set_el is not None:
        set_name = (set_el.findtext('name') or set_el.text or '').strip()
    return {
        'title': txt('title'), 'original_title': txt('originaltitle'), 'rating': rating, 'plot': txt('plot'),
        'year': txt('year'), 'genre': ', '.join(g.text.strip() for g in root.findall('genre') if g.text and g.text.strip()),
        'tmdb_id': int(tmdb) if tmdb.isdigit() else None,
        'imdb_id': txt('imdbid') or txt('imdb_id'), 'set': set_name,
        'runtime': int(txt('runtime')) if txt('runtime').isdigit() else None,
    }


_tiny_cache = {}


def is_tiny(path, limit=200):
    """True for placeholder images (some downloaders drop a 50x50 poster.jpg) so TMDb artwork is used instead."""
    try:
        st = os.stat(path)
    except OSError:
        return False
    key = (path, st.st_mtime, st.st_size)
    if key not in _tiny_cache:
        try:
            from PIL import Image
            with Image.open(path) as im:
                _tiny_cache[key] = max(im.size) < limit
        except Exception:
            _tiny_cache[key] = False
    return _tiny_cache[key]


def _images(folder):
    try:
        return [f for f in os.listdir(folder) if f.lower().endswith(IMG_EXTS) and not f.startswith('._')
                and not is_tiny(os.path.join(folder, f))]
    except OSError:
        return []


def find_poster(folder, base_names, generic_ok):
    files = _images(folder)
    low = {f.lower(): f for f in files}
    names = []
    for b in base_names:
        for ext in IMG_EXTS:
            names += [f"{b}-poster{ext}", f"{b}{ext}"]
    if generic_ok:
        for g in ('poster', 'folder', 'cover', 'movie'):
            names += [g + ext for ext in IMG_EXTS]
    for n in names:
        if n.lower() in low:
            return os.path.join(folder, low[n.lower()])
    if generic_ok:
        imgs = [f for f in files if not any(w in f.lower() for w in NON_POSTER_WORDS)]
        if len(imgs) == 1:
            return os.path.join(folder, imgs[0])
    return None


def find_backdrop(folder, base_names=(), generic_ok=True):
    low = {f.lower(): f for f in _images(folder)}
    names = []
    for b in base_names:
        names += [f"{b}-fanart{ext}" for ext in IMG_EXTS] + [f"{b}-backdrop{ext}" for ext in IMG_EXTS]
    if generic_ok:
        for g in ('backdrop', 'fanart', 'background', 'landscape'):
            names += [g + ext for ext in IMG_EXTS]
    for n in names:
        if n.lower() in low:
            return os.path.join(folder, low[n.lower()])
    return None


def find_movie_nfo(folder, base, generic_ok):
    cands = [os.path.join(folder, base + '.nfo')]
    if generic_ok:
        cands.append(os.path.join(folder, 'movie.nfo'))
        try:
            entries = os.listdir(folder)
            if len([f for f in entries if f.lower().endswith(VIDEO_EXTS)]) <= 1:
                cands += [os.path.join(folder, f) for f in entries if f.lower().endswith('.nfo') and not f.startswith('._')]
        except OSError:
            pass
    for p in cands:
        if os.path.exists(p):
            m = read_nfo(p, 'movie')
            if m:
                return m
    return None


def series_folder(settings, title):
    for root in library_dirs(settings, 'series'):
        try:
            for d in os.listdir(root):
                if os.path.isdir(os.path.join(root, d)) and clean_series_name(d).lower() == title.lower():
                    return os.path.join(root, d)
        except OSError:
            pass
    return None


def movie_folder_info(settings, path):
    folder, fname = os.path.split(path)
    base = os.path.splitext(fname)[0]
    generic_ok = os.path.normpath(folder) not in {os.path.normpath(d) for d in library_dirs(settings, 'movie')}
    return folder, base, generic_ok


def _copy_poster(src, kind, item_id):
    dst = os.path.join(POSTERS_DIR, f"poster_{kind}_{item_id}.jpg")
    try:
        if not (os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src)
                and os.path.getmtime(dst) >= os.path.getmtime(src)):
            shutil.copyfile(src, dst)
        return f"/get_poster/{kind}_{item_id}"
    except OSError:
        return None


def sync_emby(settings):
    if not emby_lock.acquire(blocking=False):
        return 0, 0
    state.set_task('emby', 'Emby bilgileri okunuyor')
    try:
        return _sync_emby(settings)
    finally:
        state.clear_task('emby')
        emby_lock.release()


def _sync_emby(settings):
    n_movies = n_series = 0
    with session() as c:
        for row in c.execute("SELECT id, path FROM movies").fetchall():
            folder, base, generic_ok = movie_folder_info(settings, row['path'])
            meta = find_movie_nfo(folder, base, generic_ok)
            poster_src = find_poster(folder, [base], generic_ok)
            fields = {}
            if poster_src:
                p = _copy_poster(poster_src, 'movie', row['id'])
                if p:
                    fields['poster'] = p
            if meta:
                for k in ('title', 'original_title', 'rating', 'plot', 'genre', 'year', 'tmdb_id', 'imdb_id', 'runtime'):
                    if meta.get(k):
                        fields[k] = meta[k]
            if fields:
                c.execute(f"UPDATE movies SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                          list(fields.values()) + [row['id']])
                n_movies += 1
        for row in c.execute("SELECT id, title FROM series").fetchall():
            folder = series_folder(settings, row['title'])
            if not folder:
                continue
            nfo = os.path.join(folder, 'tvshow.nfo')
            meta = read_nfo(nfo, 'tvshow') if os.path.exists(nfo) else None
            poster_src = find_poster(folder, [], True)
            fields = {}
            if poster_src:
                p = _copy_poster(poster_src, 'series', row['id'])
                if p:
                    fields['poster'] = p
            if meta:
                for k in ('rating', 'plot', 'genre', 'year', 'tmdb_id', 'original_title'):
                    if meta.get(k):
                        fields[k] = meta[k]
            if fields:
                c.execute(f"UPDATE series SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                          list(fields.values()) + [row['id']])
                n_series += 1
    print(f"Emby metadata: {n_movies} film, {n_series} dizi güncellendi.")
    return n_movies, n_series
