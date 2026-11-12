import json
import os
import sqlite3
from contextlib import contextmanager

from .config import DB_FILE, DEFAULT_MOVIE_DIRS, DEFAULT_MUSIC_DIRS, DEFAULT_SERIES_DIRS, OMDB_KEYS

SCHEMA = """
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, year TEXT, path TEXT UNIQUE NOT NULL,
    poster TEXT, rating TEXT, plot TEXT, genre TEXT, candidates TEXT
);
CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL, year TEXT, poster TEXT, rating TEXT, plot TEXT, genre TEXT, candidates TEXT
);
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL, series_name TEXT NOT NULL,
    season INTEGER NOT NULL, episode INTEGER NOT NULL,
    title TEXT, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
    FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY, name TEXT, overview TEXT, poster TEXT, backdrop TEXT,
    parts INTEGER DEFAULT 0, fetched INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS progress (
    viewer TEXT NOT NULL, key TEXT NOT NULL, position REAL, duration REAL, finished INTEGER DEFAULT 0, updated_at REAL,
    PRIMARY KEY (viewer, key)
);
CREATE TABLE IF NOT EXISTS mylist (viewer TEXT NOT NULL, key TEXT NOT NULL, added_at REAL, PRIMARY KEY (viewer, key));
CREATE TABLE IF NOT EXISTS credits (kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, data TEXT, fetched_at REAL,
    PRIMARY KEY (kind, tmdb_id));
CREATE TABLE IF NOT EXISTS season_fetch (series_id INTEGER, season INTEGER, fetched_at REAL,
    PRIMARY KEY (series_id, season));
-- Titles seen in the Online tab (TMDb data), so Continue Watching and My List can show them without TMDb.
CREATE TABLE IF NOT EXISTS online_titles (kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, data TEXT, updated_at REAL,
    PRIMARY KEY (kind, tmdb_id));
-- Music videos (the Music Videos tab). thumb: 0 = cover frame not made yet, 1 = ready, -1 = ffmpeg failed.
CREATE TABLE IF NOT EXISTS music_videos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, artist TEXT,
    title TEXT, added_at REAL, size INTEGER, duration REAL, thumb INTEGER DEFAULT 0);
-- Music video artists: photo and background (files in cache/clip_art), genre, country and biography (clipmeta.py).
CREATE TABLE IF NOT EXISTS clip_artists (key TEXT PRIMARY KEY, name TEXT, deezer_id INTEGER, photo INTEGER DEFAULT 0,
    bg INTEGER DEFAULT 0, genre TEXT, country TEXT, bio_tr TEXT, bio_en TEXT, fetched_at REAL);
-- Live TV: a viewer's own IPTV subscription (iptv.py). kind 'm3u' (url = playlist link) or 'xtream' (url = panel
-- address + username/password). shared = every device of this server sees it. The channel list is in data/iptv/<id>.json.
CREATE TABLE IF NOT EXISTS iptv_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, viewer TEXT NOT NULL, name TEXT,
    kind TEXT, url TEXT, username TEXT, password TEXT, shared INTEGER DEFAULT 0, added_at REAL, updated_at REAL,
    count INTEGER DEFAULT 0, info TEXT, error TEXT);
-- Devices that use this server (the viewer cookie), for Settings › Connected devices on the server computer. name is
-- what the server owner called it; empty = a name guessed from the browser. last_seen is updated at most once a minute.
CREATE TABLE IF NOT EXISTS devices (viewer TEXT PRIMARY KEY, name TEXT DEFAULT '', ua TEXT, ip TEXT, first_seen REAL,
    last_seen REAL);
-- Activity log (activity.py): kind 'visit' (a device connected), 'watch' (pos/dur = how far it got) or 'download'
-- (size, sent = bytes sent so far, pos = byte it started at). until = last update. key = the item key (m:12, e:34...).
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, until REAL, viewer TEXT, ip TEXT,
    kind TEXT, key TEXT, title TEXT, pos REAL, dur REAL, size INTEGER, sent INTEGER);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
CREATE INDEX IF NOT EXISTS idx_activity_viewer ON activity(viewer, at);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id, season, episode);
"""

