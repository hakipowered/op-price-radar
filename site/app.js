/* TCG Price Radar - front end. Reads data/games.json and data/<game>/cards.json written by scripts/update.py. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem('opr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('opr.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const money = v => (v == null || isNaN(v)) ? '–' : (Math.abs(v) >= 1000 ? usd0.format(v) : usd.format(v));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = el => { const v = parseFloat(el.value); return isFinite(v) && v > 0 ? v : null; };
  const img = (id, w) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_${w}w.jpg`;
  const tcgUrl = id => `https://www.tcgplayer.com/product/${id}`;
  const fmtDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtShort = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const PERIOD = { c1: '1 day', c7: '7 days', c30: '30 days', c90: '90 days' };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const nz = v => (v == null ? -Infinity : v);

  function chg(v) {
    if (v == null) return '<span class="flat">–</span>';
    if (Math.abs(v) < 0.05) return '<span class="flat">0.0%</span>';
    return v > 0 ? `<span class="up">▲ ${v.toFixed(1)}%</span>` : `<span class="down">▼ ${Math.abs(v).toFixed(1)}%</span>`;
  }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------------------------------------------------------------- search
  // Normalises TCGplayer names and Courtyard-style titles to the same words.
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ').trim();
  const STOP = new Set(['one', 'piece', 'pokemon', 'card', 'cards', 'game', 'tcg', 'japanese', 'english', 'japan', 'jp', 'en',
    'the', 'of', 'and', 'psa', 'cgc', 'bgs', 'sgc', 'tag', 'ace', 'gem', 'mint', 'mt', 'nm', 'pristine', 'graded', 'holo', 'foil']);
  function tokens(q) {
    const raw = norm(q).split(' ').filter(Boolean);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (STOP.has(t) || /^(19|20)\d\d$/.test(t)) continue;
      if (/^(psa|cgc|bgs|sgc|tag)$/.test(raw[i - 1] || '') && /^\d+$/.test(t)) continue; // a grade, not a card number
      out.push(t);
    }
    return out;
  }
  function synonyms(it) {
    const n = it.n.toLowerCase(), r = (it.r || '').toLowerCase();
    let s = '';
    if (n.includes('alternate art')) s += ' parallel alt aa';
    if (n.includes('super alternate art')) s += ' sap';
    if (n.includes('manga')) s += ' manga rare';
    if (n.includes('(sp)')) s += ' sp spc special';
    if (n.includes('(tr)')) s += ' tr treasure';
    if (n.includes('reverse holofoil')) s += ' reverse rh';
    if (r.includes('special illustration')) s += ' sir';
    else if (r.includes('illustration')) s += ' ir';
    if (r.includes('special art')) s += ' sar';
    else if (r.includes('art rare')) s += ' ar';
    return s;
  }
  function search(list, q) {
    const ts = tokens(q);
    if (!ts.length) return null;
    // A card number (e.g. "#OP01-120" -> op01 120, "#199/165" -> 199 165) pins the result exactly.
    const cands = new Set(ts.filter(t => /\d/.test(t) && t.length > 3));
    for (let i = 0; i < ts.length - 1; i++) if (/\d/.test(ts[i + 1])) cands.add(ts[i] + ts[i + 1]);
    const exact = list.filter(it => it.cnum && cands.has(it.cnum));
    const pool = exact.length ? exact : list;
    const need = exact.length ? 0 : ts.length <= 3 ? ts.length : Math.ceil(ts.length * 0.6);
    const hits = [];
    for (const it of pool) {
      let found = 0, score = 0;
      for (const t of ts) if (it.hay.includes(t)) { found++; score += t.length > 2 ? 2 : 1; }
      if (found >= need) hits.push([it, score]);
    }
    return hits;
  }

  // ---------------------------------------------------------------- domain
  const OP_ORDER = ['L', 'SEC', 'SP', 'TR', 'SR', 'R', 'UC', 'C', 'P', 'PR', 'DON!!'];
  const OP_NAME = { L: 'Leader', SEC: 'Secret Rare', SP: 'Special', TR: 'Treasure Rare', SR: 'Super Rare', R: 'Rare', UC: 'Uncommon', C: 'Common', P: 'Promo', PR: 'Promo', 'DON!!': 'DON!! card' };
  const CHASE = {
    op: { r: /^(SEC|SP|SP CARD|TR|MR)$/i, n: /alternate art|manga|\(sp\)|\(tr\)|treasure|gold|serial|wanted|special foil|parallel/i },
    pk: { r: /illustration|hyper|secret|ultra|shiny|rainbow|amazing|art rare|super rare|character|gold|^(SAR|AR|SR|UR|CHR|CSR|SSR|MUR|HR|BWR)$/i, n: /alternate art|gold|full art/i },
  };
  const rarName = r => (GAME.id === 'op' && OP_NAME[r]) || r;
  const isChase = it => {
    if (it.t !== 'single') return false;
    const c = GAME.id === 'op' ? CHASE.op : CHASE.pk;
    return c.r.test(it.r || '') || c.n.test(it.n);
  };

  // ---------------------------------------------------------------- state
  let GAMES = [], GAME = { id: 'op' }, META = null, ITEMS = [];
  const BYKEY = new Map(), SETS = new Map();
  const S = {
    tab: 'market', q: '', set: '', rar: '', sort: 'price', minPx: '', type: 'all', chase: false, priced: false, page: 1,
    period: 'c7', mType: 'single', mMin: 5, mChase: false, setPeriod: 'c7', setSort: 'date', setQ: '', setPage: 1,
  };
  const PAGE = 60, SET_PAGE = 60;
  const margins = Object.assign({ offer: 75, max: 90, resell: 95, fee: 0 }, store.get('margins', {}));
  const ck = { key: null, kind: 'raw' };

  // watchlist: keys are "<game>|<item key>"; older entries without a game belong to One Piece
  const watch = (() => {
    const raw = store.get('watch', {}), out = {};
    for (const [k, v] of Object.entries(raw)) out[k.includes('|') ? k : `op|${k}`] = v || {};
    return out;
  })();
  const wkey = k => `${GAME.id}|${k}`;
  const gameWatchKeys = () => Object.keys(watch).filter(k => k.startsWith(GAME.id + '|')).map(k => k.slice(GAME.id.length + 1));

  // ---------------------------------------------------------------- theme
  const THEMES = ['system', 'light', 'dark'];
  const ICONS = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  };
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const b = $('#themeBtn');
    b.innerHTML = ICONS[t];
    b.title = `Theme: ${t}. Click to change.`; b.setAttribute('aria-label', b.title);
  }
  let theme = store.get('theme', 'system');
  applyTheme(theme);
  $('#themeBtn').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set('theme', theme); applyTheme(theme);
    if ($('#detail').open) redrawChart();
  });

  // ---------------------------------------------------------------- rows
  function spark(h) {
    const pts = (h || []).map((v, i) => [i, v]).filter(p => p[1] != null);
    if (pts.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
    const n = h.length - 1 || 1, vs = pts.map(p => p[1]);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    let d = '', prev = -2;
    for (const [i, v] of pts) {
      const x = (i / n) * 94 + 1, y = 28 - ((v - lo) / (hi - lo)) * 26;
      d += `${i === prev + 1 ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      prev = i;
    }
    return `<svg class="spark" viewBox="0 0 96 30" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function tags(it) {
    const set = SETS.get(it.s);
    const code = it.no ? `<span class="code">${esc(it.no)}</span>` : '';
    const rar = it.r ? `<span class="rtag${it.chase ? ' chase' : ''}" title="${esc(rarName(it.r))}">${esc(it.r.length > 14 ? it.r.replace(/[^A-Z0-9]/g, '') || it.r : it.r)}</span>`
      : it.t === 'sealed' ? '<span class="rtag">Sealed</span>' : '';
    const chase = it.chase && !(GAME.id === 'op' ? CHASE.op : CHASE.pk).r.test(it.r || '') ? '<span class="rtag chase">Chase</span>' : '';
    const setTxt = set ? `<span>${esc(set.a || set.n)}</span>` : '';
    return code + rar + chase + setTxt;
  }

  function rowHTML(it, period = 'c7') {
    const starred = !!watch[wkey(it.k)];
    const sub = it.cur == null ? 'no recent price' : (it.l != null && it.m != null ? `low ${money(it.l)}` : '');
    return `<div class="row${it.cur == null ? ' unpriced' : ''}" data-k="${esc(it.k)}" tabindex="0" role="button" aria-label="${esc(it.n)}, ${money(it.cur)}">
      <img class="thumb" loading="lazy" alt="" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
      <div class="row-main"><div class="nm">${esc(it.n)}</div><div class="sub">${tags(it)}</div></div>
      <div class="px">${money(it.cur)}<small>${sub}</small><small class="c7m">${chg(it[period])}</small></div>
      <div class="chg">${chg(it[period])}<small>${PERIOD[period]}</small></div>
      ${spark(it.h)}
      <button class="star" type="button" data-star="${esc(it.k)}" aria-pressed="${starred}" aria-label="${starred ? 'Remove from' : 'Add to'} watchlist">${starred ? '★' : '☆'}</button>
    </div>`;
  }

  const emptyHTML = (title, text) => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;

  // ---------------------------------------------------------------- watchlist
  function saveWatch() { store.set('watch', watch); $('#watchCount').textContent = gameWatchKeys().length || ''; }
  function setStar(key, on) {
    $$(`[data-star="${CSS.escape(key)}"]`).forEach(b => {
      b.setAttribute('aria-pressed', on); b.textContent = on ? '★' : '☆';
      b.setAttribute('aria-label', `${on ? 'Remove from' : 'Add to'} watchlist`);
    });
  }
  function toggleWatch(key) {
    const w = wkey(key);
    if (watch[w]) delete watch[w]; else watch[w] = { t: null, n: BYKEY.get(key)?.n || '' };
    saveWatch(); setStar(key, !!watch[w]);
    toast(watch[w] ? 'Added to watchlist' : 'Removed from watchlist');
    if (S.tab === 'watch') renderWatch();
  }

  // ---------------------------------------------------------------- market
  function filtered() {
    const min = parseFloat(S.minPx) || 0;
    let arr = ITEMS.filter(it =>
      (S.type === 'all' || it.t === S.type) &&
      (!S.set || String(it.s) === S.set) &&
      (!S.rar || it.r === S.rar) &&
      (!S.chase || it.chase) &&
      (!S.priced || it.cur != null) &&
      (!min || (it.cur ?? 0) >= min));
    const hits = search(arr, S.q);
    if (hits) {
      if (S.sort === 'price') return hits.sort((a, b) => b[1] - a[1] || nz(b[0].cur) - nz(a[0].cur)).map(h => h[0]);
      arr = hits.map(h => h[0]);
    }
    const sorters = {
      price: (a, b) => nz(b.cur) - nz(a.cur),
      c7: (a, b) => nz(b.c7) - nz(a.c7),
      c30: (a, b) => nz(b.c30) - nz(a.c30),
      c1: (a, b) => nz(b.c1) - nz(a.c1),
      number: (a, b) => (a.no || '~').localeCompare(b.no || '~', 'en', { numeric: true }) || nz(b.cur) - nz(a.cur),
      name: (a, b) => a.n.localeCompare(b.n),
    };
    return arr.sort(sorters[S.sort] || sorters.price);
  }

  function renderMarket() {
    const list = $('#marketList');
    if (!ITEMS.length) { list.innerHTML = ''; $('#resultCount').innerHTML = emptyHTML('No prices yet', ' The first daily update has not finished. Refresh this page in a few minutes.'); return; }
    const arr = filtered();
    const period = ['c1', 'c30'].includes(S.sort) ? S.sort : (HAS.c7 ? 'c7' : 'c1');
    const shown = arr.slice(0, S.page * PAGE);
    list.innerHTML = shown.map(it => rowHTML(it, period)).join('');
    $('#resultCount').innerHTML = arr.length ? `${arr.length.toLocaleString()} results` :
      emptyHTML('Nothing matches', ` Try fewer words, the card number on its own (e.g. ${GAME.id === 'op' ? 'OP05-119' : '199/165'}), or clear a filter.`);
    $('#moreBtn').hidden = shown.length >= arr.length;
  }

  function renderPulse() {
    const per = HAS.c7 ? 'c7' : HAS.c1 ? 'c1' : null;
    if (!per) { $('#pulse').textContent = 'Price history is still building. Daily changes appear after the second daily update.'; return; }
    const singles = ITEMS.filter(i => i.t === 'single' && i[per] != null);
    const up = singles.filter(i => i[per] > 0.05).length, down = singles.filter(i => i[per] < -0.05).length;
    const best = singles.filter(i => i.chase && i.cur >= 5).sort((a, b) => b[per] - a[per])[0];
    const box = ITEMS.filter(i => i.t === 'sealed' && /booster box/i.test(i.n) && i[per] != null && i.cur >= 50).sort((a, b) => b[per] - a[per])[0];
    let html = `${per === 'c7' ? 'This week' : 'Since yesterday'} <b>${up.toLocaleString()}</b> cards rose and <b>${down.toLocaleString()}</b> fell.`;
    if (best && best[per] > 0) html += ` Strongest chase card: <b>${esc(best.n)}</b> ${chg(best[per])} to ${money(best.cur)}.`;
    if (box && box[per] > 0) html += ` Hottest booster box: <b>${esc(box.n.replace(/ Booster Box.*$/i, ''))}</b> ${chg(box[per])}.`;
    $('#pulse').innerHTML = html;
  }

  // ---------------------------------------------------------------- movers
  const HAS = { c1: false, c7: false, c30: false };
  function syncPeriodButtons(sel, current, setsMode) {
    $$(sel + ' button').forEach(b => {
      const p = b.dataset.p, ok = setsMode ? SETS_HAS[p] : HAS[p];
      b.disabled = !ok;
      b.title = ok ? '' : `Available after ${p === 'c1' ? '2 daily updates' : p === 'c7' ? '7 days of history' : '30 days of history'}`;
      b.setAttribute('aria-pressed', p === current);
    });
  }
  function renderMovers() {
    syncPeriodButtons('#periodSeg', S.period);
    const p = S.period, min = parseFloat(S.mMin) || 0;
    const base = ITEMS.filter(it => it.cur != null && (S.mType === 'all' || it.t === S.mType) && it.cur >= min && (!S.mChase || it.chase));
    const withP = base.filter(it => it[p] != null);
    const up = withP.filter(it => it[p] > 0.05).sort((a, b) => b[p] - a[p]).slice(0, 15);
    const down = withP.filter(it => it[p] < -0.05).sort((a, b) => a[p] - b[p]).slice(0, 15);
    const hot = HAS.c30 ? base.filter(it => it.c7 > 0.05 && it.c30 > 0.05)
      .map(it => [it, 0.6 * it.c7 + 0.4 * it.c30]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[0]) : [];
    $('#moverHint').textContent = withP.length ? `${withP.length.toLocaleString()} items priced at ${money(min)} or more have ${PERIOD[p]} of history.` :
      `Not enough history yet for ${PERIOD[p]}. This fills in as daily updates arrive.`;
    const lists = [['#hotList', hot, 'c7', HAS.c30 ? 'No items rising over both 7 and 30 days.' : 'Needs 30 days of history. Check back later this month.'],
      ['#upList', up, p, 'No risers with these settings.'], ['#downList', down, p, 'No fallers with these settings.']];
    for (const [id, arr, per, msg] of lists) {
      const el = $(id);
      el.innerHTML = arr.map(it => rowHTML(it, per)).join('');
      let note = el.nextElementSibling;
      if (!arr.length) {
        if (!note || !note.classList.contains('empty')) { note = document.createElement('div'); note.className = 'empty'; el.after(note); }
        note.innerHTML = `<b>Nothing yet</b>${esc(msg)}`;
      } else if (note && note.classList.contains('empty')) note.remove();
    }
  }

  // ---------------------------------------------------------------- sets heat map
  const SETS_HAS = { c1: false, c7: false, c30: false };
  const TINT = { c1: 6, c7: 1.6, c30: 0.8 };
  function renderSets() {
    syncPeriodButtons('#setPeriod', S.setPeriod, true);
    $$('#setSort button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === S.setSort));
    const grid = $('#setGrid'), p = S.setPeriod;
    const q = norm(S.setQ);
    let sets = [...SETS.values()].filter(s => s.pr > 0 && (!q || norm(`${s.a} ${s.n}`).includes(q)));
    if (!SETS.size) { grid.innerHTML = emptyHTML('No sets yet', ' Sets appear after the first daily update.'); $('#setMore').hidden = true; return; }
    const order = {
      date: (a, b) => (b.d || '').localeCompare(a.d || ''),
      up: (a, b) => nz(b[p]) - nz(a[p]),
      down: (a, b) => (a[p] ?? Infinity) - (b[p] ?? Infinity),
      v: (a, b) => b.v - a.v,
    };
    sets.sort(order[S.setSort]);
    const withData = sets.filter(s => s[p] != null).length;
    $('#setHint').textContent = SETS_HAS[p]
      ? `Each set's index is the combined market price of its 20 most valuable singles. Tint shows the ${p.slice(1)}-day move; ${withData} of ${sets.length} sets have data for this period.`
      : `No ${PERIOD[p]} data yet. Pick a shorter period, or check back once more daily updates have run.`;
    const shown = sets.slice(0, S.setPage * SET_PAGE);
    grid.innerHTML = shown.length ? shown.map(s => {
      const top = s.top && BYKEY.get(s.top), box = s.box && BYKEY.get(s.box), c = s[p];
      const tint = c == null || Math.abs(c) < 0.1 ? '' :
        `background: color-mix(in srgb, var(--${c > 0 ? 'up' : 'down'}) ${Math.min(24, Math.abs(c) * TINT[p]).toFixed(0)}%, var(--surface));`;
      return `<button class="set-tile" type="button" data-set="${s.id}" style="${tint}">
        <div class="set-head"><span class="set-code">${esc(s.a || 'Promo')}</span><span class="code">${s.d ? fmtShort(s.d) + ' ' + s.d.slice(0, 4) : ''}</span></div>
        <div class="set-name">${esc(s.n)}</div>
        <div class="set-val">${s.v ? money(s.v) : '–'}<small>top 20 singles</small></div>
        <div class="set-moves">${['c1', 'c7', 'c30'].map(k => `<span${k === p ? ' class="on"' : ''}>${chg(s[k])}<small>${k.slice(1)}d</small></span>`).join('')}</div>
        ${top ? `<div class="set-top">Top card: <b>${esc(top.n)}</b> ${money(top.cur)}</div>` : ''}
        ${box ? `<div class="set-top">Booster box: <b>${money(box.cur)}</b> ${chg(box[p])}</div>` : ''}
      </button>`;
    }).join('') : emptyHTML('No sets match', ' Try another name or code.');
    $('#setMore').hidden = shown.length >= sets.length;
  }

  // ---------------------------------------------------------------- watchlist tab
  function renderWatch() {
    $('#watchTitle').textContent = `Watchlist · ${GAME.name || ''} ${GAME.lang ? `(${GAME.lang === 'JP' ? 'Japanese' : 'English'})` : ''}`;
    const keys = gameWatchKeys().filter(k => BYKEY.has(k));
    const list = $('#watchList');
    const others = Object.keys(watch).length - gameWatchKeys().length;
    list.nextElementSibling?.classList.contains('empty') && list.nextElementSibling.remove();
    if (!keys.length) {
      list.innerHTML = '';
      list.insertAdjacentHTML('afterend', emptyHTML('Nothing watched in this game', ` Tap the star on any card to follow it, then set the price you want to buy at.${others ? ` You also watch ${others} card${others > 1 ? 's' : ''} in other games.` : ''}`));
      return;
    }
    const rows = keys.map(k => BYKEY.get(k)).sort((a, b) => nz(b.cur) - nz(a.cur));
    list.innerHTML = rows.map(it => {
      const t = watch[wkey(it.k)].t;
      let status = '<span class="status">No target</span>';
      if (t != null && it.cur != null) {
        if (it.cur <= t) status = '<span class="status hit">At target</span>';
        else status = `<span class="status${it.cur <= t * 1.1 ? ' close' : ''}">${((it.cur / t - 1) * 100).toFixed(0)}% away</span>`;
      }
      return `<div class="row watch-row" data-k="${esc(it.k)}" tabindex="0" role="button" aria-label="${esc(it.n)}">
        <img class="thumb" loading="lazy" alt="" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
        <div class="row-main"><div class="nm">${esc(it.n)}</div><div class="sub">${tags(it)}</div></div>
        <div class="px">${money(it.cur)}<small>${chg(it.c7 ?? it.c1)} ${it.c7 != null ? '7d' : '1d'}</small></div>
        <label class="wt-target"><span class="lbl">Target $</span>
          <input class="target-in" type="number" min="0" step="0.01" inputmode="decimal" data-target="${esc(it.k)}" value="${t ?? ''}" placeholder="Set"></label>
        ${status}
        <button class="star" type="button" data-star="${esc(it.k)}" aria-pressed="true" aria-label="Remove from watchlist">★</button>
      </div>`;
    }).join('');
  }
  const alertJSON = () => JSON.stringify({ items: Object.entries(watch).map(([k, v]) => ({ key: k, target: v.t ?? null, note: v.n || '' })) }, null, 2);

  // ---------------------------------------------------------------- detail sheet
  const histCache = new Map();
  const getHist = gid => {
    const k = `${GAME.id}/${gid}`;
    if (!histCache.has(k)) histCache.set(k, fetch(`data/${GAME.id}/sets/${gid}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null));
    return histCache.get(k);
  };
  let chartState = null;
  const guide = ref => ({ offer: ref * margins.offer / 100, max: ref * margins.max / 100, resell: ref * margins.resell / 100 });

  async function openDetail(key) {
    const it = BYKEY.get(key); if (!it) return;
    const set = SETS.get(it.s), w = watch[wkey(it.k)];
    const g = it.cur != null ? guide(it.cur) : null;
    const meta = [
      it.no && `<span class="code">${esc(it.no)}</span>`,
      it.r && `<span class="rtag${it.chase ? ' chase' : ''}">${esc(rarName(it.r))}</span>`,
      it.t === 'sealed' && '<span class="rtag">Sealed product</span>',
      set && `<span class="rtag">${esc(set.n)}</span>`,
      `<span class="rtag">${esc(GAME.lang === 'JP' ? 'Japanese' : 'English')}</span>`,
    ].filter(Boolean).join('');
    $('#detailBody').innerHTML = `
      <button class="icon-btn sheet-close" type="button" data-close aria-label="Close">✕</button>
      <div class="d-head">
        <img class="d-img" alt="${esc(it.n)}" src="${img(it.id, 400)}" onerror="if(this.dataset.f){this.style.visibility='hidden'}else{this.dataset.f=1;this.src='${img(it.id, 200)}'}">
        <div>
          <h2 class="d-title" id="dTitle">${esc(it.n)}</h2>
          <div class="d-meta" id="dMeta">${meta}</div>
          <div class="d-price">${money(it.cur)}<small>${it.cur == null ? 'no recent price' : 'market'}</small></div>
          <div class="d-changes">
            <span>${chg(it.c1)}<small>1d</small></span><span>${chg(it.c7)}<small>7d</small></span>
            <span>${chg(it.c30)}<small>30d</small></span><span>${chg(it.c90)}<small>90d</small></span>
          </div>
        </div>
      </div>
      <div class="d-section">
        <h3>Buy guide for Courtyard</h3>
        ${g ? `<div class="guide">
          <div><span>Offer at</span><b>${money(g.offer)}</b></div>
          <div><span>Pay at most</span><b>${money(g.max)}</b></div>
          <div><span>Resell near</span><b>${money(g.resell)}</b></div>
        </div>
        <p class="col-note" style="margin:10px 0 0">Your margins: offer ${margins.offer}%, max ${margins.max}%, resell ${margins.resell}% of market. Raw ${it.t === 'sealed' ? 'sealed ' : ''}price; a graded copy is worth more.</p>`
        : '<p class="col-note">No recent sales on TCGplayer, so there is no reliable price to guide an offer. Check sold listings before buying.</p>'}
      </div>
      <div class="d-section">
        <h3>Market price history</h3>
        <div class="chart-wrap" id="chartWrap"><p class="col-note">Loading history…</p></div>
      </div>
      <div class="d-section">
        <h3>TCGplayer listings today</h3>
        <div class="d-grid" id="dGrid">
          <div><span>Market</span>${money(it.m)}</div><div><span>Lowest</span>${money(it.l)}</div>
          <div><span>Mid</span>…</div><div><span>High</span>…</div>
        </div>
      </div>
      <div class="d-section">
        <h3>Watch and act</h3>
        <div class="watch-in">
          <label class="field"><span class="lbl">Alert me at or below ($)</span>
            <input id="dTarget" type="number" min="0" step="0.01" inputmode="decimal" value="${w?.t ?? ''}" placeholder="${g ? g.offer.toFixed(2) : ''}"></label>
          <button class="btn" type="button" id="dWatch">${w ? 'Update' : 'Watch'}</button>
        </div>
        <div class="d-actions">
          <button class="btn ghost" type="button" id="dCheck">Check a Courtyard listing</button>
          <button class="btn ghost" type="button" id="dCopy">Copy name</button>
          <a class="btn ghost" href="${tcgUrl(it.id)}" target="_blank" rel="noopener">TCGplayer ↗</a>
          <a class="btn ghost" href="https://courtyard.io" target="_blank" rel="noopener">Courtyard ↗</a>
        </div>
      </div>`;
    const dlg = $('#detail');
    if (!dlg.open) dlg.showModal();
    $('#dWatch').onclick = () => {
      const t = num($('#dTarget'));
      watch[wkey(it.k)] = { t, n: it.n }; saveWatch(); setStar(it.k, true);
      $('#dWatch').textContent = 'Update';
      toast(t ? `Watching at ${money(t)}` : 'Added to watchlist');
      if (S.tab === 'watch') renderWatch();
    };
    $('#dCopy').onclick = () => copy(`${it.n}${it.no ? ' ' + it.no : ''}`, 'Name copied');
    $('#dCheck').onclick = () => { dlg.close(); pickCheck(it.k); showTab('check'); };

    const h = await getHist(it.s);
    if (!$('#detail').open || $('#dTitle')?.textContent !== it.n) return;
    const x = h?.x?.[it.k];
    if (x) {
      $('#dGrid').innerHTML = `<div><span>Market</span>${money(it.m)}</div><div><span>Lowest</span>${money(it.l)}</div>
        <div><span>Mid</span>${money(x[0])}</div><div><span>High</span>${money(x[1])}</div>`;
      const extra = [x[2], x[3]].filter(Boolean).map(v => `<span class="rtag">${esc(v)}</span>`).join('');
      if (extra) $('#dMeta').insertAdjacentHTML('beforeend', extra);
    } else {
      $$('#dGrid div').slice(2).forEach(d => { d.lastChild.textContent = '–'; });
    }
    chartState = h && h.s[it.k] ? { dates: h.dates, vals: h.s[it.k] } : { dates: [], vals: [] };
    redrawChart();
  }

  function redrawChart() {
    const wrap = $('#chartWrap'); if (!wrap || !chartState) return;
    const pts = chartState.dates.map((d, i) => ({ d, t: Date.parse(d + 'T00:00:00Z'), v: chartState.vals[i] })).filter(p => p.v != null);
    if (pts.length < 2) { wrap.innerHTML = '<p class="col-note">History builds with each daily update. Check back in a day or two.</p>'; return; }
    const W = Math.max(280, wrap.clientWidth || 460), H = 190, L = 58, R = 14, T = 14, B = 26;
    let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    const pad = (hi - lo) * 0.12 || hi * 0.1 || 1; lo = Math.max(0, lo - pad); hi += pad;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const X = t => L + (t - t0) / ((t1 - t0) || 1) * (W - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');
    const area = `${line}L${X(t1).toFixed(1)} ${H - B}L${X(t0).toFixed(1)} ${H - B}Z`;
    const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    const last = pts[pts.length - 1];
    wrap.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Market price from ${money(pts[0].v)} on ${fmtShort(pts[0].d)} to ${money(last.v)} on ${fmtShort(last.d)}">
      ${ticks.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${money(v)}</text>`).join('')}
      <path class="area" d="${area}"/><path class="line" d="${line}"/>
      <text class="axis" x="${L}" y="${H - 6}">${fmtShort(pts[0].d)}</text>
      <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmtShort(last.d)}</text>
      <line class="cross" id="cx" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/>
      <circle class="end" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4.5"/>
      <circle class="end" id="cdot" cx="-20" cy="-20" r="4.5"/>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="hit"/>
    </svg><div class="tip" id="ctip" hidden></div>`;
    const svg = $('svg', wrap), tip = $('#ctip'), hit = $('#hit', svg);
    const move = e => {
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width);
      let best = pts[0];
      for (const p of pts) if (Math.abs(X(p.t) - x) < Math.abs(X(best.t) - x)) best = p;
      const bx = X(best.t), by = Y(best.v);
      $('#cx', svg).setAttribute('x1', bx); $('#cx', svg).setAttribute('x2', bx);
      $('#cdot', svg).setAttribute('cx', bx); $('#cdot', svg).setAttribute('cy', by);
      tip.hidden = false;
      tip.innerHTML = `${money(best.v)}<small>${fmtDate(best.d)}</small>`;
      tip.style.left = `${(bx / W) * r.width}px`; tip.style.top = `${(by / H) * r.height}px`;
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; $('#cdot', svg).setAttribute('cx', -20); $('#cx', svg).setAttribute('x1', -10); $('#cx', svg).setAttribute('x2', -10); });
  }

  // ---------------------------------------------------------------- courtyard check
  function gradeFrom(text) {
    const m = String(text || '').match(/\b(PSA|CGC|BGS|SGC)\s*(10|9\.5|9|8\.5|8|7)\b/i);
    return m ? { grader: m[1].toUpperCase(), grade: m[2] } : null;
  }
  function pickCheck(key, fromText) {
    const it = BYKEY.get(key); if (!it) return;
    ck.key = key;
    ck.kind = it.t === 'sealed' ? 'sealed' : 'raw';
    const gr = gradeFrom(fromText);
    if (gr && it.t !== 'sealed') {
      ck.kind = 'graded';
      $('#ckGrader').value = gr.grader; $('#ckGrade').value = gr.grade;
    }
    $('#ckQuery').value = '';
    $('#ckSuggest').hidden = true;
    const p = $('#ckPicked');
    p.hidden = false;
    p.innerHTML = `<img alt="" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="nm">${esc(it.n)}</div><div class="sub">${tags(it)}</div></div>
      <button type="button" class="clear" id="ckClear">Change</button>`;
    $('#ckClear').onclick = () => { ck.key = null; p.hidden = true; $('#ckQuery').focus(); renderVerdict(); };
    syncKind(); renderVerdict();
  }
  function syncKind() {
    $$('#ckKind button').forEach(b => b.setAttribute('aria-pressed', b.dataset.kind === ck.kind));
    $('#gradedRow').hidden = ck.kind !== 'graded';
  }
  function suggest() {
    const box = $('#ckSuggest');
    const hits = search(ITEMS, $('#ckQuery').value);
    if (!hits) { box.hidden = true; return; }
    const top = hits.sort((a, b) => b[1] - a[1] || nz(b[0].cur) - nz(a[0].cur)).slice(0, 8).map(h => h[0]);
    box.hidden = !top.length;
    box.innerHTML = top.map(it => `<button type="button" role="option" data-pick="${esc(it.k)}">
      <img alt="" loading="lazy" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
      <span style="min-width:0"><span class="s-name">${esc(it.n)}</span><span class="s-sub">${esc(it.no || SETS.get(it.s)?.a || '')} · ${esc(it.r || (it.t === 'sealed' ? 'Sealed' : ''))}</span></span>
      <span class="num">${money(it.cur)}</span></button>`).join('');
  }

  function renderVerdict() {
    const box = $('#verdict');
    const it = ck.key && BYKEY.get(ck.key);
    if (!it) {
      box.innerHTML = `<h3>Verdict</h3><p class="verdict-line">Pick the card or product you are looking at on Courtyard, then enter its listed price. You'll get a verdict, the offer to make, and your profit if you resell.</p>
        <div class="advice">Tip: paste the whole Courtyard title, grade included (for example "PSA 10"), and the grade fills in for you.</div>`;
      return;
    }
    const listed = num($('#ckPrice')), top = num($('#ckOffer')), comp = num($('#ckComp'));
    const grader = $('#ckGrader').value, grade = $('#ckGrade').value;
    let ref = it.cur, refLabel = it.t === 'sealed' ? 'Market price (sealed)' : 'Market price (raw)';
    const searchTerm = `${it.n.replace(/\s*\(.*?\)\s*/g, ' ').trim()} ${it.no || ''}`.trim();
    if (ck.kind === 'graded') {
      if (comp) { ref = comp; refLabel = `Your ${grader} ${grade} sale price`; }
      else {
        box.innerHTML = `<div class="verdict-top"><span class="pill neutral">Need a graded price</span></div>
          <p class="verdict-line">A ${esc(grader)} ${esc(grade)} copy sells above a raw one, so the raw price of ${money(it.cur)} can't judge this listing. Add a recent sale price for this grade on the left.</p>
          <div class="advice">Find one here:
            <a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${searchTerm} ${grader} ${grade}`)}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay sold listings ↗</a> ·
            <a href="https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(searchTerm)}" target="_blank" rel="noopener">PriceCharting ↗</a></div>`;
        return;
      }
    }
    if (ref == null) {
      box.innerHTML = `<div class="verdict-top"><span class="pill neutral">No market price</span></div>
        <p class="verdict-line">TCGplayer has no recent sales for this item, so there's nothing reliable to compare against.</p>
        <div class="advice">Check <a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay sold listings ↗</a> before you buy.</div>`;
      return;
    }
    const g = guide(ref), net = g.resell * (1 - margins.fee / 100);
    if (!listed) {
      box.innerHTML = `<div class="verdict-top"><span class="pill neutral">Enter the listed price</span></div>
        <dl class="kv"><dt>${esc(refLabel)}</dt><dd class="big">${money(ref)}</dd>
        <dt>Offer at</dt><dd>${money(g.offer)}</dd><dt>Pay at most</dt><dd>${money(g.max)}</dd><dt>Resell near</dt><dd>${money(g.resell)}</dd></dl>`;
      return;
    }
    const diff = (listed / ref - 1) * 100;
    let pill, line;
    if (listed <= g.offer) { pill = '<span class="pill good">▲ Deal</span>'; line = `Listed ${Math.abs(diff).toFixed(0)}% below market. Buy it if the item checks out.`; }
    else if (listed <= g.max) { pill = '<span class="pill neutral">Fair</span>'; line = `${Math.abs(diff).toFixed(0)}% below market. The margin is thin, so make an offer rather than buying now.`; }
    else if (listed <= ref) { pill = '<span class="pill neutral">Market price</span>'; line = 'No room to flip. Only buy it if you want to keep it.'; }
    else { pill = '<span class="pill bad">▼ Overpriced</span>'; line = `${diff.toFixed(0)}% above market. Make an offer near ${money(g.offer)} or skip it.`; }

    let bid;
    if (top != null && top >= g.offer) bid = `The top offer (${money(top)}) is already above your offer price. Skip it, or wait for the price to drop.`;
    else if (top != null) bid = `Offer <b>${money(Math.min(g.offer, top + 0.25))}</b>. It beats the current top offer of ${money(top)} and keeps your margin.`;
    else bid = `Offer <b>${money(Math.min(g.offer, listed))}</b>.`;

    const profit = net - listed, profitPct = profit / listed * 100;
    const per = it.c7 != null ? 'c7' : 'c1', mv = it[per];
    let trend = '';
    if (mv != null && mv <= -10) trend = `<div class="advice">Careful: this fell ${Math.abs(mv).toFixed(0)}% ${per === 'c7' ? 'this week' : 'since yesterday'}. Courtyard sellers may not have caught up, and the price may keep sliding.</div>`;
    else if (mv != null && mv >= 10) trend = `<div class="advice">This rose ${mv.toFixed(0)}% ${per === 'c7' ? 'this week' : 'since yesterday'}. Listings priced before the rise can be bargains.</div>`;

    box.innerHTML = `<div class="verdict-top">${pill}<span class="code">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% vs market</span></div>
      <p class="verdict-line">${line}</p>
      <dl class="kv">
        <dt>${esc(refLabel)}</dt><dd class="big">${money(ref)}</dd>
        <dt>Listed on Courtyard</dt><dd>${money(listed)}</dd>
        <dt>Your offer price (${margins.offer}%)</dt><dd>${money(g.offer)}</dd>
        <dt>Most you should pay (${margins.max}%)</dt><dd>${money(g.max)}</dd>
      </dl>
      <dl class="kv">
        <dt>Buy at listed, resell at ${money(g.resell)}${margins.fee ? ` less ${margins.fee}% fee` : ''}</dt>
        <dd class="big ${profit >= 0 ? 'up' : 'down'}">${profit >= 0 ? '+' : '−'}${money(Math.abs(profit))}</dd>
        <dt>Return on the purchase</dt><dd class="${profit >= 0 ? 'up' : 'down'}">${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%</dd>
      </dl>
      <div class="advice">${bid}</div>${trend}`;
  }

  function bindMargins() {
    const map = { mOffer: 'offer', mMax: 'max', mResell: 'resell', mFee: 'fee' };
    for (const [id, k] of Object.entries(map)) {
      const el = $('#' + id); el.value = margins[k];
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        if (isFinite(v) && v >= 0) { margins[k] = v; store.set('margins', margins); renderVerdict(); }
      });
    }
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
    catch { toast('Copy blocked. Select the text and copy it manually.'); return false; }
  }

  // ---------------------------------------------------------------- tabs
  const RENDER = { market: renderMarket, movers: renderMovers, sets: renderSets, check: renderVerdict, watch: renderWatch };
  function showTab(tab) {
    if (!RENDER[tab]) tab = 'market';
    S.tab = tab; store.set('tab', tab);
    $$('.tabs [role="tab"]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
    $$('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
    if (META) RENDER[tab]();
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $$('.tabs [role="tab"]').forEach(b => b.addEventListener('click', () => { showTab(b.dataset.tab); window.scrollTo({ top: 0 }); }));

    document.addEventListener('click', e => {
      const star = e.target.closest('[data-star]');
      if (star) { e.stopPropagation(); toggleWatch(star.dataset.star); return; }
      if (e.target.closest('input, label.wt-target')) return;
      const row = e.target.closest('.row[data-k]');
      if (row) openDetail(row.dataset.k);
      const tile = e.target.closest('[data-set]');
      if (tile) { S.set = tile.dataset.set; $('#setSel').value = S.set; S.page = 1; showTab('market'); window.scrollTo({ top: 0 }); }
      const pick = e.target.closest('[data-pick]');
      if (pick) pickCheck(pick.dataset.pick, $('#ckQuery').value);
      if (e.target.closest('[data-close]')) $('#detail').close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('.row[data-k]')) openDetail(e.target.dataset.k);
    });
    $('#detail').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    window.addEventListener('resize', debounce(() => { if ($('#detail').open) redrawChart(); }, 150));

    const rerender = () => { S.page = 1; renderMarket(); };
    $('#q').addEventListener('input', debounce(e => { S.q = e.target.value; rerender(); }, 160));
    $('#setSel').addEventListener('change', e => { S.set = e.target.value; rerender(); });
    $('#rarSel').addEventListener('change', e => { S.rar = e.target.value; rerender(); });
    $('#sortSel').addEventListener('change', e => { S.sort = e.target.value; rerender(); });
    $('#minPx').addEventListener('input', debounce(e => { S.minPx = e.target.value; rerender(); }, 200));
    $$('#typeChips [data-type]').forEach(b => b.addEventListener('click', () => {
      S.type = b.dataset.type;
      $$('#typeChips [data-type]').forEach(x => x.setAttribute('aria-pressed', x === b));
      rerender();
    }));
    $('#chaseChip').addEventListener('click', e => { S.chase = !S.chase; e.currentTarget.setAttribute('aria-pressed', S.chase); rerender(); });
    $('#pricedChip').addEventListener('click', e => { S.priced = !S.priced; e.currentTarget.setAttribute('aria-pressed', S.priced); rerender(); });
    $('#moreBtn').addEventListener('click', () => { S.page++; renderMarket(); });

    $$('#periodSeg button').forEach(b => b.addEventListener('click', () => { S.period = b.dataset.p; renderMovers(); }));
    $$('#moverType button').forEach(b => b.addEventListener('click', () => {
      S.mType = b.dataset.type; $$('#moverType button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderMovers();
    }));
    $('#moverMin').addEventListener('input', debounce(e => { S.mMin = e.target.value; renderMovers(); }, 200));
    $('#moverChase').addEventListener('change', e => { S.mChase = e.target.checked; renderMovers(); });

    $$('#setPeriod button').forEach(b => b.addEventListener('click', () => { S.setPeriod = b.dataset.p; S.setPage = 1; renderSets(); }));
    $$('#setSort button').forEach(b => b.addEventListener('click', () => { S.setSort = b.dataset.s; S.setPage = 1; renderSets(); }));
    $('#setQ').addEventListener('input', debounce(e => { S.setQ = e.target.value; S.setPage = 1; renderSets(); }, 150));
    $('#setMore').addEventListener('click', () => { S.setPage++; renderSets(); });

    $('#ckQuery').addEventListener('input', debounce(suggest, 120));
    $('#ckQuery').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const first = $('#ckSuggest [data-pick]'); if (first) pickCheck(first.dataset.pick, $('#ckQuery').value); }
    });
    $$('#ckKind button').forEach(b => b.addEventListener('click', () => { ck.kind = b.dataset.kind; syncKind(); renderVerdict(); }));
    ['#ckPrice', '#ckOffer', '#ckComp'].forEach(s => $(s).addEventListener('input', renderVerdict));
    ['#ckGrader', '#ckGrade'].forEach(s => $(s).addEventListener('change', renderVerdict));
    $('#checkForm').addEventListener('submit', e => e.preventDefault());
    bindMargins();

    $('#watchList').addEventListener('change', e => {
      const k = e.target.dataset.target; if (!k) return;
      watch[wkey(k)] = { ...(watch[wkey(k)] || {}), t: num(e.target), n: BYKEY.get(k)?.n || '' }; saveWatch(); renderWatch();
    });
    $('#copyWatch').addEventListener('click', async () => {
      const ok = await copy(alertJSON(), 'Alert list copied');
      $('#copyNote').innerHTML = ok ? 'Now open watchlist.json, select everything, paste, and press <b>Commit changes</b>.' :
        `<textarea readonly rows="6" style="width:100%;font:12px var(--f-mono)">${esc(alertJSON())}</textarea>`;
    });
    $('#gameSel').addEventListener('change', e => loadGame(e.target.value));
  }

  // ---------------------------------------------------------------- data loading
  const gameLabel = g => `${g.name} ${g.lang === 'JP' ? '(Japanese)' : '(English)'}`;

  async function loadGame(id) {
    const g = GAMES.find(x => x.game === id) || GAMES[0];
    if (!g) return;
    GAME = { id: g.game, name: g.name, lang: g.lang };
    store.set('game', GAME.id);
    $('#gameSel').value = GAME.id;
    $('#asof').textContent = `Loading ${gameLabel(g)}…`;
    let data;
    try {
      const r = await fetch(`data/${GAME.id}/cards.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      data = await r.json();
    } catch {
      $('#asof').textContent = `Couldn't load ${gameLabel(g)}. Refresh to try again.`;
      return;
    }
    META = data.meta;
    SETS.clear(); BYKEY.clear();
    for (const s of data.sets) SETS.set(s.id, s);
    const F = data.fields;
    ITEMS = data.items.map(a => { const o = {}; F.forEach((f, i) => { o[f] = a[i]; }); return o; });
    for (const it of ITEMS) {
      it.cur = it.p;
      it.chase = isChase(it);
      const set = SETS.get(it.s);
      it.cnum = norm(it.no).replace(/ /g, '');
      it.hay = ` ${norm(`${it.n} ${it.no} ${it.cnum} ${set?.a || ''} ${set?.n || ''} ${it.r || ''}`)}${synonyms(it)} `;
      BYKEY.set(it.k, it);
    }
    for (const p of ['c1', 'c7', 'c30']) {
      HAS[p] = ITEMS.some(i => i[p] != null);
      SETS_HAS[p] = data.sets.some(s => s[p] != null);
    }
    if (!HAS[S.period]) S.period = HAS.c7 ? 'c7' : 'c1';
    S.setPeriod = SETS_HAS.c7 ? 'c7' : SETS_HAS.c1 ? 'c1' : 'c7';

    // reset per-game filters
    Object.assign(S, { set: '', rar: '', page: 1, setPage: 1, setQ: '' });
    $('#setSel').value = ''; $('#setQ').value = '';
    ck.key = null; $('#ckPicked').hidden = true;
    const setOpts = [...SETS.values()].filter(s => s.cnt).sort((a, b) => (b.d || '').localeCompare(a.d || ''))
      .map(s => `<option value="${s.id}">${esc(s.a ? s.a + ' · ' : '')}${esc(s.n)}</option>`).join('');
    $('#setSel').innerHTML = `<option value="">All sets (${SETS.size})</option>${setOpts}`;
    const counts = new Map();
    for (const it of ITEMS) if (it.r) counts.set(it.r, (counts.get(it.r) || 0) + 1);
    const rars = [...counts.keys()].sort((a, b) => GAME.id === 'op'
      ? (OP_ORDER.indexOf(a) + 1 || 99) - (OP_ORDER.indexOf(b) + 1 || 99) : counts.get(b) - counts.get(a));
    $('#rarSel').innerHTML = `<option value="">All rarities</option>${rars.map(r => `<option value="${esc(r)}">${esc(rarName(r))} (${counts.get(r).toLocaleString()})</option>`).join('')}`;

    $('#asof').textContent = `${gameLabel(g)} · prices as of ${fmtDate(META.dataDate)} · ${META.items.toLocaleString()} cards and products`;
    const failed = (META.failed || []).length;
    $('#coverage').textContent = `${gameLabel(g)}: ${META.sets} of ${META.groups} sets loaded${failed ? ` (${failed} failed today and will retry tomorrow)` : ''} · ` +
      `${META.products.toLocaleString()} products, ${META.items.toLocaleString()} including printings · ${META.priced.toLocaleString()} with a price · ${META.historyDays} day${META.historyDays === 1 ? '' : 's'} of history.`;
    $('#editWatch').href = `https://github.com/${META.repo}/edit/main/watchlist.json`;
    saveWatch();
    renderPulse();
    RENDER[S.tab]();
  }

  async function init() {
    bind();
    try {
      const r = await fetch('data/games.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      GAMES = (await r.json()).games || [];
    } catch {
      $('#asof').textContent = 'Waiting for the first price update';
      showTab('market');
      renderMarket();
      return;
    }
    $('#gameSel').innerHTML = GAMES.map(g => `<option value="${esc(g.game)}">${esc(gameLabel(g))}</option>`).join('');
    showTab(location.hash.slice(1) || store.get('tab', 'market'));
    await loadGame(store.get('game', 'op'));
  }
  init();
})();
