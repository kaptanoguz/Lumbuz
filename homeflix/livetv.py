"""Live TV tab: free channels that broadcasters stream on their own sites, played by each device directly.

Only streams served from the broadcaster's own servers (or the CDN its own website uses) are listed; restreams of
paid channels are left out on purpose. The server never carries video. It keeps the channel logos (so the list looks
right without internet), and every few hours it downloads each channel's small playlist file to see whether the
channel is on air, so dead channels drop out of the list by themselves."""
import os
import re
import threading
import time
from urllib.parse import quote, urljoin, urlsplit

import requests

from .config import IMAGES_DIR, USER_AGENT

# Category ids and the names shown on the chips, in chip order.
CATEGORIES = [('ulusal', 'Ulusal'), ('haber', 'Haber'), ('spor', 'Spor'), ('belgesel', 'Belgesel'),
              ('cocuk', 'Çocuk'), ('muzik', 'Müzik'), ('dunya', 'Dünya')]

# id (iptv-org channel id, used for the logo), name, category, quality label, stream URLs (first that works wins),
# extra flags. 'tr' marks channels that only open from inside Turkey. 'yt' streams are YouTube channel ids played
# in YouTube's own embed (the channel's official 24/7 live stream, or its own uploads where it has none).
CHANNELS = [
    ('TRT1.tr', 'TRT 1', 'ulusal', '1440p', ['https://tv-trt1.medya.trt.com.tr/master.m3u8']),
    ('KanalD.tr', 'Kanal D', 'ulusal', '1080p', ['https://demiroren.daioncdn.net/kanald/kanald.m3u8?app=kanald_web&ce=3']),
    ('ATV.tr', 'ATV', 'ulusal', '1080p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv.m3u8',
                                      'https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv_720p.m3u8']),
    ('StarTV.tr', 'Star TV', 'ulusal', '720p', ['https://dogus.daioncdn.net/startv/startv_720p.m3u8?app=a20ac41e-bdc3-4aa1-934d-26b484480ac9&ce=3']),
    ('TV8.tr', 'TV8', 'ulusal', '1080p', ['https://tv8.daioncdn.net/tv8/tv8.m3u8?app=7ddc255a-ef47-4e81-ab14-c0e5f2949788&ce=3',
                                         'https://tv8-live.daioncdn.net/tv8/tv8.m3u8']),
    ('NOWTV.tr', 'NOW', 'ulusal', '720p', ['https://uycyyuuzyh.turknet.ercdn.net/nphindgytw/nowtv/nowtv.m3u8',
                                       'https://uycyyuuzyh.turknet.ercdn.net/nphindgytw/nowtv/nowtv_720p.m3u8']),
    ('Kanal7.tr', 'Kanal 7', 'ulusal', '1080p', ['https://kanal7-live.daioncdn.net/kanal7/kanal7.m3u8']),
    ('A2TV.tr', 'a2', 'ulusal', '1080p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/a2tv/a2tv.m3u8']),
    ('TRTTurk.tr', 'TRT Türk', 'ulusal', '720p', ['https://tv-trtturk.medya.trt.com.tr/master.m3u8']),
    ('TRT2.tr', 'TRT 2', 'ulusal', '1440p', ['https://tv-trt2.medya.trt.com.tr/master.m3u8'], 'tr'),
    ('ShowTV.tr', 'Show TV', 'ulusal', '1080p', ['https://ciner.daioncdn.net/showtv/showtv.m3u8?app=4bc856ef-4c68-4a94-bc87-37dfaaa66558']),
    ('TLC.tr', 'TLC', 'belgesel', '720p', ['https://dogus.daioncdn.net/tlc/tlc.m3u8?app=1aca0aa1-06e3-41ff-a8e5-38d7df475469']),
    ('TV85.tr', 'TV8,5', 'ulusal', '1080p', ['https://tv8.daioncdn.net/tv8bucuk/tv8bucuk.m3u8?app=tv8bucuk_web&ce=3']),
    ('TV4.tr', 'TV4', 'ulusal', '1080p', ['https://turkmedya-live.ercdn.net/tv4/tv4.m3u8']),
    ('BiKanal.tr', 'Bi Kanal', 'ulusal', '1080p', ['https://bikanal-live.ercdn.net/bikanal/bikanal.m3u8']),
    ('360.tr', '360', 'ulusal', '1080p', ['https://turkmedya-live.ercdn.net/tv360/tv360.m3u8']),
    ('TRTGenc.tr', 'TRT Genç', 'ulusal', '1440p', ['https://tv-trtgenc.medya.trt.com.tr/master.m3u8'], 'tr'),
    ('DMAX.tr', 'DMAX', 'belgesel', '720p', ['https://dogus.daioncdn.net/dmax/dmax.m3u8?app=5a02c599-d17e-4982-9b04-090934d51af7']),

    ('TRTHaber.tr', 'TRT Haber', 'haber', '720p', ['https://tv-trthaber.medya.trt.com.tr/master.m3u8']),
    ('NTV.tr', 'NTV', 'haber', 'HD', ['https://dogus.daioncdn.net/ntv/ntv.m3u8?app=ntv_web']),
    ('AHaber.tr', 'A Haber', 'haber', '1080p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/ahaber/ahaber.m3u8']),
    ('HalkTV.tr', 'Halk TV', 'haber', '1080p', ['https://halktv-live.daioncdn.net/halktv/halktv.m3u8']),
    ('Tele1.tr', 'Tele 1', 'haber', '1080p', ['https://tele1-live.ercdn.net/tele1/tele1.m3u8']),
    ('HaberturkTV.tr', 'Habertürk', 'haber', '1080p', ['https://ciner.daioncdn.net/haberturktv/haberturktv.m3u8?app=c98ab0b0-50cc-495b-bb37-778e91f5ff5b&ce=3']),
    ('HaberGlobal.tr', 'Haber Global', 'haber', 'HD', ['yt:UCtc-a9ZUIg0_5HpsPxEO7Qg#EqoCJ8BPxtE']),
    ('24TV.tr', 'TV24', 'haber', '1080p', ['https://turkmedya-live.ercdn.net/tv24/tv24.m3u8']),
    ('BloombergHT.tr', 'Bloomberg HT', 'haber', '720p', ['https://ciner.daioncdn.net/bloomberght/bloomberght.m3u8?app=201b9556-b11c-4d92-b264-f21fd24e9aaf&ce=3']),
    ('CNBCe.tr', 'CNBC-e', 'haber', 'HD', ['https://hnpsechtsc.turknet.ercdn.net/xpnvudnlsv/cnbc-e/cnbc-e.m3u8']),
    ('TBMMTV.tr', 'TBMM TV', 'haber', '720p', ['https://meclistv-live.ercdn.net/meclistv/meclistv.m3u8']),

    ('TRTSpor.tr', 'TRT Spor', 'spor', 'HD', ['https://tv-trtspor1.medya.trt.com.tr/master.m3u8',
                                              'https://trt.daioncdn.net/trtspor/master.m3u8?app=web']),
    ('TRTSporYildiz.tr', 'TRT Spor Yıldız', 'spor', '1440p', ['https://trt.daioncdn.net/trtspor-yildiz/master.m3u8?app=web&platform=trtspor'], 'tr'),
    ('ASpor.tr', 'A Spor', 'spor', '1080p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor.m3u8']),
    ('HTSporTV.tr', 'HT Spor', 'spor', '1080p', ['https://ciner.daioncdn.net/ht-spor/ht-spor.m3u8?app=web']),
    ('FIFAPlus.uk', 'FIFA+', 'spor', '720p', ['https://a62dad94.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWV1X0ZJRkFQbHVzRW5nbGlzaF9ITFM/playlist.m3u8']),

    ('TRTBelgesel.tr', 'TRT Belgesel', 'belgesel', '720p', ['https://tv-trtbelgesel.medya.trt.com.tr/master.m3u8']),
    ('NASATV.us', 'NASA TV', 'belgesel', 'HD', ['yt:UCLA_DiR1FfKNvjuUpBHmylQ']),
    ('DWDocumentary.de', 'DW Documentary', 'belgesel', 'HD', ['yt:UCW39zufHfsuGgpLviKh297Q#uploads']),
    ('FreeDocumentary.de', 'Free Documentary', 'belgesel', 'HD', ['yt:UCijcd0GR0fkxCAZwkiuWqtQ#uploads']),
    ('NASASpaceflight.us', 'NASASpaceflight', 'belgesel', 'HD', ['yt:UCSUu1lih2RifWkKtDOJdsBA']),
    ('WildEarth.za', 'WildEarth', 'belgesel', 'HD', ['yt:UCV6HJBZD_hZcIX9JVJ3dCXQ']),
    # These run documentary marathons most of the time but not 24/7; when nothing is live, their newest video plays.
    ('NationalGeographic.us', 'Nat Geo', 'belgesel', 'HD', ['yt:UCpVm7bg6pXKo1Pr6k5kxG9A']),
    ('DiscoveryChannel.us', 'Discovery', 'belgesel', 'HD', ['yt:UCqOoboPm3uhY_YXhvhmL-WA']),
    ('ScienceChannel.us', 'Science Channel', 'belgesel', 'HD', ['yt:UCvJiYiBUbw4tmpRSZT2r1Hw']),
    ('RealStories.uk', 'Real Stories', 'belgesel', 'HD', ['yt:UCu4XcDBdnZkV6-5z2f16M0g']),
    ('NHKWorldJapan.jp', 'NHK World', 'belgesel', '1080p', ['https://masterpl.hls.nhkworld.jp/hls/w/live/smarttv.m3u8',
                                                             'https://media-tyo.hls.nhkworld.jp/hls/w/live/master.m3u8']),

    ('TRTCocuk.tr', 'TRT Çocuk', 'cocuk', '1440p', ['https://tv-trtcocuk.medya.trt.com.tr/master.m3u8']),
    ('MinikaCocuk.tr', 'Minika Çocuk', 'cocuk', '720p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/minikago_cocuk/minikago_cocuk.m3u8']),
    ('MinikaGo.tr', 'Minika Go', 'cocuk', '720p', ['https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/minikago/minikago.m3u8']),

    ('TRTMuzik.tr', 'TRT Müzik', 'muzik', '720p', ['https://tv-trtmuzik.medya.trt.com.tr/master.m3u8']),
    ('PowerTurkTV.tr', 'Power Türk', 'muzik', '1080p', ['https://livetv.powerapp.com.tr/powerturkTV/powerturkhd.smil/playlist.m3u8']),
    ('PowerTV.tr', 'Power TV', 'muzik', '1080p', ['https://livetv.powerapp.com.tr/powerTV/powerhd.smil/playlist.m3u8']),
    ('PowerTurkTaptaze.tr', 'Power Türk Taptaze', 'muzik', '1080p', ['https://listen.powerapp.com.tr/pturktaptaze/taptaze.smil/playlist.m3u8']),
    ('PowerTurkSlow.tr', 'Power Türk Slow', 'muzik', '1080p', ['https://listen.powerapp.com.tr/pturkslow/slow.smil/playlist.m3u8']),
    ('PowerTurkAkustik.tr', 'Power Türk Akustik', 'muzik', '1080p', ['https://listen.powerapp.com.tr/pturkakustik/akustik.smil/playlist.m3u8']),
    ('PowerLove.tr', 'Power Love', 'muzik', '1080p', ['https://listen.powerapp.com.tr/plove/love.smil/playlist.m3u8']),
    ('PowerDance.tr', 'Power Dance', 'muzik', '1080p', ['https://listen.powerapp.com.tr/dance/dance.smil/playlist.m3u8']),
    ('PowerPlus.tr', 'Power Plus', 'muzik', '1080p', ['https://listen.powerapp.com.tr/pplus/plus.smil/playlist.m3u8']),
    ('PowerPop.tr', 'Power Pop', 'muzik', '1080p', ['https://listen.powerapp.com.tr/ppop/pop.smil/playlist.m3u8']),
    ('Number1TV.tr', 'Number1', 'muzik', 'HD', ['https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/broadcast_5c9e17cd59e8b.smil/playlist.m3u8']),
    ('Number1Turk.tr', 'Number1 Türk', 'muzik', 'HD', ['https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/broadcast_5c9e187770143.smil/playlist.m3u8']),
    ('Number1Ask.tr', 'Number1 Aşk', 'muzik', '720p', ['https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/u_stream_5c9e18f9cea15_1/playlist.m3u8',
                                                       'https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/broadcast_5c9e18f9c54e6.smil/playlist.m3u8']),
    ('Number1Dance.tr', 'Number1 Dance', 'muzik', '720p', ['https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/u_stream_5c9e2aa8acf44_1/playlist.m3u8',
                                                          'https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/broadcast_5c9e2aa89e721.smil/playlist.m3u8']),
    ('Number1Rap.tr', 'Number1 Rap', 'muzik', '720p', ['https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/u_stream_5c9e198784bdc_1/playlist.m3u8',
                                                      'https://b01c02nl.mediatriple.net/videoonlylive/mtkgeuihrlfwlive/broadcast_5c9e19877b340.smil/playlist.m3u8']),
    ('DreamTurk.tr', 'Dream Türk', 'muzik', '720p', ['https://live.duhnet.tv/S2/HLS_LIVE/dreamturknp/playlist.m3u8']),

    ('SkyNews.uk', 'Sky News', 'dunya', 'HD', ['yt:UCoMdktPbSTixAyNGwb-UYkQ']),
    ('ABCNewsLive.us', 'ABC News Live', 'dunya', 'HD', ['yt:UCBi2mrWuNuyYy4gbM6fU18Q']),
    ('NBCNewsNOW.us', 'NBC News NOW', 'dunya', 'HD', ['yt:UCeY0bbntWzzVIaj2z3QigXg']),
    ('CBSNews247.us', 'CBS News 24/7', 'dunya', 'HD', ['yt:UC8p1vwvWtl6T73JiExfWs1g']),
    ('Africanews.cg', 'Africanews', 'dunya', 'HD', ['yt:UC1_E8NeF5QHY2dtdLRBCCLA']),
    ('DWEspanol.de', 'DW Español', 'dunya', 'HD', ['yt:UCT4Jg8h03dD0iN3Pb5L0PMA']),
    ('TRTWorld.tr', 'TRT World', 'dunya', '1080p', ['https://tv-trtworld.medya.trt.com.tr/master.m3u8']),
    ('DW.de', 'DW English', 'dunya', '1080p', ['https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8']),
    ('France24.fr', 'France 24', 'dunya', '1080p', ['https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_5000.m3u8',
                                                    'https://live.france24.com/hls/live/2037218/F24_EN_HI_HLS/master_5000.m3u8']),
    ('AlJazeera.qa', 'Al Jazeera English', 'dunya', '1080p', ['https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8']),
    ('EuronewsEnglish.fr', 'Euronews', 'dunya', '720p', ['https://cdn-euronews.akamaized.net/live/eds/euronews-en/25002/index.m3u8']),
    ('BloombergTV.us', 'Bloomberg', 'dunya', '720p', ['https://bloomberg.com/media-manifest/streams/eu.m3u8']),
    ('DasErste.de', 'Das Erste', 'dunya', '1080p', ['https://daserste-live.ard-mcdn.de/daserste/live/hls/int/master.m3u8']),
]