EXTRA_COLUMNS = {
    "movies": {"meta_tries": "INTEGER DEFAULT 0", "original_title": "TEXT", "tmdb_id": "INTEGER",
               "imdb_id": "TEXT", "collection_id": "INTEGER", "runtime": "INTEGER", "backdrop": "TEXT",
               "added_at": "REAL", "size": "INTEGER", "enriched": "INTEGER DEFAULT 0", "cert": "TEXT",
               # English title, plot and tagline (TMDb en-US) for the web app's English mode; NULL = not fetched yet. Genres need
               # no copy: the web app translates their Turkish names itself.
               "title_en": "TEXT", "plot_en": "TEXT", "tagline_en": "TEXT"},
    "series": {"meta_tries": "INTEGER DEFAULT 0", "original_title": "TEXT", "tmdb_id": "INTEGER",
               "backdrop": "TEXT", "added_at": "REAL", "enriched": "INTEGER DEFAULT 0", "display_title": "TEXT",
               "cert": "TEXT", "title_en": "TEXT", "plot_en": "TEXT", "tagline_en": "TEXT"},
    "episodes": {"ep_name": "TEXT", "ep_overview": "TEXT", "still": "TEXT", "runtime": "INTEGER",
                 "ep_name_en": "TEXT", "ep_overview_en": "TEXT"},
    "collections": {"name_en": "TEXT", "overview_en": "TEXT"},
    "season_fetch": {"en_at": "REAL"},
    # Year and album from Deezer; meta_at = when they were looked up (NULL = not yet).
    "music_videos": {"year": "TEXT", "album": "TEXT", "meta_at": "REAL"},
}


def connect():
    conn = sqlite3.connect(DB_FILE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Requests from the server computer itself share this viewer id; other devices get their own from a cookie.
LOCAL_VIEWER = "local"


def _split_by_viewer(c):
    """v2.0 kept one shared watch history; it was recorded on the server computer, so it becomes that viewer's."""
    for table, cols in (("progress", "key, position, duration, finished, updated_at"), ("mylist", "key, added_at")):
        have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        if have and "viewer" not in have:
            c.execute(f"ALTER TABLE {table} RENAME TO {table}_shared")
            c.executescript(SCHEMA)
            c.execute(f"INSERT INTO {table} (viewer, {cols}) SELECT ?, {cols} FROM {table}_shared", (LOCAL_VIEWER,))
            c.execute(f"DROP TABLE {table}_shared")


def init_db():
    with session() as c:
        c.execute("PRAGMA journal_mode = WAL")
        _split_by_viewer(c)
        c.executescript(SCHEMA)
        for table, cols in EXTRA_COLUMNS.items():
            have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            for name, decl in cols.items():
                if name not in have:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        c.execute("CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_movies_collection ON movies(collection_id)")
        if not c.execute("SELECT 1 FROM config WHERE key = 'v2_title_pass'").fetchone():
            c.execute("UPDATE movies SET enriched = 0 WHERE tmdb_id IS NOT NULL")
            c.execute("UPDATE series SET enriched = 0 WHERE tmdb_id IS NOT NULL")
            c.execute("INSERT INTO config (key, value) VALUES ('v2_title_pass', '1')")
        if not c.execute("SELECT 1 FROM config WHERE key = 'v2_rematch'").fetchone():
            c.execute("UPDATE movies SET tmdb_id = NULL, original_title = NULL, enriched = 0, meta_tries = 0")
            c.execute("INSERT INTO config (key, value) VALUES ('v2_rematch', '1')")
        if not c.execute("SELECT 1 FROM config WHERE key = 'v2_caps_pass'").fetchone():
            for r in c.execute("SELECT id, title FROM movies WHERE tmdb_id IS NOT NULL").fetchall():
                if r['title'].isupper():
                    c.execute("UPDATE movies SET enriched = 0 WHERE id = ?", (r['id'],))
            c.execute("INSERT INTO config (key, value) VALUES ('v2_caps_pass', '1')")


def _first_existing(paths):
    return next((p for p in paths if os.path.isdir(p) and os.listdir(p)), paths[0])


def load_settings():
    with session() as c:
        conf = {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM config")}
    conf.setdefault("movie_dir", _first_existing(DEFAULT_MOVIE_DIRS))
    conf.setdefault("series_dir", _first_existing(DEFAULT_SERIES_DIRS))
    if "music_dirs" not in conf:
        music = next((p for p in DEFAULT_MUSIC_DIRS if os.path.isdir(p)), None)
        conf["music_dirs"] = json.dumps([music] if music else [], ensure_ascii=False)
    conf.setdefault("omdb_api_key", OMDB_KEYS[0] if OMDB_KEYS else "")
    return conf


def library_dirs(settings, kind):
    """The movie, series or music video folders ('movie' / 'series' / 'music'). Older installs kept a single folder in
    movie_dir / series_dir."""
    raw = settings.get(f"{kind}_dirs")
    if raw is None:
        return [settings[f"{kind}_dir"]] if settings.get(f"{kind}_dir") else []
    try:
        dirs = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return [d for d in dirs if isinstance(d, str) and d]


def save_settings(values):
    with session() as c:
        for k, v in values.items():
            c.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (k, str(v)))
