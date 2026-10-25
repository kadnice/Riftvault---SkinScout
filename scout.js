// ═══════════════════════════════════════════════════════════════════════════════
// SKIN SCOUT — window logic
//
// Three layouts, picked automatically by window size:
//   • narrow (small window): a one-column list; hover a row to peek at skins.
//   • split  (large window): slim list on the left, the selected champion's
//                            skins shown big on the right.
//   • focus  (large window): just the selected champion's skins, filling the
//                            window, with a strip of champion icons on top.
// In a large window, the Split/Focus buttons in the header switch between the
// last two. The "selected" champion is whichever you last clicked in the
// League client, or clicked here in Skin Scout.
// ═══════════════════════════════════════════════════════════════════════════════

const bodyEl = document.getElementById('scout-body');
const listEl = document.getElementById('scout-list');
const stripEl = document.getElementById('scout-strip');
const focusEl = document.getElementById('scout-focus');
const subEl = document.getElementById('scout-sub');
const footerEl = document.querySelector('.scout-footer');
const searchBtn = document.getElementById('scout-search-btn');
const searchInput = document.getElementById('scout-search');

const WIDE_MIN_WIDTH = 720;  // at this width or more, use Split/Focus
const MAX_CARD_WIDTH = 560;  // biggest a skin card may get (px); the art is ~1.8× taller
const HEADER_HEIGHT = 56;    // must match .scout-header height in scout.css

let lastPayload = null;
let lastClientPickId = 0;    // champion last clicked in the League client
let userPickId = 0;          // champion last clicked here in Skin Scout
let searchQuery = '';
let currentScale = 1;
let layoutPref = 'split';
try { layoutPref = localStorage.getItem('scoutLayout') || 'split'; } catch (e) { /* storage unavailable */ }

// Last HTML written to each area, so we only redraw what actually changed
// (redrawing reloads images, which looks like flicker)
const lastHtml = { list: '', strip: '', focus: '' };

// ─── Build guide panel state ──────────────────────────────────────────────────
// Large window: the guide panel sits to the right of the skins and stays
// open/closed as you last left it. Small window: the guide temporarily takes
// over the list, with a "← Skins" button to go back.
const guideEl = document.getElementById('scout-guide');
const guideView = document.getElementById('scout-guide-view');
const guideTitle = document.getElementById('scout-guide-title');
let guideOpenWide = false;
try { guideOpenWide = localStorage.getItem('scoutGuideOpen') === '1'; } catch (e) { /* storage unavailable */ }
let guideOpenNarrow = false;
let guideUrl = '';          // page currently loaded in the guide panel
let guideChamp = null;      // champion the guide is showing