CHECK_EVERY = 6 * 3600
# Some broadcaster CDNs (ATV's) take up to ~10 s to answer, so a shorter limit hides working channels.
CHECK_TIMEOUT = 20
# A channel is hidden only after this many failed checks in a row, so one hiccup doesn't make it disappear.
DEAD_AFTER = 2
LOGO_LIST = 'https://iptv-org.github.io/api/logos.json'
# Logos for channels iptv-org doesn't list (YouTube-only channels): their YouTube channel pictures.
LOGO_URLS = {
    'DWDocumentary.de': 'https://yt3.googleusercontent.com/rgphL4c6DGPlwzkxIzE5tH0DPe1yuynH0nTdOAecCVIX5gUjJGsCwXtp9wnxjcsfqboL6C5aFg=s240-c-k-c0x00ffffff-no-rj',
    'FreeDocumentary.de': 'https://yt3.googleusercontent.com/xKTkbX06Be5s6Kt6Ff28SIvDp4zyhJcZEJzmqjM12eKAfUEsSz-wvMhR0rx0Q7bc2dxFdiT4PA=s240-c-k-c0x00ffffff-no-rj',
}
LOGO_DIR = os.path.join(IMAGES_DIR, 'live')
LOGO_MAX_AGE = 7 * 86400
LOGO_EXT = ('png', 'svg', 'jpg', 'webp')
os.makedirs(LOGO_DIR, exist_ok=True)

