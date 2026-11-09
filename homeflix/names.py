import os
import re
import unicodedata

VTS_RE = re.compile(r'^VTS_(\d+)_(\d+)\.VOB$', re.I)

TITLE_JUNK = re.compile(
    r"[\s,(\[-]*\b(izle|full\s*hd|hd\s*film|t[üu]rk[çc]e|dublaj|altyaz[ıi]l?[ıi]?|1080p|720p|480p|bluray|web-?dl|dvdrip"
    r"|brrip|webrip|xvid|divx|dvdscr|trdub|x26[45]|set\s*film|fullhdfilm\w*|hdfilm\w*|dizipal\w*|dizimag|diziyo"
    r"|filmizle\w*)\b.*", re.I)

SEARCH_JUNK = [
    r'film\s*izle.*', r'türkçe\s*dublaj.*', r'türkçe\s*altyazı.*', r'turkce\s*dublaj.*', r'full\s*hd.*',
    r'hd\s*film.*', r'diziyo.*', r'dizimag.*', r'1080p.*', r'720p.*', r'bluray.*', r'web-dl.*', r'dvdrip.*',
    r'x264.*', r'x265.*', r'set\s*film.*', r'\bizle\b.*',
]


def clean_display_title(name):
    cleaned = TITLE_JUNK.sub('', name or '')
    cleaned = re.sub(r'\s+', ' ', cleaned).strip(' ,-–._')
    cleaned = re.sub(r'\s+Full$', '', cleaned, flags=re.I)
    return cleaned if len(cleaned) >= 2 else (name or '').strip()


def vob_parts(path):
    m = VTS_RE.match(os.path.basename(path))
    if not m:
        return None
    folder = os.path.dirname(path)
    parts = []
    for f in os.listdir(folder):
        pm = VTS_RE.match(f)
        if pm and pm.group(1) == m.group(1) and int(pm.group(2)) >= 1:
            parts.append((int(pm.group(2)), os.path.join(folder, f)))
    return [p for _, p in sorted(parts)]


def smart_title(path):
    filename = os.path.basename(path)
    name = os.path.splitext(filename)[0]
    if VTS_RE.match(filename):
        name = os.path.basename(os.path.dirname(path))
    year = ""
    y = re.search(r'[\(\[\.\s](19\d{2}|20\d{2})[\)\]\.\s]', name)
    if y:
        year = y.group(1)
        name = name[:y.start()]
    name = re.sub(r'[\.\-_]', ' ', name)
    for j in ['1080p', '720p', '480p', 'BluRay', 'WEB-DL', 'DVDRip', 'x264', 'x265', 'AAC', 'DTS', 'HDR', 'BrRip', 'WEBRip']:
        name = re.sub(r'\b' + j + r'\b', '', name, flags=re.I)
    name = clean_display_title(re.sub(r'\s+', ' ', name).strip())
    if not year:
        fy = re.search(r'\b(19\d{2}|20\d{2})\b', os.path.basename(os.path.dirname(path)))
        if fy:
            year = fy.group(1)
    return name, year


def clean_series_name(folder_name):
    name = re.sub(r'[\(\[\.\s](19\d{2}|20\d{2})[\)\]\.\s].*', '', folder_name)
    name = re.sub(r'\s*\d+\.?\s*[Ss]ezon.*', '', name, flags=re.I)
    name = re.sub(r'\s*Season\s*\d+.*', '', name, flags=re.I)
    name = name.strip()
    return name or folder_name


# Folders and Plex/Jellyfin file suffixes that hold a series' extras rather than episodes. Extras go to season 0.
EXTRAS_DIR_RE = re.compile(r'^(specials?|extras?|featurettes?|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|interviews?|'
                           r'scenes|shorts|trailers?|bonus|other|ekstra(lar)?|özel(ler)?|kamera[ ._-]?arkası)$', re.I)
EXTRAS_FILE_RE = re.compile(r'-(featurette|behindthescenes|deleted|interview|trailer|short|scene|other|extra)\.\w+$', re.I)
EXTRA_BASE = 1000  # extras without their own S00Exx number are numbered from here, so TMDb's specials never rename them


def is_extra(rel_path):
    parts = rel_path.split(os.sep)
    return any(EXTRAS_DIR_RE.match(p.strip()) for p in parts[1:-1]) or bool(EXTRAS_FILE_RE.search(parts[-1]))


def extra_title(filename):
    """A readable name for an extra from its file name: 'Season 1 - Honest Trailer - Screen Junkies.mkv' ->
    'Honest Trailer - Screen Junkies'."""
    t = re.sub(r'\.\w+$', '', filename)
    t = EXTRAS_FILE_RE.sub('', filename) if EXTRAS_FILE_RE.search(filename) else t
    t = re.sub(r'^(season|sezon)\s*\d+\s*[-–:.]\s*', '', t, flags=re.I)
    return re.sub(r'[._]+', ' ', t).strip() or filename


