'use strict';

/* ================================================================ utilities */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const icon = (id, cls = '') => `<svg class="icon ${cls}"><use href="#i-${id}"/></svg>`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fold = s => String(s || '').replace(/ı/g, 'i').replace(/İ/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const collator = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const api = {
  async get(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); },
  async post(u, body) {
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(r.status);
    return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
  },
};

function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtRuntime(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? T('{h} sa {m} dk', { h, m }) : T('{h} sa', { h })) : T('{m} dk', { m });
}
function fmtLeft(pos, dur) {
  const left = Math.max(0, Math.round((dur - pos) / 60));
  return left >= 60 ? T('{h} sa {m} dk kaldı', { h: Math.floor(left / 60), m: left % 60 }) : T('{m} dk kaldı', { m: left });
}
function fmtSize(b) { return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB'; }
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function shuffle(a, seed) {
  a = a.slice();
  let s = seed ?? Math.random() * 1e9;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const genresOf = it => (it.g || '').split(',').map(g => g.trim()).filter(g => g && g !== 'N/A');
const daySeed = Math.floor(Date.now() / 864e5);

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

/* ================================================================ data */
const S = {
  titles: [], series: [], cols: [], byKey: new Map(), movieToTitle: new Map(), colById: new Map(),
  genres: [], progress: {}, mylist: new Set(), cont: [], version: 0, loaded: false,
  tmMovie: new Map(), tmSeries: new Map(), online: new Map(), embed: 'https://framextv.tech/embed',
  view: 'home', browse: { movies: { genre: '', sort: 'added' }, series: { genre: '', sort: 'added' } },
};

function img(kind, id, type, w) {
  const it = type === 'poster' && (kind === 'm' ? S.movieToTitle.get(id)?.versions.find(v => v.id === id) : kind === 's' ? S.byKey.get('s:' + id) : null);
  return `/img/${type}/${kind}/${id}?w=${w || 0}${it && it.ph ? '&v=' + it.ph : ''}`;
}

function buildLibrary(lib) {
  const groups = new Map();
  for (const m of lib.movies) {
    const k = m.tm ? 't' + m.tm : 'i' + m.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  S.movieToTitle.clear();
  S.titles = [...groups.values()].map(vs => {
    vs.sort((a, b) => (b.ph - a.ph) || (b.sz - a.sz));
    const p = vs[0];
    const t = {
      ...p, kind: 'm', key: 'm:' + p.id, versions: vs,
      add: Math.max(...vs.map(v => v.add || 0)),
      r: p.r || vs.find(v => v.r)?.r || '', g: p.g || vs.find(v => v.g)?.g || '',
      p: p.p || vs.find(v => v.p)?.p || '', bd: vs.some(v => v.bd), c: vs.find(v => v.c)?.c || null, k: Math.max(...vs.map(v => +v.k || 0)),
    };
    t.bdId = (vs.find(v => v.bd) || p).id;
    t.search = fold([t.t, t.ot, t.g, t.y, t.p].join(' '));
    vs.forEach(v => S.movieToTitle.set(v.id, t));
    return t;
  });
  S.series = lib.series.map(s => ({ ...s, kind: 's', key: 's:' + s.id, search: fold([s.t, s.ot, s.g, s.y, s.p].join(' ')) }));
  S.cols = lib.collections.map(c => {
    const items = [];
    for (const id of c.items) { const t = S.movieToTitle.get(id); if (t && !items.includes(t)) items.push(t); }
    return { ...c, kind: 'c', key: 'c:' + c.id, titles: items };
  }).filter(c => c.titles.length >= 2);
  S.byKey = new Map([...S.titles, ...S.series, ...S.cols].map(x => [x.key, x]));
  S.series.forEach(s => (s.ids || []).forEach(i => { if (!S.byKey.has('s:' + i)) S.byKey.set('s:' + i, s); }));
  S.colById = new Map(S.cols.map(c => [String(c.id), c]));
  S.tmMovie = new Map(S.titles.filter(t => t.tm).map(t => [t.tm, t]));
  S.tmSeries = new Map(S.series.filter(x => x.tm).map(x => [x.tm, x]));
  const count = new Map();
  [...S.titles, ...S.series].forEach(it => genresOf(it).forEach(g => count.set(g, (count.get(g) || 0) + 1)));
  S.genres = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => ({ g, n }));
  S.version = lib.version;
  S.loaded = true;
}

async function loadLibrary() { buildLibrary(await api.get('/api/library')); }
async function loadUser() {
  const u = await api.get('/api/user');
  S.progress = u.progress; S.mylist = new Set(u.mylist); S.cont = u.continue;
  S.online = new Map(Object.entries(u.online || {}).map(([k, d]) => [k, onlineItem(d)]));
  if (u.embed) S.embed = u.embed;
}
const inList = it => it.kind === 'm' ? it.versions.some(v => S.mylist.has('m:' + v.id)) : S.mylist.has(it.key);
const itemByKey = k => S.byKey.get(k) || OL.items.get(k) || S.online.get(k) || (k.startsWith('m:') ? S.movieToTitle.get(+k.slice(2)) : null);
function movieProgress(t) {
  let best = null;
  for (const v of t.versions || []) {
    const p = S.progress['m:' + v.id];
    if (p && (!best || p[3] > best[3])) best = [...p, v.id];
  }
  return best;
}
const isNew = it => it.add && (Date.now() / 1000 - it.add) < 21 * 864e2;

/* ================================================================ cards */
function artHTML(it, w = 342) {
  if (it.kind === 'c') {
    const first = it.titles.find(t => t.bd) || it.titles[0];
    const src = it.backdrop ? img('c', it.id, 'backdrop', 780) : first?.bd ? img('m', first.bdId, 'backdrop', 780) : null;
    return src ? `<img src="${src}" alt="" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">` :
      `<div class="ph" style="--h:${hue(it.name)}">${esc(it.name)}</div>`;
  }
  const ph = `<div class="ph" style="--h:${hue(it.t)}">${esc(it.t)}</div>`;
  if (it.online) return it.op ? `${ph}<img src="${TMDB_IMG}w342${it.op}" alt="${esc(it.t)}" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">` : ph;
  if (!it.ph) return ph;
  return `${ph}<img src="${img(it.kind, it.id, 'poster', w)}" alt="${esc(it.t)}" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">`;
}

function posterCard(it, { caption = false, current = false } = {}) {
  const prog = it.kind === 'm' ? movieProgress(it) : null;
  const pct = prog && !prog[2] && prog[1] ? clamp(prog[0] / prog[1] * 100, 2, 100) : 0;
  const sub = [it.y, it.kind === 's' ? T('{n} sezon', { n: it.seasons }) : it.kind === 'os' ? T('Dizi') : fmtRuntime(it.rt)].filter(Boolean).join(' · ');
  const flag = it.online ? (localOf(it) ? `<span class="flag own">${T('KÜTÜPHANEDE')}</span>` : '') : isNew(it) && !caption ? `<span class="flag new">${T('YENİ')}</span>` : '';
  return `<div class="card${current ? ' current' : ''}" tabindex="0" role="button" data-open="${it.key}" aria-label="${esc(it.t)}">
    <div class="art">${artHTML(it)}
      ${flag}
      <div class="shade"><strong>${esc(it.t)}</strong><span>${it.r ? `<b class="score">${icon('star')}${esc(it.r)}</b>` : ''}${esc(sub)}</span></div>
      ${pct ? `<div class="pbar progress-line"><i style="width:${pct}%"></i></div>` : ''}
    </div>
    ${caption ? `<div class="caption"><strong>${esc(it.t)}</strong><span>${esc(it.y || '')}${it.r ? ` <b class="score">${icon('star')}${esc(it.r)}</b>` : ''}</span></div>` : ''}
  </div>`;
}

function continueCard(c) {
  if (c.kind === 'om' || c.kind === 'oe') return onlineContinueCard(c);
  const series = c.kind === 'e' ? S.byKey.get('s:' + c.sid) : null;
  const movie = c.kind === 'm' ? S.movieToTitle.get(c.id) : null;
  const src = series ? (series.bd ? img('s', series.id, 'backdrop', 640) : series.ph ? img('s', series.id, 'poster', 342) : '')
    : movie ? (movie.bd ? img('m', movie.bdId, 'backdrop', 640) : movie.ph ? img('m', movie.id, 'poster', 342) : '') : '';
  const pct = c.dur ? clamp(c.pos / c.dur * 100, 2, 100) : 0;
  return `<div class="card land" tabindex="0" role="button" data-play="${c.kind}:${c.id}" aria-label="${esc(c.title)}">
    <div class="art">${src ? `<img src="${src}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : `<div class="ph" style="--h:${hue(c.title)}">${esc(c.title)}</div>`}
      ${c.up_next ? `<span class="flag new">${T('SIRADAKİ')}</span>` : ''}
      <button class="x" data-forget="${c.kind}:${c.id}" title="${T('Listeden kaldır')}" aria-label="${T('Kaldır')}">${icon('x')}</button>
      <div class="play-glyph">${icon('play', 'fill')}</div>
      <div class="shade"><strong>${esc(c.title)}</strong><span>${esc(tx(c.sub || ''))}${c.dur ? ` · ${fmtLeft(c.pos, c.dur)}` : ''}</span></div>
      ${pct ? `<div class="pbar progress-line"><i style="width:${pct}%"></i></div>` : ''}
    </div></div>`;
}

function collectionCard(c) {
  const stack = c.titles.filter(t => t.ph).slice(0, 3).map(t => `<img src="${img('m', t.id, 'poster', 154)}" alt="" loading="lazy">`).join('');
  return `<div class="card col" tabindex="0" role="button" data-open="${c.key}" aria-label="${esc(c.name)}">
    <div class="art">${artHTML(c)}<div class="stack">${stack}</div>
      <div class="shade"><strong>${esc(c.name)}</strong><span>${T('{n} film', { n: c.titles.length })}${c.parts > c.titles.length ? ` · ${T('serinin {n} filminden', { n: c.parts })}` : ''}</span></div>
    </div></div>`;
}

function row(title, items, { kind = 'poster', more = '' } = {}) {
  if (!items.length) return '';
  const body = items.map(x => kind === 'cont' ? continueCard(x) : kind === 'col' ? collectionCard(x) : posterCard(x)).join('');
  return `<section class="row">
    <div class="row-head"><h2>${esc(tx(title))}</h2>${more ? `<a class="more" href="${more}">${T('Tümünü gör')} ${icon('right')}</a>` : ''}</div>
    <div class="rail-wrap">
      <button class="rail-btn prev" aria-label="${T('Geri')}" hidden>${icon('left')}</button>
      <div class="rail${kind !== 'poster' ? ' wide' : ''}">${body}</div>
      <button class="rail-btn next" aria-label="${T('İleri')}">${icon('right')}</button>
    </div></section>`;
}

function wireRails(root) {
  $$('.rail-wrap', root).forEach(w => {
    const rail = $('.rail', w), prev = $('.prev', w), next = $('.next', w);
    const upd = () => {
      prev.hidden = rail.scrollLeft < 8;
      next.hidden = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
    };
    prev.onclick = () => rail.scrollBy({ left: -rail.clientWidth * .9, behavior: 'smooth' });
    next.onclick = () => rail.scrollBy({ left: rail.clientWidth * .9, behavior: 'smooth' });
    rail.addEventListener('scroll', upd, { passive: true });
    requestAnimationFrame(upd);
  });
}

function metaLine(it, { runtime = true } = {}) {
  const bits = [];
  if (it.r) bits.push(`<span class="score">${icon('star')}${esc(it.r)}</span>`);
  if (it.y) bits.push(`<span>${esc(it.y)}</span>`);
  if (it.kind === 'm' && runtime && it.rt) bits.push(`<span>${fmtRuntime(it.rt)}</span>`);
  if (it.kind === 's') bits.push(`<span>${T('{n} sezon', { n: it.seasons })} · ${T('{n} bölüm', { n: it.eps })}</span>`);
  const g = genresOf(it).slice(0, 3).map(tx).join(', ');
  if (g) bits.push(`<span>${esc(g)}</span>`);
  return bits.join('<i class="sep"></i>');
}

/* ================================================================ views */
let heroTimer = null;

function heroHTML(picks) {
  if (!picks.length) return '<div style="height:calc(var(--nav-h) + 20px)"></div>';
  const src = it => it.online ? `${TMDB_IMG}w1280${it.ob}` : img(it.kind, it.kind === 'm' ? it.bdId : it.id, 'backdrop', 1600);
  const slides = picks.map((it, i) => `<div class="hero-slide${i ? '' : ' on'}"><img src="${src(it)}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'}></div>`).join('');
  return `<section class="hero" id="hero">${slides}<div class="hero-content" id="hero-content"></div>
    ${picks.length > 1 ? `<div class="hero-dots">${picks.map((_, i) => `<button data-hero="${i}" class="${i ? '' : 'on'}" aria-label="${T('Öne çıkan {n}', { n: i + 1 })}"></button>`).join('')}</div>` : ''}</section>`;
}

function heroContent(it) {
  if (it.online) return `<div class="kicker"><b>L</b>Online · ${T(it.kind === 'os' ? 'Dizi' : 'Film')}</div>
    <h1>${esc(it.t)}</h1>
    <div class="meta">${metaLine(it)}</div>
    <p class="plot">${esc(it.p)}</p>
    <div class="actions">
      <button class="btn btn-play" ${it.kind === 'os' ? `data-open="${it.key}"` : `data-oplay="m:${it.tm}"`}>${icon('play', 'fill')}${T('Oynat')}</button>
      <button class="btn btn-ghost" data-open="${it.key}">${icon('info')}${T('Daha Fazla Bilgi')}</button>
    </div>`;
  const col = it.c ? S.colById.get(String(it.c)) : null;
  const kicker = it.kind === 's' ? T('Dizi') : col ? `${T('Koleksiyon')} · ${col.name}` : isNew(it) ? T('Yeni Eklendi') : T('Öne Çıkan Film');
  const prog = it.kind === 'm' ? movieProgress(it) : null;
  const resume = prog && !prog[2] && prog[0] > 30;
  return `<div class="kicker"><b>L</b>${esc(kicker)}</div>
    <h1>${esc(it.t)}</h1>
    <div class="meta">${metaLine(it)}</div>
    <p class="plot">${esc(it.p)}</p>
    <div class="actions">
      <button class="btn btn-play" data-${it.kind === 's' ? 'open' : 'play'}="${it.kind === 's' ? it.key : 'm:' + it.id}">${icon('play', 'fill')}${T(resume ? 'Devam Et' : 'Oynat')}</button>
      <button class="btn btn-ghost" data-open="${it.key}">${icon('info')}${T('Daha Fazla Bilgi')}</button>
    </div>`;
}

function startHero(picks) {
  clearInterval(heroTimer);
  const hero = $('#hero');
  if (!hero || !picks.length) return;
  let i = 0;
  const show = n => {
    i = (n + picks.length) % picks.length;
    $$('.hero-slide', hero).forEach((s, k) => s.classList.toggle('on', k === i));
    $$('.hero-dots button', hero).forEach((s, k) => s.classList.toggle('on', k === i));
    $('#hero-content').innerHTML = heroContent(picks[i]);
  };
  show(0);
  hero.onclick = e => { const d = e.target.closest('[data-hero]'); if (d) { show(+d.dataset.hero); restart(); } };
  const restart = () => { clearInterval(heroTimer); heroTimer = setInterval(() => { if (!document.hidden && !anyOverlay()) show(i + 1); }, 9000); };
  if (picks.length > 1) restart();
}

function renderHome() {
  const pool = [...S.titles, ...S.series];
  const withBd = pool.filter(t => t.bd && t.p && parseFloat(t.r || 0) >= 6.5);
  const picks = shuffle(withBd.length ? withBd : pool.filter(t => t.bd), daySeed + (Date.now() / 36e5 | 0)).slice(0, 6);
  const byAdd = [...S.titles].sort((a, b) => b.add - a.add);
  const top = S.titles.filter(t => parseFloat(t.r) >= 7.2).sort((a, b) => parseFloat(b.r) - parseFloat(a.r));
  const list = [...S.mylist].map(itemByKey).filter((x, i, a) => x && a.indexOf(x) === i);
  const cols = [...S.cols].sort((a, b) => b.titles.length - a.titles.length);
  const series = [...S.series].sort((a, b) => b.add - a.add);
  let html = heroHTML(picks) + '<div class="rows">';
  html += row('İzlemeye Devam Et', S.cont, { kind: 'cont' });
  html += row('Listem', list, { more: '#list' });
  html += row('Yeni Eklenenler', byAdd.slice(0, 24), { more: '#movies' });
  html += row('Koleksiyonlar', cols.slice(0, 16), { kind: 'col', more: '#collections' });
  html += row('Diziler', series.slice(0, 24), { more: '#series' });
  html += row('En Yüksek Puanlılar', top.slice(0, 24));
  const used = new Set();
  S.genres.filter(g => g.n >= 10).slice(0, 7).forEach(({ g }) => {
    const items = shuffle(S.titles.filter(t => genresOf(t).includes(g) && !used.has(t.key)), daySeed + hue(g))
      .sort((a, b) => (parseFloat(b.r) || 0) - (parseFloat(a.r) || 0)).slice(0, 20);
    items.slice(0, 6).forEach(t => used.add(t.key));
    html += row(g, shuffle(items, daySeed), { more: `#movies/${encodeURIComponent(g)}` });
  });
  html += row('Bugün Ne İzlesem?', shuffle(S.titles, daySeed * 7).slice(0, 24));
  html += '</div>';
  $('#view').innerHTML = html;
  wireRails($('#view'));
  startHero(picks);
}

const SORTS = [
  ['added', 'Yeni eklenen'], ['rating', 'Puan (yüksek)'], ['rating_asc', 'Puan (düşük)'],
  ['name', 'İsim (A–Z)'], ['year', 'Yıl (yeni)'], ['year_asc', 'Yıl (eski)'],
];
function sortItems(items, sort) {
  const r = x => parseFloat(x.r) || 0, y = x => parseInt(x.y) || 0;
  const f = {
    added: (a, b) => b.add - a.add, rating: (a, b) => r(b) - r(a), rating_asc: (a, b) => (r(a) || 99) - (r(b) || 99),
    name: (a, b) => collator.compare(a.t, b.t), year: (a, b) => y(b) - y(a), year_asc: (a, b) => (y(a) || 9999) - (y(b) || 9999),
  }[sort] || (() => 0);
  return items.slice().sort(f);
}

function renderBrowse(kind) {
  const st = S.browse[kind];
  const base = kind === 'movies' ? S.titles : S.series;
  const genreCount = new Map();
  base.forEach(it => genresOf(it).forEach(g => genreCount.set(g, (genreCount.get(g) || 0) + 1)));
  const genres = [...genreCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const items = sortItems(st.genre ? base.filter(it => genresOf(it).includes(st.genre)) : base, st.sort);
  $('#view').innerHTML = `
    <div class="page-head"><h1>${T(kind === 'movies' ? 'Filmler' : 'Diziler')}</h1><span class="count">${T(kind === 'movies' ? '{n} film' : '{n} dizi', { n: items.length })}</span></div>
    <div class="toolbar">
      <div class="chips"><button class="chip${st.genre ? '' : ' on'}" data-genre="">${T('Tümü')}</button>${genres.map(g => `<button class="chip${st.genre === g ? ' on' : ''}" data-genre="${esc(g)}">${esc(tx(g))}</button>`).join('')}</div>
      <label class="select"><span class="sr">${T('Sırala')}</span><select id="sort">${SORTS.map(([v, l]) => `<option value="${v}"${st.sort === v ? ' selected' : ''}>${T(l)}</option>`).join('')}</select></label>
    </div>
    <div class="grid" id="grid">${items.map(it => posterCard(it, { caption: true })).join('') || emptyState('Bu türde içerik yok', 'Başka bir tür seçmeyi deneyin.')}</div>`;
  $('.chips').onclick = e => {
    const c = e.target.closest('[data-genre]');
    if (!c) return;
    st.genre = c.dataset.genre;
    history.replaceState(history.state, '', `#${kind}${st.genre ? '/' + encodeURIComponent(st.genre) : ''}`);
    renderBrowse(kind);
  };
  $('#sort').onchange = e => { st.sort = e.target.value; store.set('sort_' + kind, st.sort); renderBrowse(kind); };
  const on = $('.chip.on'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function emptyState(title, text, ic = 'popcorn') {
  return `<div class="empty">${icon(ic)}<h3>${esc(tx(title))}</h3><p>${esc(tx(text))}</p></div>`;
}

function renderCollections() {
  const cols = [...S.cols].sort((a, b) => collator.compare(a.name, b.name));
  $('#view').innerHTML = `
    <div class="page-head"><h1>${T('Koleksiyonlar')}</h1><span class="count">${T('{n} seri', { n: cols.length })} · ${T('{n} film', { n: cols.reduce((n, c) => n + c.titles.length, 0) })}</span></div>
    <div class="grid cols" style="padding-top:20px">${cols.map(collectionCard).join('') || emptyState('Henüz koleksiyon yok', 'Film bilgileri tamamlandıkça devam filmleri burada gruplanacak.')}</div>`;
}

/* ---------------------------------------------------------------- kids zone */
// Titles flagged by the server (animation / family rated G/PG, PG/PG-13 comedies and hand-picked titles).
const KIDS_EMOJI = ['🎈', '⭐', '🚀', '🦄', '🐼', '🌈', '🍭', '🦖', '🎠', '🐠', '🪁', '🌟', '🐣', '🍦'];
function renderKids() {
  const movies = S.titles.filter(t => t.k);
  const series = S.series.filter(s => s.k);
  const r = x => parseFloat(x.r) || 0;
  const kidKeys = new Set(movies.map(t => t.key));
  const cols = S.cols.filter(c => c.titles.length > 1 && c.titles.every(t => kidKeys.has(t.key)));
  const sky = KIDS_EMOJI.map((e, i) => `<span style="left:${(i * 7.3 + 3) % 96}%;top:${(i * 37 + 11) % 88}%;--d:${5 + i % 4}s;--w:${i * .4}s">${e}</span>`).join('');
  const title = [...'Kids Zone'].map((ch, i) => ch === ' ' ? '<i class="sp"></i>' : `<span style="--i:${i}">${ch}</span>`).join('');
  let html = `<div class="kids"><div class="kids-sky" aria-hidden="true">${sky}</div>
    <header class="kids-hero">
      <h1 class="kids-title" aria-label="Kids Zone">${title}</h1>
      <p>${T('Çizgi filmler, animasyonlar ve aile filmleri burada! {n} macera seni bekliyor.', { n: movies.length + series.length })}</p>
      ${movies.length ? `<button class="kids-surprise" data-action="kids-surprise">${T('🎲 Sürpriz Film!')}</button>` : ''}
    </header><div class="rows">`;
  html += row('🌟 En Sevilenler', [...movies].sort((a, b) => r(b) - r(a)).slice(0, 24));
  html += row('🎨 Animasyon Filmleri', shuffle(movies.filter(t => genresOf(t).includes('Animasyon')), daySeed));
  html += row('📺 Çizgi Diziler', series);
  html += row('🧸 Film Serileri', cols, { kind: 'col' });
  const live = movies.filter(t => !genresOf(t).includes('Animasyon'));
  html += row('✨ Macera ve Fantastik', shuffle(live.filter(t => ['Macera', 'Fantastik', 'Bilim-Kurgu'].some(g => genresOf(t).includes(g))), daySeed + 3));
  html += row('👨‍👩‍👧 Aile Filmleri', shuffle(live.filter(t => genresOf(t).includes('Aile')), daySeed + 1));
  html += row('😂 Komediler', shuffle(live.filter(t => genresOf(t).includes('Komedi')), daySeed + 2));
  html += row('🆕 Yeni Gelenler', [...movies].sort((a, b) => b.add - a.add).slice(0, 20));
  if (!movies.length && !series.length) html += emptyState('Henüz çocuk filmi yok', 'Animasyon ve aile filmleri eklendikçe burada görünecek.');
  $('#view').innerHTML = html + '</div></div>';
  wireRails($('#view'));
}

function kidsSurprise() {
  const pool = S.titles.filter(t => t.k);
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  for (let i = 0; i < 18; i++) {
    const c = document.createElement('span');
    c.className = 'kids-confetti';
    c.textContent = KIDS_EMOJI[i % KIDS_EMOJI.length];
    c.style.left = Math.random() * 100 + 'vw';
    c.style.animationDelay = Math.random() * .3 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1900);
  }
  setTimeout(() => openDetail(pick.key), 650);
}

function renderList() {
  const items = [...S.mylist].map(itemByKey).filter((x, i, a) => x && a.indexOf(x) === i);
  $('#view').innerHTML = `
    <div class="page-head"><h1>${T('Listem')}</h1><span class="count">${T('{n} içerik', { n: items.length })}</span></div>
    <div class="grid" style="padding-top:20px">${items.map(it => posterCard(it, { caption: true })).join('') ||
      emptyState('Listeniz boş', 'Bir filmin ya da dizinin sayfasındaki + düğmesiyle buraya ekleyin.', 'bookmark')}</div>`;
}

function route() {
  const [view, arg] = (location.hash.slice(1) || 'home').split('/');
  S.view = ['home', 'movies', 'series', 'collections', 'kids', 'list', 'online', 'live', 'clips'].includes(view) ? view : 'home';
  if ((S.view === 'movies' || S.view === 'series')) S.browse[S.view].genre = arg ? decodeURIComponent(arg) : '';
  if (S.view === 'clips') CL.artist = arg ? decodeURIComponent(arg) : '';
  $$('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === S.view));
  render();
  window.scrollTo(0, 0);
  // Cover frames are made in the background after a scan: the list is fetched again so new ones show up.
  if (S.view === 'clips' && CL.items) {
    const before = CL.items.map(c => c.id + ':' + c.th).join();
    loadClips().then(() => { if (S.view === 'clips' && !P.open && CL.items.map(c => c.id + ':' + c.th).join() !== before) softRender(); });
  }
}

function render() {
  if (!S.loaded) return;
  clearInterval(heroTimer);
  const y = window.scrollY;
  ({ home: renderHome, movies: () => renderBrowse('movies'), series: () => renderBrowse('series'),
     collections: renderCollections, kids: renderKids, list: renderList, online: renderOnline, live: renderLive, clips: renderClips })[S.view]();
  return y;
}
function softRender() { const y = window.scrollY; render(); window.scrollTo(0, y); }

/* ================================================================ overlays & history */
const stack = [];
const anyOverlay = () => stack.length > 0;
function pushOverlay(name, onClose) {
  stack.push({ name, onClose });
  history.pushState({ ov: stack.length }, '');
  document.body.classList.add('locked');
}
function back() { if (stack.length) history.back(); }
window.addEventListener('popstate', () => {
  const top = stack.pop();
  if (top) top.onClose();
  if (!stack.length) document.body.classList.remove('locked');
});

/* ================================================================ detail */
let detailKey = null;

async function openDetail(key) {
  if (/^o[ms]:\d+$/.test(key)) return openOnlineDetail(key);
  const it = S.byKey.get(key) || (key.startsWith('m:') ? S.movieToTitle.get(+key.slice(2)) : null);
  if (!it) return;
  const el = $('#detail');
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    pushOverlay('detail', () => { el.classList.remove('open'); detailKey = null; });
  }
  detailKey = it.key;
  $('#detail-scroll').scrollTop = 0;
  if (it.kind === 'c') return renderCollectionDetail(it);
  renderDetail(it);
  if (it.kind === 's') loadEpisodes(it);
}

function detailHero(it, title, actions, metaHTML) {
  const kind = it.kind === 'c' ? 'c' : it.kind;
  const bdSrc = it.online ? (it.ob ? `${TMDB_IMG}w1280${it.ob}` : '') : it.kind === 'c' ? (it.backdrop ? img('c', it.id, 'backdrop', 1280) : (() => { const f = it.titles.find(t => t.bd); return f ? img('m', f.bdId, 'backdrop', 1280) : ''; })())
    : it.bd ? img(kind, kind === 'm' ? it.bdId : it.id, 'backdrop', 1280) : '';
  const posterSrc = it.online ? (it.op ? `${TMDB_IMG}w342${it.op}` : '') : it.kind !== 'c' && it.ph ? img(kind, it.id, 'poster', 500) : '';
  const fallback = posterSrc ? `<img class="blurposter" src="${posterSrc}" alt="">` : `<div class="ph" style="--h:${hue(title)}"></div>`;
  return `<div class="d-hero">${bdSrc ? `<img src="${bdSrc}" alt="" onload="this.classList.add('ok')" onerror="this.outerHTML=this.dataset.fb" data-fb='${esc(fallback)}'>` : fallback}
    <div class="d-head"><h1>${esc(title)}</h1>${metaHTML ? `<div class="meta" style="margin-bottom:18px">${metaHTML}</div>` : ''}<div class="d-prov" id="d-prov"></div><div class="actions">${actions}</div></div></div>`;
}
// Logos of the streaming services that carry the title in Turkey, with no heading (Oğuz's wish). Saved on the server.
function fillProviders(list, key) {
  const box = $('#d-prov');
  if (!box || detailKey !== key || !list?.length) return;
  box.innerHTML = list.map(p => `<img${p.w ? ' class="wide"' : ''} src="/img/tmdb/w92${esc(p.l)}" alt="${esc(p.n)}" title="${esc(p.n)}" onerror="this.remove()">`).join('');
}

// Downloads are for phones and computers; TVs (webOS, the Android TV app's WebView) have nowhere to save a file.
const CAN_DOWNLOAD = !/Web0S|webOS|NetCast|HomeflixTV|SmartTV|Tizen/i.test(navigator.userAgent);
function downloadButton(ref, size) {
  if (!CAN_DOWNLOAD) return '';
  return `<button class="round-btn" data-dl="${ref}" title="${T('İndir')}${size ? ' · ' + fmtSize(size) : ''}" aria-label="${T('İndir')}">${icon('download')}</button>`;
}
// A few downloads at a time per device (set on the server): the server refuses one more, so check first and say why.
async function startDownload(ref) {
  const [kind, id] = ref.split(':');
  let st;
  try { st = await api.get('/api/download/status'); } catch { return toast(T('Sunucuya ulaşılamadı.')); }
  // Older servers send only "mine"; newer ones also say how many more this device may start ("free").
  if (st.mine && !(st.free > 0)) {
    const pct = st.mine.size ? Math.floor(st.mine.sent / st.mine.size * 100) : 0;
    if ((st.per_device || 1) > 1) return toast(`${icon('download')} ${T('Bu cihazda zaten {n} indirme sürüyor. Biri bitince yenisini başlatabilirsiniz.', { n: st.per_device })}`, 4500);
    return toast(`${icon('download')} ${T('Bu cihazda zaten bir indirme sürüyor: <b>{name}</b> (%{pct}). O bitince yenisini başlatabilirsiniz.', { name: esc(st.mine.name), pct })}`, 4500);
  }
  const a = document.createElement('a');
  a.href = `/download/${kind}/${id}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`${icon('download')} ${T('İndirme başladı. Ağı yormamak için hız sınırlıdır, bu biraz sürebilir.')}`, 4000);
}

function listButton(it) {
  const on = inList(it);
  return `<button class="round-btn${on ? ' on' : ''}" data-list="${it.key}" title="${T(on ? 'Listemden çıkar' : 'Listeme ekle')}" aria-label="${T('Listem')}">${icon(on ? 'check' : 'plus')}</button>`;
}

function renderDetail(it) {
  const col = it.kind === 'm' && it.c ? S.colById.get(String(it.c)) : null;
  let actions = '', resumeNote = '';
  if (it.kind === 'm') {
    const prog = movieProgress(it);
    const resume = prog && !prog[2] && prog[0] > 30;
    const vid = resume ? prog[4] : it.id;
    actions = `<button class="btn btn-play" data-play="m:${vid}">${icon('play', 'fill')}${T(resume ? 'Devam Et' : 'Oynat')}</button>
      ${resume ? `<button class="btn btn-ghost" data-play="m:${vid}" data-from="0">${icon('refresh')}${T('Baştan Başla')}</button>` : ''}${listButton(it)}${downloadButton('m:' + vid, (it.versions.find(v => v.id === vid) || {}).sz)}`;
    if (resume && prog[1]) resumeNote = `<div class="resume-note"><div class="progress-line"><i style="width:${clamp(prog[0] / prog[1] * 100, 2, 100)}%"></i></div>${fmtLeft(prog[0], prog[1])}</div>`;
  } else {
    actions = `<button class="btn btn-play" id="series-play" data-play="">${icon('play', 'fill')}${T('Oynat')}</button>${listButton(it)}`;
  }
  const similar = [...S.titles, ...S.series].filter(x => x !== it && !(col && x.c === it.c))
    .map(x => ({ x, s: genresOf(x).filter(g => genresOf(it).includes(g)).length + (parseFloat(x.r) || 0) / 20 }))
    .filter(o => o.s >= 1).sort((a, b) => b.s - a.s).slice(0, 12).map(o => o.x);
  const facts = [];
  if (it.ot && fold(it.ot) !== fold(it.t)) facts.push(`<div>${T('Orijinal ad')}: <b>${esc(it.ot)}</b></div>`);
  if (genresOf(it).length) facts.push(`<div>${T('Türler')}: <b>${esc(genresOf(it).map(tx).join(', '))}</b></div>`);
  if (col) facts.push(`<div>${T('Koleksiyon')}: <a data-open="${col.key}">${esc(col.name)}</a></div>`);
  if (it.kind === 'm') facts.push(`<div>${T('Kütüphaneye eklendi')}: <b>${new Date(it.add * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })}</b></div>`);
  const versions = it.kind === 'm' && it.versions.length > 1 ? `<div class="section"><div class="section-head"><h3>${T('Sürümler')}</h3></div><div class="versions">
    ${it.versions.map((v, i) => `<div class="version-row"><button class="version" data-play="m:${v.id}" data-from="0">${icon('play', 'fill')}<span>${esc(v.t)}${i === 0 ? ' · ' + T('varsayılan') : ''}</span><small>${v.sz ? fmtSize(v.sz) : ''}</small></button>${CAN_DOWNLOAD ? `<button class="version-dl icon-btn" data-dl="m:${v.id}" title="${T('Bu sürümü indir')}" aria-label="${T('Bu sürümü indir')}">${icon('download')}</button>` : ''}</div>`).join('')}</div></div>` : '';
  $('#detail-sheet').innerHTML = `
    <button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button>
    ${detailHero(it, it.t, actions, metaLine(it))}
    <div class="d-body">
      <div class="d-grid"><div><p class="plot">${esc(it.p || T('Bu içerik için açıklama bulunamadı.'))}</p>${resumeNote}</div><div class="facts">${facts.join('')}</div></div>
      ${it.kind === 's' ? `<div class="section" id="episodes"><div class="section-head"><h3>${T('Bölümler')}</h3></div><div class="eps"><div class="spin" style="margin:20px auto"></div></div></div>` : ''}
      ${col ? `<div class="section"><div class="section-head"><h3>${esc(col.name)}</h3><a class="more" style="opacity:1;transform:none;color:var(--muted);font-weight:600;font-size:14px;cursor:pointer" data-open="${col.key}">${T('Koleksiyonu aç')}</a></div>
        <div class="grid">${col.titles.map(t => posterCard(t, { caption: true, current: t === it })).join('')}</div></div>` : ''}
      ${versions}
      ${similar.length ? `<div class="section"><div class="section-head"><h3>${T('Benzer İçerikler')}</h3></div><div class="grid">${similar.map(x => posterCard(x, { caption: true })).join('')}</div></div>` : ''}
    </div>`;
  loadCredits(it).then(cr => fillProviders(cr.prov, it.key));
}

function renderCollectionDetail(c) {
  const next = c.titles.find(t => { const p = movieProgress(t); return !p || !p[2]; }) || c.titles[0];
  const years = c.titles.map(t => parseInt(t.y)).filter(Boolean);
  const meta = [`<span>${T('{n} film', { n: c.titles.length })}</span>`, years.length ? `<span>${Math.min(...years)}–${Math.max(...years)}</span>` : '',
    c.parts > c.titles.length ? `<span>${T('Seride {n} film var', { n: c.parts })}</span>` : ''].filter(Boolean).join('<i class="sep"></i>');
  $('#detail-sheet').innerHTML = `
    <button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button>
    ${detailHero(c, c.name, `<button class="btn btn-play" data-play="m:${next.id}">${icon('play', 'fill')}${T(next === c.titles[0] ? 'Seriye Başla' : 'Sıradakini İzle')}</button>`, meta)}
    <div class="d-body">
      ${c.ov ? `<p class="plot" style="font-size:16px;color:#e4e4e7;margin:14px 0 0;max-width:760px;line-height:1.6">${esc(c.ov)}</p>` : ''}
      <div class="section"><div class="section-head"><h3>${T('Filmler')}</h3><span style="color:var(--dim);font-size:14px">${T('Çıkış sırasına göre')}</span></div>
      <div class="grid">${c.titles.map(t => posterCard(t, { caption: true })).join('')}</div></div>
    </div>`;
}

async function loadEpisodes(s, season, tries = 0) {
  let data;
  try { data = await api.get(`/api/series/${s.id}`); } catch { return; }
  if (detailKey !== s.key) return;
  const box = $('#episodes');
  if (!box || !data.seasons.length) { if (box) box.innerHTML = emptyState('Bölüm bulunamadı', ''); return; }
  // Play / Continue follows the episodes; season 0 (specials and extras) only when there is nothing else.
  const regular = data.seasons.filter(x => x.n !== 0);
  const all = (regular.length ? regular : data.seasons).flatMap(x => x.eps.map(e => ({ ...e, season: x.n })));
  const last = all.filter(e => e.at).sort((a, b) => b.at - a.at)[0];
  let target = all[0];
  if (last) {
    const i = all.indexOf(last);
    target = last.fin ? (all[i + 1] || last) : last;
  }
  const cur = season ?? target.season;
  const playBtn = $('#series-play');
  if (playBtn) {
    const resume = target.pos > 30 && !target.fin;
    playBtn.dataset.play = 'e:' + target.id;
    playBtn.innerHTML = `${icon('play', 'fill')}${T(resume ? 'Devam Et' : last ? 'Oynat' : 'İzlemeye Başla')} · ${epCode(target.season, target.n)}`;
  }
  const sName = n => n === 0 ? T('Özel ve Ekstralar') : T('Sezon {n}', { n });
  const seasonSel = data.seasons.length > 1 ? `<label class="select"><select id="season-sel">${data.seasons.map(x => `<option value="${x.n}"${x.n === cur ? ' selected' : ''}>${sName(x.n)}</option>`).join('')}</select></label>` : `<span style="color:var(--dim)">${sName(cur)}</span>`;
  const eps = data.seasons.find(x => x.n === cur)?.eps || [];
  box.innerHTML = `<div class="section-head"><h3>${T('Bölümler')}</h3>${seasonSel}</div><div class="eps">${eps.map(e => {
    const pct = e.dur && !e.fin ? clamp(e.pos / e.dur * 100, 2, 100) : e.fin ? 100 : 0;
    const thumb = e.still ? `/img/still/${e.id}` : s.bd ? img('s', s.id, 'backdrop', 400) : s.ph ? img('s', s.id, 'poster', 342) : '';
    return `<div class="ep${target.id === e.id ? ' now' : ''}${CAN_DOWNLOAD ? ' has-dl' : ''}" tabindex="0" role="button" data-play="e:${e.id}">
      <div class="num">${e.x ? icon('star') : e.n}</div>
      <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" onload="this.classList.add('ok')">` : ''}<div class="play-glyph"><span>${icon('play', 'fill')}</span></div>
        ${pct ? `<div class="pbar progress-line"><i style="width:${pct}%"></i></div>` : ''}</div>
      <div><h4><span>${esc(e.name || T('{n}. Bölüm', { n: e.n }))}</span><small>${e.fin ? `<span class="done">${icon('check')}${T('İzlendi')}</span>` : e.rt ? T('{m} dk', { m: e.rt }) : ''}</small></h4>
        <p>${esc(e.ov || e.file)}</p></div>${CAN_DOWNLOAD ? `<button class="ep-dl icon-btn" data-dl="e:${e.id}" title="${T('Bölümü indir')}" aria-label="${T('Bölümü indir')}">${icon('download')}</button>` : ''}</div>`;
  }).join('')}</div>`;
  const sel = $('#season-sel');
  if (sel) sel.onchange = () => loadEpisodes(s, +sel.value);
  if (data.pending && tries < 4) setTimeout(() => detailKey === s.key && loadEpisodes(s, season, tries + 1), 1500);
}

async function toggleList(key, btn) {
  const it = itemByKey(key);
  if (!it) return;
  const on = !inList(it);
  const keys = it.kind === 'm' ? (on ? [it.key] : it.versions.map(v => 'm:' + v.id)) : [it.key];
  for (const k of keys) { await api.post('/api/mylist', { key: k, on }); on ? S.mylist.add(k) : S.mylist.delete(k); }
  if (it.online && on) S.online.set(it.key, it);
  if (btn) { btn.classList.toggle('on', on); btn.innerHTML = icon(on ? 'check' : 'plus'); btn.title = T(on ? 'Listemden çıkar' : 'Listeme ekle'); }
  toast(on ? `${icon('check')} ${T('<b>{t}</b> listene eklendi', { t: esc(it.t) })}` : T('<b>{t}</b> listenden çıkarıldı', { t: esc(it.t) }));
  if (S.view === 'list' || S.view === 'home') softRender();
}

/* ================================================================ search */
function openSearch() {
  const el = $('#search');
  if (el.classList.contains('open')) return $('#search-input').focus();
  el.classList.add('open');
  pushOverlay('search', () => el.classList.remove('open'));
  const inp = $('#search-input');
  inp.value = '';
  runSearch('');
  setTimeout(() => inp.focus(), 30);
}
function runSearch(q) {
  const box = $('#search-results');
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) {
    box.innerHTML = `<div class="search-hint">${T('Türlere göz atın')}</div><div class="chips">${S.genres.slice(0, 24).map(({ g, n }) => `<button class="chip" data-goto="#movies/${encodeURIComponent(g)}">${esc(tx(g))} <span style="color:var(--dim);margin-left:4px">${n}</span></button>`).join('')}</div>
      ${S.cols.length ? `<div class="search-hint">${T('Koleksiyonlar')}</div><div class="grid cols" style="padding-top:0">${S.cols.slice(0, 6).map(collectionCard).join('')}</div>` : ''}`;
    return;
  }
  const score = it => {
    const t = fold(it.t), ot = fold(it.ot);
    let s = 0;
    for (const w of terms) {
      if (!it.search.includes(w)) return 0;
      s += t.startsWith(w) ? 6 : t.includes(w) ? 4 : ot.includes(w) ? 3 : 1;
    }
    return s + (parseFloat(it.r) || 0) / 10;
  };
  const hits = [...S.titles, ...S.series].map(it => [it, score(it)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const cols = S.cols.filter(c => terms.every(w => fold(c.name).includes(w)));
  box.innerHTML = `<div class="search-hint">${hits.length ? T('Kütüphanede {n} sonuç', { n: hits.length }) : T('Kütüphanede sonuç yok')}</div>
    ${cols.length ? `<div class="grid cols" style="padding-bottom:20px">${cols.map(collectionCard).join('')}</div>` : ''}
    ${hits.length ? `<div class="grid">${hits.slice(0, 120).map(it => posterCard(it, { caption: true })).join('')}</div>` : ''}
    <div id="online-hits"></div>`;
  searchOnline(q);
}

/* ================================================================ settings */
// A full-screen page: categories on the left, the chosen one on a large panel on the right. Every row is a button,
// so the remote goes up and down a column, right into the panel and left back to the categories. Moving over a
// category already shows it, like flipping through channels.
const ST = { cat: 'library', s: null, bd: '' };
function stCats() {
  return [
    ['library', 'stack', 'Kütüphane', 'Klasörler, tarama ve eksik film bilgileri.'],
    ['subs', 'cc', 'Altyazı', 'Altyazının görünüşü ve kendiliğinden açılması.'],
    ['random', 'shuffle', 'Rastgele film', 'Rastgele film düğmesinin hangi filmlerden seçeceği.'],
    ST.s.local && ['downloads', 'download', 'İndirmeler', 'Kütüphane dosyaları indirilirken ağın ne kadarının kullanılacağı.'],
    ST.s.local && ['clients', 'monitor', 'Bağlı cihazlar', 'Bu sunucuyu kullanan cihazlar, adları ve şu an indirdikleri.'],
    ['devices', 'wifi', 'Diğer cihazlar', 'Telefon, tablet ve TV’den Lumbuz’a bağlanın.'],
    ['lang', 'lang', 'Dil · Language', 'Menülerin ve düğmelerin dili.'],
    ['keys', 'keyboard', 'Klavye kısayolları', 'Bilgisayarda klavyeyle hızlı kullanım.'],
    ['about', 'info', 'Hakkında', 'Lumbuz ve bilgilerin geldiği yerler.'],
  ].filter(Boolean);
}
async function openSettings() {
  const el = $('#settings');
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    pushOverlay('settings', () => { el.classList.remove('open'); ST.s = null; });
  }
  const page = $('#settings-sheet');
  page.innerHTML = `<div class="st-wait"><div class="spin"></div></div>`;
  try { ST.s = await api.get('/api/settings'); } catch { page.innerHTML = emptyState('Sunucuya ulaşılamıyor', 'Lumbuz sunucusunun çalıştığından emin olun ve sayfayı yenileyin.'); return; }
  const withBd = S.titles.filter(t => t.bd);
  const pick = withBd[Math.floor(Math.random() * withBd.length)];
  ST.bd = pick ? img('m', pick.bdId, 'backdrop', 1280) : '';
  if (!stCats().some(c => c[0] === ST.cat)) ST.cat = 'library';
  page.innerHTML = `
    <aside class="st-side">
      <div class="st-top"><h2>${T('Ayarlar')}</h2><button class="icon-btn st-close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button></div>
      <nav class="st-nav" role="tablist" aria-label="${T('Ayarlar')}">${stCats().map(([k, ic, label]) =>
        `<button class="st-cat${k === ST.cat ? ' on' : ''}" data-st-cat="${k}" role="tab" aria-selected="${k === ST.cat}">${icon(ic)}<span>${T(label)}</span></button>`).join('')}</nav>
    </aside>
    <section class="st-panel" id="st-panel" role="tabpanel"></section>`;
  renderStPanel();
  stFocus($('.st-cat.on'));
}
function stShow(cat) {
  if (cat === ST.cat || !ST.s) return;
  ST.cat = cat;
  $$('.st-cat').forEach(b => { const on = b.dataset.stCat === cat; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  renderStPanel();
}
function renderStPanel(refocus) {
  const box = $('#st-panel');
  if (!box) return;
  const [k, ic, label, desc] = stCats().find(c => c[0] === ST.cat);
  box.innerHTML = `${ST.bd ? `<div class="st-art" style="background-image:linear-gradient(180deg, rgba(20,20,28,.35), #14141c 96%), url('${ST.bd}')"></div>` : ''}
    <header class="st-ph"><div class="st-ico">${icon(ic)}</div><h3>${T(label)}</h3><p>${T(desc)}</p></header>
    <div class="st-body">${ST.browse && k === 'library' ? stBrowse() : ST_PANELS[k](ST.s)}</div>`;
  box.scrollTop = 0;
  if (refocus) stFocus(box.querySelector(refocus));
}

// Building blocks of a panel: a row is a button (an icon, a title with an optional line under it, and a value,
// switch or arrow at the end); a tile is a small label over a large value.
const stRow = ({ ic = '', title, sub = '', value = '', end = '', attrs = '', on = false }) =>
  `<button class="st-row${on ? ' on' : ''}" ${attrs}>${ic ? `<span class="st-ri">${icon(ic)}</span>` : ''}<span class="st-rt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${value !== '' ? `<span class="st-rv">${value}</span>` : ''}${end}</button>`;
const stSwitch = (attrs, on, title, sub, ic) => stRow({ ic, title, sub, on, attrs: `${attrs} role="switch" aria-checked="${on}"`, end: '<span class="st-sw" aria-hidden="true"></span>' });
const stCycle = (attrs, title, value, ic, sub) => stRow({ ic, title, sub, value, attrs, end: icon('updown', 'st-end') });
const stTile = (label, value, id = '') => `<div class="st-tile"><small>${label}</small><b${id ? ` id="${id}"` : ''}>${value}</b></div>`;
const stGroup = label => `<h4 class="st-gl">${label}</h4>`;
const stHint = text => `<p class="st-hint">${text}</p>`;

// Library folders, picked like in Plex: "Add folder" opens a folder browser in the panel; the folder chosen there is
// saved to the list and scanned straight away. A row in the list takes its folder out of the library.
const DIR_LABELS = { movie: ['Film klasörleri', 'Bu klasörü film klasörü olarak ekle'], series: ['Dizi klasörleri', 'Bu klasörü dizi klasörü olarak ekle'],
  music: ['Müzik klibi klasörleri', 'Bu klasörü müzik klibi klasörü olarak ekle'] };
const stDirs = (s, kind) => `${stGroup(T(DIR_LABELS[kind][0]))}
  ${s[`${kind}_dirs`].map((d, i) => stRow({ ic: 'folder', title: `<span class="st-mono">${esc(d)}</span>`, attrs: `data-dir-rm="${kind}:${i}" aria-label="${T('Kaldır')}: ${esc(d)}"`, end: icon('x', 'st-end') })).join('')}
  ${stRow({ ic: 'plus', title: T('Klasör ekle'), sub: s[`${kind}_dirs`].length ? '' : T('Henüz klasör eklenmedi.'), attrs: `data-dir-add="${kind}"`, end: icon('right', 'st-end') })}`;
function stBrowse() {
  const b = ST.browse;
  return `${stGroup(b.path ? `<span class="st-mono">${esc(b.path)}</span>` : T('Bir disk veya klasör seçin'))}
    ${b.path ? stRow({ ic: 'check', title: T(DIR_LABELS[b.kind][1]), attrs: 'data-dir-pick' }) : ''}
    ${b.path ? stRow({ ic: 'back', title: T('Üst klasör'), attrs: `data-dir-go="${esc(b.parent || '')}"` }) : ''}
    ${b.dirs.map(d => stRow({ ic: 'folder', title: esc(d.name), attrs: `data-dir-go="${esc(d.path)}"`, end: icon('right', 'st-end') })).join('')}
    ${b.dirs.length ? '' : stHint(T('Bu klasörde alt klasör yok.'))}
    ${stRow({ ic: 'x', title: T('Vazgeç'), attrs: 'data-action="back"' })}`;
}
async function dirGo(path) {
  let r;
  try { r = await api.get(`/api/browse?path=${encodeURIComponent(path)}`); } catch { return toast(T('Bu klasör açılamadı')); }
  if (!ST.browse) return;
  Object.assign(ST.browse, r);
  renderStPanel('#st-panel .st-row');
}
function dirAdd(kind) {
  ST.browse = { kind, path: '', parent: '', dirs: [] };
  pushOverlay('browse', () => { ST.browse = null; if (ST.s) renderStPanel(`[data-dir-add="${kind}"]`); });
  return dirGo('');
}
async function saveDirs(kind, dirs) {
  try {
    ST.s = await api.post('/api/settings', { [`${kind}_dirs`]: dirs });
    await api.post('/api/scan');
  } catch { toast(T('Kaydedilemedi')); return false; }
  pollStatus(true);
  return true;
}
async function dirPick() {
  const { kind, path } = ST.browse;
  if (!await saveDirs(kind, [...ST.s[`${kind}_dirs`], path])) return;
  toast(T('Klasör eklendi, tarama başladı'));
  back();
}
async function dirRemove(v) {
  const [kind, i] = v.split(':'), dirs = ST.s[`${kind}_dirs`];
  if (!confirm(T('{d} kütüphaneden çıkarılsın mı? Diskteki dosyalar silinmez.', { d: dirs[+i] }))) return;
  if (!await saveDirs(kind, dirs.filter((_, j) => j !== +i))) return;
  toast(T('Klasör çıkarıldı'));
  renderStPanel(`[data-dir-add="${kind}"]`);
}

const SUB_SIZES = [['s', 'Küçük'], ['m', 'Orta'], ['l', 'Büyük']];
const ST_PANELS = {
  library: s => `
    <div class="st-tiles four">${stTile(T2('Film', 'Movies'), s.stats.movies)}${stTile(T2('Dizi', 'Series'), s.stats.series)}${stTile(T2('Bölüm', 'Episodes'), s.stats.episodes)}${stTile(T2('Koleksiyon', 'Collections'), S.cols.length)}</div>
    ${s.local ? `${stDirs(s, 'movie')}${stDirs(s, 'series')}${stDirs(s, 'music')}
      ${stGroup(T('OMDb'))}
      <label class="st-field"><small>${T('OMDb API anahtarı')}</small><input id="conf-key" value="${esc(s.omdb_api_key)}" spellcheck="false"></label>
      ${stRow({ ic: 'check', title: T('Kaydet ve Tara'), sub: T('Anahtarı kaydeder ve kütüphaneyi baştan tarar.'), attrs: 'data-action="save-settings"', end: icon('right', 'st-end') })}` : ''}
    ${stGroup(T('Tarama'))}
    ${stRow({ ic: 'refresh', title: T('Yeniden Tara'), sub: T('Diskteki yeni ve silinen dosyaları bulur.'), attrs: 'data-action="rescan"', end: icon('right', 'st-end') })}
    ${stRow({ ic: 'search', title: T('Eksik Bilgileri Tekrar Ara'), sub: T('Bilgisi veya afişi bulunamayan içerikleri yeniden arar.'), attrs: 'data-action="enrich"', end: icon('right', 'st-end') })}`,

  subs: () => {
    const size = store.get('subSize', 'm'), boxed = store.get('subBox', false), auto = !store.get('subsOff', false);
    return `
    <div class="st-subprev size-${size}${boxed ? ' boxed' : ''}"${ST.bd ? ` style="background-image:linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,.1)), url('${ST.bd}')"` : ''}><span>${T('Altyazılar böyle görünecek.')}</span></div>
    ${stGroup(T('Görünüm'))}
    ${stCycle('data-st="sub-size"', T('Boyut'), T(SUB_SIZES.find(x => x[0] === size)[1]), 'type')}
    ${stSwitch('data-st="sub-box"', boxed, T('Arka plan'), T('Yazının arkasını koyulaştırır, açık sahnelerde okumayı kolaylaştırır.'), 'cc')}
    ${stGroup(T('Seçim'))}
    ${stSwitch('data-st="sub-auto"', auto, T('Türkçe altyazıyı kendiliğinden aç'), T('Video Türkçe konuşmuyorsa önce dosyadaki, yoksa internetteki Türkçe altyazı açılır.'), 'globe')}
    ${stSwitch('data-st="sub-align"', store.get('subAlign', true), T('Altyazıyı sese göre hizala'), T('İnternetten gelen ya da yüklenen altyazı filmin sesiyle karşılaştırılır ve kayıksa kendiliğinden düzeltilir.'), 'cc')}
    ${stHint(T('Oynatıcıda altyazıyı kapatırsanız bu ayar da kapanır. Altyazı ayarları yalnızca bu cihazda geçerlidir.'))}`;
  },

  random: () => {
    const { genres, min } = randPrefs();
    const chip = (attr, on, label) => `<button class="chip${on ? ' on' : ''}" ${attr} aria-pressed="${on}">${label}</button>`;
    return `
    <div class="st-tiles one">${stTile(T('Uyan film'), T('{n} film', { n: randPool().length }), 'rand-count')}</div>
    ${stCycle('data-st="rand-min"', T('En düşük puan'), T(RAND_MIN.find(x => x[0] === min)?.[1] || 'Hepsi'), 'star')}
    ${stGroup(T('Türler'))}
    <div class="chips wrap st-chips" role="group" aria-label="${T('Türler')}">
      ${chip('data-rand="genre" data-v=""', !genres.length, T('Tümü'))}${movieGenres().map(([g, n]) => chip(`data-rand="genre" data-v="${esc(g)}"`, genres.includes(g), `${esc(tx(g))} <span class="n">${n}</span>`)).join('')}
    </div>
    ${stHint(T('Birden fazla tür seçerseniz bunlardan herhangi birine uyan filmler gelir. Bu seçimler yalnızca bu cihazda geçerlidir.'))}`;
  },

  downloads: s => `
    ${stCycle('data-st="dl-limit"', T('Hız sınırı'), T('{v} Mbit/sn', { v: s.download_mbps }), 'gauge', T('Bütün indirmeler birlikte'))}
    ${stCycle('data-st="dl-per"', T('Aynı anda'), T('Cihaz başına {n} dosya', { n: s.download_per_device }), 'stack', T('Bir cihazın aynı anda indirebileceği dosya sayısı'))}
    <div class="st-tiles one">${stTile(T('Televizyonlar'), T('İndirme düğmesi gizli'))}</div>
    ${stHint(T('Bütün indirmeler birlikte bu hızı geçmez. Bir cihaz aynı anda en fazla bu kadar dosya indirebilir; sayı artınca her indirme hızın daha küçük bir payını alır.'))}`,

  clients: () => {
    CL_DEV.edit = '';
    setTimeout(loadClients, 0);
    return `<div id="st-clients">${CL_DEV.list ? clientsHtml() : '<div class="st-wait"><div class="spin"></div></div>'}</div>`;
  },

  devices: s => {
    const urls = s.urls.length ? s.urls : [location.origin];
    setTimeout(() => drawQR(urls[0]), 0);
    return `
    <div class="st-qr-box"><div class="st-qr" id="st-qr" aria-label="${T('QR kod')}: ${esc(urls[0])}"></div>
      <div class="st-qr-text"><b>${T('Telefonun kamerasıyla okutun')}</b><small>${T('Lumbuz açılır. Sonra tarayıcıda “Ana ekrana ekle” derseniz uygulama gibi kalır.')}</small>
        <span class="st-mono">${esc(urls[0])}</span></div></div>
    ${stGroup(T('Bu adreslerden biri'))}
    ${urls.map(u => stRow({ ic: 'globe', title: `<span class="st-mono">${esc(u)}</span>`, attrs: `data-copy="${esc(u)}" aria-label="${T('Kopyala')}: ${esc(u)}"`, end: icon('copy', 'st-end') })).join('')}
    ${stHint(T('Telefon, tablet veya TV tarayıcısından bu adrese girin. Aynı Wi-Fi ağında olmanız yeterli. Lumbuz TV uygulaması sunucuyu ağda kendisi bulur.'))}`;
  },

  lang: () => `
    ${LANGS.map(([v, l]) => stRow({ ic: 'lang', title: l, on: LANG === v, attrs: `data-lang="${v}" role="radio" aria-checked="${LANG === v}"`, end: LANG === v ? icon('check', 'st-end') : '' })).join('')}
    ${stHint(T('Menüler ve düğmeler bu dilde görünür. Film adları ve özetleri TMDb’den geldiği gibi kalır.'))}`,

  keys: () => `<div class="st-tiles keys2">${[['/', 'Ara'], [T('Boşluk'), 'Oynat / Duraklat'], ['← →', '10 sn geri / ileri'], ['↑ ↓', 'Ses'],
    ['F', 'Tam ekran'], ['M', 'Sessiz'], ['C', 'Ses ve altyazı'], ['N', 'Sonraki bölüm'], ['Esc', 'Geri']]
    .map(([k, l]) => `<div class="st-tile st-key"><kbd>${k}</kbd><span>${l === 'Ses' ? T2('Ses', 'Volume') : T(l)}</span></div>`).join('')}</div>`,

  about: () => `
    <div class="st-tiles">${stTile(T('Uygulama'), 'Lumbuz')}${stTile(T('Lisans'), 'GPL-3.0')}${stTile(T('Film bilgileri'), 'TMDb · Emby · OMDb')}${stTile(T('Bu sunucu'), `<span class="st-mono">${esc(location.host)}</span>`)}</div>
    <div class="st-tiles">${stTile(T('Sürüm'), `<span class="st-mono">${esc(ST.s.version || '')}</span>`)}${stTile(T('Depo'), `<span class="st-mono">kaptanoguz/Lumbuz</span>`)}</div>
    ${stHint(T("Lumbuz · Film bilgileri TMDb, Emby ve OMDb'den alınır."))}`,
};

// Rows with data-st change a per-device setting (or the server's download limit) and redraw the panel in place.
async function stAction(a) {
  if (a === 'sub-size') {
    const i = SUB_SIZES.findIndex(x => x[0] === store.get('subSize', 'm'));
    store.set('subSize', SUB_SIZES[(i + 1) % SUB_SIZES.length][0]);
    applySubStyle();
  } else if (a === 'sub-box') { store.set('subBox', !store.get('subBox', false)); applySubStyle(); }
  else if (a === 'sub-auto') store.set('subsOff', !store.get('subsOff', false));
  else if (a === 'sub-align') store.set('subAlign', !store.get('subAlign', true));
  else if (a === 'rand-min') {
    const i = RAND_MIN.findIndex(x => x[0] === randPrefs().min);
    store.set('randMin', RAND_MIN[(i + 1) % RAND_MIN.length][0]);
  } else if (a === 'dl-limit') {
    const v = DL_LIMITS[(DL_LIMITS.indexOf(ST.s.download_mbps) + 1) % DL_LIMITS.length];
    if (!await setDownloadLimit(v)) return;
  } else if (a === 'dl-per') {
    const v = DL_PER[(DL_PER.indexOf(ST.s.download_per_device) + 1) % DL_PER.length];
    try { await api.post('/api/settings', { download_per_device: v }); } catch { toast(T('Kaydedilemedi')); return; }
    ST.s.download_per_device = v;
    toast(T('Cihaz başına aynı anda {n} indirme', { n: v }));
  }
  renderStPanel(`[data-st="${a}"]`);
}

// Remote and arrow keys inside settings. Captured before the TV's own navigation, which would pick the nearest box on
// the whole screen and could jump from the panel to a category in the middle of the list.
function stFocus(el) {
  if (!el) return;
  $$('#settings .hf-focus').forEach(x => x.classList.remove('hf-focus'));
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  try { el.scrollIntoView({ block: 'nearest' }); } catch {}
}
function stNearest(from, list, dir) {
  const r = from.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const vertical = dir === 'ArrowUp' || dir === 'ArrowDown';
  let best = null, bs = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const q = el.getBoundingClientRect();
    if (!q.width) continue;
    const dx = q.left + q.width / 2 - cx, dy = q.top + q.height / 2 - cy;
    const prim = { ArrowDown: dy, ArrowUp: -dy, ArrowRight: dx, ArrowLeft: -dx }[dir];
    const sec = vertical ? Math.abs(dx) : Math.abs(dy);
    if (prim <= 4 || (!vertical && sec > Math.max(r.height, q.height) * 0.8)) continue;
    const score = prim + sec * 2;
    if (score < bs) { bs = score; best = el; }
  }
  return best;
}
window.addEventListener('keydown', e => {
  if (!$('#settings').classList.contains('open') || P.open) return;
  document.documentElement.classList.add('kb');
  const k = e.key, a = document.activeElement;
  const enter = k === 'Enter' || e.keyCode === 23;
  if (!/^Arrow/.test(k) && !enter) return;
  const typing = a && a.tagName === 'INPUT';
  if (typing && (enter || k === 'ArrowLeft' || k === 'ArrowRight')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const inSide = a && a.closest && a.closest('.st-nav');
  const panelItems = () => $$('#st-panel button, #st-panel input');
  if (enter) { if (a && a.closest && a.closest('#settings') && !e.repeat) a.click(); return; }
  if (!inSide && !(a && a.closest && a.closest('#st-panel'))) return stFocus($('.st-cat.on'));
  if (inSide) {
    if (k === 'ArrowRight') return stFocus(panelItems()[0]);
    if (k === 'ArrowLeft') return;
    const cats = $$('.st-cat'), i = cats.indexOf(a);
    const next = cats[i + (k === 'ArrowDown' ? 1 : -1)];
    if (next) { stShow(next.dataset.stCat); stFocus(next); }
    return;
  }
  const next = stNearest(a, panelItems(), k);
  if (next) return stFocus(next);
  if (k === 'ArrowLeft') return stFocus($('.st-cat.on'));
  if (k === 'ArrowUp') $('#st-panel').scrollTop = 0;
}, true);
// The white pill highlight (tabs, settings) follows the remote and keyboard; with a mouse or finger, hover is enough.
// It works on old TV browsers too, which do not know :focus-visible.
window.addEventListener('keydown', () => document.documentElement.classList.add('kb'), true);
window.addEventListener('pointerdown', () => document.documentElement.classList.remove('kb'), true);

// Interface language, kept per device like the random movie filters. The page reloads to redraw everything in it.
const LANGS = [['tr', 'Türkçe'], ['en', 'English']];
function setLang(v) {
  if (v === LANG) return;
  store.set('lang', v);
  location.reload();
}

// Speed limit shared by all downloads together, so people watching are never slowed down. Set from this computer only.
const DL_LIMITS = [10, 20, 40, 80, 200];
const DL_PER = [1, 2, 3, 5];

// Settings › Connected devices (server computer only): every device that used Lumbuz lately, by its viewer cookie.
// A device can be given a name; without one it is named after its browser ("Android phone", "LG TV"...). The list
// refreshes every few seconds while it is open, so downloads move along.
const CL_DEV = { list: null, edit: '', timer: 0 };
function guessDevice(ua) {
  const u = ua || '';
  if (/Web0S|webOS|NetCast/i.test(u)) return ['LG TV', 'tv'];
  if (/Tizen|SmartTV|SMART-TV/i.test(u)) return ['Akıllı TV', 'tv'];
  if (/HomeflixTV|Android TV|AFT|BRAVIA|GoogleTV/i.test(u)) return ['Android TV', 'tv'];
  if (/iPad/i.test(u)) return ['iPad', 'phone'];
  if (/iPhone/i.test(u)) return ['iPhone', 'phone'];
  if (/Android/i.test(u)) return [/Mobile/i.test(u) ? 'Android telefon' : 'Android tablet', 'phone'];
  if (/Windows/i.test(u)) return ['Windows bilgisayar', 'monitor'];
  if (/Macintosh|Mac OS X/i.test(u)) return ['Mac', 'monitor'];
  if (/Linux|CrOS/i.test(u)) return ['Linux bilgisayar', 'monitor'];
  return ['Bilinmeyen cihaz', 'monitor'];
}
function agoText(sec) {
  if (sec < 300) return T('Şu an bağlı');
  if (sec < 3600) return T('{n} dk önce', { n: Math.floor(sec / 60) });
  if (sec < 86400) return T('{n} sa önce', { n: Math.floor(sec / 3600) });
  return T('{n} gün önce', { n: Math.floor(sec / 86400) });
}
const devName = d => d.name ? esc(d.name) : T(guessDevice(d.ua)[0]);
const dlLine = x => `${esc(x.name)} · %${x.size ? Math.floor(x.sent / x.size * 100) : 0}${x.size ? ' / ' + fmtSize(x.size) : ''}`;
function clientsHtml() {
  const list = CL_DEV.list || [];
  const online = list.filter(d => d.ago < 300).length, dls = list.flatMap(d => d.downloads.map(x => [d, x]));
  const ed = CL_DEV.edit && list.find(d => d.id === CL_DEV.edit);
  if (ed) {
    const [guess, ic] = guessDevice(ed.ua);
    return `${stGroup(T('Cihaza ad verin'))}
      <label class="st-field"><small>${T(guess)}${ed.ip ? ' · ' + esc(ed.ip) : ''}</small><input id="dev-name" value="${esc(ed.name)}" maxlength="40" placeholder="${T('Örn. Kamara 12 laptop')}" spellcheck="false"></label>
      ${stRow({ ic: 'check', title: T('Kaydet'), attrs: 'data-dev-save' })}
      ${stRow({ ic: 'x', title: T('Vazgeç'), attrs: 'data-dev-cancel' })}
      ${stRow({ ic, title: T('Bu cihazı listeden kaldır'), sub: T('Lumbuz’u tekrar açarsa listeye geri gelir.'), attrs: 'data-dev-forget' })}
      ${stHint(T('Adı boş bırakırsanız tarayıcısından tahmin edilen ad kullanılır.'))}`;
  }
  return `<div class="st-tiles">${stTile(T('Şu an bağlı'), online)}${stTile(T('İndiren'), new Set(dls.map(([d]) => d.id)).size)}</div>
    ${dls.length ? `${stGroup(T('Şu an indirenler'))}${dls.map(([d, x]) => stRow({ ic: 'download', title: devName(d), sub: dlLine(x), attrs: `data-dev="${esc(d.id)}"`, end: icon('right', 'st-end') })).join('')}` : ''}
    ${stGroup(T('Cihazlar'))}
    ${list.length ? list.map(d => {
      const sub = [agoText(d.ago), d.ip && esc(d.ip), d.downloads.length && T('{n} indirme', { n: d.downloads.length })].filter(Boolean).join(' · ');
      return stRow({ ic: guessDevice(d.ua)[1], title: devName(d), sub, on: d.ago < 300, attrs: `data-dev="${esc(d.id)}" aria-label="${T('Ad ver')}: ${devName(d)}"`, end: icon('right', 'st-end') });
    }).join('') : stHint(T('Henüz başka bir cihaz bağlanmadı.'))}
    ${stHint(T('Bir cihaza dokunup ad verebilirsiniz. Adlar yalnızca bu bilgisayarda görünür. Bir cihazın tarayıcı verileri silinirse yeni bir cihaz olarak görünür.'))}`;
}
async function loadClients() {
  clearTimeout(CL_DEV.timer);
  const box = $('#st-clients');
  if (!box) return;
  try { CL_DEV.list = (await api.get('/api/devices')).devices; } catch { CL_DEV.list = CL_DEV.list || []; }
  if (!$('#st-clients') || ST.cat !== 'clients') return;
  if (!CL_DEV.edit) {
    const a = document.activeElement, key = a?.dataset?.dev;
    $('#st-clients').innerHTML = clientsHtml();
    if (key) stFocus($(`#st-clients [data-dev="${CSS.escape(key)}"]`));
  }
  CL_DEV.timer = setTimeout(loadClients, 5000);
}
function devEdit(id) {
  CL_DEV.edit = id;
  $('#st-clients').innerHTML = clientsHtml();
  const inp = $('#dev-name');
  if (!inp) return;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') devSave(); else if (e.key === 'Escape') { e.stopPropagation(); devDone(); } });
  stFocus(inp);
}
function devDone(focusId) {
  const id = focusId || CL_DEV.edit;
  CL_DEV.edit = '';
  $('#st-clients').innerHTML = clientsHtml();
  stFocus($(`#st-clients [data-dev="${CSS.escape(id)}"]`) || $('#st-clients button'));
}
async function devSave() {
  const id = CL_DEV.edit, name = $('#dev-name').value.trim();
  try { await api.post(`/api/devices/${encodeURIComponent(id)}`, { name }); } catch { return toast(T('Kaydedilemedi')); }
  const d = CL_DEV.list.find(x => x.id === id);
  if (d) d.name = name;
  devDone(id);
}
async function devForget() {
  const id = CL_DEV.edit;
  try { await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { return toast(T('Kaydedilemedi')); }
  CL_DEV.list = CL_DEV.list.filter(x => x.id !== id);
  CL_DEV.edit = '';
  $('#st-clients').innerHTML = clientsHtml();
  stFocus($('#st-clients button'));
}
async function setDownloadLimit(v) {
  try { await api.post('/api/settings', { download_mbps: v }); } catch { toast(T('Kaydedilemedi')); return false; }
  ST.s.download_mbps = v;
  toast(T('İndirme sınırı {v} Mbit/sn', { v }));
  return true;
}

// Random movie filters are kept per device, like volume and subtitle style. Several genres match any of them.
const RAND_MIN = [[0, 'Hepsi'], [6, '6+'], [7, '7+'], [8, '8+']];
function movieGenres() {
  const count = new Map();
  S.titles.forEach(t => genresOf(t).forEach(g => count.set(g, (count.get(g) || 0) + 1)));
  return [...count.entries()].sort((a, b) => b[1] - a[1]);
}
function randPrefs() {
  const known = new Set(S.titles.flatMap(genresOf));
  return { genres: store.get('randGenres', []).filter(g => known.has(g)), min: store.get('randMin', 6) };
}
function randPool() {
  const { genres, min } = randPrefs();
  return S.titles.filter(t => (!genres.length || genresOf(t).some(g => genres.includes(g))) && (!min || parseFloat(t.r) >= min));
}
function randAction(el) {
  const { genres } = randPrefs();
  const v = el.dataset.v;
  if (el.dataset.rand === 'genre') store.set('randGenres', !v ? [] : genres.includes(v) ? genres.filter(g => g !== v) : [...genres, v]);
  else store.set('randMin', +v);
  // Toggle in place so the remote's focus stays on the chip that was pressed.
  const now = randPrefs();
  $$('[data-rand]').forEach(b => {
    const on = b.dataset.rand === 'min' ? +b.dataset.v === now.min : b.dataset.v ? now.genres.includes(b.dataset.v) : !now.genres.length;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  $('#rand-count').textContent = T('{n} film', { n: randPool().length });
}

async function settingsAction(a) {
  if (a === 'save-settings') {
    await api.post('/api/settings', { omdb_api_key: $('#conf-key').value });
    await api.post('/api/scan');
    toast(T('Ayarlar kaydedildi, tarama başladı'));
  } else if (a === 'rescan') { await api.post('/api/rescan'); toast(T('Diskteki dosyalar taranıyor…')); }
  else if (a === 'enrich') { await api.post('/api/enrich'); toast(T('Eksik bilgiler yeniden aranıyor')); }
  pollStatus(true);
}

/* ================================================================ status polling */
let pollTimer = null, wasBusy = false;
async function pollStatus(now) {
  clearTimeout(pollTimer);
  if (now || !document.hidden) {
    try {
      const st = await api.get('/api/status');
      $('#status').classList.toggle('on', st.busy);
      $('#status-text').textContent = st.tasks.map(tx).join(' · ');
      if ((st.version !== S.version && !st.busy) || (wasBusy && !st.busy)) await refresh();
      else if (st.version !== S.version) await Promise.all([loadLibrary(), loadUser()]);
      wasBusy = st.busy;
    } catch {}
  }
  pollTimer = setTimeout(pollStatus, wasBusy ? 4000 : 30000);
}
async function refresh() {
  await Promise.all([loadLibrary(), loadUser(), CL.items ? loadClips() : null]);
  if (!P.open) softRender();
}

/* ================================================================ player */
const P = {
  open: false, kind: '', id: 0, info: null, mode: 'direct', offset: 0, audio: 0, subs: null, subDelay: 0, subIdx: -1,
  hideT: 0, lastSave: 0, raf: 0, next: null, upnextT: 0, upnextDismissed: false, speed: 1, fsFallback: false,
  seekTarget: null, lastSubHTML: '', retries: 0, loadSeq: 0, pauseT: 0, openAfter: null,
};
const V = () => $('#video');
// Apple's WebKit (every iOS browser, desktop Safari) can't play the progressive transcode stream: it gets HLS instead.
const UA = navigator.userAgent;
const APPLE = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  (/Safari/.test(UA) && !/Chrome|Chromium|Android|Edg|OPR|Firefox/.test(UA));
const HLS_CLIENT = Math.random().toString(36).slice(2) + Date.now().toString(36);
// LG webOS can't take the progressive stream (unknown length, chunked): it plays the segmented HLS instead, like Apple.
// Some webOS 4.x browsers only say "NetCast" in their user agent.
const WEBOS = /Web0S|webOS|NetCast/i.test(UA);
const streamMode = () => APPLE || WEBOS ? 'hls' : 'stream';

function pTime() { const v = V(); return P.mode !== 'direct' ? P.offset + (v.currentTime || 0) : (v.currentTime || 0); }
function pDur() { const v = V(); return P.mode === 'direct' && isFinite(v.duration) && v.duration > 0 ? v.duration : (P.info?.duration || 0); }

async function play(kind, id, opts = {}) {
  const pl = $('#player');
  if (!P.open) {
    P.open = true;
    pl.classList.add('open', 'ui', 'loading');
    pushOverlay('player', closePlayerNow);
    document.body.classList.add('locked');
  } else {
    savePosition(true);
    pl.classList.add('loading');
  }
  Object.assign(P, { kind, id, info: null, subs: null, subIdx: -1, audio: 0, next: null, upnextDismissed: false, lastSubHTML: '', retries: 0, openAfter: null });
  hidePauseInfo();
  $('#p-subs').innerHTML = '';
  $('#upnext').classList.remove('open');
  $('#p-panel').classList.remove('open');
  $('#p-title').textContent = opts.title || '';
  $('#p-sub').textContent = '';
  let info;
  try { info = await api.get(`/api/media/${kind}/${id}`); } catch { toast(T('Video dosyası bulunamadı. Disk bağlı mı?')); return back(); }
  if (P.kind !== kind || P.id !== id) return;
  P.info = info;
  P.next = kind === 'v' ? clipNext() : info.next || null;
  $('#p-title').textContent = info.title;
  $('#p-sub').textContent = kind === 'v' ? (CL.byId.get(id)?.a || info.sub || '') : tx(info.sub || '');
  $('#p-next').hidden = !P.next;
  $('#p-next').title = T(kind === 'v' ? 'Sonraki klip (N)' : 'Sonraki bölüm (N)');
  loadCredits(playingItem());
  document.title = `${info.title} · Lumbuz`;
  const start = opts.from !== undefined ? +opts.from : (info.resume > 30 ? info.resume : 0);
  P.mode = info.direct ? 'direct' : streamMode();
  loadSource(start);
  if (start > 30) toast(T('Kaldığın yerden devam ediliyor · {time}', { time: fmtTime(start) }));
  autoSubtitles();
  mediaSession();
  showUI();
  cancelAnimationFrame(P.raf);
  P.raf = requestAnimationFrame(tick);
}

function loadSource(t) {
  const v = V();
  const pl = $('#player');
  pl.classList.add('loading');
  t = Math.max(0, t || 0);
  const base = `/play/${P.kind}/${P.id}`;
  const seq = ++P.loadSeq;
  if (P.mode === 'hls') {
    P.offset = t;
    api.get(`/api/hls/${P.kind}/${P.id}?a=${P.audio}&t=${t.toFixed(3)}&c=${HLS_CLIENT}`).then(r => {
      if (seq !== P.loadSeq || !P.open) return;
      if (typeof r.start === 'number') P.offset = r.start;
      v.src = r.url;
      P.hlsUrl = r.url;
      v.playbackRate = P.speed;
      v.play().catch(() => {});
    }).catch(() => { if (seq === P.loadSeq && P.open) playbackFailed(t, 'hls-start'); });
    return;
  }
  if (P.mode === 'stream') {
    P.offset = t;
    if (!t) { v.src = `${base}?mode=stream&a=${P.audio}`; v.playbackRate = P.speed; v.play().catch(() => {}); return; }
    // A copied stream starts on a keyframe near t, not at t, so ask the server where exactly and use that as the
    // clock's offset; otherwise subtitles are seconds off after every resume or long jump.
    const go = s => {
      if (seq !== P.loadSeq || !P.open) return;
      P.offset = s;
      v.src = `${base}?mode=stream&a=${P.audio}&t=${t.toFixed(3)}`;
      v.playbackRate = P.speed;
      v.play().catch(() => {});
    };
    api.get(`/api/seek/${P.kind}/${P.id}?t=${t.toFixed(3)}`).then(r => go(typeof r.start === 'number' ? r.start : t), () => go(t));
    return;
  } else {
    P.offset = 0;
    v.src = base;
    if (t) v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
  }
  v.playbackRate = P.speed;
  v.play().catch(() => {});
}

// Reports the failure to the server log, then falls back from direct play or retries the stream a few times
// (Wi-Fi hiccups) before telling the user.
function playbackFailed(t, code) {
  api.post('/api/client_error', { item: `${P.kind}:${P.id}`, mode: P.mode, code, t, retry: P.retries }).catch(() => {});
  if (P.mode === 'direct') { P.mode = streamMode(); return loadSource(t); }
  if (P.retries < 3) {
    const seq = P.loadSeq;
    P.retries++;
    return setTimeout(() => { if (P.open && seq === P.loadSeq) loadSource(t); }, 700 * P.retries);
  }
  $('#player').classList.remove('loading');
  toast(T('Video oynatılamadı. Dosya bozuk ya da desteklenmiyor olabilir.'), 4000);
}

function seek(t) {
  const v = V();
  t = clamp(t, 0, Math.max(0, pDur() - 1));
  if (P.mode === 'direct') { v.currentTime = t; return; }
  const rel = t - P.offset;
  const ranges = P.mode === 'hls' ? v.seekable : v.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (rel >= ranges.start(i) && rel <= ranges.end(i) - 0.5) { v.currentTime = rel; return; }
  }
  loadSource(t);
}

function togglePlay() {
  const v = V();
  if (v.paused) { v.play().catch(() => {}); flash('play'); } else { v.pause(); flash('pause'); }
}
function flash(ic) {
  const f = $('#p-flash');
  f.innerHTML = icon(ic, 'fill');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}
function seekHint(dir) {
  const h = $(dir < 0 ? '#p-hint-l' : '#p-hint-r');
  h.classList.add('on');
  clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove('on'), 600);
}

function showUI() {
  const pl = $('#player');
  pl.classList.add('ui');
  pl.classList.remove('idle');
  clearTimeout(P.hideT);
  P.hideT = setTimeout(() => {
    if (V().paused || $('#p-panel').classList.contains('open') || $('#p-bar').classList.contains('drag')) return;
    pl.classList.remove('ui');
    pl.classList.add('idle');
  }, 3200);
}

function tick() {
  if (!P.open) return;
  const v = V(), t = pTime(), d = pDur();
  if (!$('#p-bar').classList.contains('drag')) {
    const pct = d ? clamp(t / d * 100, 0, 100) : 0;
    $('#p-played').style.width = pct + '%';
    $('#p-knob').style.left = pct + '%';
    $('#p-cur').textContent = fmtTime(t);
  }
  $('#p-dur').textContent = fmtTime(d);
  let bufEnd = 0;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) bufEnd = Math.max(bufEnd, v.buffered.end(i));
  $('#p-buf').style.width = d ? clamp((P.offset + bufEnd) / d * 100, 0, 100) + '%' : '0';
  renderSubtitle(t);
  if (P.next && P.kind !== 'v' && d && !P.upnextDismissed && d - t < 30 && d - t > 0 && !v.paused) showUpNext();
  if (!v.paused && Date.now() - P.lastSave > 10000) savePosition();
  P.raf = requestAnimationFrame(tick);
}

function savePosition(beacon = false) {
  if (!P.info || P.kind === 'v') return;
  const t = pTime(), d = pDur();
  if (t < 5 || !d) return;
  P.lastSave = Date.now();
  const body = JSON.stringify({ key: `${P.kind}:${P.id}`, position: t, duration: d });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' }));
  else fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  if (P.kind === 'm') S.progress[`m:${P.id}`] = [t, d, t >= d * 0.93 ? 1 : 0, Date.now() / 1000];
}

function closePlayerNow() {
  savePosition(true);
  const v = V();
  v.pause();
  v.removeAttribute('src');
  v.load();
  P.open = false;
  P.loadSeq++;
  if (P.mode === 'hls' && P.hlsUrl) fetch(`/api/hls/stop?c=${HLS_CLIENT}&s=${P.hlsUrl.split('/')[2]}`, { method: 'POST', keepalive: true }).catch(() => {});
  P.hlsUrl = '';
  cancelAnimationFrame(P.raf);
  clearTimeout(P.upnextT);
  hidePauseInfo();
  $('#player').classList.remove('open', 'ui', 'idle', 'loading');
  $('#p-panel').classList.remove('open');
  $('#upnext').classList.remove('open');
  document.title = 'Lumbuz';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (P.fsFallback && window.pywebview?.api) { window.pywebview.api.toggle_fullscreen(); P.fsFallback = false; }
  const openAfter = P.openAfter;
  P.openAfter = null;
  setTimeout(async () => {
    await loadUser();
    if (openAfter) openDetail(openAfter);
    else if (detailKey) { const it = S.byKey.get(detailKey); if (it && it.kind !== 'c') { renderDetail(it); if (it.kind === 's') loadEpisodes(it); } }
    else softRender();
  }, 400);
}

async function toggleFullscreen() {
  const pl = $('#player');
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
    } else if (pl.requestFullscreen || pl.webkitRequestFullscreen) {
      await (pl.requestFullscreen ? pl.requestFullscreen() : pl.webkitRequestFullscreen());
    } else throw new Error('no-fs');
  } catch {
    if (window.pywebview?.api) { window.pywebview.api.toggle_fullscreen(); P.fsFallback = !P.fsFallback; }
    else if (V().webkitEnterFullscreen) V().webkitEnterFullscreen();
  }
}
document.addEventListener('fullscreenchange', () => { $('#p-fsicon').setAttribute('href', document.fullscreenElement ? '#i-shrink' : '#i-expand'); });

function mediaSession() {
  if (!('mediaSession' in navigator) || !P.info) return;
  const art = P.kind === 'v' ? `/img/clip/${P.id}` : P.kind === 'm' ? img('m', P.id, 'poster', 500) : img('s', P.info.sid, 'poster', 500);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: P.info.title, artist: P.info.sub || 'Lumbuz',
      artwork: [{ src: art, sizes: P.kind === 'v' ? '640x360' : '500x750', type: 'image/jpeg' }] });
    navigator.mediaSession.setActionHandler('play', () => mediaCommand('play'));
    navigator.mediaSession.setActionHandler('pause', () => mediaCommand('pause'));
    navigator.mediaSession.setActionHandler('seekbackward', () => mediaCommand('back'));
    navigator.mediaSession.setActionHandler('seekforward', () => mediaCommand('fwd'));
    navigator.mediaSession.setActionHandler('nexttrack', P.next ? () => mediaCommand('next') : null);
  } catch {}
}

function playNext() {
  if (!P.next) return;
  if (P.kind === 'v') { toast(T('Sıradaki: {t}', { t: esc(`${P.next.label} – ${P.next.name}`) }), 1800); return play('v', P.next.id, { from: 0, title: P.next.name }); }
  savePosition();
  api.post('/api/progress', { key: `${P.kind}:${P.id}`, position: pDur(), duration: pDur() }).catch(() => {});
  play('e', P.next.id, { from: 0 });
}

function showUpNext() {
  const box = $('#upnext');
  if (box.classList.contains('open')) return;
  const n = P.next;
  const still = n.still ? `/img/still/${n.id}` : (P.info.sid ? img('s', P.info.sid, 'backdrop', 640) : '');
  let left = 10;
  box.innerHTML = `<div class="still" style="background-image:url('${still}')">
      <svg class="ring" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="rgba(0,0,0,.55)" stroke="rgba(255,255,255,.25)" stroke-width="4"/>
      <circle id="upring" cx="32" cy="32" r="28" fill="none" stroke="#fff" stroke-width="4" stroke-dasharray="176" stroke-dashoffset="0" transform="rotate(-90 32 32)" style="transition:stroke-dashoffset 1s linear"/>
      <text id="upnum" x="32" y="39" text-anchor="middle" fill="#fff" font-size="20" font-weight="700" font-family="sans-serif">${left}</text></svg></div>
    <div class="body"><small>${T('Sonraki bölüm')}</small><strong>${esc(tx(n.label))}${n.name ? ' · ' + esc(n.name) : ''}</strong>
      <div class="actions"><button class="btn btn-play" data-p="next">${icon('play', 'fill')}${T('Şimdi Oynat')}</button><button class="btn btn-ghost" data-p="dismiss-next">${T('Kapat')}</button></div></div>`;
  box.classList.add('open');
  const step = () => {
    left--;
    const ring = $('#upring'), num = $('#upnum');
    if (ring) ring.style.strokeDashoffset = String(176 * (1 - left / 10));
    if (num) num.textContent = Math.max(0, left);
    if (left <= 0) return playNext();
    P.upnextT = setTimeout(step, 1000);
  };
  clearTimeout(P.upnextT);
  P.upnextT = setTimeout(step, 1000);
}
function dismissUpNext() { clearTimeout(P.upnextT); P.upnextDismissed = true; $('#upnext').classList.remove('open'); }

/* ---------------- pause screen: what's playing, who's in it, what to watch next */
const CREDITS = new Map();
const regionName = (() => { try { const d = new Intl.DisplayNames([LANG], { type: 'region' }); return c => d.of(c) || c; } catch { return c => c; } })();
const playingItem = () => !P.info ? null : P.kind === 'm' ? S.movieToTitle.get(P.id) : S.byKey.get('s:' + P.info.sid);

function loadCredits(it) {
  if (!it || !it.tm) return Promise.resolve({});
  if (!CREDITS.has(it.key)) CREDITS.set(it.key, api.get(`/api/credits/${it.kind}/${it.id}`).catch(() => { CREDITS.delete(it.key); return { failed: true }; }));
  return CREDITS.get(it.key);
}

// Same kind of title from the library: TMDb's recommendations first, then the rest of the series and shared genres.
// Things already watched to the end sink to the back.
function similarTitles(it, rec = [], n = 14) {
  const rank = new Map(rec.map((tm, i) => [tm, i]));
  const genres = genresOf(it);
  return (it.kind === 's' ? S.series : S.titles).filter(x => x !== it).map(x => {
    let s = genresOf(x).filter(g => genres.includes(g)).length + (parseFloat(x.r) || 0) / 20;
    if (x.tm && rank.has(x.tm)) s += 4 + (40 - rank.get(x.tm)) / 20;
    if (it.c && x.c === it.c) s += 3;
    if (x.kind === 'm' && movieProgress(x)?.[2]) s -= 3;
    return { x, s };
  }).filter(o => o.s >= 1).sort((a, b) => b.s - a.s).slice(0, n).map(o => o.x);
}

function pauseHTML(it, cr) {
  const ep = P.kind === 'e' ? P.info.sub : '';
  const date = cr.date ? new Date(cr.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const facts = [
    [it.kind === 's' ? 'Yaratıcı' : 'Yönetmen', (cr.directors || []).join(', ')],
    ['Senaryo', (cr.writers || []).join(', ')],
    ['Ülke', (cr.countries || []).map(regionName).join(', ')],
    [it.kind === 's' ? 'İlk yayın' : 'Vizyon', date],
    ['Orijinal ad', it.ot && fold(it.ot) !== fold(it.t) ? it.ot : ''],
  ].filter(f => f[1]).map(([k, v]) => `<div><span>${T(k)}</span><b>${esc(v)}</b></div>`).join('');
  const cast = (cr.cast || []).map(p => `<div class="pp-person">
      <div class="pp-face">${icon('user')}${p.p ? `<img src="/img/person${esc(p.p)}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}</div>
      <b>${esc(p.n)}</b>${p.c ? `<small>${esc(p.c)}</small>` : ''}</div>`).join('');
  const castBlock = cast ? `<div class="pp-sec"><h4>${T('Oyuncular')}</h4><div class="pp-row">${cast}</div></div>`
    : it.tm && !cr.done ? `<div class="pp-sec"><h4>${T('Oyuncular')}</h4><div class="spin"></div></div>` : '';
  const similar = similarTitles(it, cr.rec).map(x => `<button class="pp-card" data-p="similar" data-key="${x.key}" title="${esc(x.t)}">
      <div class="art">${artHTML(x, 185)}</div><b>${esc(x.t)}</b><small>${esc(x.y || '')}${x.r ? ` · ★ ${esc(x.r)}` : ''}</small></button>`).join('');
  return `<div class="pp-inner">
    <div class="pp-main">
      ${it.ph ? `<img class="pp-poster" src="${img(it.kind, it.id, 'poster', 342)}" alt="">` : ''}
      <div class="pp-info">
        <small class="pp-kicker">${T('İzliyorsun')}</small>
        <h2>${esc(it.t)}</h2>
        ${ep ? `<div class="pp-ep">${esc(tx(ep))}</div>` : ''}
        <div class="meta">${metaLine(it)}</div>
        ${cr.tagline ? `<p class="pp-tagline">${esc(cr.tagline)}</p>` : ''}
        ${it.p ? `<p class="pp-plot">${esc(it.p)}</p>` : ''}
        ${facts ? `<div class="pp-facts">${facts}</div>` : ''}
      </div>
    </div>
    ${castBlock}
    ${similar ? `<div class="pp-sec"><h4>${T(it.kind === 's' ? 'Benzer Diziler' : 'Benzer Filmler')}</h4><div class="pp-row">${similar}</div></div>` : ''}
  </div>`;
}

function showPauseInfo() {
  const v = V(), pl = $('#player'), it = playingItem();
  if (P.open && P.kind === 'v' && v.paused) return showClipPause();
  if (!P.open || !it || !v.paused) return;
  if (pl.classList.contains('loading')) { P.pauseT = setTimeout(showPauseInfo, 500); return; }
  const box = $('#p-pause'), key = `${P.kind}:${P.id}`;
  pl.classList.add('paused-info');
  if (box.dataset.for === key && box.dataset.full) return;
  if (box.dataset.for !== key) { box.innerHTML = pauseHTML(it, {}); box.dataset.for = key; delete box.dataset.full; }
  loadCredits(it).then(cr => {
    if (box.dataset.for !== key) return;
    const scroll = $('.pp-inner', box)?.scrollTop || 0;
    box.innerHTML = pauseHTML(it, { ...cr, done: true });
    if (!cr.failed) box.dataset.full = '1';  // otherwise try TMDb again on the next pause
    $('.pp-inner', box).scrollTop = scroll;
  });
}
function hidePauseInfo() {
  clearTimeout(P.pauseT);
  $('#player').classList.remove('paused-info');
}

/* ---------------- subtitles */
function parseTime(s) {
  const p = s.trim().replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
function sanitizeCue(text) {
  return esc(text.replace(/\{\\[^}]*\}/g, '').replace(/<(?!\/?[ibu]>)[^>]+>/gi, ''))
    .replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>');
}
function parseSubs(text) {
  const cues = [];
  text = text.replace(/\r/g, '').replace(/^﻿/, '');
  if (!/-->/.test(text)) return cues;
  // Decomposed letters (s + combining cedilla) fall back to another font, so compose them.
  if (text.normalize) text = text.normalize('NFC');
  // Turkish subs saved as Windows-1252 show ş ğ ı as þ ð ý; those letters never appear in Turkish.
  if (/[þðÞÐ]/.test(text) && !/[şğŞĞ]/.test(text)) text = text.replace(/[þðýÞÐÝ]/g, c => ({ þ: 'ş', ð: 'ğ', ý: 'ı', Þ: 'Ş', Ð: 'Ğ', Ý: 'İ' })[c]);
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ s: parseTime(m[1]), e: parseTime(m[2]), h: sanitizeCue(body) });
  }
  return cues.sort((a, b) => a.s - b.s);
}
function setSubs(text, label, source) {
  const cues = parseSubs(text || '');
  if (!cues.length) { toast(T('Altyazı dosyası okunamadı')); return false; }
  P.subs = { cues, label, source, text, align: '' };
  P.lastSubHTML = null;
  toast(`${icon('cc')} ${T('Altyazı')}: <b>${esc(tx(label))}</b>`);
  if ($('#p-panel').classList.contains('open')) renderPanel();
  // Subtitles from the internet or from a file are often made for another release of the film; line them up with
  // the sound. Embedded tracks come with the video itself and are already in sync.
  if (!source.startsWith('emb') && store.get('subAlign', true)) alignSubs(false);
  return true;
}
// The server compares the subtitle with where people talk in the film and answers with a shift (and, for a copy at
// another frame rate, a stretch). The first subtitle for a video takes about a minute, later ones a few seconds.
async function alignSubs(manual) {
  const subs = P.subs, k = P.kind, id = P.id;
  if (!subs || subs.align === 'working' || P.kind === 'v') return;
  const same = () => P.subs === subs && P.kind === k && P.id === id && P.open;
  const done = (state, msg) => { subs.align = state; if (msg && (manual || state === 'done')) toast(msg, 3500); if ($('#p-panel').classList.contains('open') && same()) renderPanel(); };
  subs.align = 'working';
  if (manual) toast(T('Altyazı filmin sesine göre hizalanıyor…'), 3000);
  if ($('#p-panel').classList.contains('open')) renderPanel();
  let r;
  try {
    r = await api.post(`/api/subs/align/${k}/${id}?a=${P.audio}`, { text: subs.text });
    for (let i = 0; r.state === 'working' && i < 200; i++) {
      await new Promise(res => setTimeout(res, 3000));
      if (!same()) return;
      r = await api.get(`/api/subs/align/status/${r.key}`);
    }
  } catch (e) { r = { state: 'failed' }; }
  if (!same()) return;
  if (r.state !== 'done' || !r.ok) return done('unsure', T('Altyazı sesle eşleştirilemedi. Senkronu elle ayarlayabilirsiniz.'));
  const ratio = +r.ratio || 1, off = +r.offset || 0;
  if (ratio === 1 && Math.abs(off) < 0.3) return done('done', manual ? T('Altyazı zaten filmle uyumlu') : '');
  subs.cues = subs.cues.map(c => ({ s: c.s * ratio + off, e: c.e * ratio + off, h: c.h }));
  P.subDelay = 0;
  P.lastSubHTML = null;
  const dec = n => LANG === 'en' ? n : n.replace('.', ',');
  done('done', T('Altyazı sese göre hizalandı ({v} sn)', { v: (off > 0 ? '+' : '') + dec(off.toFixed(1)) }));
}
function renderSubtitle(t) {
  const el = $('#p-subs');
  let html = '';
  if (P.subs) {
    const cues = P.subs.cues, tt = t - P.subDelay;
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].s <= tt) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    const out = [];
    for (let i = idx; i >= 0 && i > idx - 6; i--) if (cues[i].e > tt) out.unshift(cues[i].h);
    html = out.map(h => `<span>${h}</span>`).join('<br>');
  }
  if (html !== P.lastSubHTML) { el.innerHTML = html; P.lastSubHTML = html; }
}
async function loadServerSub(url, label, source) {
  const slow = source.startsWith('emb') ? setTimeout(() => toast(T('Gömülü altyazı hazırlanıyor, bu biraz sürebilir…')), 900) : 0;
  try {
    const r = await fetch(url);
    clearTimeout(slow);
    if (!r.ok) throw 0;
    setSubs(await r.text(), label, source);
  } catch { clearTimeout(slow); toast(T('Altyazı yüklenemedi')); }
}
function autoSubtitles() {
  const info = P.info;
  if (!info || P.kind === 'v' || store.get('subsOff', false)) return;
  const k = P.kind, id = P.id;
  // A Turkish (or unlabeled) file with the video comes first; one in another language only if no Turkish one is found.
  const loc = info.local_subs[0];
  if (loc && loc.lang !== 'en') return loadServerSub(`/sub/${k}/${id}/local/0`, loc.label, 'local:0');
  const turkishAudio = info.audio.some(a => ['tur', 'tr'].includes(a.lang));
  const tr = info.subs.find(s => ['tur', 'tr'].includes(s.lang));
  if (tr && !turkishAudio) return loadServerSub(`/sub/${k}/${id}/embedded/${tr.index}`, tr.label, 'emb:' + tr.index);
  if (!turkishAudio) autoOnlineSub(k, id).then(found => {
    if (!found && loc && P.kind === k && P.id === id && !P.subs && !store.get('subsOff', false)) loadServerSub(`/sub/${k}/${id}/local/0`, loc.label, 'local:0');
  });
  else if (loc) loadServerSub(`/sub/${k}/${id}/local/0`, loc.label, 'local:0');
}
// No Turkish subtitle with the video: the server looks one up on OpenSubtitles (once; it keeps the file, so it
// also works offline later). Quietly does nothing without internet, and never replaces a subtitle picked meanwhile.
async function autoOnlineSub(k, id) {
  let text = '';
  try { const r = await fetch(`/sub/${k}/${id}/auto`); if (r.status === 200) text = await r.text(); } catch (e) {}
  if (!text || P.kind !== k || P.id !== id || P.subs || store.get('subsOff', false)) return false;
  if (setSubs(text, 'Türkçe (internet)', 'auto')) P.info.auto_sub = true;
  return true;
}
function loadSubFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    let text = e.target.result;
    if (/�/.test(text)) { const r2 = new FileReader(); r2.onload = e2 => setSubs(e2.target.result, file.name, 'file'); r2.readAsText(file, 'windows-1254'); return; }
    setSubs(text, file.name, 'file');
  };
  reader.readAsText(file, 'utf-8');
}

function renderPanel(view = 'main') {
  const pn = $('#p-panel'), info = P.info;
  if (!info) return;
  if (view === 'online') {
    pn.innerHTML = `<button class="back" data-p="panel-main">${icon('left')}${T('Çevrimiçi altyazı')}</button><div class="results" id="sub-results"><div style="padding:30px;display:grid;place-items:center"><div class="spin"></div></div></div>`;
    api.get(`/api/subs/search/${P.kind}/${P.id}`).then(list => {
      const box = $('#sub-results');
      if (!box) return;
      box.innerHTML = list.length ? list.map(s => `<button class="opt" data-p="dl-sub" data-fid="${s.file_id}" data-label="${esc(s.release || s.lang)}">
        <span><b style="color:#fff">${T(s.lang === 'tr' ? 'Türkçe' : 'İngilizce')}</b> · ${esc(s.release || '')}</span><small>${s.match === 'HASH' ? T('tam eşleşme') + ' · ' : ''}${s.downloads} ⬇</small></button>`).join('')
        : `<p style="padding:20px;color:var(--muted)">${T('Bu video için altyazı bulunamadı.')}</p>`;
    }).catch(() => { const box = $('#sub-results'); if (box) box.innerHTML = `<p style="padding:20px;color:var(--muted)">${T('Arama başarısız. İnternet bağlantınızı kontrol edin.')}</p>`; });
    return;
  }
  const src = P.subs?.source || 'off';
  const opt = (on, attrs, label, small = '') => `<button class="opt${on ? ' on' : ''}" ${attrs}>${icon('check', 'chk')}<span>${esc(tx(label))}</span>${small ? `<small>${esc(tx(small))}</small>` : ''}</button>`;
  const audio = (info.audio.length ? info.audio : [{ index: 0, label: 'Varsayılan' }]).map(a => opt(P.audio === a.index, `data-p="audio" data-i="${a.index}"`, a.label, a.codec ? a.codec.toUpperCase() : '')).join('');
  let subs = opt(src === 'off', 'data-p="sub-off"', 'Kapalı');
  subs += info.local_subs.map(s => opt(src === 'local:' + s.index, `data-p="sub" data-url="/sub/${P.kind}/${P.id}/local/${s.index}" data-src="local:${s.index}" data-label="${esc(s.label)}"`, s.label, 'dosya')).join('');
  if (info.auto_sub) subs += opt(src === 'auto', `data-p="sub" data-url="/sub/${P.kind}/${P.id}/auto" data-src="auto" data-label="Türkçe (internet)"`, 'Türkçe (internet)', 'otomatik');
  subs += info.subs.map(s => opt(src === 'emb:' + s.index, `data-p="sub" data-url="/sub/${P.kind}/${P.id}/embedded/${s.index}" data-src="emb:${s.index}" data-label="${esc(s.label)}"`, s.label, 'gömülü')).join('');
  if (P.subs && (src === 'file' || src === 'online')) subs += opt(true, '', P.subs.label, src === 'file' ? 'yüklendi' : 'indirildi');
  subs += `<button class="opt" data-p="panel-online">${icon('globe')}<span>${T('Çevrimiçi ara…')}</span></button>`;
  subs += `<button class="opt" data-p="sub-file">${icon('upload')}<span>${T('Dosyadan yükle…')}</span></button>`;
  const size = store.get('subSize', 'm');
  const dec = n => LANG === 'en' ? n : n.replace('.', ',');
  pn.innerHTML = `<div class="cols"><div class="col"><h5>${T2('Ses', 'Audio')}</h5>${audio}</div><div class="col"><h5>${T('Altyazı')}</h5>${subs}</div></div>
    <div class="foot">
      <span>${T('Boyut')}</span><div class="seg">${[['s', 'Küçük'], ['m', 'Orta'], ['l', 'Büyük']].map(([k, l]) => `<button class="${size === k ? 'on' : ''}" data-p="sub-size" data-v="${k}">${T(l)}</button>`).join('')}</div>
      <span>${T('Senkron')}</span><div class="seg"><button data-p="sub-delay" data-v="-0.5">${dec('−0.5')}</button><button class="on" style="min-width:58px">${T('{v} sn', { v: (P.subDelay > 0 ? '+' : '') + dec(P.subDelay.toFixed(1)) })}</button><button data-p="sub-delay" data-v="0.5">${dec('+0.5')}</button></div>
      <div class="seg"><button class="${store.get('subBox', false) ? 'on' : ''}" data-p="sub-box">${T('Arka plan')}</button></div>
      ${P.subs ? `<div class="seg"><button class="${P.subs.align === 'done' ? 'on' : ''}" data-p="sub-align"${P.subs.align === 'working' ? ' disabled' : ''}>${T(P.subs.align === 'working' ? 'Hizalanıyor…' : P.subs.align === 'done' ? 'Sese göre hizalandı' : 'Sese göre hizala')}</button></div>` : ''}
    </div>`;
}
function applySubStyle() {
  const size = { s: 'clamp(15px, 2vw, 32px)', m: 'clamp(18px, 2.6vw, 42px)', l: 'clamp(22px, 3.4vw, 54px)' }[store.get('subSize', 'm')];
  document.documentElement.style.setProperty('--sub-size', size);
  $('#p-subs').classList.toggle('boxed', store.get('subBox', false));
}

async function playerAction(a, el) {
  const v = V();
  switch (a) {
    case 'close': return back();
    case 'toggle': return togglePlay();
    case 'back10': seekHint(-1); return seek(pTime() - 10);
    case 'fwd10': seekHint(1); return seek(pTime() + 10);
    case 'mute': v.muted = !v.muted; return updateVolIcon();
    case 'fullscreen': return toggleFullscreen();
    case 'next': return playNext();
    case 'dismiss-next': return dismissUpNext();
    case 'similar': P.openAfter = el.dataset.key; return back();
    case 'clip': {
      // A suggestion keeps the current play order when it is part of it; otherwise its row becomes the new order.
      const id = +el.dataset.id, list = CL.lists[el.dataset.sec] || [];
      if (!(P.queue || []).includes(id)) P.queue = list.map(x => x.id);
      const c = CL.byId.get(id);
      return play('v', id, { from: 0, title: c?.t });
    }
    case 'speed': {
      const speeds = [1, 1.25, 1.5, 2, 0.75];
      P.speed = speeds[(speeds.indexOf(P.speed) + 1) % speeds.length];
      v.playbackRate = P.speed;
      $('#p-speedtag').textContent = P.speed === 1 ? '' : P.speed + 'x';
      return toast(T('Oynatma hızı {v}x', { v: LANG === 'en' ? P.speed : String(P.speed).replace('.', ',') }), 1400);
    }
    case 'panel': {
      const pn = $('#p-panel');
      if (pn.classList.toggle('open')) renderPanel();
      return showUI();
    }
    case 'panel-main': return renderPanel();
    case 'panel-online': return renderPanel('online');
    case 'audio': {
      const i = +el.dataset.i;
      if (i === P.audio) return;
      const t = pTime();
      P.audio = i;
      P.mode = (P.info.direct && i === 0) ? 'direct' : streamMode();
      loadSource(t);
      return renderPanel();
    }
    case 'sub-off': P.subs = null; store.set('subsOff', true); P.lastSubHTML = null; return renderPanel();
    case 'sub': store.set('subsOff', false); await loadServerSub(el.dataset.url, el.dataset.label, el.dataset.src); return renderPanel();
    case 'sub-file': return $('#sub-file').click();
    case 'dl-sub': {
      el.innerHTML = `<div class="spin"></div><span>${T('İndiriliyor…')}</span>`;
      try { const vtt = await api.post('/api/subs/download', { file_id: +el.dataset.fid }); if (setSubs(vtt, el.dataset.label, 'online')) renderPanel(); }
      catch { toast(T('Altyazı indirilemedi (günlük limit dolmuş olabilir)')); renderPanel('online'); }
      return;
    }
    case 'sub-size': store.set('subSize', el.dataset.v); applySubStyle(); return renderPanel();
    case 'sub-box': store.set('subBox', !store.get('subBox', false)); applySubStyle(); return renderPanel();
    case 'sub-align': if (P.subs) { P.subs.align = ''; alignSubs(true); } return;
    case 'sub-delay': P.subDelay = Math.round((P.subDelay + parseFloat(el.dataset.v)) * 10) / 10; P.lastSubHTML = null; return renderPanel();
  }
}

function updateVolIcon() {
  const v = V();
  $('#p-volicon').setAttribute('href', v.muted || v.volume === 0 ? '#i-mute' : '#i-vol');
  $('#p-volume').value = v.muted ? 0 : v.volume;
  store.set('volume', v.volume);
}

function wirePlayer() {
  const pl = $('#player'), v = V(), bar = $('#p-bar');
  v.volume = store.get('volume', 1);
  applySubStyle();
  updateVolIcon();
  v.addEventListener('waiting', () => pl.classList.add('loading'));
  v.addEventListener('seeking', () => pl.classList.add('loading'));
  ['playing', 'canplay', 'seeked'].forEach(e => v.addEventListener(e, () => pl.classList.remove('loading')));
  v.addEventListener('playing', () => { P.retries = 0; });
  v.addEventListener('play', () => { $('#p-playicon').setAttribute('href', '#i-pause'); hidePauseInfo(); showUI(); });
  v.addEventListener('pause', () => {
    $('#p-playicon').setAttribute('href', '#i-play'); showUI(); savePosition();
    clearTimeout(P.pauseT); P.pauseT = setTimeout(showPauseInfo, 900);
  });
  v.addEventListener('ended', () => {
    savePosition();
    if (P.next && !P.upnextDismissed) playNext();
    else if (P.mode !== 'direct' && pDur() - pTime() > 20) loadSource(pTime());
    else if (P.kind === 'v') pl.classList.add('ui');
    else { pl.classList.add('ui'); api.post('/api/progress', { key: `${P.kind}:${P.id}`, position: pDur(), duration: pDur() }).catch(() => {}); }
  });
  v.addEventListener('error', () => {
    if (!P.open || !v.getAttribute('src')) return;
    const e = v.error;
    playbackFailed(pTime(), e ? `${e.code} ${e.message || ''}` : '?');
  });
  $('#p-volume').addEventListener('input', e => { v.volume = +e.target.value; v.muted = v.volume === 0; updateVolIcon(); });

  pl.addEventListener('pointermove', showUI);
  pl.addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (b) { e.stopPropagation(); return playerAction(b.dataset.p, b); }
    if (e.target.closest('.p-panel, .upnext, .p-bottom, .p-top, .pp-main, .pp-sec')) return;
    if ($('#p-panel').classList.contains('open')) { $('#p-panel').classList.remove('open'); return; }
    if (matchMedia('(hover: none)').matches && !pl.classList.contains('ui')) return showUI();
    togglePlay();
  });
  pl.addEventListener('dblclick', e => { if (!e.target.closest('.p-bottom, .p-top, .p-panel, .upnext, .p-pause')) toggleFullscreen(); });

  const posFromEvent = e => { const r = $('.p-track', bar).getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  const tip = $('#p-tip');
  const preview = f => {
    const t = f * pDur();
    tip.textContent = fmtTime(t);
    tip.style.left = clamp(f * 100, 3, 97) + '%';
    return t;
  };
  bar.addEventListener('pointermove', e => preview(posFromEvent(e)));
  bar.addEventListener('pointerdown', e => {
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag');
    const upd = ev => { const f = posFromEvent(ev); preview(f); $('#p-played').style.width = f * 100 + '%'; $('#p-knob').style.left = f * 100 + '%'; $('#p-cur').textContent = fmtTime(f * pDur()); };
    upd(e);
    const move = ev => upd(ev);
    const up = ev => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      bar.classList.remove('drag');
      seek(posFromEvent(ev) * pDur());
      showUI();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });

  $('#sub-file').addEventListener('change', e => { loadSubFile(e.target.files[0]); e.target.value = ''; });
  pl.addEventListener('dragover', e => { e.preventDefault(); pl.classList.add('dragover'); });
  pl.addEventListener('dragleave', e => { if (e.target === pl || !pl.contains(e.relatedTarget)) pl.classList.remove('dragover'); });
  pl.addEventListener('drop', e => { e.preventDefault(); pl.classList.remove('dragover'); loadSubFile(e.dataTransfer.files[0]); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && P.open) savePosition(true); });
  window.addEventListener('pagehide', () => { if (P.open) savePosition(true); });
}

// Media buttons on TV remotes and keyboards. Android TV browsers name them in e.key; older TV platforms only
// send a keyCode.
const MEDIA_KEYS = { mediaplaypause: 'toggle', mediaplay: 'play', mediapause: 'pause', mediastop: 'pause',
  mediarewind: 'back', mediafastforward: 'fwd', mediatracknext: 'next' };
const MEDIA_CODES = { 179: 'toggle', 250: 'play', 415: 'play', 19: 'pause', 178: 'pause', 413: 'pause',
  227: 'back', 412: 'back', 228: 'fwd', 417: 'fwd', 176: 'next' };

function mediaCommand(cmd) {
  // Some browsers deliver one button press both as a key event and to the media session; act on it once.
  if (Date.now() - (P.mediaAt || 0) < 400) return;
  P.mediaAt = Date.now();
  const v = V();
  if (cmd === 'toggle') togglePlay();
  else if (cmd === 'play') { if (v.paused) togglePlay(); }
  else if (cmd === 'pause') { if (!v.paused) togglePlay(); }
  else if (cmd === 'back') { seekHint(-1); seek(pTime() - 10); }
  else if (cmd === 'fwd') { seekHint(1); seek(pTime() + 10); }
  else if (cmd === 'next') { if (P.next) playNext(); }
  showUI();
}

function playerKeys(e) {
  const v = V();
  const k = e.key.toLowerCase();
  const media = MEDIA_KEYS[k] || MEDIA_CODES[e.keyCode];
  if (media) { e.preventDefault(); return mediaCommand(media); }
  const map = {
    ' ': togglePlay, k: togglePlay,
    arrowleft: () => { seekHint(-1); seek(pTime() - 10); }, j: () => { seekHint(-1); seek(pTime() - 10); },
    arrowright: () => { seekHint(1); seek(pTime() + 10); }, l: () => { seekHint(1); seek(pTime() + 10); },
    arrowup: () => { v.muted = false; v.volume = clamp(v.volume + 0.1, 0, 1); updateVolIcon(); toast(T('Ses %{n}', { n: Math.round(v.volume * 100) }), 900); },
    arrowdown: () => { v.volume = clamp(v.volume - 0.1, 0, 1); updateVolIcon(); toast(T('Ses %{n}', { n: Math.round(v.volume * 100) }), 900); },
    f: toggleFullscreen, m: () => { v.muted = !v.muted; updateVolIcon(); },
    c: () => playerAction('panel'), n: () => P.next && playNext(),
    escape: () => {
      if ($('#p-panel').classList.contains('open')) return $('#p-panel').classList.remove('open');
      if (!document.fullscreenElement) back();
    },
  };
  if (/^[0-9]$/.test(k)) { seek(pDur() * (+k) / 10); showUI(); e.preventDefault(); return; }
  if (map[k]) { e.preventDefault(); map[k](); showUI(); }
}

/* ================================================================ music videos */
// Clips from the music video folders (Settings › Library), named "Artist - Song.mp4". A clip plays in the normal player
// and the list it was started from carries on by itself, like a playlist (the last one wraps to the first). Clips
// have no Continue Watching entry and no subtitles.
// Artist photos, backgrounds, year and album come from Deezer and TheAudioDB through the server, which keeps them.
const CL = { items: null, byId: new Map(), artists: {}, artist: '', error: false, q: '', sort: store.get('clip_sort', 'artist'), lists: {} };
const CLIP_SORTS = [['artist', 'Sanatçı (A–Z)'], ['added', 'Yeni eklenen'], ['title', 'Şarkı (A–Z)']];

async function loadClips() {
  try {
    const r = await api.get('/api/clips');
    CL.items = r.clips.map(c => ({ ...c, search: fold(`${c.a} ${c.t}`) }));
    CL.byId = new Map(CL.items.map(c => [c.id, c]));
    CL.artists = r.artists || {};
    CL.error = false;
  } catch { CL.error = !CL.items; }
}
const clipArtist = c => c.a || T('Bilinmeyen sanatçı');
function sortClips(items, sort) {
  const by = { artist: (a, b) => collator.compare(a.a, b.a) || collator.compare(a.t, b.t), title: (a, b) => collator.compare(a.t, b.t),
    added: (a, b) => b.add - a.add }[sort] || (() => 0);
  return items.slice().sort(by);
}
function clipCard(c, list, i) {
  return `<div class="card land clip" tabindex="0" role="button" data-clip="${list}:${i}" aria-label="${esc(`${clipArtist(c)} – ${c.t}`)}">
    <div class="art"><div class="ph" style="--h:${hue(c.a || c.t)}">${esc(c.a || c.t)}</div>
      ${c.th >= 0 ? `<img src="/img/clip/${c.id}?w=480&v=${c.th}" alt="" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}
      ${c.d ? `<span class="dur">${fmtTime(c.d)}</span>` : ''}
      <div class="play-glyph">${icon('play', 'fill')}</div>
      <div class="shade"><strong>${esc(c.t)}</strong><span>${esc(clipArtist(c))}${c.y ? ` · ${esc(c.y)}` : ''}</span></div>
    </div></div>`;
}
const clipArt = (k, kind) => CL.artists[k]?.[kind] ? `/img/clipart/${CL.artists[k][kind]}` : '';
function artistAvatar(name, k, w = 300) {
  const src = clipArt(k, 'ph');
  const initials = [...name.split(/\s+/).filter(Boolean).slice(0, 2).map(x => [...x][0])].join('').toUpperCase();
  return `<div class="av" style="--h:${hue(name)}"><span>${esc(initials)}</span>${src ? `<img src="${src}?w=${w}" alt="" loading="lazy" decoding="async" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}</div>`;
}
const artistHref = name => `#clips/${encodeURIComponent(name)}`;
function artistCard(name, list) {
  return `<a class="card artist" href="${artistHref(name)}" aria-label="${esc(name)}">${artistAvatar(name, list[0].k)}
    <strong>${esc(name)}</strong><small>${T('{n} klip', { n: list.length })}</small></a>`;
}
function clipArtists() {
  const m = new Map();
  CL.items.forEach(c => { if (c.a) m.set(c.a, [...(m.get(c.a) || []), c]); });
  return m;
}
function clipRow(title, items, list, artist = false) {
  if (!items.length) return '';
  CL.lists[list] = items;
  const h = artist ? `<a class="cl-ah" href="${artistHref(title)}">${artistAvatar(title, items[0].k, 120)}<h2>${esc(title)}</h2>${icon('right')}</a>` : `<h2>${esc(title)}</h2>`;
  return `<section class="row">
    <div class="row-head">${h}</div>
    <div class="rail-wrap">
      <button class="rail-btn prev" aria-label="${T('Geri')}" hidden>${icon('left')}</button>
      <div class="rail wide">${items.map((c, i) => clipCard(c, list, i)).join('')}</div>
      <button class="rail-btn next" aria-label="${T('İleri')}">${icon('right')}</button>
    </div></section>`;
}
function clipGrid() {
  const q = fold(CL.q.trim());
  const items = sortClips(q ? CL.items.filter(c => c.search.includes(q)) : CL.items, CL.sort);
  CL.lists.all = items;
  return items.map((c, i) => clipCard(c, 'all', i)).join('') || emptyState('Klip bulunamadı', 'Başka bir arama deneyin.', 'music');
}

async function renderClips() {
  const view = $('#view');
  const head = n => `<div class="page-head"><h1>${T('Müzik Klipleri')}</h1><span class="count">${n}</span></div>`;
  if (!CL.items) {
    if (CL.error) {
      view.innerHTML = head('') + `<div class="grid">${emptyState('Klip listesi alınamadı', 'Lumbuz sunucusuna ulaşılamıyor.', 'music')}</div>
        <div style="text-align:center;margin-top:-60px"><button class="btn btn-ghost" data-action="clips-retry">${icon('refresh')}${T('Tekrar Dene')}</button></div>`;
      return;
    }
    view.innerHTML = head('') + `<div style="height:50vh;display:grid;place-items:center"><div class="spin" style="width:40px;height:40px;border-width:3px"></div></div>`;
    await loadClips();
    if (S.view === 'clips') renderClips();
    return;
  }
  const all = CL.items;
  if (CL.artist) return renderClipArtist();
  if (!all.length) {
    view.innerHTML = head('') + `<div class="grid">${emptyState('Henüz klip yok', 'Ayarlar › Kütüphane bölümünden müzik klibi klasörü ekleyin.', 'music')}</div>`;
    return;
  }
  const artists = clipArtists();
  CL.lists = {};
  let html = head(`${T('{n} klip', { n: all.length })} · ${T('{n} sanatçı', { n: artists.size })}`) + `
    <div class="lv-tools cl-tools">
      <button class="btn btn-play" data-action="clips-shuffle">${icon('shuffle')}${T('Karışık Çal')}</button>
      <div class="chips" id="cl-sort">${CLIP_SORTS.map(([v, l]) => `<button class="chip${CL.sort === v ? ' on' : ''}" data-csort="${v}">${T(l)}</button>`).join('')}</div>
      <label class="o-search-box">${icon('search')}<input id="clip-q" type="search" placeholder="${T('Sanatçı veya şarkı ara…')}" autocomplete="off" spellcheck="false" value="${esc(CL.q)}"></label>
    </div>`;
  if (!CL.q.trim()) {
    html += '<div class="rows cl-rows">' + clipRow(T('Son Eklenenler'), sortClips(all, 'added').slice(0, 20), 'new');
    // Artists with a photo first, then by number of clips.
    const byCount = [...artists.entries()].sort((a, b) => (!!clipArt(b[1][0].k, 'ph') - !!clipArt(a[1][0].k, 'ph')) ||
      b[1].length - a[1].length || collator.compare(a[0], b[0]));
    html += `<section class="row"><div class="row-head"><h2>${T('Sanatçılar')}</h2></div><div class="rail-wrap">
      <button class="rail-btn prev" aria-label="${T('Geri')}" hidden>${icon('left')}</button>
      <div class="rail artists">${byCount.slice(0, 40).map(([a, v]) => artistCard(a, v)).join('')}</div>
      <button class="rail-btn next" aria-label="${T('İleri')}">${icon('right')}</button></div></section>`;
    [...artists.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length || collator.compare(a[0], b[0]))
      .slice(0, 8).forEach(([a, v], i) => { html += clipRow(a, sortClips(v, 'title'), 'a' + i, true); });
    html += `</div><h2 class="lv-sec">${T('Tüm Klipler')}</h2>`;
  }
  view.innerHTML = html + `<div class="grid clips" id="cl-grid">${clipGrid()}</div>`;
  wireRails(view);
  const inp = $('#clip-q');
  let t = 0;
  inp.addEventListener('input', () => {
    const had = !!CL.q.trim();
    CL.q = inp.value;
    clearTimeout(t);
    t = setTimeout(() => {
      if (had !== !!CL.q.trim()) { renderClips(); const i = $('#clip-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
      else $('#cl-grid').innerHTML = clipGrid();
    }, 120);
  });
}

// One artist: background art (or the photo, blurred), photo, genre and country, biography, then the clips.
function renderClipArtist() {
  const name = CL.artist;
  const list = sortClips(CL.items.filter(c => fold(c.a) === fold(name)), 'title');
  if (!list.length) { CL.artist = ''; history.replaceState(history.state, '', '#clips'); return renderClips(); }
  const k = list[0].k, info = CL.artists[k] || {}, bg = clipArt(k, 'bg') || clipArt(k, 'ph');
  const years = [...new Set(list.map(c => c.y).filter(Boolean))].sort();
  const meta = [tx(info.g || ''), info.c, T('{n} klip', { n: list.length }), years.length ? (years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0]) : '']
    .filter(Boolean).map(esc).join(' · ');
  CL.lists = { artist: list };
  $('#view').innerHTML = `<header class="cl-hero${clipArt(k, 'bg') ? '' : ' blur'}">
      ${bg ? `<img class="cl-bg" src="${bg}?w=1280" alt="" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}
      <div class="cl-hero-in">${artistAvatar(name, k, 400)}
        <div class="cl-hero-txt"><a class="cl-back" href="#clips">${icon('back')}${T('Müzik Klipleri')}</a><h1>${esc(list[0].a)}</h1>
          <div class="meta">${meta}</div>
          ${info.bio ? `<p class="cl-bio">${esc(info.bio)}</p>` : ''}
          <div class="actions"><button class="btn btn-play" data-clip="artist:0">${icon('play', 'fill')}${T('Oynat')}</button>
            ${list.length > 1 ? `<button class="btn btn-ghost" data-action="clips-shuffle-artist">${icon('shuffle')}${T('Karışık Çal')}</button>` : ''}</div>
        </div></div></header>
    <div class="grid clips">${list.map((c, i) => clipCard(c, 'artist', i)).join('')}</div>`;
}

// Pause screen of a music video: the artist (photo, genre, country, biography), the song's year and album, then the
// artist's other clips and clips by similar artists (same genre, otherwise picked at random).
function clipPauseCard(c, sec) {
  return `<button class="pp-card clip" data-p="clip" data-id="${c.id}" data-sec="${sec}" title="${esc(`${clipArtist(c)} – ${c.t}`)}">
    <div class="art"><div class="ph" style="--h:${hue(c.a || c.t)}">${esc(c.a || c.t)}</div>${c.th >= 0 ? `<img src="/img/clip/${c.id}?w=320&v=${c.th}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}</div>
    <b>${esc(c.t)}</b><small>${esc(clipArtist(c))}${c.y ? ` · ${esc(c.y)}` : ''}</small></button>`;
}
function clipSuggestions(c) {
  const all = CL.items || [];
  const same = sortClips(all.filter(x => x.k === c.k && x.id !== c.id), 'title');
  const genre = (CL.artists[c.k]?.g || '').toLowerCase();
  const others = all.filter(x => x.k !== c.k);
  const alike = genre ? others.filter(x => (CL.artists[x.k]?.g || '').toLowerCase() === genre) : [];
  const fill = shuffle(others.filter(x => !alike.includes(x)), c.id * 7 + daySeed);
  const more = [...shuffle(alike, c.id + daySeed), ...fill].slice(0, 16);
  CL.lists.pp_same = same; CL.lists.pp_more = more;
  return { same, more };
}
function showClipPause() {
  const c = CL.byId.get(P.id), pl = $('#player'), box = $('#p-pause');
  if (!c) return;
  if (pl.classList.contains('loading')) { P.pauseT = setTimeout(showPauseInfo, 500); return; }
  pl.classList.add('paused-info');
  const key = `v:${c.id}`;
  if (box.dataset.for === key) return;
  const info = CL.artists[c.k] || {}, { same, more } = clipSuggestions(c);
  const facts = [['Albüm', c.al], ['Yıl', c.y], ['Tür', tx(info.g || '')], ['Ülke', info.c]]
    .filter(f => f[1]).map(([k, v]) => `<div><span>${T(k)}</span><b>${esc(v)}</b></div>`).join('');
  const row = (title, list, sec) => list.length ? `<div class="pp-sec"><h4>${title}</h4><div class="pp-row">${list.map(x => clipPauseCard(x, sec)).join('')}</div></div>` : '';
  box.innerHTML = `<div class="pp-inner">
    <div class="pp-main">${c.a ? artistAvatar(c.a, c.k, 300).replace('class="av"', 'class="av pp-av"') : ''}
      <div class="pp-info">
        <small class="pp-kicker">${T('İzliyorsun')}</small>
        <h2>${esc(c.t)}</h2>
        <div class="pp-ep">${esc(clipArtist(c))}</div>
        ${info.bio ? `<p class="pp-plot">${esc(info.bio)}</p>` : ''}
        ${facts ? `<div class="pp-facts">${facts}</div>` : ''}
      </div>
    </div>
    ${row(T('{a} klipleri', { a: esc(clipArtist(c)) }), same, 'pp_same')}
    ${row(T(alikeTitle(c) ? 'Benzer Klipler' : 'Başka Klipler'), more, 'pp_more')}
  </div>`;
  box.dataset.for = key;
  delete box.dataset.full;
}
const alikeTitle = c => !!(CL.artists[c.k]?.g && (CL.items || []).some(x => x.k !== c.k && CL.artists[x.k]?.g === CL.artists[c.k].g));

// Plays clip i of a list, then the rest of the list in order.
function playClips(list, i) {
  if (!list?.length) return;
  P.queue = list.map(c => c.id);
  const c = list[i] || list[0];
  play('v', c.id, { title: c.t, from: 0 });
}
function clipNext() {
  const q = P.queue || [];
  if (q.length < 2) return null;
  const c = CL.byId.get(q[(q.indexOf(P.id) + 1) % q.length]);
  return c ? { id: c.id, label: clipArtist(c), name: c.t } : null;
}

/* ================================================================ online (TMDb catalog, frameXTV player) */
// Titles that aren't in the library: listed from TMDb, played in frameXTV's iframe player by TMDb id. Keys are
// 'om:<tmdb>' (movie) and 'os:<tmdb>' (series); progress keys 'om:<tmdb>' and 'oe:<tmdb>:<season>:<episode>'.
// Online images come through the Lumbuz server, which keeps a copy, so devices without internet see them too.
const TMDB_IMG = '/img/tmdb/';
const OL = { home: null, loading: false, error: false, items: new Map(), details: new Map(), q: '', searchT: 0, pageT: 0 };

function onlineItem(d) {
  const kind = d.kind === 's' || d.kind === 'os' ? 'os' : 'om';
  const it = { ...d, kind, key: `${kind}:${d.tm}`, online: true };
  if (!OL.items.has(it.key) || d.rec) OL.items.set(it.key, it);
  return it;
}
const localOf = it => it.kind === 'om' ? S.tmMovie.get(it.tm) : it.kind === 'os' ? S.tmSeries.get(it.tm) : null;

function nextOnlineEpisode(seasons, s, e) {
  const sizes = new Map(seasons || []);
  if (e < (sizes.get(s) || 0)) return [s, e + 1];
  const later = [...sizes.keys()].filter(n => n > s && sizes.get(n)).sort((a, b) => a - b);
  return later.length ? [later[0], 1] : null;
}

function onlineContinueCard(c) {
  const src = c.ob ? `${TMDB_IMG}w1280${c.ob}` : c.op ? `${TMDB_IMG}w342${c.op}` : '';
  const spec = c.kind === 'om' ? `m:${c.tm}` : `s:${c.tm}:${c.s}:${c.e}`;
  const pct = c.dur ? clamp(c.pos / c.dur * 100, 2, 100) : 0;
  return `<div class="card land" tabindex="0" role="button" data-oplay="${spec}" aria-label="${esc(c.title)}">
    <div class="art">${src ? `<img src="${src}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : `<div class="ph" style="--h:${hue(c.title)}">${esc(c.title)}</div>`}
      ${c.up_next ? `<span class="flag new">${T('SIRADAKİ')}</span>` : '<span class="flag">ONLINE</span>'}
      <button class="x" data-forget="${esc(c.pkey)}" title="${T('Listeden kaldır')}" aria-label="${T('Kaldır')}">${icon('x')}</button>
      <div class="play-glyph">${icon('play', 'fill')}</div>
      <div class="shade"><strong>${esc(c.title)}</strong><span>${esc(tx(c.sub || ''))}${c.dur ? `${c.sub ? ' · ' : ''}${fmtLeft(c.pos, c.dur)}` : ''}</span></div>
      ${pct ? `<div class="pbar progress-line"><i style="width:${pct}%"></i></div>` : ''}
    </div></div>`;
}

/* ---------------- the Online tab */
async function renderOnline() {
  const view = $('#view');
  const head = `<div class="page-head"><h1>Online</h1><span class="count">${T('Kütüphanende olmayan film ve diziler')}</span></div>`;
  if (!OL.home) {
    if (OL.error) {
      view.innerHTML = head + `<div class="grid">${emptyState('Online katalog yüklenemedi', 'İnternet bağlantısını ve TMDb anahtarını kontrol edin.', 'globe')}</div>
        <div style="text-align:center;margin-top:-60px"><button class="btn btn-ghost" data-action="online-retry">${icon('refresh')}${T('Tekrar Dene')}</button></div>`;
      return;
    }
    view.innerHTML = head + `<div style="height:50vh;display:grid;place-items:center"><div class="spin" style="width:40px;height:40px;border-width:3px"></div></div>`;
    if (OL.loading) return;
    OL.loading = true;
    try {
      OL.home = await api.get('/api/online/home');
      if (OL.home.embed) S.embed = OL.home.embed;
    } catch { OL.error = true; }
    OL.loading = false;
    if (S.view === 'online') renderOnline();
    return;
  }
  const rows = OL.home.rows.map(r => ({ title: r.title, items: r.items.map(onlineItem) }));
  const pool = rows.slice(0, 2).flatMap(r => r.items).filter(it => it.ob && it.p && !localOf(it));
  const picks = shuffle(pool, daySeed + (Date.now() / 36e5 | 0)).slice(0, 6);
  const cont = S.cont.filter(c => c.kind === 'om' || c.kind === 'oe');
  const list = [...S.mylist].filter(k => /^o[ms]:/.test(k)).map(itemByKey).filter(Boolean);
  let html = heroHTML(picks) + `<div class="rows">
    <div class="o-search"><label class="o-search-box">${icon('search')}<input id="online-q" type="search" placeholder="${T("Online'da film veya dizi ara…")}" autocomplete="off" spellcheck="false" value="${esc(OL.q)}"></label></div>
    <div id="online-results"></div><div id="online-rows">`;
  html += row('İzlemeye Devam Et', cont, { kind: 'cont' });
  html += row('Listem', list);
  rows.forEach(r => { html += row(r.title, r.items); });
  html += '</div></div>';
  view.innerHTML = html;
  wireRails(view);
  startHero(picks);
  const inp = $('#online-q');
  inp.addEventListener('input', () => { clearTimeout(OL.pageT); OL.pageT = setTimeout(() => onlinePageSearch(inp.value), 350); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(OL.pageT); onlinePageSearch(inp.value); } });
  if (OL.q) onlinePageSearch(OL.q);
}

async function onlinePageSearch(q) {
  OL.q = q.trim();
  const res = $('#online-results'), rowsBox = $('#online-rows');
  if (!res) return;
  if (OL.q.length < 2) { res.innerHTML = ''; rowsBox.hidden = false; return; }
  rowsBox.hidden = true;
  res.innerHTML = '<div style="padding:40px;display:grid;place-items:center"><div class="spin"></div></div>';
  let list;
  try { list = await api.get('/api/online/search?q=' + encodeURIComponent(OL.q)); } catch { list = null; }
  if (OL.q !== q.trim() || !$('#online-results')) return;
  res.innerHTML = !list ? `<div class="grid">${emptyState('Arama yapılamadı', 'İnternet bağlantısını kontrol edin.', 'globe')}</div>`
    : `<div class="grid">${list.map(d => posterCard(onlineItem(d), { caption: true })).join('') || emptyState(T('“{q}” için sonuç yok', { q: OL.q }), 'Farklı bir yazım ya da orijinal adıyla aramayı deneyin.', 'search')}</div>`;
}

// The search overlay also lists online matches under the library's.
function searchOnline(q) {
  clearTimeout(OL.searchT);
  if (q.trim().length < 2) return;
  OL.searchT = setTimeout(async () => {
    let list;
    try { list = await api.get('/api/online/search?q=' + encodeURIComponent(q.trim())); } catch { return; }
    const box = $('#online-hits');
    if (!box || $('#search-input').value !== q || !list.length) return;
    box.innerHTML = `<div class="search-hint">Online · ${T('{n} sonuç', { n: list.length })}</div><div class="grid">${list.slice(0, 40).map(d => posterCard(onlineItem(d), { caption: true })).join('')}</div>`;
  }, 400);
}

/* ---------------- online detail */
async function onlineTitle(kind, tm) {
  const data = await api.get(`/api/online/title/${kind}/${tm}`);
  OL.details.set(`${kind}:${tm}`, data);
  if (data.embed) S.embed = data.embed;
  return data;
}

async function openOnlineDetail(key) {
  const [k, tm] = key.split(':');
  const kind = k === 'om' ? 'm' : 's';
  const el = $('#detail');
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    pushOverlay('detail', () => { el.classList.remove('open'); detailKey = null; });
  }
  detailKey = key;
  $('#detail-scroll').scrollTop = 0;
  const base = itemByKey(key);
  if (base) renderOnlineDetail(base, null);
  else $('#detail-sheet').innerHTML = `<button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button><div style="padding:120px;display:grid;place-items:center"><div class="spin"></div></div>`;
  let data;
  try { data = await onlineTitle(kind, tm); } catch {
    if (detailKey === key && !base) $('#detail-sheet').innerHTML = `<button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button>${emptyState('Bilgiler alınamadı', 'İnternet bağlantısını kontrol edin.', 'globe')}`;
    return;
  }
  if (detailKey !== key) return;
  const it = onlineItem(data);
  renderOnlineDetail(it, data);
  if (kind === 's') loadOnlineSeason(it, data);
}

function renderOnlineDetail(it, data) {
  const tm = it.tm;
  const local = data?.local || (localOf(it)?.key ?? '');
  let actions, resumeNote = '';
  const localBtn = local ? `<button class="btn btn-ghost" data-open="${local}">${icon('film')}${T('Kütüphanede Aç')}</button>` : '';
  if (it.kind === 'om') {
    const prog = data?.progress;
    const resume = prog && !prog[2] && prog[0] > 30;
    actions = `<button class="btn btn-play" data-oplay="m:${tm}">${icon('play', 'fill')}${T(resume ? 'Devam Et' : 'Oynat')}</button>
      ${resume ? `<button class="btn btn-ghost" data-oplay="m:${tm}" data-from="0">${icon('refresh')}${T('Baştan Başla')}</button>` : ''}${listButton(it)}${localBtn}`;
    if (resume && prog[1]) resumeNote = `<div class="resume-note"><div class="progress-line"><i style="width:${clamp(prog[0] / prog[1] * 100, 2, 100)}%"></i></div>${fmtLeft(prog[0], prog[1])}</div>`;
  } else {
    actions = `<button class="btn btn-play" id="series-play" data-oplay="">${icon('play', 'fill')}${T('Oynat')}</button>${listButton(it)}${localBtn}`;
  }
  const extra = [];
  if (it.kind === 'om' && it.rt) extra.push(`<span>${fmtRuntime(it.rt)}</span>`);
  if (it.kind === 'os' && it.seasons?.length) extra.push(`<span>${T('{n} sezon', { n: it.seasons.length })}</span>`);
  extra.push('<span class="badge">Online</span>');
  const meta = [metaLine(it), ...extra].filter(Boolean).join('<i class="sep"></i>');
  const facts = [];
  if (it.ot && fold(it.ot) !== fold(it.t)) facts.push(`<div>${T('Orijinal ad')}: <b>${esc(it.ot)}</b></div>`);
  if (genresOf(it).length) facts.push(`<div>${T('Türler')}: <b>${esc(genresOf(it).map(tx).join(', '))}</b></div>`);
  if (data?.date) facts.push(`<div>${T(it.kind === 'os' ? 'İlk yayın' : 'Vizyon')}: <b>${new Date(data.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })}</b></div>`);
  facts.push(`<div>${T('Kaynak')}: <b>frameXTV (internet)</b></div>`);
  const rec = (data?.rec || []).map(onlineItem);
  $('#detail-sheet').innerHTML = `
    <button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button>
    ${detailHero(it, it.t, actions, meta)}
    <div class="d-body">
      <div class="d-grid"><div>${data?.tagline ? `<p class="pp-tagline" style="margin:14px 0 0">${esc(data.tagline)}</p>` : ''}<p class="plot">${esc(it.p || T('Bu içerik için açıklama bulunamadı.'))}</p>${resumeNote}</div><div class="facts">${facts.join('')}</div></div>
      ${it.kind === 'os' ? `<div class="section" id="episodes"><div class="section-head"><h3>${T('Bölümler')}</h3></div><div class="eps">${data ? '<div class="spin" style="margin:20px auto"></div>' : ''}</div></div>` : ''}
      ${rec.length ? `<div class="section"><div class="section-head"><h3>${T('Benzer İçerikler')}</h3></div><div class="grid">${rec.map(x => posterCard(x, { caption: true })).join('')}</div></div>` : ''}
    </div>`;
  fillProviders(data?.prov, detailKey);
}

// Where "Play" starts a series: after the last episode watched (or in it, if unfinished), else the first one.
function onlineSeriesTarget(data) {
  const seasons = data.seasons || [];
  let last = null;
  for (const [k, p] of Object.entries(data.progress || {})) if (!last || p[3] > last.p[3]) last = { k, p };
  if (!last) return { s: seasons[0][0], e: 1, started: false };
  const [s, e] = last.k.split(':').map(Number);
  const nxt = last.p[2] ? nextOnlineEpisode(seasons, s, e) : null;
  return nxt ? { s: nxt[0], e: nxt[1], started: true } : { s, e, started: true, resume: !last.p[2] && last.p[0] > 30 };
}

async function loadOnlineSeason(it, data, season) {
  const box = $('#episodes');
  if (!box) return;
  const seasons = data.seasons || [];
  if (!seasons.length) { box.innerHTML = `<div class="section-head"><h3>${T('Bölümler')}</h3></div>` + emptyState('Bölüm bilgisi yok', ''); return; }
  const target = onlineSeriesTarget(data);
  const cur = season ?? target.s;
  const playBtn = $('#series-play');
  if (playBtn) {
    playBtn.dataset.oplay = `s:${it.tm}:${target.s}:${target.e}`;
    playBtn.innerHTML = `${icon('play', 'fill')}${T(target.resume ? 'Devam Et' : target.started ? 'Oynat' : 'İzlemeye Başla')} · ${epCode(target.s, target.e)}`;
  }
  const seasonSel = seasons.length > 1 ? `<label class="select"><select id="season-sel">${seasons.map(([n]) => `<option value="${n}"${n === cur ? ' selected' : ''}>${T('Sezon {n}', { n })}</option>`).join('')}</select></label>` : `<span style="color:var(--dim)">${T('Sezon {n}', { n: cur })}</span>`;
  const head = `<div class="section-head"><h3>${T('Bölümler')}</h3>${seasonSel}</div>`;
  const wire = () => { const sel = $('#season-sel'); if (sel) sel.onchange = () => loadOnlineSeason(it, data, +sel.value); };
  box.innerHTML = head + '<div class="eps"><div class="spin" style="margin:20px auto"></div></div>';
  wire();
  let eps;
  try { eps = await api.get(`/api/online/season/${it.tm}/${cur}`); } catch { eps = null; }
  if (detailKey !== it.key || !$('#episodes')) return;
  const today = new Date().toISOString().slice(0, 10);
  const prog = data.progress || {};
  box.innerHTML = head + (!eps ? emptyState('Bölümler alınamadı', 'İnternet bağlantısını kontrol edin.', 'globe') : `<div class="eps">${eps.map(e => {
    const p = prog[`${cur}:${e.n}`];
    const fin = p && p[2];
    const pct = fin ? 100 : p && p[1] ? clamp(p[0] / p[1] * 100, 2, 100) : 0;
    const soon = e.air && e.air > today;
    const thumb = e.still ? `${TMDB_IMG}w300${e.still}` : it.ob ? `${TMDB_IMG}w300${it.ob}` : '';
    const now = target.s === cur && target.e === e.n;
    return `<div class="ep${now ? ' now' : ''}${soon ? ' soon' : ''}" tabindex="0" role="button" ${soon ? '' : `data-oplay="s:${it.tm}:${cur}:${e.n}"`}>
      <div class="num">${e.n}</div>
      <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" onload="this.classList.add('ok')">` : ''}<div class="play-glyph"><span>${icon('play', 'fill')}</span></div>
        ${pct ? `<div class="pbar progress-line"><i style="width:${pct}%"></i></div>` : ''}</div>
      <div><h4><span>${esc(e.name || T('{n}. Bölüm', { n: e.n }))}</span><small>${soon ? `${T('Yayın')}: ${new Date(e.air).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}` : fin ? `<span class="done">${icon('check')}${T('İzlendi')}</span>` : e.rt ? T('{m} dk', { m: e.rt }) : ''}</small></h4>
        <p>${esc(e.ov)}</p></div></div>`;
  }).join('')}</div>`);
  wire();
}

/* ---------------- online player: frameXTV's iframe, steered with postMessage */
const OP = { open: false, kind: '', tm: 0, s: 0, e: 0, info: null, t: 0, d: 0, lastAdvance: 0, lastSave: 0, ended: false,
  guessPlaying: true, nextT: 0 };
const oFrame = () => $('#o-frame');

async function playOnline(spec, opts = {}) {
  const [k, tmS, sS, eS] = spec.split(':');
  const kind = k === 'm' ? 'm' : 's', tm = +tmS;
  let info = OL.details.get(`${kind}:${tm}`);
  if (!info) {
    try { info = await onlineTitle(kind, tm); } catch { return toast(T('İçerik bilgisi alınamadı. İnternet bağlantısını kontrol edin.')); }
  }
  let s = +sS || 0, e = +eS || 0;
  if (kind === 's' && !s) {
    if (!info.seasons?.length) return toast(T('Bu dizinin bölüm bilgisi yok.'));
    ({ s, e } = onlineSeriesTarget(info));
  }
  const prog = kind === 'm' ? info.progress : info.progress?.[`${s}:${e}`];
  const start = opts.from !== undefined ? opts.from : prog && !prog[2] && prog[0] > 30 ? prog[0] : 0;
  const el = $('#oplayer');
  if (OP.open) saveOnline(true);
  else {
    OP.open = true;
    el.classList.add('open');
    pushOverlay('oplayer', closeOnlineNow);
  }
  clearTimeout(OP.nextT);
  Object.assign(OP, { kind, tm, s, e, info, t: start, d: 0, lastAdvance: 0, lastSave: Date.now(), ended: false, guessPlaying: true });
  const sub = kind === 's' ? epCode(s, e) : (info.y || '');
  $('#o-title').textContent = info.t;
  $('#o-sub').textContent = sub;
  $('#o-next').hidden = !(kind === 's' && nextOnlineEpisode(info.seasons, s, e));
  document.title = `${info.t} · Lumbuz`;
  const params = new URLSearchParams({ autoplay: '1' });
  if (start > 0) params.set('t', String(Math.floor(start)));
  params.set('title', kind === 's' ? `${info.t} · ${sub}` : info.t);
  if (info.ob) params.set('poster', `https://image.tmdb.org/t/p/w1280${info.ob}`);
  oFrame().src = `${S.embed}/${tm}${kind === 's' ? `/${s}/${e}` : ''}?${params}`;
  if (start > 30) toast(T('Kaldığın yerden devam ediliyor · {time}', { time: fmtTime(start) }));
  try { document.activeElement?.blur(); } catch {}
}

function onlineKey() { return OP.kind === 'm' ? `om:${OP.tm}` : `oe:${OP.tm}:${OP.s}:${OP.e}`; }

function saveOnline(beacon = false, finished = false) {
  if (!OP.info || !OP.d || (!finished && OP.t < 5)) return;
  OP.lastSave = Date.now();
  const body = JSON.stringify({ key: onlineKey(), position: finished ? OP.d : OP.t, duration: OP.d });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' }));
  else fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function closeOnlineNow() {
  saveOnline(true);
  OP.open = false;
  clearTimeout(OP.nextT);
  oFrame().src = 'about:blank';
  $('#oplayer').classList.remove('open');
  document.title = 'Lumbuz';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  OL.details.delete(`${OP.kind}:${OP.tm}`);  // its progress changed
  setTimeout(async () => {
    await loadUser().catch(() => {});
    if (detailKey && /^o[ms]:/.test(detailKey)) openOnlineDetail(detailKey);
    else if (detailKey) { const it = S.byKey.get(detailKey); if (it && it.kind !== 'c') { renderDetail(it); if (it.kind === 's') loadEpisodes(it); } }
    else softRender();
  }, 400);
}

function onlineEnded() {
  if (OP.ended) return;
  OP.ended = true;
  saveOnline(false, true);
  const nxt = OP.kind === 's' && nextOnlineEpisode(OP.info.seasons, OP.s, OP.e);
  if (!nxt) return;
  toast(`${icon('play', 'fill')} ${T('Sonraki bölüm başlıyor · {code}', { code: epCode(nxt[0], nxt[1]) })}`, 4000);
  OP.nextT = setTimeout(() => { if (OP.open) playOnline(`s:${OP.tm}:${nxt[0]}:${nxt[1]}`, { from: 0 }); }, 5000);
}

function playNextOnline() {
  const nxt = OP.kind === 's' && nextOnlineEpisode(OP.info.seasons, OP.s, OP.e);
  if (!nxt) return;
  saveOnline(false, true);
  playOnline(`s:${OP.tm}:${nxt[0]}:${nxt[1]}`, { from: 0 });
}

function postToPlayer(msg) { try { oFrame().contentWindow.postMessage(msg, '*'); } catch {} }

// Remote, keyboard and media keys while the online player is open. The player only reports time, so "playing"
// means time moved in the last 1.5 s; before any report, play and pause alternate.
function onlineCommand(cmd) {
  if (!OP.open) return;
  const playing = OP.lastAdvance ? Date.now() - OP.lastAdvance < 1500 : OP.guessPlaying;
  if (cmd === 'toggle') { postToPlayer({ action: playing ? 'pause' : 'play' }); OP.guessPlaying = !playing; }
  else if (cmd === 'play') postToPlayer({ action: 'play' });
  else if (cmd === 'pause') postToPlayer({ action: 'pause' });
  else if (cmd === 'back') postToPlayer({ action: 'seekBy', seconds: -10 });
  else if (cmd === 'fwd') postToPlayer({ action: 'seekBy', seconds: 10 });
  else if (cmd === 'next') playNextOnline();
}

function onlineAction(a) {
  if (a === 'close') return back();
  if (a === 'next') return playNextOnline();
  if (a === 'fullscreen') {
    const f = oFrame();
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    if (f.requestFullscreen) return f.requestFullscreen().catch(() => { if (window.pywebview?.api) window.pywebview.api.toggle_fullscreen(); });
    if (window.pywebview?.api) window.pywebview.api.toggle_fullscreen();
  }
}

window.addEventListener('message', ev => {
  if (!OP.open) return;
  let embedOrigin = '';
  try { embedOrigin = new URL(S.embed).origin; } catch {}
  if (ev.source !== oFrame().contentWindow && ev.origin !== embedOrigin) return;
  const d = ev.data;
  if (!d || typeof d !== 'object' || typeof d.event !== 'string') return;
  if (d.event === 'frameXTV:timeupdate') {
    const t = +d.currentTime || 0, dur = +d.duration || 0;
    if (t !== OP.t) OP.lastAdvance = Date.now();
    OP.t = t;
    if (dur > 0) OP.d = dur;
    if (Date.now() - OP.lastSave > 10000) saveOnline();
    if (OP.d && OP.d - t < 1.5 && t > 60) onlineEnded();
  } else if (/ended$/i.test(d.event)) onlineEnded();
});

window.addEventListener('keydown', e => {
  if (!OP.open) return;
  const a = document.activeElement;
  const inBar = a && a.closest && a.closest('.o-bar');
  const k = e.key;
  if (inBar) {
    // Down from the top bar hands the remote back to the player.
    if (k === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); a.blur(); a.classList.remove('hf-focus'); }
    return;
  }
  const media = MEDIA_KEYS[k.toLowerCase()] || MEDIA_CODES[e.keyCode];
  const cmd = media || { ArrowLeft: 'back', ArrowRight: 'fwd', ' ': 'toggle', Enter: 'toggle', k: 'toggle', n: 'next' }[k]
    || (e.keyCode === 23 ? 'toggle' : '');
  if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); return back(); }
  if (k === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); return $('#oplayer .o-bar [data-o]')?.focus(); }
  if (k === 'f') { e.preventDefault(); return onlineAction('fullscreen'); }
  if (!cmd) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  onlineCommand(cmd);
}, true);
document.addEventListener('visibilitychange', () => { if (document.hidden && OP.open) saveOnline(true); });
window.addEventListener('pagehide', () => { if (OP.open) saveOnline(true); });

/* ================================================================ live TV (broadcasters' own free streams) */
// Each device plays the broadcaster's stream directly; the Lumbuz server only lists the channels, keeps their
// logos and checks every few hours which ones are on air. Apple devices and LG TVs play HLS natively; the others
// use hls.js (loaded on first use), and fall back to the native player when a broadcaster blocks hls.js (CORS).
const LV = { data: null, loading: false, error: false, cat: '', q: '', open: false, cur: null, prev: null, pcat: '',
  list: false, hl: null, hls: null, seq: 0, uiT: 0, osdT: 0, listT: 0, numBuf: '', numT: 0, failT: 0, pre: new Set(),
  // The viewer's own IPTV lists: src = the list shown ('' = Lumbuz's built-in channels, else a list id), srcs = the
  // lists, pool = every IPTV channel seen so far by id, ipGroups = each list's groups, ipg/ipq = the page's group
  // ('' or 'g:<name>') and search, ipItems = the channels on the page, ipRows = the player's list.
  src: store.get('live_src', ''), srcs: null, pool: new Map(), ipGroups: {}, ipg: '', ipq: '', ipItems: [], ipTotal: 0,
  ipSeq: 0, ipRows: [], ipRowSeq: 0, ipDead: false, ckT: 0 };
const LIVE_CAT = id => tx(LV.data?.cats.find(c => c.id === id)?.n || '');
const liveCat = ch => (ch.src ? ch.cat || T('Diğer') : LIVE_CAT(ch.cat));
const liveFind = id => LV.pool.get(id) || LV.data?.channels.find(c => c.id === id);
const lVideo = () => $('#l-video');
const PORTRAIT = () => window.matchMedia('(max-width: 760px) and (orientation: portrait)').matches;

async function loadLive() {
  if (LV.data || LV.loading) return LV.data;
  LV.loading = true;
  try { LV.data = await api.get('/api/live'); LV.error = false; } catch { LV.error = true; }
  LV.loading = false;
  return LV.data;
}

function liveLogo(ch) {
  // A logo that doesn't load becomes the channel's name (as text: IPTV names come from the provider).
  return `<div class="l-logo">${ch.logo ? `<img src="${esc(ch.logo)}" alt="${esc(ch.n)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'lt',textContent:this.alt}))">`
    : `<div class="lt" style="color:hsl(${hue(ch.n)},70%,82%)">${esc(ch.n)}</div>`}</div>`;
}

const liveRecent = () => store.get('live_recent', []).map(id => LV.data.channels.find(c => c.id === id)).filter(Boolean);
function liveFilter(cat, q = '') {
  const f = fold(q);
  return LV.data.channels.filter(c => (!cat || c.cat === cat) && (!f || fold(c.n).includes(f)));
}

function liveCard(ch) {
  const watching = LV.open && LV.cur?.id === ch.id;
  return `<button class="lv-card" data-live="${esc(ch.id)}"><span class="lv-no">${ch.no}</span>
    <span class="lv-name">${esc(ch.n)}</span><span class="lv-meta">${esc(liveCat(ch))}${ch.tr ? ' · ' + T('Türkiye') : ''}</span>
    ${liveLogo(ch)}<span class="lv-badges"><span class="lv-pill${ch.dead && !watching ? ' off' : ''}">${T(watching ? 'İZLENİYOR' : ch.dead ? 'BOZUK' : 'CANLI')}</span>${ch.q ? `<span class="lv-q">${esc(ch.q)}</span>` : ''}</span></button>`;
}

async function renderLive() {
  const view = $('#view');
  const head = n => `<div class="page-head"><h1>${T('Canlı TV')}</h1><span class="count">${n}</span></div>`;
  if (!LV.srcs) {
    await loadIptvSources();
    if (S.view !== 'live') return;
  }
  const src = LV.src && LV.srcs.find(x => x.id === LV.src);
  if (src) return renderIptv(src);
  LV.src = '';
  if (!LV.data) {
    if (LV.error) {
      view.innerHTML = head('') + liveSourceBar() + `<div class="grid">${emptyState('Kanal listesi alınamadı', 'Lumbuz sunucusuna ulaşılamıyor.', 'live')}</div>
        <div style="text-align:center;margin-top:-60px"><button class="btn btn-ghost" data-action="live-retry">${icon('refresh')}${T('Tekrar Dene')}</button></div>`;
      return;
    }
    view.innerHTML = head('') + `<div style="height:50vh;display:grid;place-items:center"><div class="spin" style="width:40px;height:40px;border-width:3px"></div></div>`;
    await loadLive();
    if (S.view === 'live') renderLive();
    return;
  }
  const all = LV.data.channels;
  const items = liveFilter(LV.cat, LV.q);
  const recent = !LV.cat && !LV.q ? liveRecent().slice(0, 6) : [];
  const count = c => all.filter(x => x.cat === c).length;
  view.innerHTML = head(`<span class="lv-dot"></span>${T('{n} kanal', { n: all.length })}`) + liveSourceBar() + `
    <div class="lv-tools">
      <div class="chips" id="lv-chips"><button class="chip${LV.cat ? '' : ' on'}" data-lcat="">${T('Tümü')}</button>${LV.data.cats.filter(c => count(c.id))
        .map(c => `<button class="chip${LV.cat === c.id ? ' on' : ''}" data-lcat="${c.id}">${esc(tx(c.n))}<span class="n">${count(c.id)}</span></button>`).join('')}</div>
      <label class="o-search-box">${icon('search')}<input id="live-q" type="search" placeholder="${T('Kanal ara…')}" autocomplete="off" spellcheck="false" value="${esc(LV.q)}"></label>
    </div>
    ${recent.length ? `<h2 class="lv-sec">${T('Son İzlediklerin')}</h2><div class="lv-grid recent">${recent.map(liveCard).join('')}</div><h2 class="lv-sec">${T('Tüm Kanallar')}</h2>` : ''}
    <div class="lv-grid" id="lv-grid">${items.map(liveCard).join('') || emptyState('Kanal bulunamadı', 'Başka bir kategori ya da arama deneyin.', 'live')}</div>`;
  const inp = $('#live-q');
  inp.addEventListener('input', () => {
    LV.q = inp.value;
    $('#lv-grid').innerHTML = liveFilter(LV.cat, LV.q).map(liveCard).join('') || emptyState('Kanal bulunamadı', 'Başka bir arama deneyin.', 'live');
  });
}

/* ---- the viewer's own IPTV lists (M3U link or Xtream Codes login) */
// The Lumbuz server reads the provider's channel list and pages it, so a TV never loads thousands of channels at
// once. Video goes from the provider straight to this device, like the built-in channels.
async function loadIptvSources() {
  try { LV.srcs = (await api.get('/api/iptv')).sources; } catch { LV.srcs = LV.srcs || []; }
  return LV.srcs;
}

function liveSourceBar() {
  return `<div class="lv-srcs" id="lv-srcs">
    <button class="lv-src${LV.src ? '' : ' on'}" data-lsrc="">${icon('livetv')}<span>${T('Lumbuz Kanalları')}</span></button>
    ${(LV.srcs || []).map(s => `<button class="lv-src${LV.src === s.id ? ' on' : ''}" data-lsrc="${s.id}">${icon('list')}<span>${esc(s.name)}</span></button>`).join('')}
    <button class="lv-src add" data-action="iptv-add">${icon('plus')}<span>${T('IPTV Ekle')}</span></button></div>`;
}

function setLiveSource(id) {
  if (LV.src === id) return;
  LV.src = id;
  store.set('live_src', id);
  LV.ipg = ''; LV.ipq = ''; LV.ipItems = []; LV.ipTotal = 0; LV.ipDead = false;
  renderLive().then(() => $(`#lv-srcs [data-lsrc="${id}"]`)?.focus());
}

// A short id from the stream link, so the same channel keeps its id when the provider reorders the list.
function urlKey(u) { let h = 5381; for (let i = 0; i < u.length; i++) h = (h * 33 ^ u.charCodeAt(i)) >>> 0; return h.toString(36); }

function ipCh(sid, it) {
  const id = `i${sid}:${urlKey(it.url)}`;
  let ch = LV.pool.get(id);
  if (!ch) LV.pool.set(id, ch = { id, n: it.n, cat: it.g || '', no: it.no, q: '', logo: it.logo || '', url: it.url, src: sid });
  ch.no = it.no;
  ch.dead = !!it.dead;
  return ch;
}

// Xtream panels serve every channel as HLS too (/live/user/pass/id.m3u8), which browsers play better than the
// MPEG-TS link many M3U lists carry; the list's own link stays as the fallback.
function iptvUrls(u) {
  const m = u.match(/^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.ts)?$/);
  const hls = m ? `${m[1]}/live/${m[2]}/${m[3]}/${m[4]}.m3u8` : '';
  return hls && hls !== u ? [hls, u] : [u];
}

function iptvInfo(src) {
  const d = t => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  const parts = [src.kind === 'xtream' ? 'Xtream Codes' : T('M3U listesi')];
  if (src.exp) parts.push(T('Bitiş: {d}', { d: d(src.exp) }));
  if (src.max) parts.push(T('{n} bağlantı', { n: +src.max }));
  if (src.shared) parts.push(T('Tüm cihazlarda'));
  if (src.updated) parts.push(T('Güncellendi: {d}', { d: d(src.updated) }));
  return `<span class="ip-meta">${esc(parts.join(' · '))}</span>${src.error ? `<span class="ip-warn">${esc(tx(src.error))}</span>` : ''}`;
}

// The broken-channel tools under the list's info: check the channels (the open group, or all), the progress of a
// running check, and the channels hidden as broken (show them, or bring them all back).
function iptvCheckBar(src) {
  const ck = src.checking || {};
  const g = LV.ipg ? LV.ipg.slice(2) || T('Diğer') : '';
  const run = ck.running
    ? `<span class="ip-check-run"><span class="spin"></span>${T('Kontrol ediliyor: {d}/{t} · {n} bozuk', { d: ck.done, t: ck.total, n: ck.dead })}</span>
       <button class="btn btn-ghost btn-sm" data-action="iptv-check-stop">${icon('x')}${T('Durdur')}</button>`
    : `<button class="btn btn-ghost btn-sm" data-action="iptv-check">${icon('check')}${g ? T('“{g}” kanallarını kontrol et', { g: esc(g) }) : T('Tüm kanalları kontrol et')}</button>`;
  const dead = src.dead ? `<span class="ip-meta">${T('{n} bozuk kanal gizli', { n: src.dead })}</span>
    <button class="btn btn-ghost btn-sm" data-action="iptv-dead-toggle">${T(LV.ipDead ? 'Bozukları gizle' : 'Bozukları göster')}</button>
    <button class="btn btn-ghost btn-sm" data-action="iptv-dead-clear">${icon('refresh')}${T('Hepsini geri getir')}</button>` : '';
  return `<div class="ip-bar" id="ip-check">${run}${dead}</div>`;
}

// While a check runs, its progress is read every few seconds; the page is redrawn when it ends.
function watchIptvCheck(src) {
  clearTimeout(LV.ckT);
  if (!src.checking?.running) return;
  LV.ckT = setTimeout(async () => {
    if (S.view !== 'live' || LV.src !== src.id) return;
    try { src.checking = await api.get(`/api/iptv/${src.id}/check`); } catch { return; }
    if (src.checking.running) {
      const box = $('#ip-check');
      if (box) box.outerHTML = iptvCheckBar(src);
      return watchIptvCheck(src);
    }
    await loadIptvSources();
    delete LV.ipGroups[src.id];
    const s = LV.srcs.find(x => x.id === src.id);
    toast(T('Kontrol bitti: {n} bozuk kanal gizlendi', { n: src.checking.dead }), 3000);
    if (s && S.view === 'live' && LV.src === s.id) renderIptv(s);
  }, 3000);
}

async function renderIptv(src) {
  const view = $('#view'), sid = src.id;
  const head = `<div class="page-head"><h1>${T('Canlı TV')}</h1><span class="count"><span class="lv-dot"></span>${T('{n} kanal', { n: src.count })}</span></div>`;
  if (!LV.ipGroups[sid]) {
    view.innerHTML = head + liveSourceBar() + `<div style="height:40vh;display:grid;place-items:center"><div class="spin" style="width:40px;height:40px;border-width:3px"></div></div>`;
    try { LV.ipGroups[sid] = await api.get(`/api/iptv/${sid}/groups${LV.ipDead ? '?dead=1' : ''}`); }
    catch {
      if (S.view === 'live' && LV.src === sid) view.innerHTML = head + liveSourceBar() + `<div class="grid">${emptyState('Kanal listesi alınamadı', 'Lumbuz sunucusuna ulaşılamıyor.', 'live')}</div>`;
      return;
    }
    if (S.view === 'live' && LV.src === sid) renderIptv(src);
    return;
  }
  const groups = LV.ipGroups[sid];
  const recent = !LV.ipg && !LV.ipq ? store.get(`iptv_recent_${sid}`, []).slice(0, 6).map(it => ipCh(sid, it)) : [];
  view.innerHTML = head + liveSourceBar() + `
    <div class="ip-bar">${iptvInfo(src)}
      <button class="btn btn-ghost btn-sm" data-action="iptv-refresh">${icon('refresh')}${T('Yenile')}</button>
      <button class="btn btn-ghost btn-sm" data-action="iptv-edit">${icon('settings')}${T('Düzenle')}</button></div>
    ${iptvCheckBar(src)}
    <div class="lv-tools">
      ${groups.length > 1 ? `<div class="chips" id="lv-chips"><button class="chip${LV.ipg ? '' : ' on'}" data-ipg="">${T('Tümü')}<span class="n">${src.count}</span></button>${groups
        .map(g => `<button class="chip${LV.ipg === 'g:' + g.n ? ' on' : ''}" data-ipg="g:${esc(g.n)}">${esc(g.n || T('Diğer'))}<span class="n">${g.c}</span></button>`).join('')}</div>` : ''}
      <label class="o-search-box">${icon('search')}<input id="live-q" type="search" placeholder="${T('Kanal ara…')}" autocomplete="off" spellcheck="false" value="${esc(LV.ipq)}"></label>
    </div>
    ${recent.length ? `<h2 class="lv-sec">${T('Son İzlediklerin')}</h2><div class="lv-grid recent">${recent.map(liveCard).join('')}</div><h2 class="lv-sec">${T('Tüm Kanallar')}</h2>` : ''}
    <div class="lv-grid" id="lv-grid"></div><div class="ip-more" id="ip-more"></div>`;
  $('#lv-chips .chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  const inp = $('#live-q');
  let t = 0;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { LV.ipq = inp.value; loadIptvPage(true); }, 300); });
  loadIptvPage(true);
  watchIptvCheck(src);
}

