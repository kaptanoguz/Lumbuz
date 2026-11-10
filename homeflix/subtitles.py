import hashlib
import os
import re
import struct
import subprocess
import threading
import time

import requests

from .config import OPENSUBTITLES_API_KEY, SUBS_DIR, USER_AGENT
from .names import vob_parts

SUB_EXTS = ('.srt', '.vtt', '.sub', '.ass', '.ssa')
OS_HEADERS = {'Api-Key': OPENSUBTITLES_API_KEY, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT}


SUB_DIRS = ('subs', 'sub', 'subtitles', 'altyazi', 'altyazı', 'altyazılar')
_LANG_WORDS = {'tr': 'Türkçe', 'tur': 'Türkçe', 'turkish': 'Türkçe', 'türkçe': 'Türkçe', 'turkce': 'Türkçe',
               'en': 'İngilizce', 'eng': 'İngilizce', 'english': 'İngilizce'}


def _sub_label(rest, fname, single):
    """Label and language from what the file name says beyond the video's name ("tr", "English", "2_Eng.SDH")."""
    words = [w for w in re.split(r'[^0-9a-zçğıöşü]+', rest.lower()) if w]
    for w in words:
        if w in _LANG_WORDS:
            label = _LANG_WORDS[w]
            if any(x in words for x in ('sdh', 'hi', 'cc')):
                label += ' (SDH)'
            elif any(x in words for x in ('forced', 'zorunlu')):
                label += ' (zorunlu)'
            return label, ('tr' if label.startswith('Türkçe') else 'en')
    if not rest:
        return ('Yerel altyazı' if single else fname), ''
    return rest.upper() if len(rest) <= 12 else fname, ''


def local_subtitles(video_path):
    """Subtitle files that belong to the video: next to it, or in a Subs folder beside it (as many releases ship
    them, also as Subs/<video name>/2_English.srt)."""
    folder, fname = os.path.split(video_path)
    base = os.path.splitext(fname)[0].lower()
    try:
        entries = os.listdir(folder)
    except OSError:
        return []
    videos = [f for f in entries if os.path.splitext(f)[1].lower() in
              ('.mp4', '.mkv', '.avi', '.ts', '.mov', '.m4v', '.wmv', '.webm', '.mpg', '.mpeg', '.vob')]
    own_folder = len(videos) <= 1 or bool(vob_parts(video_path))
    is_sub = lambda f: f.lower().endswith(SUB_EXTS) and not f.startswith('._')

    found = []  # (path, file name, part of the name after the video's name or None)
    files = sorted(f for f in entries if is_sub(f))
    matches = [f for f in files if f.lower().startswith(base)]
    if not matches and own_folder:
        matches = files
    found += [(os.path.join(folder, f), f) for f in matches]
    for d in sorted(e for e in entries if e.lower() in SUB_DIRS and os.path.isdir(os.path.join(folder, e))):
        sd = os.path.join(folder, d)
        try:
            inner = sorted(os.listdir(sd))
        except OSError:
            continue
        # Subs/<video name>/... (series packs)
        for e in inner:
            if e.lower() == base and os.path.isdir(os.path.join(sd, e)):
                try:
                    found += [(os.path.join(sd, e, f), f) for f in sorted(os.listdir(os.path.join(sd, e))) if is_sub(f)]
                except OSError:
                    pass
        subs = [f for f in inner if is_sub(f)]
        own = [f for f in subs if f.lower().startswith(base)]
        found += [(os.path.join(sd, f), f) for f in (own or (subs if own_folder else []))]

    out = []
    for i, (path, f) in enumerate(found):
        stem = os.path.splitext(f)[0]
        rest = stem[len(base):].strip('._- ') if stem.lower().startswith(base) else (stem if os.path.dirname(path) != folder else '')
        label, lang = _sub_label(rest, f, len(found) == 1)
        out.append({'index': i, 'path': path, 'label': label, 'lang': lang})
    out.sort(key=lambda s: (s['lang'] != 'tr', s['lang'] != '', s['index']))
    for i, s in enumerate(out):
        s['index'] = i
    return out