const GUIDE_ROLES = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };
function skillCappedUrl(championKey, role) {
  const slug = String(championKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = GUIDE_ROLES[role] || '';
  return `https://www.skill-capped.com/lol/guides/builds/${slug}${r ? '/' + r : ''}`;
}

function guideVisible() {
  return currentLayout() === 'narrow' ? guideOpenNarrow : guideOpenWide;
}

function setGuideOpen(open) {
  if (currentLayout() === 'narrow') {
    guideOpenNarrow = open;
  } else {
    guideOpenWide = open;
    try { localStorage.setItem('scoutGuideOpen', open ? '1' : '0'); } catch (e) { /* not important */ }
  }
  lastHtml.focus = ''; // the "Build guide" button label changes
  if (lastPayload) render(lastPayload);
}

/** Shows (and if needed loads) the guide for the selected champion */
function updateGuide(champ) {
  const visible = guideVisible() && !!champ;
  document.body.classList.toggle('guide-open', visible);
  if (!visible) return;
  guideChamp = champ;
  const role = (lastPayload && lastPayload.myRole) || '';
  const url = skillCappedUrl(champ.key, role);
  guideTitle.textContent = `${champ.name} build guide`;
  if (url !== guideUrl) {
    guideUrl = url;
    guideView.setAttribute('src', url); // follows whichever champion you click
  }
}

// Show the guide a little smaller so more of the page fits in the panel
guideView.addEventListener('dom-ready', () => {
  try { guideView.setZoomFactor(0.9); } catch (e) { /* not important */ }
});

document.getElementById('scout-guide-close').addEventListener('click', () => setGuideOpen(false));
document.getElementById('scout-guide-back').addEventListener('click', () => setGuideOpen(false));
document.getElementById('scout-guide-popout').addEventListener('click', () => {
  // Open the same guide in a RiftVault tab instead, and close the panel
  if (guideChamp) window.scoutAPI.openGuide(guideChamp.key, (lastPayload && lastPayload.myRole) || '');
  setGuideOpen(false);
});

// ─── Small helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

function setHtml(el, key, html) {
  if (lastHtml[key] === html) return false;
  lastHtml[key] = html;
  el.innerHTML = html;
  return true;
}

function imgTag(src, fallbacks, cls = '') {
  return `<img class="${cls}" src="${escapeHtml(src)}" alt="" loading="lazy"
    data-fallbacks="${escapeHtml(JSON.stringify(fallbacks || []))}" />`;
}

function tagsFor(champ) {
  const tags = [];
  if (champ.isMine) tags.push('<span class="scout-tag scout-tag--you">You</span>');
  if (champ.onBench) tags.push('<span class="scout-tag scout-tag--bench">Bench</span>');
  if (champ.onTeam) tags.push('<span class="scout-tag scout-tag--team">Team</span>');
  return tags.join('');
}

// ─── Layout + size ─────────────────────────────────────────────────────────────
function currentLayout() {
  return window.innerWidth >= WIDE_MIN_WIDTH ? layoutPref : 'narrow';
}

function applyLayout() {
  const layout = currentLayout();
  document.body.classList.toggle('layout-narrow', layout === 'narrow');
  document.body.classList.toggle('layout-split', layout === 'split');
  document.body.classList.toggle('layout-focus', layout === 'focus');
  document.querySelectorAll('.scout-layout-toggle__btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.layout === layoutPref);
  });
  // Taller than wide (e.g. a vertical monitor): the guide stacks under the skins
  document.body.classList.toggle('is-portrait', window.innerHeight > window.innerWidth);
  // (No CSS zoom here: zoom made Windows think the drag area was lower than the
  // title bar really is, so grabbing the top of the window didn't work.)
  currentScale = 1;
}

document.querySelectorAll('.scout-layout-toggle__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    layoutPref = btn.dataset.layout;
    try { localStorage.setItem('scoutLayout', layoutPref); } catch (e) { /* not important */ }
    applyLayout();
    Object.keys(lastHtml).forEach(k => { lastHtml[k] = ''; }); // force a full redraw
    if (lastPayload) render(lastPayload);
  });
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  const before = currentLayout();
  applyLayout();
  if (before !== currentLayout()) {
    Object.keys(lastHtml).forEach(k => { lastHtml[k] = ''; });
    if (lastPayload) render(lastPayload);
  }
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitFocusCards, 60);
});
applyLayout();

// Re-fit the big cards whenever the panel's size changes for ANY reason:
// the window appearing, maximizing, resizing, or switching layouts
new ResizeObserver(() => fitFocusCards()).observe(focusEl);

/**
 * Sizes the big skin cards so every skin fits in the panel at once, as large
 * as possible. Tries 1 row, 2 rows, 3 rows… and keeps whichever gives the
 * biggest cards.
 */