async function loadIptvPage(reset) {
  const sid = LV.src, seq = ++LV.ipSeq, grid = $('#lv-grid');
  if (!grid) return;
  if (reset) {
    LV.ipItems = []; LV.ipTotal = 0;
    grid.innerHTML = `<div class="empty"><div class="spin" style="width:34px;height:34px;border-width:3px;margin:0 auto"></div></div>`;
  }
  const g = LV.ipg ? '&g=' + encodeURIComponent(LV.ipg.slice(2)) : '';
  let d = null;
  try { d = await api.get(`/api/iptv/${sid}/channels?off=${LV.ipItems.length}&q=${encodeURIComponent(LV.ipq)}${g}${LV.ipDead ? '&dead=1' : ''}`); } catch {}
  if (seq !== LV.ipSeq || S.view !== 'live' || LV.src !== sid || !$('#lv-grid')) return;
  if (!d) { grid.innerHTML = emptyState('Kanal listesi alınamadı', 'Lumbuz sunucusuna ulaşılamıyor.', 'live'); return; }
  const before = LV.ipItems.length;
  const chs = d.items.map(it => ipCh(sid, it));
  LV.ipItems.push(...chs);
  LV.ipTotal = d.total;
  if (reset) grid.innerHTML = chs.map(liveCard).join('') || emptyState('Kanal bulunamadı', 'Başka bir kategori ya da arama deneyin.', 'live');
  else {
    grid.insertAdjacentHTML('beforeend', chs.map(liveCard).join(''));
    grid.children[before]?.focus();  // the remote carries on from the first new channel
  }
  const left = LV.ipTotal - LV.ipItems.length;
  $('#ip-more').innerHTML = left > 0 ? `<button class="btn btn-ghost btn-sm" data-action="iptv-more">${T('Daha fazla göster ({n})', { n: left })}</button>` : '';
}