def decode_text(data):
    for enc in ('utf-8-sig', 'cp1254', 'latin-1'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('latin-1', errors='ignore')


def to_vtt(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if text.lstrip().startswith('WEBVTT'):
        return text
    if re.search(r'^\[Script Info\]', text, re.M):
        return ass_to_vtt(text)
    return "WEBVTT\n\n" + re.sub(r'(\d{1,2}:\d{2}:\d{2}),(\d{3})', r'\1.\2', text)


def ass_to_vtt(text):
    out = ["WEBVTT", ""]
    fmt = None
    for line in text.split('\n'):
        if line.startswith('Format:') and fmt is None and 'Start' in line:
            fmt = [x.strip().lower() for x in line[7:].split(',')]
        elif line.startswith('Dialogue:') and fmt:
            vals = line[9:].split(',', len(fmt) - 1)
            row = dict(zip(fmt, vals))

            def ts(v):
                h, m, s = v.strip().split(':')
                return f"{int(h):02d}:{int(m):02d}:{float(s):06.3f}"
            body = re.sub(r'\{[^}]*\}', '', row.get('text', '')).replace('\\N', '\n').replace('\\n', '\n')
            out += [f"{ts(row['start'])} --> {ts(row['end'])}", body.strip(), ""]
    return '\n'.join(out)


def read_subtitle(path):
    with open(path, 'rb') as f:
        return to_vtt(decode_text(f.read()))


def extract_embedded(path, index):
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_mtime}|{index}".encode()).hexdigest()
    dest = os.path.join(SUBS_DIR, key + '.vtt')
    if os.path.exists(dest):
        with open(dest, encoding='utf-8') as f:
            return f.read()
    out = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', path, '-map', f'0:s:{index}', '-f', 'webvtt', 'pipe:1'],
                         capture_output=True, timeout=180).stdout
    if not out:
        return None
    text = decode_text(out)
    with open(dest, 'w', encoding='utf-8') as f:
        f.write(text)
    return text


def opensubtitles_hash(path):
    size = os.path.getsize(path)
    if size < 131072:
        return None
    h = size
    with open(path, 'rb') as f:
        for off in (0, size - 65536):
            f.seek(off)
            h = (h + sum(struct.unpack('<8192Q', f.read(65536)))) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def search_online(path, query):
    results, seen = [], set()

    def collect(params, tag):
        try:
            r = requests.get("https://api.opensubtitles.com/api/v1/subtitles", params=params, headers=OS_HEADERS, timeout=10)
            if r.status_code != 200:
                return
            for item in r.json().get('data', []):
                attr = item['attributes']
                if attr.get('language') not in ('tr', 'en') or not attr.get('files'):
                    continue
                fid = attr['files'][0]['file_id']
                if fid in seen:
                    continue
                seen.add(fid)
                results.append({'file_id': fid, 'lang': attr['language'], 'release': attr.get('release') or '',
                                'downloads': attr.get('download_count') or 0, 'match': tag,
                                'title': f"[{tag}] {attr['language']} - {attr.get('release') or ''}"})
        except (requests.RequestException, ValueError, KeyError):
            pass

    try:
        mh = opensubtitles_hash(path)
    except OSError:
        mh = None
    if mh:
        collect({'moviehash': mh, 'languages': 'tr,en'}, 'HASH')
    if len(results) < 5 and query:
        collect({'query': query, 'languages': 'tr,en'}, 'ISIM')
    results.sort(key=lambda x: (x['match'] != 'HASH', x['lang'] != 'tr', -x['downloads']))
    return results


def download_online(file_id):
    r = requests.post("https://api.opensubtitles.com/api/v1/download", headers=OS_HEADERS,
                      json={'file_id': file_id}, timeout=10)
    if r.status_code != 200:
        return None
    link = r.json().get('link')
    if not link:
        return None
    return to_vtt(decode_text(requests.get(link, timeout=15).content))


