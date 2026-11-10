import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time

import requests
from flask import Response

from .config import CACHE_DIR, IMAGES_DIR, THUMBS_DIR, TMDB_IMG, USER_AGENT
from .names import vob_parts

HAS_VAAPI = os.path.exists('/dev/dri/renderD128')
BROWSER_VIDEO = ('h264', 'vp8', 'vp9', 'av1')
BROWSER_AUDIO = ('aac', 'mp3', 'opus', 'vorbis')
TEXT_SUBS = ('subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text')

LANG_NAMES = {'tur': 'Türkçe', 'tr': 'Türkçe', 'eng': 'İngilizce', 'en': 'İngilizce', 'ger': 'Almanca', 'deu': 'Almanca',
              'fre': 'Fransızca', 'fra': 'Fransızca', 'spa': 'İspanyolca', 'ita': 'İtalyanca', 'rus': 'Rusça',
              'jpn': 'Japonca', 'kor': 'Korece', 'ara': 'Arapça', 'und': ''}

_probe_cache = {}
_probe_lock = threading.Lock()


def probe(path):
    with _probe_lock:
        if path in _probe_cache:
            return _probe_cache[path]
    parts = vob_parts(path) or [path]
    info = {'duration': 0.0, 'video': None, 'audio': [], 'subs': [], 'container': os.path.splitext(path)[1].lower()}
    for i, part in enumerate(parts):
        try:
            out = subprocess.run(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', part],
                                 capture_output=True, text=True, timeout=15).stdout
            d = json.loads(out or '{}')
        except Exception:
            continue
        info['duration'] += float((d.get('format') or {}).get('duration') or 0)
        if i:
            continue
        try:
            info['start'] = float((d.get('format') or {}).get('start_time') or 0)
        except ValueError:
            info['start'] = 0.0
        for st in d.get('streams', []):
            tags = st.get('tags') or {}
            lang = (tags.get('language') or 'und').lower()
            t = st.get('codec_type')
            if t == 'video' and not info['video'] and (st.get('disposition') or {}).get('attached_pic') != 1:
                info['video'] = {'codec': (st.get('codec_name') or '').lower(), 'width': st.get('width'),
                                 'height': st.get('height')}
            elif t == 'audio':
                info['audio'].append({'index': len(info['audio']), 'codec': (st.get('codec_name') or '').lower(),
                                      'lang': lang, 'channels': st.get('channels') or 2,
                                      'title': tags.get('title') or '',
                                      'label': _track_label(lang, tags.get('title'), st.get('channels'))})
            elif t == 'subtitle':
                codec = (st.get('codec_name') or '').lower()
                info['subs'].append({'index': len(info['subs']), 'codec': codec, 'lang': lang,
                                     'title': tags.get('title') or '', 'text': codec in TEXT_SUBS,
                                     'label': _track_label(lang, tags.get('title'))})
    v = (info['video'] or {}).get('codec')
    a = info['audio'][0]['codec'] if info['audio'] else 'aac'
    info['direct'] = (info['container'] in ('.mp4', '.m4v', '.webm') and v in BROWSER_VIDEO and a in BROWSER_AUDIO
                      and not vob_parts(path))
    with _probe_lock:
        _probe_cache[path] = info
    return info


def _track_label(lang, title=None, channels=None):
    name = LANG_NAMES.get(lang, lang.upper() if lang else '')
    title = (title or '').strip()
    if len(title) > 32 or re.search(r'encoded|www\.|\.com|\.org|x26[45]|S\d{2}E\d{2}|\d{3,4}p|\w\.\w+\.', title, re.I):
        title = ''
    bits = [b for b in (name, title) if b]
    label = ' · '.join(dict.fromkeys(bits)) or 'Varsayılan'
    if channels and channels > 2:
        label += ' (5.1)' if channels == 6 else f' ({channels}ch)'
    return label