function setIptvGroup(g) {
  LV.ipg = g;
  $$('#lv-chips .chip').forEach(b => b.classList.toggle('on', b.dataset.ipg === g));
  loadIptvPage(true);
}

async function loadIpRows() {
  const sid = LV.cur?.src;
  if (!sid) return;
  const seq = ++LV.ipRowSeq;
  const g = LV.pcat ? '&g=' + encodeURIComponent(LV.pcat.slice(2)) : '';
  try {
    if (!LV.ipGroups[sid]) LV.ipGroups[sid] = await api.get(`/api/iptv/${sid}/groups`);
    const d = await api.get(`/api/iptv/${sid}/channels?lim=500${g}`);
    if (seq === LV.ipRowSeq) LV.ipRows = d.items.map(it => ipCh(sid, it));
  } catch {}
  if (seq === LV.ipRowSeq && LV.open && (LV.list || PORTRAIT())) renderLiveList();
}

/* ---- adding and editing an IPTV list */
function iptvForm() {
  let el = $('#iptv-form');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', `<div class="overlay" id="iptv-form" role="dialog" aria-modal="true"><div class="scrim"></div>
      <div class="sheet-scroll" data-dismiss><div class="sheet ip-sheet" id="ip-sheet"></div></div></div>`);
    el = $('#iptv-form');
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); $('#ip-sheet [data-action="iptv-save"]')?.click(); }
    });
  }
  return el;
}

function openIptvForm(src) {
  const el = iptvForm();
  const field = (id, label, attrs = '', cls = '') => `<div class="field ${cls}"><label for="${id}">${T(label)}</label><input id="${id}" ${attrs} autocomplete="off" autocapitalize="off" spellcheck="false"></div>`;
  const share = `<button class="ip-check" data-ipshare aria-pressed="${src?.shared ? 'true' : 'false'}"><span class="box">${icon('check')}</span>${T('Bu sunucuya bağlanan tüm cihazlarda göster')}</button>
    <p class="ip-note">${T('Kapalıyken liste yalnızca bu cihazda görünür. Açıkken bu Lumbuz’u kullanan herkes aboneliğinizle izleyebilir (TV’de eklemek yerine telefondan eklemek için kullanışlı).')}</p>`;
  $('#ip-sheet').innerHTML = `<button class="close" data-action="back" aria-label="${T('Kapat')}">${icon('x')}</button><div class="ip-body">` + (src
    ? `<h2>${T('IPTV listesini düzenle')}</h2><p class="ip-hint">${iptvInfo(src)}</p><div class="form">
        ${field('ip-name', 'Liste adı', `value="${esc(src.name)}"`)}${share}
        <div class="ip-err" id="ip-err" hidden></div>
        <div class="ip-actions"><button class="btn btn-play btn-sm" data-action="iptv-save" data-sid="${src.id}">${T('Kaydet')}</button>
          <button class="btn btn-ghost btn-sm" data-action="iptv-delete" data-sid="${src.id}">${icon('x')}${T('Listeyi sil')}</button></div></div>`
    : `<h2>${T('IPTV Ekle')}</h2><p class="ip-hint">${T('IPTV aboneliğiniz varsa kanal listenizi buraya ekleyin. Kanallar bu cihazda, doğrudan sağlayıcınızdan açılır.')}</p>
      <div class="chips wrap ip-kind"><button class="chip on" data-ipkind="m3u">${T('M3U bağlantısı')}</button><button class="chip" data-ipkind="xtream">Xtream Codes</button></div>
      <div class="form">
        ${field('ip-name', 'Liste adı (isteğe bağlı)', `placeholder="${T('Örn. Ev IPTV')}"`)}
        ${field('ip-url', 'M3U bağlantısı', 'type="url" placeholder="http://…/get.php?username=…&amp;password=…&amp;type=m3u_plus"', 'ip-m3u')}
        ${field('ip-server', 'Sunucu adresi', 'type="url" placeholder="http://sunucu.com:8080"', 'ip-x')}
        ${field('ip-user', 'Kullanıcı adı', '', 'ip-x')}
        ${field('ip-pass', 'Şifre', 'type="password"', 'ip-x')}
        ${share}
        <div class="ip-err" id="ip-err" hidden></div>
        <div class="ip-actions"><button class="btn btn-play btn-sm" data-action="iptv-save">${T('Listeyi ekle')}</button>
          <button class="btn btn-ghost btn-sm" data-action="back">${T('Vazgeç')}</button></div></div>`) + `</div>`;
  if (!src) iptvKind('m3u');
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    pushOverlay('iptv', () => el.classList.remove('open'));
  }
  setTimeout(() => $(src ? '#ip-name' : '.ip-kind .chip.on')?.focus(), 60);
}

function iptvKind(kind) {
  $$('.ip-kind .chip').forEach(b => b.classList.toggle('on', b.dataset.ipkind === kind));
  $$('#ip-sheet .ip-m3u').forEach(x => { x.hidden = kind !== 'm3u'; });
  $$('#ip-sheet .ip-x').forEach(x => { x.hidden = kind !== 'xtream'; });
  $('#ip-sheet').dataset.kind = kind;
}

function iptvError(msg) {
  const e = $('#ip-err');
  if (!e) return toast(msg, 4000);
  e.textContent = msg;
  e.hidden = !msg;
}

async function iptvRequest(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
  if (!r.ok) throw new Error(d.error ? tx(d.error) : T('Lumbuz sunucusuna ulaşılamıyor.'));
  return d;
}

async function iptvAction(a, btn) {
  const cur = LV.srcs?.find(x => x.id === LV.src);
  if (a === 'iptv-add') return openIptvForm(null);
  if (a === 'iptv-edit') return cur && openIptvForm(cur);
  if (a === 'iptv-more') return loadIptvPage(false);
  if (a === 'iptv-check' && cur) {
    try { cur.checking = await api.post(`/api/iptv/${cur.id}/check`, LV.ipg ? { g: LV.ipg.slice(2) } : {}); } catch { return; }
    const box = $('#ip-check');
    if (box) box.outerHTML = iptvCheckBar(cur);
    $('#ip-check [data-action="iptv-check-stop"]')?.focus();
    return watchIptvCheck(cur);
  }
  if (a === 'iptv-check-stop' && cur) {
    await fetch(`/api/iptv/${cur.id}/check`, { method: 'DELETE' }).catch(() => {});
    return;
  }
  if (a === 'iptv-dead-toggle' && cur) {
    LV.ipDead = !LV.ipDead;
    delete LV.ipGroups[cur.id];
    return renderLive();
  }
  if (a === 'iptv-dead-clear' && cur) {
    await fetch(`/api/iptv/${cur.id}/dead`, { method: 'DELETE' }).catch(() => {});
    cur.dead = 0; LV.ipDead = false;
    delete LV.ipGroups[cur.id];
    toast(T('Gizlenen kanallar geri getirildi'));
    return renderLive();
  }
  if (a === 'iptv-refresh') {
    if (!cur || btn.disabled) return;
    btn.disabled = true;
    toast(T('Kanal listesi yenileniyor…'), 2000);
    try {
      const s = await iptvRequest('POST', `/api/iptv/${cur.id}/refresh`);
      Object.assign(cur, s);
      delete LV.ipGroups[cur.id];
      toast(T('{n} kanal', { n: s.count }));
    } catch (e) { toast(e.message, 4000); }
    btn.disabled = false;
    return S.view === 'live' && renderLive();
  }
  if (a === 'iptv-delete') {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.lastChild.textContent = T('Silmek için tekrar basın');
      return;
    }
    try { await iptvRequest('DELETE', `/api/iptv/${btn.dataset.sid}`); } catch (e) { return iptvError(e.message); }
    LV.srcs = LV.srcs.filter(x => x.id !== +btn.dataset.sid);
    store.set(`iptv_recent_${btn.dataset.sid}`, []);
    back();
    LV.src = ''; store.set('live_src', '');
    return renderLive();
  }
  if (a === 'iptv-save') {
    if (btn.disabled) return;
    const val = id => ($(id)?.value || '').trim();
    const shared = $('#ip-sheet [data-ipshare]').getAttribute('aria-pressed') === 'true';
    iptvError('');
    if (btn.dataset.sid) {
      try { await iptvRequest('POST', `/api/iptv/${btn.dataset.sid}`, { name: val('#ip-name'), shared }); }
      catch (e) { return iptvError(e.message); }
      await loadIptvSources();
      back();
      return renderLive();
    }
    const kind = $('#ip-sheet').dataset.kind;
    const body = kind === 'xtream' ? { kind, name: val('#ip-name'), url: val('#ip-server'), username: val('#ip-user'), password: val('#ip-pass'), shared }
      : { kind, name: val('#ip-name'), url: val('#ip-url'), shared };
    if (!body.url || (kind === 'xtream' && !(body.username && body.password))) return iptvError(T('Lütfen tüm alanları doldurun.'));
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin" style="width:18px;height:18px;border-width:2px"></span>${T('Liste okunuyor…')}`;
    try {
      const s = await iptvRequest('POST', '/api/iptv', body);
      await loadIptvSources();
      back();
      toast(T('{name}: {n} kanal eklendi', { name: esc(s.name), n: s.count }), 3000);
      LV.src = ''; setLiveSource(s.id);
    } catch (e) { iptvError(e.message); }
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

/* ---- player */
function liveRows() { return LV.cur?.src ? LV.ipRows : liveFilter(LV.pcat); }

// The player's categories: the built-in channels' own, or an IPTV list's groups ('g:<name>').
function liveListCats() {
  if (LV.cur?.src) return [{ id: '', n: T('Tümü') }, ...(LV.ipGroups[LV.cur.src] || []).map(g => ({ id: 'g:' + g.n, n: g.n || T('Diğer') }))];
  return [{ id: '', n: T('Tümü') }, ...LV.data.cats.filter(c => LV.data.channels.some(x => x.cat === c.id)).map(c => ({ id: c.id, n: tx(c.n) }))];
}

function setLivePcat(id) {
  LV.pcat = id;
  LV.hl = null;
  if (LV.cur?.src) { LV.ipRows = []; loadIpRows(); }
  renderLiveList();
  armListHide();
}

function renderLiveList() {
  const cats = liveListCats();
  $('#l-chips').innerHTML = cats.map(c => `<button class="chip${LV.pcat === c.id ? ' on' : ''}" data-lpcat="${esc(c.id)}">${esc(c.n)}</button>`).join('');
  const rows = liveRows();
  if (!rows.includes(LV.hl)) LV.hl = rows.includes(LV.cur) ? LV.cur : rows[0];
  $('#l-rows').innerHTML = rows.map(ch => `<button class="l-row${ch === LV.hl ? ' hl' : ''}" data-lch="${esc(ch.id)}">
    <span class="no">${ch.no}</span>${liveLogo(ch)}<span class="txt"><strong>${esc(ch.n)}</strong><span>${esc([liveCat(ch), ch.q].filter(Boolean).join(' · '))}</span></span>
    ${ch === LV.cur ? `<span class="lv-pill">${T('İZLENİYOR')}</span>` : ''}</button>`).join('');
  $('.l-chips .chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('#l-rows .l-row.hl')?.scrollIntoView({ block: 'nearest' });
}

function liveHighlight(ch) {
  LV.hl = ch;
  $$('#l-rows .l-row').forEach(r => r.classList.toggle('hl', r.dataset.lch === ch?.id));
  $('#l-rows .l-row.hl')?.scrollIntoView({ block: 'nearest' });
  livePreconnect(ch);
  armListHide();
}

// Opens the connection to a channel's server while it is only highlighted, so switching to it starts sooner.
function livePreconnect(ch) {
  if (!ch?.url) return;
  try {
    const origin = new URL(ch.url).origin;
    if (LV.pre.has(origin)) return;
    LV.pre.add(origin);
    const l = document.createElement('link');
    l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
  } catch {}
}

function liveUI() {
  const el = $('#lplayer');
  el.classList.add('ui');
  clearTimeout(LV.uiT);
  LV.uiT = setTimeout(() => el.classList.remove('ui'), 3500);
}

function armListHide() {
  clearTimeout(LV.listT);
  if (LV.list) LV.listT = setTimeout(() => closeLiveList(), 9000);
}

function openLiveList() {
  if (PORTRAIT()) return;
  if (!LV.list) {
    LV.list = true;
    $('#lplayer').classList.add('listing');
    pushOverlay('llist', () => { LV.list = false; clearTimeout(LV.listT); $('#lplayer').classList.remove('listing'); });
  }
  LV.hl = LV.cur;
  renderLiveList();
  armListHide();
}

function closeLiveList() {
  if (!LV.list) return;
  if (stack[stack.length - 1]?.name === 'llist') back();
}

function showOSD(ch, typed) {
  const osd = $('#l-osd');
  osd.innerHTML = typed ? `<div class="no">${esc(typed)}<span style="opacity:.4">_</span></div>`
    : `<div class="no">${ch.no}</div>${liveLogo(ch)}<div><strong>${esc(ch.n)}</strong><span>${esc(liveCat(ch))} · <span class="lv-dot"></span>${T('CANLI')}</span></div>`;
  osd.classList.add('show');
  clearTimeout(LV.osdT);
  LV.osdT = setTimeout(() => osd.classList.remove('show'), typed ? 1600 : 3200);
}

// The QR code library is only loaded when Settings shows the address, so normal pages don't carry it.
let qrLoading = null;
function drawQR(url) {
  if (!qrLoading) qrLoading = new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = '/static/vendor/qrcode.js';
    sc.onload = () => ok(window.qrcode);
    sc.onerror = () => { qrLoading = null; fail(); };
    document.head.appendChild(sc);
  });
  qrLoading.then(qrcode => {
    const box = $('#st-qr');
    if (!box) return;
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }).catch(() => {});
}