# Automatic Turkish subtitles for library videos that have none. The free OpenSubtitles plan allows only a few
# downloads a day, so each video is fetched once and kept in SUBS_DIR; later plays, also offline ones, read the file.
AUTO_RETRY = 3 * 86400  # after "nothing in Turkish", look again in three days
_auto_lock = threading.Lock()


def _auto_paths(path):
    key = hashlib.sha1(f"{path}|{os.path.getsize(path)}".encode()).hexdigest()
    base = os.path.join(SUBS_DIR, 'auto-' + key)
    return base + '.vtt', base + '.none'


def auto_cached(path):
    try:
        vtt = _auto_paths(path)[0]
    except OSError:
        return None
    if os.path.exists(vtt):
        with open(vtt, encoding='utf-8') as f:
            return f.read()
    return None


def _turkish_candidates(path, ids, query):
    """Turkish results, best first: same file (hash), then same title by TMDb/IMDb id, then by name.
    Returns None when OpenSubtitles could not be reached, so being offline is not taken for "no subtitle"."""
    found, seen, reached = [], set(), False

    def collect(params, rank):
        nonlocal reached
        params = dict(sorted({**params, 'languages': 'tr'}.items()))
        try:
            r = requests.get("https://api.opensubtitles.com/api/v1/subtitles", params=params, headers=OS_HEADERS, timeout=8)
        except requests.RequestException:
            return
        if r.status_code != 200:
            return
        reached = True
        try:
            data = r.json().get('data', [])
        except ValueError:
            return
        for item in data:
            attr = item.get('attributes') or {}
            if attr.get('language') != 'tr' or not attr.get('files'):
                continue
            fid = attr['files'][0].get('file_id')
            if not fid or fid in seen:
                continue
            seen.add(fid)
            machine = bool(attr.get('machine_translated') or attr.get('ai_translated'))
            rank_ = 0 if rank == 0 or attr.get('moviehash_match') else rank
            found.append((rank_, machine, -(attr.get('download_count') or 0), fid, attr.get('release') or ''))

    try:
        mh = opensubtitles_hash(path)
    except OSError:
        mh = None
    if mh:
        collect({'moviehash': mh}, 0)
    if ids:
        collect(ids, 1)
    if not found and query:
        collect({'query': query}, 2)
    if not reached:
        return None
    return sorted(found)


def _fits_length(vtt, path):
    """False for a subtitle made for a much longer copy (e.g. 165 min of lines for an 86 min file): no shift can
    make that one fit, so the next candidate is tried instead."""
    from .media import probe
    from .subsync import cue_times
    try:
        dur = probe(path)['duration']
    except Exception:
        return True
    cues = cue_times(vtt)
    if not dur or not cues:
        return True
    return cues[-1][0] <= dur * 1.1 + 120


def auto_turkish(path, ids, query):
    """The video's Turkish subtitle as (vtt, label), downloading it once if needed; None if there is none
    (or no key, no internet, quota used up)."""
    if not OPENSUBTITLES_API_KEY:
        return None
    try:
        vtt_path, none_path = _auto_paths(path)
    except OSError:
        return None
    with _auto_lock:  # two devices starting the same video must not spend two downloads
        cached = auto_cached(path)
        if cached and _fits_length(cached, path):
            return cached, 'Türkçe (internet)'
        if cached:  # kept from before this check existed; made for a longer copy of the film
            try:
                os.remove(vtt_path)
            except OSError:
                pass
        try:
            if time.time() - os.path.getmtime(none_path) < AUTO_RETRY:
                return None
        except OSError:
            pass
        cands = _turkish_candidates(path, ids, query)
        if cands is None:
            return None
        if not cands:
            open(none_path, 'w').close()
            return None
        for _, _, _, fid, release in cands[:3]:
            try:
                vtt = download_online(fid)
            except (requests.RequestException, ValueError):
                vtt = None
            if vtt and '-->' in vtt and _fits_length(vtt, path):
                with open(vtt_path, 'w', encoding='utf-8') as f:
                    f.write(vtt)
                return vtt, 'Türkçe (internet)'
        return None