def seek_point(path, start):
    """Where a stream asked to begin at `start` really begins. H.264 is copied, not re-encoded, and a copy can only
    begin on a keyframe, so ffmpeg starts on a keyframe near `start` (often several seconds earlier, with some
    containers later). The player must use this time as its clock offset, or subtitles drift by that much after
    every resume or long jump. ffmpeg is asked the same seek with a single copied frame, so the answer matches
    exactly what the real stream will do."""
    info = probe(path)
    if start <= 0 or (info['video'] or {}).get('codec', 'h264') != 'h264' or vob_parts(path):
        return max(0.0, start)
    try:
        out = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', f"{start:.3f}", '-i', path, '-map', '0:v:0',
                              '-c:v', 'copy', '-frames:v', '1', '-copyts', '-f', 'framecrc', '-'],
                             capture_output=True, text=True, timeout=10).stdout
        tb = re.search(r'^#tb 0: (\d+)/(\d+)', out, re.M)
        row = re.search(r'^0,\s*-?\d+,\s*(-?\d+),', out, re.M)
        if not tb or not row:
            return start
        at = int(row.group(1)) * int(tb.group(1)) / int(tb.group(2)) - info.get('start', 0.0)
    except Exception:
        return start
    # Anything far off means the file's timestamps are odd; then keep the old behaviour.
    return round(at, 3) if 0 <= at and abs(at - start) < 60 else start


def _transcode_cmd(path, start, audio, input_opts=()):
    """ffmpeg command up to the audio codec (input, mapping, H.264 video); returns it with the source audio codec."""
    info = probe(path)
    v = (info['video'] or {}).get('codec', 'h264')
    tracks = info['audio']
    audio = audio if 0 <= audio < len(tracks) else 0
    a = tracks[audio]['codec'] if tracks else 'aac'
    parts = vob_parts(path)
    cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error']
    if v != 'h264' and HAS_VAAPI:
        cmd += ['-vaapi_device', '/dev/dri/renderD128']
    if start > 0:
        cmd += ['-ss', f"{start:.3f}"]
    cmd += [*input_opts, '-i', ('concat:' + '|'.join(parts)) if parts else path, '-map', '0:v:0', '-map', f'0:a:{audio}?']
    if v == 'h264':
        cmd += ['-c:v', 'copy']
    elif HAS_VAAPI:
        cmd += ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi']
    else:
        cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']
    return cmd, a


def stream(path, start=0.0, audio=0):
    cmd, a = _transcode_cmd(path, start, audio)
    if a == 'aac':
        cmd += ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']
    elif a == 'mp3':
        cmd += ['-c:a', 'copy']
    else:
        cmd += ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']
    cmd += ['-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']

    def generate():
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        try:
            while True:
                chunk = p.stdout.read(262144)
                if not chunk:
                    break
                yield chunk
        finally:
            p.kill()
            p.wait()

    r = Response(generate(), mimetype='video/mp4')
    r.headers['Cache-Control'] = 'no-store'
    return r


# ---------------------------------------------------------------- HLS (iOS / Safari)
# Apple's WebKit only plays progressive video it can fetch with byte ranges, which a live ffmpeg pipe can't offer.
# For those clients the same transcode is segmented into an HLS event playlist on disk instead.

HLS_DIR = os.path.join(CACHE_DIR, 'hls')
HLS_IDLE = 600
HLS_MAX = 8
HLS_FILE = re.compile(r'^(index\.m3u8|seg\d{5}\.ts)$')
_hls = {}
_hls_lock = threading.Lock()
_hls_reaper = None
shutil.rmtree(HLS_DIR, ignore_errors=True)


def _hls_kill(sid):
    s = _hls.pop(sid, None)
    if s:
        s['proc'].kill()
        s['proc'].wait()
        shutil.rmtree(s['dir'], ignore_errors=True)


def _hls_reap():
    while True:
        time.sleep(30)
        with _hls_lock:
            for sid, s in list(_hls.items()):
                if time.time() - s['last'] > HLS_IDLE:
                    _hls_kill(sid)


def _hls_ready(s):
    try:
        with open(os.path.join(s['dir'], 'index.m3u8')) as f:
            return '.ts' in f.read()
    except OSError:
        return False