let hlsLoading = null;
function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) hlsLoading = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = '/static/vendor/hls.min.js';
    s.onload = () => ok(window.Hls);
    s.onerror = () => { hlsLoading = null; fail(); };
    document.head.appendChild(s);
  });
  return hlsLoading;
}

const NATIVE_HLS = () => APPLE || WEBOS;
const canNative = () => !!lVideo().canPlayType('application/vnd.apple.mpegurl');

function stopLiveMedia() {
  if (LV.hls) { try { LV.hls.destroy(); } catch {} LV.hls = null; }
  const v = lVideo();
  v.onerror = v.onplaying = null;
  v.removeAttribute('src');
  try { v.load(); } catch {}
  const f = $('#l-frame');
  if (!f.hidden) { f.src = 'about:blank'; f.hidden = true; }
}

async function openLive(id) {
  if (!LV.pool.has(id)) await loadLive();
  const ch = liveFind(id);
  if (!ch) return toast(T('Kanal bulunamadı.'));
  if (!LV.open) {
    LV.open = true;
    LV.pcat = '';
    if (ch.src) {
      // The player's list starts as the page's group: the channels already on the page, then the whole group.
      LV.pcat = LV.ipg;
      LV.ipRows = LV.ipItems.includes(ch) ? LV.ipItems.slice() : [ch];
      if (LV.ipq || !LV.ipItems.includes(ch) || LV.ipItems.length < LV.ipTotal) loadIpRows();
    }
    $('#lplayer').classList.add('open');
    pushOverlay('lplayer', closeLiveNow);
    try { document.activeElement?.blur(); } catch {}
  }
  tuneLive(ch);
  if (PORTRAIT()) renderLiveList();
}