_http = requests.Session()
_http.headers['User-Agent'] = USER_AGENT
_lock = threading.Lock()
# id -> {'ok': True/False/None, 'fails': n, 'url': working URL, 'cors': True/False/None, 'at': time}
_status = {}


def _channel(row):
    cid, name, cat, quality, urls = row[:5]
    flags = row[5] if len(row) > 5 else ''
    return {'id': cid, 'name': name, 'cat': cat, 'q': quality, 'urls': urls, 'tr': 'tr' in flags}


def channels():
    """The channel list for the web app, dead channels left out. A channel not checked yet is listed."""
    out = []
    with _lock:
        status = dict(_status)
    for i, row in enumerate(CHANNELS):
        ch = _channel(row)
        st = status.get(ch['id'], {})
        if st.get('ok') is False and st.get('fails', 0) >= DEAD_AFTER:
            continue
        url = st.get('url') or ch['urls'][0]
        item = {'id': ch['id'], 'n': ch['name'], 'cat': ch['cat'], 'q': ch['q'], 'no': i + 1,
                'logo': f"/img/live/{ch['id']}" if logo_file(ch['id']) else '', 'ok': st.get('ok')}
        if url.startswith('yt:'):
            # 'yt:<channel id>' plays the channel's current live video; 'yt:<channel id>#<video id>' a fixed one
            # (a channel whose /live page shows a programme instead of its 24/7 feed).
            # 'yt:<channel id>#uploads' plays the channel's videos one after another, newest first (a channel that
            # has no 24/7 live stream, like DW Documentary).
            chan, _, fixed = url[3:].partition('#')
            item['yt'] = chan
            if fixed == 'uploads':
                item['ytl'] = 'UU' + chan[2:]
            else:
                vid = fixed or _yt.get(chan, (0, None))[1]
                if vid:
                    item['ytv'] = vid
        else:
            item['url'] = url
            item['alt'] = [u for u in ch['urls'] if u != url and not u.startswith('yt:')]
            # False: the broadcaster's playlists have no CORS header, so browsers read them through /api/live/pl.
            item['cors'] = st.get('cors')
        if ch['tr']:
            item['tr'] = 1
        out.append(item)
    return {'channels': out, 'cats': [{'id': k, 'n': n} for k, n in CATEGORIES]}