def parse_season_episode(rel_path):
    """(season, episode) of a file under the series folder. Specials and extras are season 0: an explicit S00Exx keeps
    its number, other extras get episode 0 and the scanner numbers them from EXTRA_BASE."""
    parts = rel_path.split(os.sep)
    filename = parts[-1]
    if is_extra(rel_path):
        # Only a full SxxEyy code counts here; extras' titles are full of stray numbers ("Sketch #2", "Season 1 - ...").
        m = re.search(r'[Ss](\d+)\s*[Ee][Pp]?\s*(\d+)', filename)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    season = episode = None
    for part in parts[:-1]:
        m = (re.search(r'(\d+)\s*\.?\s*[Ss]ezon', part, re.I) or re.search(r'[Ss]ezon\s*(\d+)', part, re.I) or
             re.search(r'Season\s*(\d+)', part, re.I) or re.search(r'^(\d+)[Ss]$', part, re.I))
        if m:
            season = int(m.group(1))
            break
    m = re.search(r'[Ss](\d+)\s*[Ee][Pp]?\s*(\d+)', filename, re.I)
    if m:
        season, episode = int(m.group(1)), int(m.group(2))
    else:
        # "2 Sezon 7 Bölüm", also the "Bolum" / "Bölm" / "BÖ" spellings that turn up in downloaded file names
        m = re.search(r'(\d+)\s*\.?\s*sezon\s*\.?\s*(\d+)', filename, re.I)
        if m:
            season, episode = int(m.group(1)), int(m.group(2))
        else:
            ep_word = r'(?:b[oö]l[uü]m|b[oö]lm|blm|bö)'  # "Bölüm", "Bolum", "Bölm", "Blm", "BÖ"
            m = (re.search(r'(\d+)\s*\.?\s*' + ep_word + r'(?![a-zçğıöşü])', filename, re.I) or
                 re.search(r'\b' + ep_word + r'\s*\.?\s*(\d+)', filename, re.I) or
                 re.search(r'[Ee]pisode\s*(\d+)', filename, re.I) or re.search(r'[Ee](\d+)', filename, re.I))
            if m:
                episode = int(m.group(1))
            else:
                m = re.search(r'\b(\d{1,2})\.([0-9]{2})\b', filename)
                if m:
                    season, episode = int(m.group(1)), int(m.group(2))
                else:
                    m = re.match(r'^(\d{1,3})\.\w+$', filename)
                    if m:
                        episode = int(m.group(1))
    return (season if season is not None else 1), episode or 1


def search_candidates(title):
    cleaned = title or ''
    for j in SEARCH_JUNK:
        cleaned = re.sub(j, '', cleaned, flags=re.I)
    cands = []

    def add(c):
        c = re.sub(r'[\.\-_]', ' ', c)
        c = re.sub(r'\s+', ' ', c).strip(' ,:')
        c = re.sub(r'\b(19\d{2}|20\d{2})\b', '', c).strip()
        if c and len(c) > 1 and c not in cands:
            cands.append(c)

    add(cleaned)
    for p in re.split(r'[-–\(\):]', cleaned):
        add(p)
    for p in list(cands):
        w = p.split()
        if len(w) >= 4:
            half = len(w) // 2
            add(' '.join(w[:half]))
            add(' '.join(w[half:]))
            add(' '.join(w[-3:]))
    return cands[:8] or [title]


def fold(text):
    text = (text or '').replace('ı', 'i').replace('İ', 'i')
    text = unicodedata.normalize('NFKD', text)
    return ''.join(ch for ch in text if not unicodedata.combining(ch)).lower()


SEQUEL_RE = re.compile(r'^(.{3,}?)\s*(?:\b(?:part|bölüm|chapter)\s*)?\b(\d{1,2}|ii|iii|iv|v)\b(?!\d)', re.I)
ROMAN = {'ii': 2, 'iii': 3, 'iv': 4, 'v': 5}


def sequel_key(title):
    """'Harry Potter 3 Azkaban' -> ('harry potter', 3). Used only for movies without a TMDb collection."""
    m = SEQUEL_RE.match(title or '')
    if not m:
        return None
    base = re.sub(r'[^\w\s]', ' ', fold(m.group(1)))
    base = re.sub(r'\s+', ' ', base).strip()
    if len(base) < 3 or base.isdigit():
        return None
    num = m.group(2).lower()
    return base, ROMAN.get(num, int(num) if num.isdigit() else 0)