function tuneLive(ch) {
  if (!ch) return;
  if (LV.cur && LV.cur !== ch) LV.prev = LV.cur;
  LV.cur = ch;
  const seq = ++LV.seq;
  if (ch.src) {
    const key = `iptv_recent_${ch.src}`;
    store.set(key, [{ n: ch.n, g: ch.cat, logo: ch.logo, url: ch.url, no: ch.no }, ...store.get(key, []).filter(x => x.url !== ch.url)].slice(0, 8));
  } else {
    store.set('live_last', ch.id);
    store.set('live_recent', [ch.id, ...store.get('live_recent', []).filter(x => x !== ch.id)].slice(0, 8));
  }
  $('#l-title').textContent = ch.n;
  $('#l-sub').textContent = [ch.no, liveCat(ch), ch.q].filter(Boolean).join(' · ');
  document.title = `${ch.n} · ${T('Canlı TV')} · Lumbuz`;
  $('#l-loading-logo').outerHTML = liveLogo(ch).replace('class="l-logo"', 'class="l-logo" id="l-loading-logo"');
  $('#l-loading').classList.remove('off');
  $('#l-error').hidden = true;
  if (LV.list || PORTRAIT()) renderLiveList();
  showOSD(ch);
  liveUI();
  stopLiveMedia();
  clearTimeout(LV.failT);
  $('#lplayer').classList.toggle('yt', !!ch.yt);
  if (ch.yt) {
    const f = $('#l-frame');
    f.hidden = false;
    // The current live video by id (looked up by the server) plays on more devices than the by-channel embed.
    f.src = ch.ytv ? `https://www.youtube.com/embed/${encodeURIComponent(ch.ytv)}?autoplay=1&playsinline=1&rel=0`
      : `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(ch.yt)}&autoplay=1&playsinline=1&rel=0`;
    f.onload = () => { if (seq === LV.seq) $('#l-loading').classList.add('off'); };
    return;
  }
  // Ways to try, in order: each stream URL with hls.js (or natively), then natively when hls.js was refused.
  const urls = ch.src ? iptvUrls(ch.url) : [ch.url, ...(ch.alt || [])];
  const tries = [];
  // Some broadcasters send their playlists without a CORS header, which hls.js needs: the Lumbuz server then
  // passes just the playlist text through (/api/live/pl); the video still comes straight from the broadcaster.
  const proxied = u => (ch.src ? `/api/iptv/pl/${ch.src}?u=${encodeURIComponent(u)}`
    : `/api/live/pl/${encodeURIComponent(ch.id)}?u=${encodeURIComponent(u)}`);
  urls.forEach(u => {
    if (NATIVE_HLS()) { tries.push(['native', u]); return; }  // Apple and LG play HLS themselves; CORS doesn't apply
    if (ch.cors !== false) tries.push(['hls', u]);
    tries.push(['hls', proxied(u)]);
    if (canNative()) tries.push(['native', u]);
  });
  liveAttempt(ch, tries, 0, seq);
}