def find(cid):
    return next((_channel(r) for r in CHANNELS if r[0] == cid), None)


# ---------------------------------------------------------------- on-air check

def _read(url, headers=None, limit=262144):
    """(status, text, response headers, final URL) of a playlist or page; reads at most `limit` bytes."""
    r = _http.get(url, timeout=CHECK_TIMEOUT, headers=headers or {}, stream=True)
    try:
        body = r.raw.read(limit, decode_content=True).decode('utf-8', 'replace')
    finally:
        r.close()
    return r.status_code, body, r.headers, r.url


def _check_url(url):
    """(on air, CORS allowed) for one stream. Downloads only playlist text (a few KB), never video: the master
    playlist and its first quality, since a master can answer while every quality behind it is refused."""
    if url.startswith('yt:'):
        if '#' not in url:
            youtube_live(url[3:])  # when the lookup fails, the app falls back to YouTube's by-channel embed
        return True, None
    try:
        status, body, headers, final = _read(url, {'Origin': 'http://homeflix.local'})
        if status != 200 or '#EXTM3U' not in body[:1024]:
            return False, None
        cors = headers.get('Access-Control-Allow-Origin') in ('*', 'http://homeflix.local')
        variants = [ln.strip() for ln in body.splitlines() if ln.strip() and not ln.startswith('#')]
        if '#EXT-X-STREAM-INF' not in body or not variants:
            return True, cors
        # Players drop a quality that doesn't answer and use the next, so the channel is on air while any of its
        # first few qualities answers (ATV's 1080p one is often dead while 720p plays).
        for variant in variants[:3]:
            try:
                vstatus, vbody, vheaders, _ = _read(urljoin(final, variant), {'Origin': 'http://homeflix.local'})
            except (requests.RequestException, OSError):
                continue
            if vstatus == 200 and '#EXTM3U' in vbody[:1024]:
                return True, cors and vheaders.get('Access-Control-Allow-Origin') in ('*', 'http://homeflix.local')
        return False, None
    except (requests.RequestException, OSError):
        return False, None


