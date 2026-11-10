"""Lining up a subtitle with the film's own sound.

A subtitle from the internet (or one a viewer uploads) is often made for another release of the film: a few seconds
of extra logo at the start, or a 25 fps copy whose timings slowly run away from a 23.976 fps file. Here the film's
audio is reduced to a "someone is talking" track (energy in the voice band, 100 values a second), and the subtitle is
shifted, and if needed stretched by one of the usual frame-rate ratios, to where its lines fall on that speech best.

The speech track is made once per video and audio track (one low-priority ffmpeg run, about a minute for a film) and
kept in SUBS_DIR, so later subtitles for the same video line up in a few seconds. One job runs at a time, so this
never competes with playback for more than one CPU core.
"""
import hashlib
import json
import os
import queue
import re
import subprocess
import threading
from array import array

from .config import SUBS_DIR
from .names import vob_parts

RATE = 100                  # speech track values per second
MAX_SHIFT = 120.0           # seconds a subtitle may be moved either way
COARSE = 10                 # first pass every 0.1 s, then to the 10 ms around the best
MIN_CONFIDENCE = 6.0        # how far the best fit must stand out from all other shifts (in standard deviations)
# Same film at another frame rate: PAL 25, film 24, NTSC film 23.976.
RATIOS = (1.0, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25)

_TIME = re.compile(r'(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})')

_jobs = {}                  # key -> {'state': 'working'|'done'|'failed', ...}
_lock = threading.Lock()
_queue = queue.Queue()
_worker = None


def cue_times(text):
    """(start, end) of every cue in an SRT/VTT text, in seconds."""
    out = []
    for m in _TIME.finditer(text or ''):
        g = m.groups()
        s = int(g[0] or 0) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3].ljust(3, '0')) / 1000
        e = int(g[4] or 0) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7].ljust(3, '0')) / 1000
        if e > s:
            out.append((s, e))
    return sorted(out)


def _low_priority():
    try:
        os.nice(19)
    except (AttributeError, OSError):
        pass


def _centre(path, audio):
    """True for 5.1/7.1 tracks: their dialogue sits in the centre channel, away from music and effects."""
    from .media import probe
    try:
        tracks = probe(path)['audio']
        return (tracks[audio] if audio < len(tracks) else tracks[0])['channels'] >= 6
    except Exception:
        return False


def _speech_path(path, audio):
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|{audio}|{'fc' if _centre(path, audio) else 'mix'}".encode()).hexdigest()
    return os.path.join(SUBS_DIR, f'speech-{key}.f32')


def speech_track(path, audio=0):
    """Voice-band loudness of the film, RATE values a second, made once and kept on disk."""
    dest = _speech_path(path, audio)
    if os.path.exists(dest):
        a = array('f')
        with open(dest, 'rb') as f:
            a.frombytes(f.read())
        return a
    parts = vob_parts(path)
    cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1',
           '-i', ('concat:' + '|'.join(parts)) if parts else path, '-map', f'0:a:{audio}?', '-vn', '-sn',
           # mono, voice band only, squared and averaged down to RATE values a second
           '-af', ('pan=mono|c0=FC,' if _centre(path, audio) else 'aformat=channel_layouts=mono,') +
                  f'aresample=8000,highpass=f=300,lowpass=f=3000,'
                  f'aeval=val(0)*val(0),aresample={RATE}',
           '-f', 'f32le', 'pipe:1']
    kw = {'preexec_fn': _low_priority} if os.name == 'posix' else {'creationflags': 0x00004000}  # BELOW_NORMAL
    out = subprocess.run(cmd, capture_output=True, timeout=1800, **kw).stdout
    if len(out) < 4 * RATE * 60:  # under a minute of sound: no usable audio track
        return None
    a = array('f')
    a.frombytes(out[:len(out) // 4 * 4])
    tmp = dest + '.part'
    with open(tmp, 'wb') as f:
        a.tofile(f)
    os.replace(tmp, dest)
    return a


def _voice_prefix(power):
    """Prefix sums of +1 (louder than the film's median, likely speech) / -1 (quiet) per frame."""
    import math
    logs = [math.log10(max(p, 0.0) + 1e-10) for p in power]
    srt = sorted(logs)
    thr = srt[len(srt) // 2]
    pre = array('i', [0]) * (len(logs) + 1)
    run = 0
    for i, v in enumerate(logs):
        run += 1 if v > thr else -1
        pre[i + 1] = run
    return pre


def _score(pre, starts, ends, shift):
    n = len(pre) - 1
    tot = 0
    for a, b in zip(starts, ends):
        a += shift
        b += shift
        if b <= 0 or a >= n:
            continue
        tot += pre[min(b, n)] - pre[max(a, 0)]
    return tot


def align(power, cues):
    """Best (offset seconds, ratio) so that cue time t is shown at t * ratio + offset, with a confidence score."""
    pre = _voice_prefix(power)
    span = int(MAX_SHIFT * RATE)
    best = None
    for r in RATIOS:
        # Lines usually stay on screen a little after the words end, so only the first 80 % of each cue is used.
        starts = [int(s * r * RATE) for s, _ in cues]
        ends = [int((s + 0.8 * (e - s)) * r * RATE) for s, e in cues]
        scores = [(_score(pre, starts, ends, k), k) for k in range(-span, span + 1, COARSE)]
        top, k0 = max(scores)
        if best is None or top > best[0]:
            vals = [s for s, _ in scores]
            mean = sum(vals) / len(vals)
            sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5 or 1.0
            best = (top, k0, r, (top - mean) / sd, starts, ends)
    top, k0, r, conf, starts, ends = best
    fine = max((_score(pre, starts, ends, k), k) for k in range(k0 - COARSE, k0 + COARSE + 1))
    return {'offset': round(fine[1] / RATE, 2), 'ratio': r, 'confidence': round(conf, 1),
            'ok': conf >= MIN_CONFIDENCE}


def _result_path(key):
    return os.path.join(SUBS_DIR, f'align-{key}.json')


def _run(key, path, audio, cues):
    try:
        power = speech_track(path, audio)
        if power is None:
            res = {'state': 'failed', 'reason': 'no-audio'}
        else:
            res = {'state': 'done', **align(power, cues)}
            with open(_result_path(key), 'w') as f:
                json.dump(res, f)
    except Exception as e:  # a broken file must not stop the worker
        res = {'state': 'failed', 'reason': type(e).__name__}
    with _lock:
        _jobs[key] = res


def _work():
    while True:
        job = _queue.get()
        _run(*job)


def request(path, audio, text):
    """Starts (or finds) the alignment of this subtitle to this video. Returns (key, state dict)."""
    global _worker
    cues = cue_times(text)
    digest = hashlib.sha1(json.dumps(cues).encode()).hexdigest()
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{audio}|{digest}".encode()).hexdigest()[:24]
    if len(cues) < 20:
        return key, {'state': 'failed', 'reason': 'few-cues'}
    with _lock:
        if key in _jobs:
            return key, _jobs[key]
        try:
            with open(_result_path(key)) as f:
                _jobs[key] = json.load(f)
            return key, _jobs[key]
        except (OSError, ValueError):
            pass
        _jobs[key] = {'state': 'working'}
        if _worker is None:
            _worker = threading.Thread(target=_work, daemon=True)
            _worker.start()
    _queue.put((key, path, audio, cues))
    return key, {'state': 'working'}


def status(key):
    with _lock:
        return _jobs.get(key) or {'state': 'unknown'}