function liveAttempt(ch, tries, i, seq) {
  if (seq !== LV.seq) return;
  if (i >= tries.length) return liveFailed(ch, 'all');
  const [mode, url] = tries[i];
  let moved = false;
  const next = () => {
    if (moved || seq !== LV.seq) return;
    moved = true;
    clearTimeout(LV.failT);
    stopLiveMedia();
    liveAttempt(ch, tries, i + 1, seq);
  };
  const v = lVideo();
  clearTimeout(LV.failT);
  LV.failT = setTimeout(next, 20000);  // nothing on screen after 20 s: try the next way
  v.onplaying = () => { if (seq === LV.seq) { clearTimeout(LV.failT); $('#l-loading').classList.add('off'); } };
  v.onerror = () => next();
  const start = () => v.play().catch(() => { v.muted = true; updateLiveVol(); v.play().catch(() => {}); });
  if (mode === 'native') {
    v.src = url;
    start();
    return;
  }
  loadHlsJs().then(Hls => {
    if (seq !== LV.seq) return;
    if (!Hls || !Hls.isSupported()) return next();
    const hls = new Hls({
      // Start at a good guess of ~5 Mbit/s (720p-1080p) instead of measuring first, and keep a short buffer:
      // a live channel needs little, and switching channels throws it away anyway.
      abrEwmaDefaultEstimate: 5e6, maxBufferLength: 20, backBufferLength: 20, liveSyncDurationCount: 3,
      capLevelToPlayerSize: true, startFragPrefetch: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2,
    });
    LV.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, start);
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || seq !== LV.seq) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !hls._recovered) { hls._recovered = true; return hls.recoverMediaError(); }
      next();
    });
    hls.loadSource(url);
    hls.attachMedia(v);
  }).catch(next);
}