# ---------------------------------------------------------------- playlist pass-through

def _base_domain(host):
    return '.'.join(host.split('.')[-2:])


def proxy_allowed(cid, url):
    """Only playlists on the channel's own servers (same domain as its listed URLs) pass through."""
    ch = find(cid)
    host = urlsplit(url).hostname or ''
    if not ch or urlsplit(url).scheme not in ('http', 'https'):
        return False
    return any(_base_domain(urlsplit(u).hostname or '') == _base_domain(host) for u in ch['urls'] if not u.startswith('yt:'))


_URI_ATTR = re.compile(r'URI="([^"]+)"')


def proxy_playlist(cid, url):
    """A channel's playlist text, for browsers that may not read it from the broadcaster (no CORS header). Links to
    other playlists point back here; links to video segments become absolute, so the video itself still goes from
    the broadcaster straight to the device. Returns (status, text)."""
    try:
        status, body, _, final = _read(url)
    except (requests.RequestException, OSError):
        return 502, ''
    if status != 200 or '#EXTM3U' not in body[:1024]:
        return status if status != 200 else 502, ''

    def link(u, playlist):
        absolute = urljoin(final, u.strip())
        return f'/api/live/pl/{cid}?u={quote(absolute, safe="")}' if playlist else absolute

    out, next_is_playlist = [], False
    for ln in body.splitlines():
        if ln.startswith('#'):
            if ln.startswith('#EXT-X-STREAM-INF'):
                next_is_playlist = True
            is_pl = ln.startswith(('#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF'))
            ln = _URI_ATTR.sub(lambda m: f'URI="{link(m.group(1), is_pl or ".m3u8" in m.group(1))}"', ln)
            out.append(ln)
        elif ln.strip():
            out.append(link(ln, next_is_playlist or '.m3u8' in ln.split('?')[0]))
            next_is_playlist = False
        else:
            out.append(ln)
    return 200, '\n'.join(out) + '\n'


