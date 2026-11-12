"""Activity log for Settings › Connected devices: which device (viewer cookie and IP address) connected, what it
watched and what it downloaded. Kept for KEEP_DAYS days.

A "visit" is written when a device comes back after SESSION_GAP seconds without a request; one row per watched title
is written when playback starts and then updated (at most once a minute) with how far it got; a download gets one row
when it starts and is updated when it ends with how much was sent. Everything is a few small writes, so playback is
never slowed down.
"""
import threading
import time

from .db import session

KEEP_DAYS = 180
SESSION_GAP = 30 * 60   # a device seen again after this long counts as a new visit; a title played again, a new row
WRITE_EVERY = 60        # seconds between updates of a watch row

_lock = threading.Lock()
_last_seen = {}         # viewer -> time of its last request (None = not looked up in the database yet)
_watch = {}             # (viewer, key) -> [row id, last progress time, last write time]
_pruned = {'at': 0.0}


def client_ip(req, public=False):
    """The address of the device itself. Requests that come through a proxy on this computer (Caddy for the HTTPS
    name, or cloudflared for Lumbuz Online) arrive from 127.0.0.1; the proxy puts the real address in a header. The
    headers are trusted only from 127.0.0.1, so a device on the network cannot pretend to be someone else."""
    addr = req.remote_addr or ''
    if addr.startswith('127.') or addr == '::1':
        if public:
            cf = (req.headers.get('Cf-Connecting-Ip') or '').strip()
            if cf:
                return cf[:64]
        xff = req.headers.get('X-Forwarded-For') or ''
        if xff.strip():
            return xff.split(',')[-1].strip()[:64]  # the last entry is the one the proxy itself saw
    return addr


def _insert(c, viewer, ip, kind, key='', title='', **extra):
    now = time.time()
    cols = ['at', 'until', 'viewer', 'ip', 'kind', 'key', 'title'] + list(extra)
    vals = [now, now, viewer, ip, kind, key, title] + list(extra.values())
    cur = c.execute(f"INSERT INTO activity ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals)
    if now - _pruned['at'] > 86400:
        _pruned['at'] = now
        c.execute("DELETE FROM activity WHERE at < ?", (now - KEEP_DAYS * 86400,))
    return cur.lastrowid


def visit(viewer, ip):
    """Called on every request of a device; writes a row only when it comes back after a pause."""
    now = time.time()
    with _lock:
        last = _last_seen.get(viewer, None)
        _last_seen[viewer] = now
        if len(_last_seen) > 20000:
            _last_seen.clear()
    if last is not None and now - last < SESSION_GAP:
        return
    try:
        with session() as c:
            if last is None:  # first request since the server started: look at the log instead of guessing
                r = c.execute("SELECT MAX(until) AS t FROM activity WHERE viewer = ?", (viewer,)).fetchone()
                if r and r['t'] and now - r['t'] < SESSION_GAP:
                    return
            _insert(c, viewer, ip, 'visit')
    except Exception:
        pass


def touch(viewer):
    """Keep the visit going without writing anything (a request that is not logged as its own row)."""
    with _lock:
        if viewer in _last_seen:
            _last_seen[viewer] = time.time()


def watch(viewer, ip, key, title, pos, dur):
    """Playback progress of a title: a new row when it starts, then the position, at most once a minute. title may be
    a function, called only when a new row is written."""
    now = time.time()
    k = (viewer, key)
    with _lock:
        w = _watch.get(k)
        if w and now - w[1] < SESSION_GAP:
            w[1] = now
            if now - w[2] < WRITE_EVERY:
                return
            w[2] = now
            rid = w[0]
        else:
            rid = None
        if len(_watch) > 5000:
            _watch.clear()
    try:
        with session() as c:
            if rid:
                c.execute("UPDATE activity SET pos = ?, dur = ?, until = ? WHERE id = ?", (pos, dur, now, rid))
                return
            rid = _insert(c, viewer, ip, 'watch', key, title() if callable(title) else title, pos=pos, dur=dur)
        with _lock:
            _watch[k] = [rid, now, now]
    except Exception:
        pass


def download_start(viewer, ip, key, title, size, start=0):
    try:
        with session() as c:
            return _insert(c, viewer, ip, 'download', key, title, size=size, sent=0, pos=start)
    except Exception:
        return None


def download_end(rid, sent):
    if not rid:
        return
    try:
        with session() as c:
            c.execute("UPDATE activity SET sent = ?, until = ? WHERE id = ?", (sent, time.time(), rid))
    except Exception:
        pass


def recent(viewer=None, limit=50, before=None):
    """Newest first. pos of a download is where it started (a resumed download starts in the middle)."""
    q, args = "SELECT * FROM activity WHERE 1 = 1", []
    if viewer:
        q += " AND viewer = ?"
        args.append(viewer)
    if before:
        q += " AND at < ?"
        args.append(before)
    q += " ORDER BY at DESC LIMIT ?"
    args.append(max(1, min(500, int(limit))))
    with session() as c:
        return [dict(r) for r in c.execute(q, args)]