function liveFailed(ch, code) {
  $('#l-loading').classList.add('off');
  const err = $('#l-error');
  const why = !ch.src ? (ch.tr ? T('Bu kanal yalnızca Türkiye içinden izlenebiliyor. ') : '')
    : location.protocol === 'https:' && /^http:/i.test(ch.url) ? T('Bu IPTV yayını şifresiz (http) olduğu için güvenli (https) adreste açılmıyor; Lumbuz’u ev ağındaki adresinden açın. ')
    : T('IPTV sağlayıcınız yayını vermedi: abonelik süresi ya da aynı anda bağlantı sınırı dolmuş olabilir. ');
  err.innerHTML = `<b>${T('{name} şu an açılmıyor', { name: esc(ch.n) })}</b>${why}${T('Başka bir kanal seçin')}${PORTRAIT() ? '.' : ' (OK).'}`;
  err.hidden = false;
  if (!LV.list) openLiveList();
  if (!ch.src) api.post('/api/live/fail', { id: ch.id, code }).catch(() => {});
  // The server tries the channel once itself and hides it only when it is really gone (not on an https page,
  // where the browser itself refuses http streams).
  else if (!(location.protocol === 'https:' && /^http:/i.test(ch.url))) api.post(`/api/iptv/${ch.src}/fail`, { url: ch.url }).catch(() => {});
}