# ---------------------------------------------------------------- YouTube live streams

YT_MAX_AGE = 3 * 3600
_yt = {}


_BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
# SOCS answers YouTube's EU cookie question ("reject all"), so servers in Europe get the page instead of consent.youtube.com.
_YT_HEADERS = {'Accept-Language': 'en', 'Cookie': 'CONSENT=YES+1; SOCS=CAI', 'User-Agent': _BROWSER_UA}


def _yt_feed(channel_id):
    """Video ids of the channel's newest uploads and live streams, newest first. The feed opens from data-centre
    servers too, where YouTube's pages ask to sign in ("confirm you're not a bot")."""
    try:
        status, body, _, _ = _read(f'https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}', _YT_HEADERS)
    except (requests.RequestException, OSError):
        return []
    return re.findall(r'<yt:videoId>([\w-]{11})</yt:videoId>', body) if status == 200 else []


def youtube_live(channel_id):
    """The id of a YouTube channel's current live video (embedding the video works on more devices than YouTube's
    by-channel live embed). Looked up at most every YT_MAX_AGE; None when it can't be found. The video id sits
    about 800 KB into YouTube's page, so the whole page is read. Where YouTube shows a bot check instead (the online
    server's data-centre address), the page still names the live video, and the channel's feed confirms which one."""
    hit = _yt.get(channel_id)
    if hit and time.time() - hit[0] < YT_MAX_AGE:
        return hit[1]
    vid = hit[1] if hit else None
    found, body = None, ''
    try:
        status, body, _, _ = _read(f'https://www.youtube.com/channel/{channel_id}/live', _YT_HEADERS, limit=3_000_000)
        m = re.search(r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([\w-]{11})"', body)
        found = m.group(1) if status == 200 and m else None
    except (requests.RequestException, OSError):
        pass
    if not found:
        feed = _yt_feed(channel_id)
        on_page = re.findall(r'"videoId":"([\w-]{11})"', body)
        found = next((v for v in on_page if v in feed), None) or (feed[0] if feed else None)
    vid = found or vid
    _yt[channel_id] = (time.time(), vid)
    return vid


def check_channel(cid):
    ch = find(cid)
    if not ch:
        return None
    result = {'ok': False, 'url': None, 'cors': None}
    for url in ch['urls']:
        ok, cors = _check_url(url)
        if ok:
            result = {'ok': True, 'url': url, 'cors': cors}
            break
    with _lock:
        prev = _status.get(cid, {})
        fails = 0 if result['ok'] else prev.get('fails', 0) + 1
        _status[cid] = {**result, 'fails': fails, 'at': time.time()}
    return _status[cid]


def check_all():
    alive = 0
    for row in CHANNELS:
        st = check_channel(row[0])
        alive += bool(st and st['ok'])
        time.sleep(0.3)
    dead = [r[1] for r in CHANNELS if not _status.get(r[0], {}).get('ok')]
    print(f"Canlı TV: {alive}/{len(CHANNELS)} kanal yayında" + (f" (açılmayan: {', '.join(dead)})" if dead else ''))
    return alive


def report_failure(cid, code, agent):
    """A device couldn't play a channel: logged, and the channel is checked again right away."""
    ch = find(cid)
    if not ch:
        return
    print(f"Canlı TV: {ch['name']} cihazda açılmadı ({code}) · {agent[:80]}")
    threading.Thread(target=check_channel, args=(cid,), daemon=True).start()


# ---------------------------------------------------------------- logos

def logo_file(cid):
    for ext in LOGO_EXT:
        p = os.path.join(LOGO_DIR, f'{cid}.{ext}')
        if os.path.exists(p):
            return p
    return None


def _pick_logo(entries):
    """The best logo for one channel from iptv-org's list: the main feed's, wide and large."""
    def score(e):
        tags = e.get('tags') or []
        return (e.get('feed') is None, 'horizontal' in tags or (e.get('width') or 0) >= (e.get('height') or 0),
                e.get('format') in ('PNG', 'SVG'), (e.get('width') or 0))
    return max(entries, key=score) if entries else None


def _yt_avatar(cid):
    """The YouTube channel picture of a YouTube-only channel iptv-org has no logo for."""
    ch = find(cid)
    yt = next((u[3:].partition('#')[0] for u in ch['urls'] if u.startswith('yt:')), None) if ch else None
    if not yt:
        return None
    try:
        status, body, _, _ = _read(f'https://www.youtube.com/channel/{yt}', _YT_HEADERS, limit=2_000_000)  # the picture sits ~850 KB in
    except (requests.RequestException, OSError):
        return None
    m = re.search(r'<meta property="og:image" content="(https://yt3\.[^"]+)"', body) if status == 200 else None
    return re.sub(r'=s\d+-', '=s240-', m.group(1)) if m else None


def _get_logo(url):
    try:
        r = _http.get(url, timeout=20, headers={'Accept': 'image/png,image/jpeg'})
    except requests.RequestException:
        return None
    return r if r.status_code == 200 and len(r.content) >= 100 else None


def fetch_logos(force=False):
    """Saves every channel's logo on the server (once; refreshed weekly) so devices without internet see them."""
    missing = [r[0] for r in CHANNELS if force or not logo_file(r[0]) or
               time.time() - os.path.getmtime(logo_file(r[0])) > LOGO_MAX_AGE]
    if not missing:
        return 0
    try:
        listing = _http.get(LOGO_LIST, timeout=60).json()
    except (requests.RequestException, ValueError):
        return 0
    by_channel = {}
    for e in listing:
        if e.get('channel') in missing:
            by_channel.setdefault(e['channel'], []).append(e)
    saved = 0
    for cid in missing:
        best = _pick_logo(by_channel.get(cid, []))
        if (not best or not best.get('url')) and cid in LOGO_URLS:
            best = {'url': LOGO_URLS[cid], 'format': ''}
        if not best or not best.get('url'):
            avatar = _yt_avatar(cid)
            best = {'url': avatar, 'format': ''} if avatar else None
        if not best or not best.get('url'):
            continue
        ext = (best.get('format') or '').lower()
        if ext not in LOGO_EXT:
            m = re.search(r'\.(png|svg|jpg|webp)(\?|$)', best['url'], re.I)
            ext = m.group(1).lower() if m else ''
        r = _get_logo(best['url'])
        if r is None and 'yt3.' not in best['url']:
            # iptv-org's image host (imgur) refuses the online server's address, so the YouTube picture is used instead.
            avatar = _yt_avatar(cid)
            r = _get_logo(avatar) if avatar else None
            ext = ''
        if r is None:
            continue
        if not ext:
            kind = r.headers.get('Content-Type', '')
            ext = 'jpg' if 'jpeg' in kind else 'webp' if 'webp' in kind else 'png'
        old = logo_file(cid)
        if old:
            os.remove(old)
        with open(os.path.join(LOGO_DIR, f'{cid}.{ext}'), 'wb') as f:
            f.write(r.content)
        saved += 1
        time.sleep(0.5)
    return saved


def warm_loop():
    """Logos once, then an on-air check of every channel every CHECK_EVERY (a few KB per channel)."""
    time.sleep(40)
    while True:
        try:
            n = fetch_logos()
            if n:
                print(f"Canlı TV: {n} kanal logosu indirildi")
            check_all()
        except Exception as e:
            print(f"Canlı TV kontrol hatası: {e}")
        time.sleep(CHECK_EVERY)


def status_report():
    with _lock:
        status = dict(_status)
    return [{'id': r[0], 'n': r[1], **{k: status.get(r[0], {}).get(k) for k in ('ok', 'cors', 'url', 'fails', 'at')}}
            for r in CHANNELS]


if __name__ == '__main__':
    # python -m homeflix.livetv : checks every channel from this computer and prints the result.
    fetch_logos()
    check_all()
    for s in status_report():
        print(f"{'OK ' if s['ok'] else 'YOK'} cors={s['cors']!s:5} {s['n']}")
