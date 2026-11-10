"""Downloads of local library files to a device: a few files at a time per device (1 unless the server owner changes
it in Settings), and all downloads together share a speed limit so they never take the bandwidth people need to watch.

A device is the viewer cookie (the same id that keeps its watch history). While a device has as many downloads moving
as it is allowed, another one from that device is refused; a download that has sent nothing for STALE seconds (the connection died
without the server noticing) no longer counts, so a dropped download never leaves the device locked out.
"""
import threading
import time

CHUNK = 64 * 1024
DEFAULT_MBPS = 40          # all downloads together, in megabits per second
MIN_MBPS, MAX_MBPS = 5, 1000
DEFAULT_PER_DEVICE = 1     # files one device may download at the same time
MIN_PER_DEVICE, MAX_PER_DEVICE = 1, 5
STALE = 30

_lock = threading.Lock()
_active = {}               # token -> {'viewer', 'name', 'size', 'sent', 'last'}
_bucket = {'tokens': 0.0, 'at': time.monotonic()}
_rate = {'bps': DEFAULT_MBPS * 125_000}
_per = {'device': DEFAULT_PER_DEVICE}


def set_limit(mbps):
    try:
        mbps = int(float(mbps))
    except (TypeError, ValueError):
        mbps = DEFAULT_MBPS
    mbps = max(MIN_MBPS, min(MAX_MBPS, mbps))
    _rate['bps'] = mbps * 125_000
    return mbps


def limit_mbps():
    return _rate['bps'] // 125_000


def set_per_device(n):
    try:
        n = int(float(n))
    except (TypeError, ValueError):
        n = DEFAULT_PER_DEVICE
    _per['device'] = max(MIN_PER_DEVICE, min(MAX_PER_DEVICE, n))
    return _per['device']


def per_device():
    return _per['device']


def _mine(viewer):
    return [a for a in _active.values() if a['viewer'] == viewer and _alive(a)]


def status(viewer):
    """What this device is downloading now, how many more it may start, and how many devices are downloading."""
    with _lock:
        mine = [{'name': a['name'], 'size': a['size'], 'sent': a['sent']} for a in _mine(viewer)]
        devices = {a['viewer'] for a in _active.values() if _alive(a)}
        return {'mine': mine[0] if mine else None, 'mine_all': mine, 'per_device': per_device(),
                'free': max(0, per_device() - len(mine)), 'count': len(devices), 'limit_mbps': limit_mbps()}


def active():
    """Every download moving now: which device, which file and how far it is."""
    with _lock:
        return [{'viewer': a['viewer'], 'name': a['name'], 'size': a['size'], 'sent': a['sent']}
                for a in _active.values() if _alive(a)]


def _take(n):
    """Wait until n bytes fit under the shared limit (a token bucket holding at most a quarter second of data)."""
    while True:
        with _lock:
            now = time.monotonic()
            rate = _rate['bps']
            _bucket['tokens'] = min(rate / 4, _bucket['tokens'] + (now - _bucket['at']) * rate)
            _bucket['at'] = now
            if _bucket['tokens'] >= n:
                _bucket['tokens'] -= n
                return
            wait = (n - _bucket['tokens']) / rate
        time.sleep(min(wait, 0.25))


def _alive(a):
    return a is not None and time.monotonic() - a['last'] < STALE


def claim(viewer, name, size):
    """Start a download for this device, or return None while it already has as many moving as it is allowed.
    Stalled earlier downloads of the device are dropped and stop at their next chunk."""
    token = object()
    with _lock:
        for t, a in list(_active.items()):
            if a['viewer'] == viewer and not _alive(a):
                del _active[t]
        if len(_mine(viewer)) >= per_device():
            return None
        _active[token] = {'viewer': viewer, 'name': name, 'size': size, 'sent': 0, 'last': time.monotonic()}
    return token


def _release(token):
    with _lock:
        _active.pop(token, None)


def reader(path, viewer, token, start, length):
    """Yield the byte range of the file, throttled; ends early if the download was dropped as stalled."""
    try:
        with open(path, 'rb') as f:
            f.seek(start)
            left = length
            while left > 0:
                with _lock:
                    if token not in _active:
                        return
                n = min(CHUNK, left)
                _take(n)
                data = f.read(n)
                if not data:
                    return
                left -= len(data)
                with _lock:
                    a = _active.get(token)
                    if a:
                        a['sent'] += len(data)
                        a['last'] = time.monotonic()
                yield data
    finally:
        _release(token)
