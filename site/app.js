/* OP Price Radar - front end. Reads data/cards.json written by scripts/update.py. */
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
  const fmtDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtShort = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const PERIOD = { c1: '1 day', c7: '7 days', c30: '30 days', c90: '90 days' };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

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

  // ---------------------------------------------------------------- domain
  const RAR_ORDER = ['L', 'SEC', 'SP', 'TR', 'SR', 'R', 'UC', 'C', 'P', 'PR', 'DON'];
  const RAR_NAME = { L: 'Leader', SEC: 'Secret Rare', SP: 'Special', TR: 'Treasure Rare', SR: 'Super Rare', R: 'Rare', UC: 'Uncommon', C: 'Common', P: 'Promo', PR: 'Promo', DON: 'DON!!' };
  const CHASE_R = new Set(['SEC', 'SP', 'SP CARD', 'TR', 'MR']);
  const CHASE_NAME = /parallel|alternate art|manga|\(sp\)|treasure|gold|serial|wanted/i;
  const isChase = it => it.t === 'single' && (CHASE_R.has(it.r) || CHASE_NAME.test(it.n));

  // ---------------------------------------------------------------- state
  let META = null, ITEMS = [];
  const BYKEY = new Map(), SETS = new Map();
  const S = {
    tab: 'market', q: '', set: '', sort: 'price', minPx: '', type: 'all', chase: false, rar: new Set(), page: 1,
    period: 'c7', mType: 'single', mMin: 5, mChase: false, setSort: 'date',
  };
  const PAGE = 60;
  const margins = Object.assign({ offer: 75, max: 90, resell: 95, fee: 0 }, store.get('margins', {}));
  const watch = store.get('watch', {});
  const ck = { key: null, kind: 'raw' };

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
    b.title = `Theme: ${t}. Click to change.`; b.setAttribute("aria-label", b.title);
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
    const rar = it.r ? `<span class="rtag${it.chase ? ' chase' : ''}" title="${esc(RAR_NAME[it.r] || it.r)}">${esc(it.r)}</span>`
      : it.t === 'sealed' ? '<span class="rtag">Sealed</span>' : '';
    const chase = it.chase && !CHASE_R.has(it.r) ? '<span class="rtag chase">Chase</span>' : '';
    const setTxt = set ? `<span>${esc(set.a || set.n)}</span>` : '';
    return code + rar + chase + setTxt;
  }

  function rowHTML(it, period = 'c7') {
    const starred = !!watch[it.k];
    const low = it.l != null && it.m != null ? `low ${money(it.l)}` : '';
    return `<div class="row" data-k="${esc(it.k)}" tabindex="0" role="button" aria-label="${esc(it.n)}, ${money(it.cur)}">
      <img class="thumb" loading="lazy" alt="" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
      <div class="row-main"><div class="nm">${esc(it.n)}</div><div class="sub">${tags(it)}</div></div>
      <div class="px">${money(it.cur)}<small>${low}</small><small class="c7m">${chg(it[period])}</small></div>
      <div class="chg">${chg(it[period])}<small>${PERIOD[period]}</small></div>
      ${spark(it.h)}
      <button class="star" type="button" data-star="${esc(it.k)}" aria-pressed="${starred}" aria-label="${starred ? 'Remove from' : 'Add to'} watchlist">${starred ? '★' : '☆'}</button>
    </div>`;
  }

  function emptyHTML(title, text) { return `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`; }

  // ---------------------------------------------------------------- watchlist
  function saveWatch() { store.set('watch', watch); $('#watchCount').textContent = Object.keys(watch).length || ''; }
  function toggleWatch(key) {
    if (watch[key]) delete watch[key]; else watch[key] = { t: null };
    saveWatch();
    $$(`[data-star="${CSS.escape(key)}"]`).forEach(b => {
      const on = !!watch[key];
      b.setAttribute('aria-pressed', on); b.textContent = on ? '★' : '☆';
      b.setAttribute("aria-label", `${on ? "Remove from" : "Add to"} watchlist`);
    });
    toast(watch[key] ? 'Added to watchlist' : 'Removed from watchlist');
    if (S.tab === 'watch') renderWatch();
  }

  // ---------------------------------------------------------------- market
  function filtered() {
    const terms = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const min = parseFloat(S.minPx) || 0;
    const arr = ITEMS.filter(it =>
      (S.type === 'all' || it.t === S.type) &&
      (!S.set || String(it.s) === S.set) &&
      (!S.chase || it.chase) &&
      (!S.rar.size || S.rar.has(it.r)) &&
      (!min || it.cur >= min) &&
      terms.every(t => it.hay.includes(t)));
    const nz = v => (v == null ? -Infinity : v);
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
    const period = ['c1', 'c30'].includes(S.sort) ? S.sort : 'c7';
    const shown = arr.slice(0, S.page * PAGE);
    $('#resultCount').textContent = arr.length ? `${arr.length.toLocaleString()} results` : '';
    list.innerHTML = shown.length ? shown.map(it => rowHTML(it, period)).join('')
      : '';
    if (!arr.length) $('#resultCount').innerHTML = emptyHTML('Nothing matches', ' Try a shorter search or clear a filter.');
    $('#moreBtn').hidden = shown.length >= arr.length;
  }

  function renderPulse() {
    const singles = ITEMS.filter(i => i.t === 'single' && i.c7 != null);
    if (!singles.length) {
      $('#pulse').textContent = 'Price history is still building. Movers and changes appear after the first few daily updates.';
      return;
    }
    const up = singles.filter(i => i.c7 > 0.05).length, down = singles.filter(i => i.c7 < -0.05).length;
    const best = singles.filter(i => i.chase && i.cur >= 5).sort((a, b) => b.c7 - a.c7)[0];
    const box = ITEMS.filter(i => i.t === 'sealed' && /booster box/i.test(i.n) && i.c7 != null && i.cur >= 50).sort((a, b) => b.c7 - a.c7)[0];
    let html = `This week <b>${up.toLocaleString()}</b> cards rose and <b>${down.toLocaleString()}</b> fell.`;
    if (best && best.c7 > 0) html += ` Strongest chase card: <b>${esc(best.n)}</b> ${chg(best.c7)} to ${money(best.cur)}.`;
    if (box && box.c7 > 0) html += ` Hottest booster box: <b>${esc(box.n.replace(/ Booster Box$/i, ''))}</b> ${chg(box.c7)}.`;
    $('#pulse').innerHTML = html;
  }

  // ---------------------------------------------------------------- movers
  function renderMovers() {
    const p = S.period, min = parseFloat(S.mMin) || 0;
    const base = ITEMS.filter(it => (S.mType === 'all' || it.t === S.mType) && it.cur >= min && (!S.mChase || it.chase));
    const withP = base.filter(it => it[p] != null);
    const up = withP.filter(it => it[p] > 0.05).sort((a, b) => b[p] - a[p]).slice(0, 15);
    const down = withP.filter(it => it[p] < -0.05).sort((a, b) => a[p] - b[p]).slice(0, 15);
    const hot = base.filter(it => it.c7 > 0.05 && it.c30 > 0.05)
      .map(it => [it, 0.6 * it.c7 + 0.4 * it.c30]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[0]);
    $('#moverHint').textContent = withP.length ? `${withP.length.toLocaleString()} items priced at ${money(min)} or more have ${PERIOD[p]} of history.` :
      `Not enough history yet for ${PERIOD[p]}. This fills in as daily updates arrive.`;
    $('#hotList').innerHTML = hot.map(it => rowHTML(it, 'c7')).join('');
    $('#upList').innerHTML = up.map(it => rowHTML(it, p)).join('');
    $('#downList').innerHTML = down.map(it => rowHTML(it, p)).join('');
    for (const [id, arr] of [['#hotList', hot], ['#upList', up], ['#downList', down]]) {
      const el = $(id);
      let note = el.nextElementSibling;
      if (!arr.length) {
        if (!note || !note.classList.contains('empty')) { note = document.createElement('div'); note.className = 'empty'; el.after(note); }
        note.innerHTML = '<b>Nothing yet</b>No items match these settings.';
      } else if (note && note.classList.contains('empty')) note.remove();
    }
  }

  // ---------------------------------------------------------------- sets
  function renderSets() {
    const grid = $('#setGrid');
    const sets = [...SETS.values()].filter(s => s.cnt > 0);
    if (!sets.length) { grid.innerHTML = emptyHTML('No sets yet', ' Sets appear after the first daily update.'); return; }
    const nz = v => (v == null ? -Infinity : v);
    const order = {
      date: (a, b) => (b.d || '').localeCompare(a.d || ''),
      c7: (a, b) => nz(b.c7) - nz(a.c7), c30: (a, b) => nz(b.c30) - nz(a.c30), v: (a, b) => b.v - a.v,
    };
    sets.sort(order[S.setSort]);
    grid.innerHTML = sets.map(s => {
      const top = s.top && BYKEY.get(s.top), box = s.box && BYKEY.get(s.box);
      const tint = s.c7 == null || Math.abs(s.c7) < 0.5 ? '' :
        `background: color-mix(in srgb, var(--${s.c7 > 0 ? 'up' : 'down'}) ${Math.min(22, Math.abs(s.c7) * 1.6).toFixed(0)}%, var(--surface));`;
      return `<button class="set-tile" type="button" data-set="${s.id}" style="${tint}">
        <div class="set-head"><span class="set-code">${esc(s.a || 'Promo')}</span><span class="code">${s.d ? fmtShort(s.d) + ' ' + s.d.slice(0, 4) : ''}</span></div>
        <div class="set-name">${esc(s.n)}</div>
        <div class="set-val">${s.v ? money(s.v) : '–'}<small>top 20 singles</small></div>
        <div class="set-moves"><span>${chg(s.c7)}<small>7d</small></span><span>${chg(s.c30)}<small>30d</small></span></div>
        ${top ? `<div class="set-top">Top card: <b>${esc(top.n)}</b> ${money(top.cur)}</div>` : ''}
        ${box ? `<div class="set-top">Booster box: <b>${money(box.cur)}</b> ${chg(box.c7)}</div>` : ''}
      </button>`;
    }).join('');
  }

  // ---------------------------------------------------------------- watchlist tab
  function renderWatch() {
    const keys = Object.keys(watch).filter(k => BYKEY.has(k));
    const list = $('#watchList');
    if (!keys.length) {
      list.innerHTML = '';
      if (!list.nextElementSibling?.classList.contains('empty')) list.insertAdjacentHTML('afterend', emptyHTML('Your watchlist is empty', ' Tap the star on any card to follow it, then set the price you want to buy at.'));
      return;
    }
    list.nextElementSibling?.classList.contains('empty') && list.nextElementSibling.remove();
    const rows = keys.map(k => BYKEY.get(k)).sort((a, b) => b.cur - a.cur);
    list.innerHTML = rows.map(it => {
      const t = watch[it.k].t;
      let status = '<span class="status">No target</span>';
      if (t != null) {
        if (it.cur <= t) status = '<span class="status hit">At target</span>';
        else if (it.cur <= t * 1.1) status = `<span class="status close">${((it.cur / t - 1) * 100).toFixed(0)}% away</span>`;
        else status = `<span class="status">${((it.cur / t - 1) * 100).toFixed(0)}% away</span>`;
      }
      return `<div class="row watch-row" data-k="${esc(it.k)}" tabindex="0" role="button" aria-label="${esc(it.n)}">
        <img class="thumb" loading="lazy" alt="" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
        <div class="row-main"><div class="nm">${esc(it.n)}</div><div class="sub">${tags(it)}</div></div>
        <div class="px">${money(it.cur)}<small>${chg(it.c7)} 7d</small></div>
        <label class="wt-target"><span class="lbl" style="display:block;margin-bottom:4px">Target $</span>
          <input class="target-in" type="number" min="0" step="0.01" inputmode="decimal" data-target="${esc(it.k)}" value="${t ?? ''}" placeholder="Set"></label>
        ${status}
        <button class="star" type="button" data-star="${esc(it.k)}" aria-pressed="true" aria-label="Remove from watchlist">★</button>
      </div>`;
    }).join('');
  }

  function alertJSON() {
    return JSON.stringify({ items: Object.entries(watch).map(([k, v]) => ({ key: k, target: v.t ?? null, note: BYKEY.get(k)?.n || '' })) }, null, 2);
  }

  // ---------------------------------------------------------------- detail sheet
  const histCache = new Map();
  const getHist = gid => {
    if (!histCache.has(gid)) histCache.set(gid, fetch(`data/history/${gid}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null));
    return histCache.get(gid);
  };
  let chartState = null;

  function guide(ref) {
    return {
      offer: ref * margins.offer / 100,
      max: ref * margins.max / 100,
      resell: ref * margins.resell / 100,
    };
  }

  async function openDetail(key) {
    const it = BYKEY.get(key); if (!it) return;
    const set = SETS.get(it.s), g = guide(it.cur), w = watch[it.k];
    const meta = [
      it.no && `<span class="code">${esc(it.no)}</span>`,
      it.r && `<span class="rtag${it.chase ? ' chase' : ''}">${esc(RAR_NAME[it.r] || it.r)}</span>`,
      it.t === 'sealed' && '<span class="rtag">Sealed product</span>',
      it.chase && !CHASE_R.has(it.r) && '<span class="rtag chase">Chase</span>',
      set && `<span class="rtag">${esc(set.n)}</span>`,
      it.c && `<span class="rtag">${esc(it.c)}</span>`,
      it.ct && `<span class="rtag">${esc(it.ct)}</span>`,
    ].filter(Boolean).join('');
    $('#detailBody').innerHTML = `
      <button class="icon-btn sheet-close" type="button" data-close aria-label="Close">✕</button>
      <div class="d-head">
        <img class="d-img" alt="${esc(it.n)}" src="${img(it.id, 400)}" onerror="if(this.dataset.f){this.style.visibility='hidden'}else{this.dataset.f=1;this.src='${img(it.id, 200)}'}">
        <div>
          <h2 class="d-title" id="dTitle">${esc(it.n)}</h2>
          <div class="d-meta">${meta}</div>
          <div class="d-price">${money(it.cur)}<small>market</small></div>
          <div class="d-changes">
            <span>${chg(it.c1)}<small>1d</small></span><span>${chg(it.c7)}<small>7d</small></span>
            <span>${chg(it.c30)}<small>30d</small></span><span>${chg(it.c90)}<small>90d</small></span>
          </div>
        </div>
      </div>
      <div class="d-section">
        <h3>Buy guide for Courtyard</h3>
        <div class="guide">
          <div><span>Offer at</span><b>${money(g.offer)}</b></div>
          <div><span>Pay at most</span><b>${money(g.max)}</b></div>
          <div><span>Resell near</span><b>${money(g.resell)}</b></div>
        </div>
        <p class="col-note" style="margin:10px 0 0">Your margins: offer ${margins.offer}%, max ${margins.max}%, resell ${margins.resell}% of market. Raw ${it.t === 'sealed' ? 'sealed ' : ''}price; a graded copy is worth more.</p>
      </div>
      <div class="d-section">
        <h3>Market price history</h3>
        <div class="chart-wrap" id="chartWrap"><p class="col-note">Loading history…</p></div>
      </div>
      <div class="d-section">
        <h3>TCGplayer listings today</h3>
        <div class="d-grid">
          <div><span>Market</span>${money(it.m)}</div><div><span>Lowest</span>${money(it.l)}</div>
          <div><span>Mid</span>${money(it.mid)}</div><div><span>High</span>${money(it.hi)}</div>
        </div>
      </div>
      <div class="d-section">
        <h3>Watch and act</h3>
        <div class="watch-in">
          <label class="field"><span class="lbl">Alert me at or below ($)</span>
            <input id="dTarget" type="number" min="0" step="0.01" inputmode="decimal" value="${w?.t ?? ''}" placeholder="${g.offer.toFixed(2)}"></label>
          <button class="btn" type="button" id="dWatch">${w ? 'Update' : 'Watch'}</button>
        </div>
        <div class="d-actions">
          <button class="btn ghost" type="button" id="dCheck">Check a Courtyard listing</button>
          <button class="btn ghost" type="button" id="dCopy">Copy name</button>
          ${it.u ? `<a class="btn ghost" href="${esc(it.u)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}
          <a class="btn ghost" href="https://courtyard.io" target="_blank" rel="noopener">Courtyard ↗</a>
        </div>
      </div>`;
    const dlg = $('#detail');
    if (!dlg.open) dlg.showModal();
    $('#dWatch').onclick = () => {
      const t = num($('#dTarget'));
      watch[it.k] = { t }; saveWatch();
      $('#dWatch').textContent = 'Update';
      $$(`[data-star="${CSS.escape(it.k)}"]`).forEach(b => { b.setAttribute('aria-pressed', true); b.textContent = '★'; });
      toast(t ? `Watching at ${money(t)}` : 'Added to watchlist');
      if (S.tab === 'watch') renderWatch();
    };
    $('#dCopy').onclick = () => copy(`${it.n}${it.no ? ' ' + it.no : ''}`, 'Name copied');
    $('#dCheck').onclick = () => { dlg.close(); pickCheck(it.k); showTab('check'); };

    const h = await getHist(it.s);
    if (!$('#detail').open || $('#dTitle')?.textContent !== it.n) return;
    chartState = h && h.s[it.k] ? { dates: h.dates, vals: h.s[it.k] } : { dates: [], vals: [] };
    redrawChart();
  }

  function redrawChart() {
    const wrap = $('#chartWrap'); if (!wrap || !chartState) return;
    const pts = chartState.dates.map((d, i) => ({ d, t: Date.parse(d + 'T00:00:00Z'), v: chartState.vals[i] })).filter(p => p.v != null);
    if (pts.length < 2) { wrap.innerHTML = '<p class="col-note">History builds with each daily update. Check back in a day or two.</p>'; return; }
    const W = Math.max(280, wrap.clientWidth || 460), H = 190, L = 54, R = 14, T = 14, B = 26;
    let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    const pad = (hi - lo) * 0.12 || hi * 0.1 || 1; lo = Math.max(0, lo - pad); hi += pad;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
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
  function pickCheck(key) {
    const it = BYKEY.get(key); if (!it) return;
    ck.key = key;
    ck.kind = it.t === 'sealed' ? 'sealed' : 'raw';
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
    const terms = $('#ckQuery').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const box = $('#ckSuggest');
    if (!terms.length) { box.hidden = true; return; }
    const hits = ITEMS.filter(it => terms.every(t => it.hay.includes(t))).sort((a, b) => (b.cur || 0) - (a.cur || 0)).slice(0, 8);
    box.hidden = !hits.length;
    box.innerHTML = hits.map(it => `<button type="button" role="option" data-pick="${esc(it.k)}">
      <img alt="" loading="lazy" src="${img(it.id, 200)}" onerror="this.style.visibility='hidden'">
      <span style="min-width:0"><span class="s-name" style="display:block">${esc(it.n)}</span><span class="s-sub">${esc(it.no || SETS.get(it.s)?.a || '')} · ${esc(it.r || (it.t === 'sealed' ? 'Sealed' : ''))}</span></span>
      <span class="num">${money(it.cur)}</span></button>`).join('');
  }

  function renderVerdict() {
    const box = $('#verdict');
    const it = ck.key && BYKEY.get(ck.key);
    if (!it) {
      box.innerHTML = `<h3>Verdict</h3><p class="verdict-line">Pick the card or product you are looking at on Courtyard, then enter its listed price. You'll get a verdict, the offer to make, and your profit if you resell.</p>
        <div class="advice">Tip: open any card in <b>Market</b> and tap <b>Check a Courtyard listing</b> to fill this in.</div>`;
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
    if (ref == null) { box.innerHTML = '<p class="verdict-line">No market price for this item yet.</p>'; return; }
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
    let trend = '';
    if (it.c7 != null && it.c7 <= -10) trend = `<div class="advice">Careful: this fell ${Math.abs(it.c7).toFixed(0)}% this week. Courtyard sellers may not have caught up, and the price may keep sliding.</div>`;
    else if (it.c7 != null && it.c7 >= 10) trend = `<div class="advice">This rose ${it.c7.toFixed(0)}% this week. Listings priced before the rise can be bargains.</div>`;

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

  // ---------------------------------------------------------------- copy
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
    RENDER[tab]();
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $$('.tabs [role="tab"]').forEach(b => b.addEventListener('click', () => { showTab(b.dataset.tab); window.scrollTo({ top: 0 }); }));

    // shared row clicks
    document.addEventListener('click', e => {
      const star = e.target.closest('[data-star]');
      if (star) { e.stopPropagation(); toggleWatch(star.dataset.star); return; }
      if (e.target.closest('input, label.wt-target')) return;
      const row = e.target.closest('.row[data-k]');
      if (row) openDetail(row.dataset.k);
      const tile = e.target.closest('[data-set]');
      if (tile) { S.set = tile.dataset.set; $('#setSel').value = S.set; S.page = 1; showTab('market'); window.scrollTo({ top: 0 }); }
      const pick = e.target.closest('[data-pick]');
      if (pick) pickCheck(pick.dataset.pick);
      if (e.target.closest('[data-close]')) $('#detail').close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('.row[data-k]')) openDetail(e.target.dataset.k);
    });
    $('#detail').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    window.addEventListener('resize', debounce(() => { if ($('#detail').open) redrawChart(); }, 150));

    // market filters
    const rerender = () => { S.page = 1; renderMarket(); };
    $('#q').addEventListener('input', debounce(e => { S.q = e.target.value; rerender(); }, 140));
    $('#setSel').addEventListener('change', e => { S.set = e.target.value; rerender(); });
    $('#sortSel').addEventListener('change', e => { S.sort = e.target.value; rerender(); });
    $('#minPx').addEventListener('input', debounce(e => { S.minPx = e.target.value; rerender(); }, 200));
    $$('#typeChips [data-type]').forEach(b => b.addEventListener('click', () => {
      S.type = b.dataset.type;
      $$('#typeChips [data-type]').forEach(x => x.setAttribute('aria-pressed', x === b));
      rerender();
    }));
    $('#chaseChip').addEventListener('click', e => { S.chase = !S.chase; e.currentTarget.setAttribute('aria-pressed', S.chase); rerender(); });
    $('#moreBtn').addEventListener('click', () => { S.page++; renderMarket(); });

    // movers
    const seg = (sel, attr, key, after) => $$(sel + ' button').forEach(b => b.addEventListener('click', () => {
      S[key] = b.dataset[attr];
      $$(sel + ' button').forEach(x => x.setAttribute('aria-pressed', x === b));
      after();
    }));
    seg('#periodSeg', 'p', 'period', renderMovers);
    seg('#moverType', 'type', 'mType', renderMovers);
    seg('#setSort', 's', 'setSort', renderSets);
    $('#moverMin').addEventListener('input', debounce(e => { S.mMin = e.target.value; renderMovers(); }, 200));
    $('#moverChase').addEventListener('change', e => { S.mChase = e.target.checked; renderMovers(); });

    // courtyard check
    $('#ckQuery').addEventListener('input', debounce(suggest, 100));
    $('#ckQuery').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const first = $('#ckSuggest [data-pick]'); if (first) pickCheck(first.dataset.pick); }
    });
    $$('#ckKind button').forEach(b => b.addEventListener('click', () => { ck.kind = b.dataset.kind; syncKind(); renderVerdict(); }));
    ['#ckPrice', '#ckOffer', '#ckComp'].forEach(s => $(s).addEventListener('input', renderVerdict));
    ['#ckGrader', '#ckGrade'].forEach(s => $(s).addEventListener('change', renderVerdict));
    $('#checkForm').addEventListener('submit', e => e.preventDefault());
    bindMargins();

    // watchlist
    $('#watchList').addEventListener('change', e => {
      const k = e.target.dataset.target; if (!k) return;
      watch[k] = { t: num(e.target) }; saveWatch(); renderWatch();
    });
    $('#copyWatch').addEventListener('click', async () => {
      const ok = await copy(alertJSON(), 'Alert list copied');
      $('#copyNote').innerHTML = ok ? 'Now open watchlist.json, select everything, paste, and press <b>Commit changes</b>.' :
        `<textarea readonly rows="6" style="width:100%;font:12px var(--f-mono)">${esc(alertJSON())}</textarea>`;
    });
  }

  // ---------------------------------------------------------------- init
  function init(data) {
    META = data.meta;
    for (const s of data.sets) SETS.set(s.id, s);
    ITEMS = data.items;
    for (const it of ITEMS) {
      it.cur = it.m ?? it.l;
      it.chase = isChase(it);
      const set = SETS.get(it.s);
      it.hay = `${it.n} ${it.no || ''} ${set?.a || ''} ${set?.n || ''}`.toLowerCase();
      BYKEY.set(it.k, it);
    }
    $('#asof').textContent = `One Piece TCG · prices as of ${fmtDate(META.dataDate)} · ${META.items.toLocaleString()} cards and products`;
    const setOpts = [...SETS.values()].filter(s => s.cnt).sort((a, b) => (b.d || '').localeCompare(a.d || ''))
      .map(s => `<option value="${s.id}">${esc(s.a ? s.a + ' · ' : '')}${esc(s.n)}</option>`).join('');
    $('#setSel').insertAdjacentHTML('beforeend', setOpts);
    const rars = [...new Set(ITEMS.map(i => i.r).filter(Boolean))]
      .sort((a, b) => (RAR_ORDER.indexOf(a) + 1 || 99) - (RAR_ORDER.indexOf(b) + 1 || 99));
    $('#rarChips').innerHTML = rars.map(r => `<button class="chip rar" type="button" data-rar="${esc(r)}" aria-pressed="false" title="${esc(RAR_NAME[r] || r)}">${esc(r)}</button>`).join('');
    $$('#rarChips [data-rar]').forEach(b => b.addEventListener('click', () => {
      const r = b.dataset.rar;
      S.rar.has(r) ? S.rar.delete(r) : S.rar.add(r);
      b.setAttribute('aria-pressed', S.rar.has(r)); S.page = 1; renderMarket();
    }));
    $('#editWatch').href = `https://github.com/${META.repo}/edit/main/watchlist.json`;
    saveWatch();
    renderPulse();
    showTab(location.hash.slice(1) || store.get('tab', 'market'));
  }

  bind();
  fetch('data/cards.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => {
      $('#asof').textContent = 'Waiting for the first price update';
      $('#pulse').textContent = '';
      showTab('market');
    });
})();