function fitFocusCards() {
  const grid = focusEl.querySelector('.focus-cards');
  if (!grid) return;
  const count = grid.children.length;
  if (!count) return;
  const W = grid.clientWidth;
  const H = grid.clientHeight;
  if (W < 50 || H < 50) return; // window not visible yet; we'll re-fit when it is
  const GAP = 14;
  const NAME_H = 34;          // space for the skin name under each card
  const ART_RATIO = 308 / 560; // League loading-screen art is tall and narrow
  let best = { w: 0, cols: count };
  for (let rows = 1; rows <= count; rows++) {
    const cols = Math.ceil(count / rows);
    const wByWidth = (W - GAP * (cols - 1)) / cols;
    const artH = (H - GAP * (rows - 1)) / rows - NAME_H;
    const wByHeight = artH * ART_RATIO;
    const w = Math.min(wByWidth, wByHeight, MAX_CARD_WIDTH);
    if (w > best.w) best = { w, cols };
  }
  const cardW = Math.max(90, Math.floor(best.w));
  grid.style.setProperty('--card-w', `${cardW}px`);
  grid.style.gridTemplateColumns = `repeat(${best.cols}, ${cardW}px)`;
}

// ─── Minimize / maximize ──────────────────────────────────────────────────────
document.getElementById('scout-min').addEventListener('click', () => {
  // Tell the main process how tall the title bar is, so it can fold down to it
  // (+2 for the 1px window border at the top and bottom)
  window.scoutAPI.windowAction('minimize', (HEADER_HEIGHT + 2) * currentScale);
});
document.getElementById('scout-pin').addEventListener('click', () => {
  window.scoutAPI.windowAction('pin');
});
document.getElementById('scout-max').addEventListener('click', () => {
  window.scoutAPI.windowAction('maximize');
});
document.querySelector('.scout-header__text').addEventListener('dblclick', () => {
  window.scoutAPI.windowAction('minimize', (HEADER_HEIGHT + 2) * currentScale);
});
window.scoutAPI.onWindowState(({ maximized, collapsed, pinned }) => {
  const pinBtn = document.getElementById('scout-pin');
  pinBtn.classList.toggle('is-active', !!pinned);
  pinBtn.title = pinned
    ? 'Pinned: stays above League (click to unpin)'
    : 'Unpinned: League can cover it (click to keep on top)';
  document.body.classList.toggle('is-maximized', maximized);
  document.body.classList.toggle('is-collapsed', collapsed);
  document.getElementById('scout-max').title = maximized ? 'Restore' : 'Maximize';
  document.getElementById('scout-min').title = collapsed ? 'Expand' : 'Minimize';
});

document.getElementById('scout-close').addEventListener('click', () => window.scoutAPI.dismiss());
document.getElementById('scout-open-main').addEventListener('click', () => window.scoutAPI.openMainWindow());

// ─── Search ───────────────────────────────────────────────────────────────────
function openSearch() {
  footerEl.classList.add('is-searching');
  searchInput.focus();
}
function closeSearch() {
  footerEl.classList.remove('is-searching');
  searchInput.value = '';
  searchQuery = '';
  if (lastPayload) render(lastPayload);
}
searchBtn.addEventListener('click', () => {
  if (footerEl.classList.contains('is-searching')) closeSearch();
  else openSearch();
});
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  if (lastPayload) render(lastPayload);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});

// ─── Pieces of the page ───────────────────────────────────────────────────────
function smallSkinsHtml(champ) {
  return champ.skins.map(s => {
    const cls = ['scout-skin', `scout-skin--${escapeHtml(s.rarity)}`];
    if (champ.canEquip) cls.push('can-equip');
    if (s.id === champ.selectedSkinId) cls.push('is-equipped');
    const title = champ.canEquip ? `${s.name} (click to equip)` : s.name;
    return `<div class="${cls.join(' ')}" data-skin-id="${s.id}" title="${escapeHtml(title)}">
      ${imgTag(s.img, s.fallbacks)}</div>`;
  }).join('');
}