def hls_start(path, start=0.0, audio=0, client=''):
    """Starts (or reuses) a segmenting session and returns its id once the first segment exists."""
    global _hls_reaper
    sid = hashlib.sha1(f"{client}|{path}|{start:.1f}|{audio}".encode()).hexdigest()[:20]
    with _hls_lock:
        if _hls_reaper is None:
            _hls_reaper = threading.Thread(target=_hls_reap, daemon=True)
            _hls_reaper.start()
        s = _hls.get(sid)
        if not s:
            for other in [k for k, o in _hls.items() if client and o['client'] == client]:
                _hls_kill(other)
            for old in sorted(_hls, key=lambda k: _hls[k]['last'])[:max(0, len(_hls) - HLS_MAX + 1)]:
                _hls_kill(old)
            d = os.path.join(HLS_DIR, sid)
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d)
            # Burst the first minute for a quick start, then stay a few times ahead of playback.
            cmd, a = _transcode_cmd(path, start, audio, ('-readrate', '4', '-readrate_initial_burst', '60'))
            cmd += ['-c:a', 'copy'] if a == 'aac' else ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']
            cmd += ['-sn', '-f', 'hls', '-hls_time', '4', '-hls_init_time', '1', '-hls_list_size', '0',
                    '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
                    '-hls_segment_filename', os.path.join(d, 'seg%05d.ts'), os.path.join(d, 'index.m3u8')]
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            s = _hls[sid] = {'proc': proc, 'dir': d, 'client': client, 'last': time.time()}
        s['last'] = time.time()
    deadline = time.time() + 25
    while not _hls_ready(s):
        if s['proc'].poll() is not None or time.time() > deadline:
            if not _hls_ready(s):
                with _hls_lock:
                    _hls_kill(sid)
                return None
        time.sleep(0.05)
    return sid


def hls_stop(client, sid):
    with _hls_lock:
        if sid in _hls and _hls[sid]['client'] == client:
            _hls_kill(sid)


def hls_file(sid, name):
    if not HLS_FILE.match(name):
        return None
    with _hls_lock:
        s = _hls.get(sid)
        if not s:
            return None
        s['last'] = time.time()
    p = os.path.join(s['dir'], name)
    return p if os.path.exists(p) else None


# ---------------------------------------------------------------- images

def thumbnail(src, width):
    """Resized JPEG copy of a local image, cached by source path + mtime."""
    try:
        st = os.stat(src)
    except OSError:
        return None
    key = hashlib.sha1(f"{src}|{st.st_mtime}|{st.st_size}|{width}".encode()).hexdigest()
    dest = os.path.join(THUMBS_DIR, f"{key}.jpg")
    if os.path.exists(dest):
        return dest
    try:
        from PIL import Image
        with Image.open(src) as im:
            im = im.convert('RGB')
            if im.width > width:
                im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
            tmp = dest + '.part'
            im.save(tmp, 'JPEG', quality=84, optimize=True, progressive=True)
            os.replace(tmp, dest)
        return dest
    except Exception:
        return src


# Image requests are served by the same worker threads as video streams. Without internet (VPN reconnects etc.) a
# retrying download could hold a thread for a minute and starve playback, so these fetches fail fast, run at most
# a few at a time and are not retried for a while after a failure.
_img_http = requests.Session()
_img_http.headers.update({'User-Agent': USER_AGENT})
_img_slots = threading.BoundedSemaphore(4)
_img_failed = {}
_img_lock = threading.Lock()
IMG_RETRY_AFTER = 300


def _fetch_image(url, dest):
    try:
        r = _img_http.get(url, timeout=(3, 8))
        if r.status_code == 200 and len(r.content) > 1000:
            tmp = f"{dest}.{threading.get_ident()}.part"
            with open(tmp, 'wb') as f:
                f.write(r.content)
            os.replace(tmp, dest)
            return True
    except (requests.RequestException, OSError):
        pass
    return False


def image_path(tmdb_path, size):
    """Where remote_image keeps its copy of a TMDb image."""
    return os.path.join(IMAGES_DIR, hashlib.sha1(f"{size}{tmdb_path}".encode()).hexdigest() + '.jpg')


def remote_image(tmdb_path, size='w1280'):
    if not tmdb_path:
        return None
    dest = image_path(tmdb_path, size)
    name = os.path.basename(dest)
    if os.path.exists(dest):
        return dest
    with _img_lock:
        if time.time() - _img_failed.get(name, 0) < IMG_RETRY_AFTER:
            return None
    if not _img_slots.acquire(timeout=2):
        return None
    try:
        if os.path.exists(dest) or _fetch_image(f"{TMDB_IMG}{size}{tmdb_path}", dest):
            return dest
    finally:
        _img_slots.release()
    with _img_lock:
        _img_failed[name] = time.time()
    return None