function zapLive(dir) {
  const rows = liveRows();
  if (!rows.length) return;
  const i = rows.indexOf(LV.cur);
  tuneLive(rows[(i + dir + rows.length) % rows.length]);
}

function liveNumber(d) {
  LV.numBuf = (LV.numBuf + d).slice(-3);
  showOSD(null, LV.numBuf);
  clearTimeout(LV.numT);
  LV.numT = setTimeout(() => {
    const sid = LV.cur?.src;
    if (sid) {
      const n = +LV.numBuf;
      LV.numBuf = '';
      return api.get(`/api/iptv/${sid}/channels?no=${n}`).then(d => {
        if (d.items[0]) tuneLive(ipCh(sid, d.items[0])); else toast(T('Bu numarada kanal yok.'), 1500);
      }).catch(() => {});
    }
    const ch = LV.data.channels.find(c => c.no === +LV.numBuf);
    LV.numBuf = '';
    if (ch) tuneLive(ch); else toast(T('Bu numarada kanal yok.'), 1500);
  }, 1200);
}

function updateLiveVol() { $('#l-volicon').setAttribute('href', lVideo().muted ? '#i-mute' : '#i-vol'); }

function liveAction(a) {
  if (a === 'close') return back();
  if (a === 'list') return LV.list ? closeLiveList() : openLiveList();
  if (a === 'mute') { const v = lVideo(); v.muted = !v.muted; return updateLiveVol(); }
  if (a === 'fullscreen') {
    const el = $('#lplayer'), v = lVideo();
    // iPhone Safari can't put a page element in full screen, only the video itself (its own player).
    const videoOnly = () => { if (v.webkitEnterFullscreen && !LV.cur?.yt) { try { v.webkitEnterFullscreen(); return true; } catch {} } return false; };
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {});
    }
    // On iPhone the video's own full screen is called first, inside the tap: after a refused page-level request
    // the tap no longer counts and iOS blocks it.
    if (/iPhone|iPod/.test(UA) && videoOnly()) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const r = req.call(el);
        if (r && r.catch) r.catch(() => { if (!videoOnly() && window.pywebview?.api) window.pywebview.api.toggle_fullscreen(); });
        return;
      } catch {}
    }
    if (videoOnly()) return;
    if (window.pywebview?.api) window.pywebview.api.toggle_fullscreen();
  }
}

function closeLiveNow() {
  LV.open = false;
  clearTimeout(LV.failT);
  LV.seq++;
  stopLiveMedia();
  $('#lplayer').classList.remove('open', 'listing', 'ui');
  document.title = 'Lumbuz';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (S.view === 'live') softRender();
}

$('#lplayer').addEventListener('click', e => {
  const b = e.target.closest('[data-l]');
  if (b) return liveAction(b.dataset.l);
  const c = e.target.closest('[data-lpcat]');
  if (c) return setLivePcat(c.dataset.lpcat);
  const r = e.target.closest('[data-lch]');
  if (r) { const ch = liveFind(r.dataset.lch); LV.hl = ch; tuneLive(ch); return armListHide(); }
  if (e.target.closest('.l-list')) return armListHide();
  // A tap on the picture shows the controls, a second one opens the list.
  if ($('#lplayer').classList.contains('ui') || LV.list) return LV.list ? closeLiveList() : openLiveList();
  liveUI();
});
$('#l-rows').addEventListener('scroll', () => armListHide(), { passive: true });
lVideo().addEventListener('volumechange', updateLiveVol);

// Remote and keyboard while the live player is open. List closed: up/down (and CH+/CH-) switch channels,
// OK or left opens the list, digits pick a channel number. List open: up/down move, left/right change the
// category, OK switches, Back closes the list.
const CH_UP = [427, 33], CH_DOWN = [428, 34];
window.addEventListener('keydown', e => {
  if (!LV.open) return;
  const k = e.key, code = e.keyCode;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  const ok = k === 'Enter' || code === 13 || code === 23;
  if (k === 'Escape' || code === 461 || k === 'Backspace' || k === 'GoBack') { stop(); return back(); }
  if (/^[0-9]$/.test(k)) { stop(); return liveNumber(k); }
  if (k === 'm' || k === 'M') { stop(); return liveAction('mute'); }
  if (k === 'f' || k === 'F') { stop(); return liveAction('fullscreen'); }
  if (CH_UP.includes(code) || k === 'ChannelUp') { stop(); return zapLive(1); }
  if (CH_DOWN.includes(code) || k === 'ChannelDown') { stop(); return zapLive(-1); }
  if (LV.list) {
    const rows = liveRows();
    const i = rows.indexOf(LV.hl);
    if (k === 'ArrowDown') { stop(); return liveHighlight(rows[Math.min(rows.length - 1, i + 1)]); }
    if (k === 'ArrowUp') { stop(); return liveHighlight(rows[Math.max(0, i - 1)]); }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      stop();
      const cats = liveListCats().map(c => c.id);
      return setLivePcat(cats[(cats.indexOf(LV.pcat) + (k === 'ArrowRight' ? 1 : -1) + cats.length) % cats.length]);
    }
    if (ok) { stop(); if (LV.hl && LV.hl !== LV.cur) tuneLive(LV.hl); return armListHide(); }
    return;
  }
  if (PORTRAIT()) return;
  if (k === 'ArrowUp') { stop(); return zapLive(-1); }
  if (k === 'ArrowDown') { stop(); return zapLive(1); }
  if (ok || k === 'ArrowLeft') { stop(); return openLiveList(); }
  if (k === 'ArrowRight') { stop(); showOSD(LV.cur); return liveUI(); }
  if (k === ' ') { stop(); const v = lVideo(); return v.paused ? v.play().catch(() => {}) : v.pause(); }
}, true);

/* ================================================================ global events */
function shuffleMovie() {
  const pool = randPool();
  if (!pool.length) return toast(T(S.titles.length ? 'Rastgele film ayarlarına uyan film yok. Ayarlar’dan seçimleri genişletin.' : 'Kütüphanede film yok.'), 3200);
  const m = pool[Math.floor(Math.random() * pool.length)];
  toast(`${icon('shuffle')} ${T('Rastgele seçildi: <b>{t}</b>', { t: esc(m.t) })}`, 2200);
  setTimeout(() => play('m', m.id, { title: m.t }), 1100);
}

document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('#player')) return;
  if (t.closest('#oplayer')) { const b = t.closest('[data-o]'); if (b) onlineAction(b.dataset.o); return; }
  if (t.closest('#lplayer')) return;
  const lv = t.closest('[data-live]');
  if (lv) return openLive(lv.dataset.live);
  const lc = t.closest('[data-lcat]');
  if (lc) { LV.cat = lc.dataset.lcat; return renderLive(); }
  const ls = t.closest('[data-lsrc]');
  if (ls) return setLiveSource(ls.dataset.lsrc ? +ls.dataset.lsrc : '');
  const ig = t.closest('[data-ipg]');
  if (ig) return setIptvGroup(ig.dataset.ipg);
  const ik = t.closest('[data-ipkind]');
  if (ik) return iptvKind(ik.dataset.ipkind);
  const ish = t.closest('[data-ipshare]');
  if (ish) return ish.setAttribute('aria-pressed', ish.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  const clip = t.closest('[data-clip]');
  if (clip) { const [list, i] = clip.dataset.clip.split(':'); return playClips(CL.lists[list], +i); }
  const cs = t.closest('[data-csort]');
  if (cs) {
    CL.sort = cs.dataset.csort; store.set('clip_sort', CL.sort);
    $$('#cl-sort .chip').forEach(b => b.classList.toggle('on', b === cs));
    $('#cl-grid').innerHTML = clipGrid();
    return;
  }
  const forget = t.closest('[data-forget]');
  if (forget) {
    e.stopPropagation();
    await fetch('/api/progress/' + encodeURIComponent(forget.dataset.forget), { method: 'DELETE' });
    await loadUser();
    return softRender();
  }
  const op = t.closest('[data-oplay]');
  if (op) {
    e.stopPropagation();
    if (!op.dataset.oplay) return;
    if ($('#search').classList.contains('open')) { back(); await new Promise(r => setTimeout(r, 30)); }
    return playOnline(op.dataset.oplay, op.dataset.from !== undefined ? { from: +op.dataset.from } : {});
  }
  const dl = t.closest('[data-dl]');
  if (dl) { e.stopPropagation(); return startDownload(dl.dataset.dl); }
  const stc = t.closest('[data-st-cat]');
  if (stc) { stShow(stc.dataset.stCat); return; }
  const st = t.closest('[data-st]');
  if (st) return stAction(st.dataset.st);
  const dev = t.closest('[data-dev]');
  if (dev) return devEdit(dev.dataset.dev);
  if (t.closest('[data-dev-save]')) return devSave();
  if (t.closest('[data-dev-cancel]')) return devDone();
  if (t.closest('[data-dev-forget]')) return devForget();
  const dg = t.closest('[data-dir-go]');
  if (dg) return dirGo(dg.dataset.dirGo);
  const dad = t.closest('[data-dir-add]');
  if (dad) return dirAdd(dad.dataset.dirAdd);
  const drm = t.closest('[data-dir-rm]');
  if (drm) return dirRemove(drm.dataset.dirRm);
  if (t.closest('[data-dir-pick]')) return dirPick();
  const pl = t.closest('[data-play]');
  if (pl && pl.dataset.play) {
    const [kind, id] = pl.dataset.play.split(':');
    const it = kind === 'm' ? S.movieToTitle.get(+id) : null;
    return play(kind, +id, { title: it?.t, ...(pl.dataset.from !== undefined ? { from: +pl.dataset.from } : {}) });
  }
  const lst = t.closest('[data-list]');
  if (lst) return toggleList(lst.dataset.list, lst);
  const open = t.closest('[data-open]');
  if (open) {
    if ($('#search').classList.contains('open')) { back(); await new Promise(r => setTimeout(r, 30)); }
    return openDetail(open.dataset.open);
  }
  const cp = t.closest('[data-copy]');
  if (cp) { navigator.clipboard?.writeText(cp.dataset.copy); return toast(T('Adres kopyalandı')); }
  const lang = t.closest('[data-lang]');
  if (lang) return setLang(lang.dataset.lang);
  const rand = t.closest('[data-rand]');
  if (rand) return randAction(rand);
  const go = t.closest('[data-goto]');
  if (go) { back(); setTimeout(() => { location.hash = go.dataset.goto; }, 60); return; }
  const act = t.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'back') return back();
    if (a === 'search') return openSearch();
    if (a === 'settings') return openSettings();
    if (a === 'shuffle') return shuffleMovie();
    if (a === 'kids-surprise') return kidsSurprise();
    if (a === 'online-retry') { OL.error = false; return renderOnline(); }
    if (a === 'live-retry') { LV.error = false; return renderLive(); }
    if (a.startsWith('iptv-')) return iptvAction(a, act);
    if (a === 'clips-retry') { CL.error = false; return renderClips(); }
    if (a === 'clips-shuffle') return playClips(shuffle(CL.items || []), 0);
    if (a === 'clips-shuffle-artist') return playClips(shuffle(CL.lists.artist || []), 0);
    return settingsAction(a);
  }
  if (t.hasAttribute('data-dismiss')) back();
});

document.addEventListener('keydown', e => {
  if (P.open) return playerKeys(e);
  if (OP.open || LV.open) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); return back(); }
  if (typing) return;
  if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); return openSearch(); }
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.matches('[data-open], [data-play], [data-oplay], [data-live], [data-clip], [data-lsrc], [data-ipg]')) {
    e.preventDefault(); document.activeElement.click();
  }
});

let searchT = 0;
$('#search-input').addEventListener('input', e => { clearTimeout(searchT); searchT = setTimeout(() => runSearch(e.target.value), 90); });
$('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $('#search-results [data-open]'); if (first) first.click(); } });
window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', window.scrollY > 30), { passive: true });
window.addEventListener('hashchange', () => { while (stack.length) { const o = stack.pop(); o.onClose(); } document.body.classList.remove('locked'); route(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollStatus(); });

/* ================================================================ boot */
async function migrateV1() {
  if (store.get('hf2_migrated', false)) return;
  try {
    const favorites = store.get('favorites', []);
    const positions = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('pos_')) positions[k.slice(4)] = parseFloat(localStorage.getItem(k));
    }
    if (favorites.length || Object.keys(positions).length) await api.post('/api/migrate', { favorites, positions });
    store.set('hf2_migrated', true);
  } catch {}
}

async function boot() {
  S.browse.movies.sort = store.get('sort_movies', 'added');
  S.browse.series.sort = store.get('sort_series', 'added');
  i18nPage();
  wirePlayer();
  $('#view').innerHTML = `<div style="height:100vh;display:grid;place-items:center"><div class="spin" style="width:40px;height:40px;border-width:3px"></div></div>`;
  await migrateV1();
  try { await Promise.all([loadLibrary(), loadUser()]); }
  catch { $('#view').innerHTML = emptyState('Sunucuya ulaşılamıyor', 'Lumbuz sunucusunun çalıştığından emin olun ve sayfayı yenileyin.'); return; }
  route();
  pollStatus(true);
}
boot();