function rowHtml(champ, { selectedId, openIds, layout }) {
  const cls = ['scout-row'];
  const isSelected = champ.id === selectedId;
  if (isSelected) cls.push('is-hovered');
  // Only the small layout opens rows in place; the large layouts show skins in the big panel
  if (layout === 'narrow' && (isSelected || champ.canEquip || openIds.has(champ.id))) cls.push('is-open');
  return `
    <section class="${cls.join(' ')}" data-id="${champ.id}">
      <div class="scout-row__main">
        <img class="scout-row__icon" src="${escapeHtml(champ.iconUrl)}" alt="" />
        <div class="scout-row__name">${escapeHtml(champ.name)} ${tagsFor(champ)}</div>
        <button class="scout-row__guide" data-guide="${escapeHtml(champ.key)}" data-id="${champ.id}" title="Skill Capped build guide"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 4h2v5l-1-.75L9 9V4zm9 16H6V4h1v9l3-2.25L13 13V4h5v16z"/></svg></button>
        <div class="scout-row__count" title="${champ.skinCount} owned skin${champ.skinCount === 1 ? '' : 's'}">${champ.skinCount}</div>
      </div>
      ${layout === 'narrow' ? `<div class="scout-row__skins">${smallSkinsHtml(champ)}</div>` : ''}
    </section>`;
}

function stripHtml(champs, selectedId) {
  return champs.map(c => `
    <button class="scout-strip__item${c.id === selectedId ? ' is-selected' : ''}" data-id="${c.id}" title="${escapeHtml(c.name)}">
      <img src="${escapeHtml(c.iconUrl)}" alt="" />
      <span class="scout-strip__count">${c.skinCount}</span>
    </button>`).join('');
}

function focusHtml(champ) {
  if (!champ) {
    return `<div class="focus-empty">
      <div class="focus-empty__title">Pick a champion</div>
      <div>Click a champion in the League client${currentLayout() === 'focus' ? ' or an icon above' : ' or the list'} to see your skins here.</div>
    </div>`;
  }
  const hint = champ.canEquip ? 'Click a skin to equip it' : (champ.isMine ? 'Lock in to equip from here' : '');
  const cards = champ.skins.map(s => {
    const cls = ['focus-card', `focus-card--${escapeHtml(s.rarity)}`];
    if (champ.canEquip) cls.push('can-equip');
    if (s.id === champ.selectedSkinId) cls.push('is-equipped');
    return `<figure class="${cls.join(' ')}" data-skin-id="${s.id}" title="${escapeHtml(s.name)}">
      <div class="focus-card__art">${imgTag(s.img, s.fallbacks)}</div>
      <figcaption class="focus-card__name">${escapeHtml(s.name)}</figcaption>
    </figure>`;
  }).join('');
  return `
    <header class="focus-header">
      <img class="focus-header__icon" src="${escapeHtml(champ.iconUrl)}" alt="" />
      <div class="focus-header__text">
        <div class="focus-header__name">${escapeHtml(champ.name)} ${tagsFor(champ)}</div>
        <div class="focus-header__meta">${champ.skinCount} owned skin${champ.skinCount === 1 ? '' : 's'}${hint ? ` · ${hint}` : ''}</div>
      </div>
      <button class="focus-guide${guideOpenWide ? ' is-active' : ''}" data-guide="${escapeHtml(champ.key)}" data-id="${champ.id}"
        title="${guideOpenWide ? 'Hide the build guide' : 'Show the Skill Capped build guide next to your skins'}">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 4h2v5l-1-.75L9 9V4zm9 16H6V4h1v9l3-2.25L13 13V4h5v16z"/></svg>
        ${guideOpenWide ? 'Hide guide' : 'Build guide'}
      </button>
    </header>
    <div class="focus-cards">${cards}</div>`;
}

function message(text) {
  return `<div class="scout-empty">${escapeHtml(text)}</div>`;
}

// ─── Main render ──────────────────────────────────────────────────────────────
function render(payload) {
  lastPayload = payload;
  const layout = currentLayout();

  if (payload.state === 'loading') {
    subEl.textContent = 'Loading your skins...';
    setHtml(listEl, 'list', message('Reading your collection from the League client. This takes a few seconds the first time.'));
    setHtml(stripEl, 'strip', '');
    setHtml(focusEl, 'focus', '');
    document.body.classList.remove('guide-open');
    return;
  }

  const { champions, availableCount, mode, hoverId } = payload;
  if (mode === 'preview') subEl.textContent = `Preview · ${champions.length} champs with skins`;
  else if (mode === 'bench') subEl.textContent = `ARAM · ${champions.length} of ${availableCount} available have skins`;
  else subEl.textContent = `${champions.length} of ${availableCount} pickable have skins`;

  // A new click in the League client takes over from a click made here
  if (hoverId && hoverId !== lastClientPickId) userPickId = 0;
  const clientPickChanged = hoverId !== lastClientPickId;
  lastClientPickId = hoverId;

  const shown = searchQuery
    ? champions.filter(c => c.name.toLowerCase().includes(searchQuery))
    : champions;

  // Which champion gets the big view
  const byId = id => champions.find(c => c.id === id);
  const selected = byId(userPickId) || byId(hoverId) || champions.find(c => c.canEquip) || null;
  const selectedId = selected ? selected.id : 0;

  // List (small layout + Split)
  let listHtml;
  if (champions.length === 0) {
    listHtml = message(mode === 'bench'
      ? 'No skins on your champion, the bench, or your teammates right now.'
      : 'None of your pickable champions have skins.');
  } else if (shown.length === 0) {
    listHtml = message(`No champions matching "${searchInput.value.trim()}".`);
  } else {
    const openIds = new Set([...listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)')]
      .map(r => Number(r.dataset.id)));
    listHtml = shown.map(c => rowHtml(c, { selectedId, openIds, layout })).join('');
  }
  const scrollTop = listEl.scrollTop;
  if (setHtml(listEl, 'list', layout === 'focus' ? '' : listHtml)) listEl.scrollTop = scrollTop;

  // Icon strip (Focus)
  setHtml(stripEl, 'strip', layout === 'focus' ? stripHtml(shown, selectedId) : '');

  // Big view (Split + Focus)
  if (layout !== 'narrow' && setHtml(focusEl, 'focus', focusHtml(selected))) fitFocusCards();
  if (layout === 'narrow') setHtml(focusEl, 'focus', '');

  // Build guide panel follows the selected champion
  updateGuide(selected);

  // Bring the selected champion into view when the client pick changes
  if (clientPickChanged && selectedId) {
    const row = listEl.querySelector(`.scout-row[data-id="${selectedId}"]`);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'auto' });
    const chip = stripEl.querySelector(`.scout-strip__item[data-id="${selectedId}"]`);
    if (chip) chip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
  }
}

// ─── Interaction ──────────────────────────────────────────────────────────────

// If an image fails to load, try its backup addresses one by one.
// (Image errors don't "bubble up" like clicks do, so listen in the capture phase.)
bodyEl.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallbacks) return;
  let fallbacks = [];
  try { fallbacks = JSON.parse(img.dataset.fallbacks); } catch (err) { /* ignore */ }
  const next = fallbacks.shift();
  img.dataset.fallbacks = JSON.stringify(fallbacks);
  if (next) img.src = next;
}, true);

bodyEl.addEventListener('click', async (e) => {
  // "Build guide" buttons: open Skill Capped for that champion (and your role)
  const guideBtn = e.target.closest('[data-guide]');
  if (guideBtn) {
    const isHeaderToggle = guideBtn.classList.contains('focus-guide');
    if (isHeaderToggle) {
      setGuideOpen(!guideOpenWide); // big view: show/hide the panel
    } else {
      userPickId = Number(guideBtn.dataset.id); // list row: guide for that champion
      setGuideOpen(true);
    }
    return;
  }
  // Equip a skin (small thumbnails or big cards)
  const skinEl = e.target.closest('.scout-skin.can-equip, .focus-card.can-equip');
  if (skinEl) {
    const skinId = Number(skinEl.dataset.skinId);
    skinEl.classList.add('is-equipping');
    const res = await window.scoutAPI.equipSkin(skinId);
    skinEl.classList.remove('is-equipping');
    if (res && res.success) {
      bodyEl.querySelectorAll('.is-equipped').forEach(el => el.classList.remove('is-equipped'));
      skinEl.classList.add('is-equipped');
    } else {
      skinEl.classList.add('is-failed');
      setTimeout(() => skinEl.classList.remove('is-failed'), 800);
    }
    return;
  }
  // Pick a champion for the big view (list rows in Split, icons in Focus)
  const pick = e.target.closest('.scout-strip__item') ||
    (currentLayout() !== 'narrow' && e.target.closest('.scout-row'));
  if (pick) {
    userPickId = Number(pick.dataset.id);
    if (lastPayload) render(lastPayload);
  }
});

// Small layout only: hovering a row peeks at its skins
listEl.addEventListener('mouseover', (e) => {
  if (currentLayout() !== 'narrow') return;
  const row = e.target.closest('.scout-row');
  if (!row) return;
  listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)').forEach(r => {
    if (r !== row) r.classList.remove('is-open');
  });
  row.classList.add('is-open');
});
listEl.addEventListener('mouseleave', () => {
  if (currentLayout() !== 'narrow') return;
  listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)').forEach(r => r.classList.remove('is-open'));
});

// ─── Moving the window ────────────────────────────────────────────────────────
// Press on any empty part of the window and drag to move it. Things you click
// (buttons, rows, skin cards, the search box, the guide page, scroll bars)
// don't start a drag. You have to move 3 pixels first, so plain clicks and
// double-clicks still work normally.
const NOT_DRAGGABLE = 'button, input, a, textarea, select, webview, .scout-row, .focus-card,' +
  '.scout-skin, .scout-strip__item, .scout-layout-toggle, .scout-guide__view, .resize-grip';
let resizing = false;

// Resize handles on the left, right and bottom edges. Listening on the whole
// document (instead of on each handle) works no matter when the handles are
// added to the page.
document.addEventListener('pointerdown', (e) => {
  const grip = e.button === 0 && e.target instanceof Element && e.target.closest('.resize-grip');
  if (!grip) return;
  e.preventDefault();
  e.stopPropagation();
  resizing = true;
  try { grip.setPointerCapture(e.pointerId); } catch (err) { /* not important */ }
  window.scoutAPI.windowAction('resize-start', grip.dataset.edge);
}, true);
let dragPending = null;
let dragging = false;

function onScrollbar(el, e) {
  const r = el.getBoundingClientRect();
  const vBar = el.scrollHeight > el.clientHeight && e.clientX > r.left + el.clientLeft + el.clientWidth;
  const hBar = el.scrollWidth > el.clientWidth && e.clientY > r.top + el.clientTop + el.clientHeight;
  return vBar || hBar;
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = e.target instanceof Element ? e.target : e.target.parentElement;
  if (!el || el.closest(NOT_DRAGGABLE) || onScrollbar(el, e)) return;
  dragPending = { x: e.screenX, y: e.screenY, id: e.pointerId, el };
});

document.addEventListener('pointermove', (e) => {
  if (!dragPending || dragging) return;
  if (Math.abs(e.screenX - dragPending.x) + Math.abs(e.screenY - dragPending.y) < 3) return;
  dragging = true;
  try { dragPending.el.setPointerCapture(dragPending.id); } catch (err) { /* not important */ }
  console.log('[Scout] Drag detected in window.');
  window.scoutAPI.windowAction('drag-start');
});

function endDrag() {
  if (dragging || resizing) window.scoutAPI.windowAction('drag-end'); // also ends resizing
  dragging = false;
  resizing = false;
  dragPending = null;
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);

window.scoutAPI.onUpdate(render);
