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
const searchInput = document.getElementById('scout-search');
const searchBox = document.querySelector('.scout-search');

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
const videoView = document.getElementById('scout-guide-video'); // YouTube-safe viewer
let videoUrl = ''; // page loaded in the YouTube viewer

function isYouTube(url) {
  try { return /(^|\.)youtube\.com$/.test(new URL(url).hostname); } catch (e) { return false; }
}

/** Stops the YouTube viewer (so a hidden video doesn't keep playing) */
function stopVideo() {
  if (!videoUrl) return;
  videoUrl = '';
  videoView.setAttribute('src', 'about:blank');
}
let guideOpenWide = false;
try { guideOpenWide = localStorage.getItem('scoutGuideOpen') === '1'; } catch (e) { /* storage unavailable */ }
let guideOpenNarrow = false;
// "Guide only": hide the skins so the guide fills Skin Scout, and keep Skin
// Scout open during the game (RiftVault itself still hides to the tray)
let guideOnly = false;
try { guideOnly = localStorage.getItem('scoutGuideOnly') === '1'; } catch (e) { /* storage unavailable */ }
let lastKeepOpen = null;
let inGameChamp = null; // during a game: the champion whose guide is shown
const guideOnlyBtn = document.getElementById('scout-guide-only');
let guideUrl = '';          // page currently loaded in the guide panel
let guideChamp = null;      // champion the guide is showing
let guideTarget = null;     // { url, title } of what the panel shows

// What the panel below the skins shows: 'guide' (Skill Capped), 'wiki',
// 'model' (Khada 3D) or 'spotlight' (Skin Spotlights on YouTube)
let panelMode = 'guide';
const PANEL_LABELS = { guide: 'Build guide', wiki: 'Wiki', model: '3D model', spotlight: 'Spotlight' };
// The skin used for 3D model / Spotlight: the one you last clicked
let pickedSkinId = 0;
let pickedSkinChampId = 0;
let pickedSkinName = ''; // name of a picked skin you may not own (from Khada's page)

function wikiUrl(champName) {
  const n = champName === 'Nunu & Willump' ? 'Nunu' : champName;
  return 'https://wiki.leagueoflegends.com/en-us/' + n.replace(/ /g, '_').replace(/'/g, '%27');
}

/** The skin for 3D model / Spotlight: your last click, else equipped, else the first */
function panelSkin(champ) {
  const skins = champ.skins || [];
  const all = skins.concat(unownedCache[champ.id] || []);
  return (pickedSkinChampId === champ.id && all.find(s => s.id === pickedSkinId)) ||
    skins.find(s => s.id === champ.selectedSkinId) || skins[0] || null;
}

/** Address + title for the panel, for this champion and the current mode */
function panelTarget(champ) {
  const role = (lastPayload && lastPayload.myRole) || '';
  const skin = panelSkin(champ);
  if (panelMode === 'wiki') return { url: wikiUrl(champ.name), title: `${champ.name} · Wiki` };
  if (panelMode === 'model') {
    // No owned skins (e.g. in game on a champion without skins): base model
    const id = skin ? skin.id : champ.id * 1000;
    return { url: `https://modelviewer.lol/model-viewer?id=${id}`, title: `${skin ? skin.name : champ.name} · 3D model` };
  }
  if (panelMode === 'spotlight') {
    // A skin picked on Khada's page that you don't own isn't in your list: use its name
    const unownedPick = pickedSkinName && pickedSkinChampId === champ.id &&
      !(champ.skins || []).some(s => s.id === pickedSkinId);
    const name = unownedPick ? pickedSkinName : (skin ? skin.name : champ.name);
    const q = encodeURIComponent(`${name} Spotlight`).replace(/%20/g, '+');
    return { url: `https://www.youtube.com/@SkinSpotlights/search?app=desktop&query=${q}`, title: `${name} · Spotlight` };
  }
  return { url: skillCappedUrl(champ.key, role), title: `${champ.name} · Build guide` };
}

/** Button handler: open the panel showing `mode`, or close it if it already does */
function togglePanel(mode) {
  if (guideVisible() && panelMode === mode) {
    setGuideOpen(false);
    return;
  }
  panelMode = mode;
  setGuideOpen(true);
}

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
  const onlyGuide = visible && guideOnly;
  document.body.classList.toggle('guide-only', onlyGuide);
  guideOnlyBtn.textContent = guideOnly ? 'Show skins' : 'Guide only';
  guideOnlyBtn.classList.toggle('is-active', guideOnly);
  guideOnlyBtn.title = guideOnly
    ? 'Bring the skins back'
    : 'Hide the skins so the guide fills Skin Scout (and stays open during the game)';
  if (onlyGuide !== lastKeepOpen) {
    lastKeepOpen = onlyGuide;
    window.scoutAPI.setGuideMode(onlyGuide); // tells the app whether to keep Skin Scout open in game
  }
  if (!visible) { stopVideo(); return; }
  guideChamp = champ;
  guideTarget = panelTarget(champ);
  guideTitle.textContent = guideTarget.title;
  // YouTube goes to the YouTube-safe viewer; everything else to the normal one
  const video = isYouTube(guideTarget.url);
  guideView.classList.toggle('is-hidden', video);
  videoView.classList.toggle('is-hidden', !video);
  if (video) {
    if (guideTarget.url !== videoUrl) {
      videoUrl = guideTarget.url;
      videoView.setAttribute('src', guideTarget.url);
    }
  } else {
    stopVideo();
    if (guideTarget.url !== guideUrl) {
      guideUrl = guideTarget.url;
      guideView.setAttribute('src', guideTarget.url); // follows your champion / skin / button
    }
  }
}

// Khada's Spotlight button (inside the panel): show that skin's Spotlight here
window.scoutAPI.onShowSpotlight(({ skinId, skinName }) => {
  if (!skinId) return;
  pickedSkinId = skinId;
  pickedSkinName = skinName || '';
  pickedSkinChampId = Math.floor(skinId / 1000);
  panelMode = 'spotlight';
  setGuideOpen(true);
});

// Show the guide a little smaller so more of the page fits in the panel
guideView.addEventListener('dom-ready', () => {
  try { guideView.setZoomFactor(0.9); } catch (e) { /* not important */ }
});

guideOnlyBtn.addEventListener('click', () => {
  guideOnly = !guideOnly;
  try { localStorage.setItem('scoutGuideOnly', guideOnly ? '1' : '0'); } catch (e) { /* not important */ }
  if (lastPayload) render(lastPayload);
});

document.getElementById('scout-guide-close').addEventListener('click', () => setGuideOpen(false));
document.getElementById('scout-guide-back').addEventListener('click', () => setGuideOpen(false));
document.getElementById('scout-guide-popout').addEventListener('click', () => {
  // Open whatever the panel shows in a RiftVault tab instead, and close the panel
  if (guideTarget) window.scoutAPI.openUrl(guideTarget.url, guideTarget.title);
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
  return `<img class="${cls}" src="${escapeHtml(src)}" alt="" loading="lazy" draggable="false"
    data-fallbacks="${escapeHtml(JSON.stringify(fallbacks || []))}" />`;
}

// No picture can be dragged out as a "ghost" copy (it happened when the mouse
// moved slightly during a click). Pictures stay clickable.
document.addEventListener('dragstart', (e) => {
  if (e.target instanceof HTMLImageElement || (e.target.closest && e.target.closest('img, .focus-card, .scout-skin, .info-card'))) {
    e.preventDefault();
  }
});

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
  const GAP = 10;             // space between cards (matches .focus-cards gap)
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
// The search box is always visible; Esc clears it
function clearSearch() {
  searchInput.value = '';
  searchQuery = '';
  searchInput.blur();
  if (lastPayload) render(lastPayload);
}
// Letters and numbers only, so "kaisa" finds Kai'Sa and "nunu" finds Nunu & Willump
const searchKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Skins matching the search (by skin name or skin line), from the main process:
// { query, byChamp: Map(champId -> [{ skinId, name, owned }]), list }
let skinSearch = { query: '', byChamp: new Map(), list: [] };
let skinSearchTimer = null;

function requestSkinSearch() {
  clearTimeout(skinSearchTimer);
  const q = searchQuery;
  // 3+ letters: shorter text (e.g. "vi") would match parts of many skin names
  if (q.length < 3) { skinSearch = { query: q, byChamp: new Map(), list: [] }; return; }
  skinSearchTimer = setTimeout(async () => {
    const list = await fetchSkinMatches(q);
    if (q !== searchQuery) return; // you kept typing
    if (lastPayload) render(lastPayload);
  }, 120);
}

async function fetchSkinMatches(q) {
  if (skinSearch.query === q) return skinSearch.list;
  let list = [];
  try { list = (await window.scoutAPI.searchSkins(q)) || []; } catch (e) { /* no skin data yet */ }
  const byChamp = new Map();
  for (const m of list) {
    if (!byChamp.has(m.champId)) byChamp.set(m.champId, []);
    byChamp.get(m.champId).push(m);
  }
  skinSearch = { query: q, byChamp, list };
  return list;
}

// Under a champion found through one of its skins: "Demoncursed Vayne (+1)"
function skinNoteFor(champ) {
  if (!searchQuery || skinSearch.query !== searchQuery) return null;
  if (searchKey(champ.name).includes(searchQuery)) return null; // found by name
  const hits = skinSearch.byChamp.get(champ.id);
  if (!hits || !hits.length) return null;
  const first = hits.find(h => h.owned) || hits[0];
  const more = hits.length > 1 ? ` (+${hits.length - 1})` : '';
  return { text: `${first.name}${first.owned ? '' : ' · not owned'}${more}`, owned: first.owned, skinId: first.skinId };
}

searchInput.addEventListener('input', () => {
  searchBox.classList.remove('is-miss');
  searchQuery = searchKey(searchInput.value);
  requestSkinSearch();
  if (lastPayload) render(lastPayload);
});

// Enter: open the best match. A champion name opens their page; a skin name
// (e.g. "demon cursed vayne") opens the champion with that skin selected and
// its info card showing. Then the search clears.
async function openSearchedChampion() {
  const q = searchKey(searchInput.value);
  if (!q || !lastPayload) return;
  const owned = lastPayload.champions || [];
  const all = owned.concat(lastPayload.noSkinChamps || []);
  const key = c => searchKey(c.name);
  const listed = (id) => all.some(c => c.id === id);
  const skins = (await fetchSkinMatches(q)).filter(m => listed(m.champId));
  if (q !== searchKey(searchInput.value)) return; // you kept typing
  const exactChamp = all.find(c => key(c) === q);
  const exactSkin = skins.find(m => m.exact);
  const startChamp = owned.find(c => key(c).startsWith(q)) || all.find(c => key(c).startsWith(q));
  const skin = exactSkin || (!exactChamp && !startChamp ? skins[0] : null);
  if (skin && !exactChamp) { await openSearchedSkin(skin); return; }
  const match = exactChamp || startChamp ||
    owned.find(c => key(c).includes(q)) || all.find(c => key(c).includes(q));
  if (!match) {
    // Nothing found: flash the box red
    searchBox.classList.remove('is-miss');
    void searchBox.offsetWidth; // restart the animation
    searchBox.classList.add('is-miss');
    return;
  }
  userPickId = match.id;
  inGameChamp = null; // you picked a champion: the panel follows it
  searchInput.value = '';
  searchQuery = '';
  searchInput.blur();
  render(lastPayload);
  const rowEl = listEl.querySelector(`.scout-row[data-id="${match.id}"], .scout-strip__item[data-id="${match.id}"]`);
  if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
}

// Same as clicking that skin on the champion's page: select it, equip it (if
// you own it and can), and show its info card
async function openSearchedSkin(m, { keepSearch = false } = {}) {
  if (!m.owned) {
    // Make sure the skin is on the page: load the champion's unowned skins
    // and turn "Unowned skins" on
    try { unownedCache[m.champId] = (await window.scoutAPI.getUnownedSkins(m.champId)) || []; } catch (e) { /* ignore */ }
    if (!showUnowned) flipUnowned();
  }
  userPickId = m.champId;
  inGameChamp = null;
  pickedSkinId = m.skinId;
  pickedSkinChampId = m.champId;
  pickedSkinName = '';
  if (!keepSearch) {
    searchInput.value = '';
    searchQuery = '';
    searchInput.blur();
  }
  lastHtml.focus = '';
  render(lastPayload);
  const rowEl = listEl.querySelector(`.scout-row[data-id="${m.champId}"], .scout-strip__item[data-id="${m.champId}"]`);
  if (rowEl && !keepSearch) rowEl.scrollIntoView({ block: 'nearest' });
  const champ = lastFocusChamp;
  if (!champ || champ.id !== m.champId) return;
  if (m.owned && champ.canEquip && champ.selectedSkinId !== m.skinId) {
    const cardEl = bodyEl.querySelector(`.focus-card[data-skin-id="${m.skinId}"]`);
    if (cardEl) equipFrom(cardEl, m.skinId);
  }
  openInfoCard(champ, m.skinId);
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearSearch();
  else if (e.key === 'Enter') openSearchedChampion();
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

// ─── "No skins" display + the two footer toggles ───────────────────────────────
// Gray = you own no skins (never red: it isn't an error). Both toggles start off.
//   "No-skin champs": also list champions you own no skins for (preview +
//                     normal champ select; ARAM always shows them)
//   "Unowned skins":  in the big view, also show skins you don't own (dimmed)
let showNoSkinChamps = false;
let showUnowned = false;
try {
  showNoSkinChamps = localStorage.getItem('scoutShowNoSkin') === '1';
  showUnowned = localStorage.getItem('scoutShowUnowned') === '1';
} catch (e) { /* storage unavailable */ }
const unownedCache = {};      // champion id → skins you don't own
const unownedLoading = new Set();

// The unowned list is always fetched (it feeds the "6 / 8" count), but the
// dimmed cards only appear while "Show unowned" is on.
function unownedFor(champ) {
  return showUnowned ? unownedList(champ) || [] : [];
}

// Skins you don't own for this champion, or null while still loading
function unownedList(champ) {
  if (!champ) return null;
  if (unownedCache[champ.id]) return unownedCache[champ.id];
  if (!unownedLoading.has(champ.id)) {
    unownedLoading.add(champ.id);
    window.scoutAPI.getUnownedSkins(champ.id).then((skins) => {
      unownedCache[champ.id] = Array.isArray(skins) ? skins : [];
      unownedLoading.delete(champ.id);
      lastHtml.focus = '';
      if (lastPayload) render(lastPayload);
    }).catch(() => unownedLoading.delete(champ.id));
  }
  return null;
}

// Each toggle returns a "flip" function, so a second button (like "Show
// unowned" next to the skin count) can flip the very same setting.
function setupToggle(id, getter, setter, storageKey) {
  const btn = document.getElementById(id);
  const paint = () => {
    btn.classList.toggle('is-on', getter());
    btn.setAttribute('aria-pressed', getter() ? 'true' : 'false');
  };
  const flip = () => {
    setter(!getter());
    try { localStorage.setItem(storageKey, getter() ? '1' : '0'); } catch (e) { /* not important */ }
    paint();
    Object.keys(lastHtml).forEach(k => { lastHtml[k] = ''; });
    if (lastPayload) render(lastPayload);
  };
  btn.addEventListener('click', flip);
  paint();
  return flip;
}
setupToggle('tg-noskin', () => showNoSkinChamps, v => { showNoSkinChamps = v; }, 'scoutShowNoSkin');
const flipUnowned = setupToggle('tg-unowned', () => showUnowned, v => { showUnowned = v; }, 'scoutShowUnowned');

// ARAM groups: which color/section a champion belongs to
function groupOf(champ) {
  if (champ.isMine) return 'you';
  if (champ.onBench) return 'bench';
  if (champ.onTeam) return 'team';
  return '';
}

const ARAM_SECTIONS = [
  { group: 'you', label: 'Your champion' },
  { group: 'bench', label: 'Bench · swap anytime' },
  { group: 'team', label: 'Teammates · trade to get' },
];

function rowHtml(champ, { selectedId, openIds, layout, compact = false, note = '', skinNote = null, skinHit = false, dim = false }) {
  const cls = ['scout-row'];
  if (groupOf(champ)) cls.push(`is-${groupOf(champ)}`);
  if (champ.noSkins || dim) cls.push('is-noskins');
  if (skinHit) cls.push('is-skin-hit');
  if (compact) cls.push('is-compact');
  const isSelected = champ.id === selectedId;
  if (isSelected) cls.push('is-hovered');
  // Only the small layout opens rows in place; the large layouts show skins in the big panel
  if (layout === 'narrow' && (isSelected || champ.canEquip || openIds.has(champ.id))) cls.push('is-open');
  return `
    <section class="${cls.join(' ')}" data-id="${champ.id}"${skinNote ? ` data-hit-skin="${skinNote.skinId}" data-hit-owned="${skinNote.owned ? 1 : 0}"` : ''}>
      <div class="scout-row__main">
        <img class="scout-row__icon" src="${escapeHtml(champ.iconUrl)}" alt="" />
        <div class="scout-row__name">${escapeHtml(champ.name)} ${tagsFor(champ)}${note ? `<span class="noskins-note">${escapeHtml(note)}</span>` : ''}${skinNote ? `<span class="skin-match-note${skinNote.owned ? ' is-owned' : ''}">${escapeHtml(skinNote.text)}</span>` : ''}</div>
        <button class="scout-row__guide" data-guide="${escapeHtml(champ.key)}" data-id="${champ.id}" title="Skill Capped build guide"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 4h2v5l-1-.75L9 9V4zm9 16H6V4h1v9l3-2.25L13 13V4h5v16z"/></svg></button>
        <div class="scout-row__count${champ.skinCount ? '' : ' is-zero'}" title="${champ.skinCount} owned skin${champ.skinCount === 1 ? '' : 's'}">${champ.skinCount}</div>
      </div>
      ${layout === 'narrow' && !champ.noSkins ? `<div class="scout-row__skins">${smallSkinsHtml(champ)}</div>` : ''}
    </section>`;
}

function stripHtml(champs, selectedId) {
  return champs.map(c => `
    <button class="scout-strip__item${c.id === selectedId ? ' is-selected' : ''}${groupOf(c) ? ` is-${groupOf(c)}` : ''}${c.noSkins ? ' is-noskins' : ''}" data-id="${c.id}" title="${escapeHtml(c.name)}${c.noSkins ? ' (no skins owned)' : ''}">
      <img src="${escapeHtml(c.iconUrl)}" alt="" />
      <span class="scout-strip__count">${c.skinCount}</span>
    </button>`).join('');
}

// ─── Skin tier icons + chromas (borrowed from RiftVault's collection view) ────
// Gems match the League client exactly: a skin with no tier there (under
// 1350 RP, e.g. Neon Strike Vi, Debonair Jace) gets no gem here either.
const TIER_ICON = {
  transcendent: 'Transcendent', exalted: 'Exalted', ultimate: 'Ultimate',
  mythic: 'Mythic', legendary: 'Legendary', epic: 'Epic',
};
function tierOf(skin) {
  // The client said "no gem" for this skin: trust it
  if (skin.clientGemPath === '') return null;
  return TIER_ICON[skin.rarity] ? skin.rarity : null;
}

const EQUIP_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

function tierGemHtml(skin, cls) {
  const tier = tierOf(skin);
  if (!tier) return '';
  return `<span class="${cls} is-${tier}" title="${TIER_ICON[tier]} skin"><img src="assets/tier-icons/${tier}.png" alt="${TIER_ICON[tier]}" draggable="false" /></span>`;
}

// Legacy Vault skins: RiftVault's legacy emblem
function legacyHtml(skin, cls) {
  return skin.isLegacy
    ? `<span class="${cls}" title="Legacy skin (Legacy Vault: not normally sold)"><img src="assets/tier-icons/legacy.png" alt="Legacy" draggable="false" /></span>`
    : '';
}

function chromaBadgeHtml(skin, champId, cls) {
  const chromas = skin.chromas || [];
  if (!chromas.length) return '';
  const owned = chromas.filter(c => c.owned).length;
  return `<button class="${cls}${owned ? '' : ' is-none-owned'}" data-chromas="${skin.id}" data-champ-id="${champId}"
      title="Chromas: ${owned} of ${chromas.length} owned (click to view)">
      <img src="assets/tier-icons/chroma.png" alt="" draggable="false" /><span>${owned}</span>
    </button>`;
}

// RiftVault card layout, drawn on top of the skin art:
//   top-left: Apply button (or a lock if you don't own it)
//   top-right: chroma badge   ·   bottom center: tier gem   ·   bottom-left: legacy
function cardOverlaysHtml(skin, champ, owned) {
  const corner = !owned
    ? '<span class="focus-card__lock" aria-hidden="true"></span>'
    : (champ.canEquip ? `<button class="focus-card__apply" data-equip="${skin.id}" title="Equip this skin">${EQUIP_ICON}</button>` : '');
  return corner + chromaBadgeHtml(skin, champ.id, 'focus-card__chromas') + tierGemHtml(skin, 'focus-card__gem')
    + legacyHtml(skin, 'focus-card__legacy');
}

// Chroma viewer: a pop-up over the skins. Lives outside the skins area so the
// 3-times-a-second refresh doesn't wipe it.
const chromaPop = document.createElement('div');
chromaPop.className = 'chroma-pop is-hidden';
document.body.appendChild(chromaPop);
let chromaPopSkinId = null;
let lastFocusChamp = null;   // the champion shown in the big view right now

// "Bioforge Darius (Ruby)" → "Ruby"
function chromaLabel(chroma, skinName) {
  const m = /\(([^)]+)\)\s*$/.exec(chroma.name);
  if (m) return m[1];
  return chroma.name && chroma.name !== skinName ? chroma.name : `Chroma ${chroma.id % 1000}`;
}

function findSkin(champ, skinId) {
  if (!champ) return null;
  return champ.skins.find(s => s.id === skinId)
    || (unownedCache[champ.id] || []).find(s => s.id === skinId) || null;
}

function openChromas(champ, skinId) {
  const skin = findSkin(champ, skinId);
  if (!skin || !skin.chromas || !skin.chromas.length) return;
  chromaPopSkinId = skinId;
  // Owned chromas first, then by ID
  const list = [...skin.chromas].sort((a, b) => (a.owned === b.owned ? a.id - b.id : (a.owned ? -1 : 1)));
  const ownedCount = list.filter(c => c.owned).length;
  const items = list.map(c => {
    const swatch = c.colors.length
      ? `<span class="chroma-pop__swatch" style="background:linear-gradient(135deg, ${c.colors.map(escapeHtml).join(', ')})"></span>`
      : '';
    const img = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-chroma-images/${champ.id}/${c.id}.png`;
    return `<figure class="chroma-pop__item${c.owned ? '' : ' is-locked'}" title="${escapeHtml(c.name)}${c.owned ? '' : ' (not owned)'}">
      <div class="chroma-pop__art"><img src="${img}" alt="" draggable="false" onerror="this.style.visibility='hidden'" />${c.owned ? '' : '<span class="focus-card__lock" aria-hidden="true"></span>'}</div>
      <figcaption>${swatch}${escapeHtml(chromaLabel(c, skin.name))}</figcaption>
    </figure>`;
  }).join('');
  chromaPop.innerHTML = `
    <div class="chroma-pop__box" role="dialog" aria-label="Chromas">
      <header class="chroma-pop__head">
        <img src="assets/tier-icons/chroma.png" alt="" draggable="false" />
        <div class="chroma-pop__title">${escapeHtml(skin.name)}<span>${ownedCount} / ${list.length} chromas owned</span></div>
        <button class="chroma-pop__close" data-chroma-close title="Close (Esc)">&#x2715;</button>
      </header>
      <div class="chroma-pop__grid">${items}</div>
    </div>`;
  chromaPop.classList.remove('is-hidden');
}

function closeChromas() {
  chromaPopSkinId = null;
  chromaPop.classList.add('is-hidden');
  chromaPop.innerHTML = '';
}

chromaPop.addEventListener('click', (e) => {
  // Close with the X or by clicking the dark area around the box
  if (e.target.closest('[data-chroma-close]') || !e.target.closest('.chroma-pop__box')) closeChromas();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chromaPopSkinId !== null) {
    e.preventDefault(); // Esc closes only the chroma pop-up, not the skin view under it
    closeChromas();
  }
});

// ─── Full-window skin view (click a skin card) ──────────────────────────────
// Like RiftVault's skin detail: the wide splash art fills the window, with the
// tier, chromas and an Equip button along the bottom. ← / → flip through skins.
const skinView = document.createElement('div');
skinView.className = 'skin-view is-hidden';
skinView.style.top = `${HEADER_HEIGHT}px`;
document.body.appendChild(skinView);
let skinViewId = null;

// The skins the big view is showing right now, in order (owned, then unowned)
function viewableSkins(champ) {
  if (!champ) return [];
  return [...champ.skins.map(s => ({ skin: s, owned: true })),
    ...unownedFor(champ).map(s => ({ skin: s, owned: false }))];
}

// "[RP icon] 1350" for RP skins; "Special distribution" / "Battle Pass" / ...
// for skins that weren't sold for RP; nothing when the price is unknown
function priceHtml(price) {
  if (!price) return '';
  if (price.rp) {
    return `<span class="skin-view__price" title="${price.rp} Riot Points"><img src="assets/icon-riot-points.png" alt="RP" draggable="false" />${price.rp.toLocaleString('en-US')}</span>`;
  }
  const label = price.label === 'Special' ? 'Special distribution' : price.label;
  return `<span class="skin-view__price is-special" title="Not sold for RP">${escapeHtml(label)}</span>`;
}

function openSkinView(champ, skinId) {
  const list = viewableSkins(champ);
  const i = list.findIndex(x => x.skin.id === skinId);
  if (i < 0) return;
  const { skin, owned } = list[i];
  skinViewId = skinId;
  const equipped = owned && skin.id === champ.selectedSkinId;
  let action = '';
  if (!owned) action = '<span class="skin-view__state is-locked">Not owned</span>';
  else if (equipped) action = `<span class="skin-view__state is-equipped">${EQUIP_ICON} Equipped</span>`;
  else if (champ.canEquip) action = `<button class="skin-view__equip" data-equip="${skin.id}">${EQUIP_ICON} Equip</button>`;
  const arrows = list.length > 1
    ? `<button class="skin-view__nav is-prev" data-skin-nav="-1" title="Previous skin (←)">&#x2039;</button>
       <button class="skin-view__nav is-next" data-skin-nav="1" title="Next skin (→)">&#x203A;</button>`
    : '';
  skinView.classList.toggle('is-unowned', !owned);
  skinView.innerHTML = `
    <div class="skin-view__backdrop" aria-hidden="true">${imgTag(skin.splash || skin.img, [skin.img, ...(skin.fallbacks || [])])}</div>
    <div class="skin-view__art">${imgTag(skin.splash || skin.img, [skin.img, ...(skin.fallbacks || [])])}</div>
    <div class="skin-view__count" title="Skin ${i + 1} of ${list.length} (← → to flip)"><b>${i + 1}</b> of ${list.length}</div>
    <button class="skin-view__close" data-skin-close title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    ${arrows}
    <div class="skin-view__bar">
      ${tierGemHtml(skin, 'skin-view__gem')}
      <div class="skin-view__text">
        <div class="skin-view__name">${escapeHtml(skin.name)}</div>
        <div class="skin-view__sub">${[
          tierOf(skin) ? `${TIER_ICON[tierOf(skin)]} skin` : '', // no tier: leave it out (like the League client)
          priceHtml(skin.price),
          skin.isLegacy ? `${legacyHtml(skin, 'skin-view__legacy')} Legacy` : '',
        ].filter(Boolean).join('<span class="skin-view__dot">·</span>')}</div>
      </div>
      ${chromaBadgeHtml(skin, champ.id, 'skin-view__chromas')}
      ${action}
    </div>`;
  skinView.classList.remove('is-hidden');
  const artImg = skinView.querySelector('.skin-view__art img');
  if (artImg) {
    artImg.addEventListener('load', fitSkinViewArt); // also after a backup image loads
    fitSkinViewArt();
  }
  // Same as clicking a card before: this skin is the one 3D model / Spotlight show
  pickedSkinId = skinId;
  pickedSkinChampId = champ.id;
  pickedSkinName = '';
}

// Scale the splash to the largest size that fits its box, keeping its shape.
// (CSS max-width alone only shrinks a picture, never enlarges it, so on big
// windows the splash stayed at its original ~1215 px.)
const SPLASH_MAX_SCALE = 1.3;
function fitSkinViewArt() {
  const box = skinView.querySelector('.skin-view__art');
  const img = box && box.querySelector('img');
  if (!img || !img.naturalWidth) return;
  // Fit the box, but never more than SPLASH_MAX_SCALE × the picture's own size
  // (1.3 = 30% bigger than before), so on big monitors it stays a framed
  // picture instead of filling the whole screen.
  const scale = Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight, SPLASH_MAX_SCALE);
  img.style.width = `${Math.floor(img.naturalWidth * scale)}px`;
  img.style.height = `${Math.floor(img.naturalHeight * scale)}px`;
}
window.addEventListener('resize', () => { if (skinViewId !== null) fitSkinViewArt(); });

function closeSkinView() {
  skinViewId = null;
  skinView.classList.add('is-hidden');
  skinView.innerHTML = '';
}

function stepSkinView(dir) {
  const list = viewableSkins(lastFocusChamp);
  const i = list.findIndex(x => x.skin.id === skinViewId);
  if (i < 0 || list.length < 2) return;
  openSkinView(lastFocusChamp, list[(i + dir + list.length) % list.length].skin.id);
}

// btn: the button (or card) that shows the "equipping..." state
async function equipFrom(btn, skinId = Number(btn.dataset.equip)) {
  btn.classList.add('is-equipping');
  const res = await window.scoutAPI.equipSkin(skinId);
  btn.classList.remove('is-equipping');
  if (res && res.success) {
    if (lastFocusChamp && lastFocusChamp.skins.some(x => x.id === skinId)) lastFocusChamp.selectedSkinId = skinId;
    bodyEl.querySelectorAll('.is-equipped').forEach(el => el.classList.remove('is-equipped'));
    const card = bodyEl.querySelector(`.focus-card[data-skin-id="${skinId}"], .scout-skin[data-skin-id="${skinId}"]`);
    if (card) card.classList.add('is-equipped');
    if (skinViewId === skinId) openSkinView(lastFocusChamp, skinId); // show "Equipped"
    if (infoCardSkinId === skinId) openInfoCard(lastFocusChamp, skinId); // show "Equipped"
  } else {
    btn.classList.add('is-failed');
    setTimeout(() => btn.classList.remove('is-failed'), 800);
  }
}

skinView.addEventListener('click', (e) => {
  const chromaBtn = e.target.closest('[data-chromas]');
  if (chromaBtn) { openChromas(lastFocusChamp, Number(chromaBtn.dataset.chromas)); return; }
  const equipBtn = e.target.closest('[data-equip]');
  if (equipBtn) { equipFrom(equipBtn); return; }
  const nav = e.target.closest('[data-skin-nav]');
  if (nav) { stepSkinView(Number(nav.dataset.skinNav)); return; }
  if (e.target.closest('[data-skin-close]')) closeSkinView();
});
document.addEventListener('keydown', (e) => {
  if (skinViewId === null || chromaPopSkinId !== null || e.defaultPrevented) return;
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') closeSkinView();
  else if (e.key === 'ArrowLeft') stepSkinView(-1);
  else if (e.key === 'ArrowRight') stepSkinView(1);
});

// ─── Skin info card (click a skin) ──────────────────────────────────────────
// A small card next to the skin, like RiftVault's skin view: splash art, tier,
// name, RP, chromas, and Build guide / Spotlight / 3D model / Wiki + Equip.
const infoDim = document.createElement('div');
infoDim.className = 'info-dim is-hidden';
document.body.appendChild(infoDim);
const infoCard = document.createElement('div');
infoCard.className = 'info-card is-hidden';
document.body.appendChild(infoCard);
let infoCardSkinId = null;

const INFO_BUTTONS = [ // left to right
  ['guide', 'Build guide'], ['spotlight', 'Spotlight'], ['model', '3D model'], ['wiki', 'Wiki'],
];

function openInfoCard(champ, skinId) {
  const skin = findSkin(champ, skinId);
  if (!skin) return;
  const owned = champ.skins.some(s => s.id === skinId);
  infoCardSkinId = skinId;
  const tier = tierOf(skin);
  const chromas = skin.chromas || [];
  const info = [
    tier ? `${TIER_ICON[tier]} skin` : '',
    infoPriceHtml(skin.price),
    skin.isLegacy ? `${legacyHtml(skin, 'info-card__legacy')} Legacy` : '',
    chromas.length ? `${chromas.filter(c => c.owned).length} of ${chromas.length} chromas owned` : '',
  ].filter(Boolean).join('<span class="info-card__dot">·</span>');
  let action;
  if (!owned) action = '<div class="info-card__state is-locked">Not owned</div>';
  else if (skin.id === champ.selectedSkinId) action = `<div class="info-card__state is-equipped">${EQUIP_ICON} Equipped</div>`;
  else if (champ.canEquip) action = `<button class="info-card__equip" data-equip="${skin.id}">${EQUIP_ICON} Equip</button>`;
  else action = `<div class="info-card__state">${champ.isMine ? 'Lock in to equip' : 'Equip in champ select'}</div>`;
  infoCard.classList.toggle('is-unowned', !owned);
  infoCard.innerHTML = `
    <div class="info-card__art">${imgTag(skin.splash || skin.img, [skin.img, ...(skin.fallbacks || [])])}
      <button class="info-card__close" data-info-close title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="info-card__body">
      <div class="info-card__name">${tier ? tierGemHtml(skin, 'info-card__gem') : ''}<span>${escapeHtml(skin.name)}</span></div>
      ${info ? `<div class="info-card__info">${info}</div>` : ''}
      <div class="info-card__links">${INFO_BUTTONS.map(([mode, label]) =>
        `<button class="info-card__link${mode === 'guide' ? ' is-guide' : ''}" data-info-panel="${mode}">${label}</button>`).join('')}</div>
      ${action}
    </div>`;
  infoDim.classList.remove('is-hidden');
  infoCard.classList.remove('is-hidden');
  placeInfoCard();
}

// Beside the skin you clicked, on whichever side has room
function placeInfoCard() {
  if (infoCardSkinId === null) return;
  const card = bodyEl.querySelector(`.focus-card[data-skin-id="${infoCardSkinId}"]`);
  const w = infoCard.offsetWidth;
  const h = infoCard.offsetHeight;
  const margin = 12;
  let left = (window.innerWidth - w) / 2;
  let top = (window.innerHeight - h) / 2;
  if (card) {
    const r = card.getBoundingClientRect();
    if (r.right + 14 + w <= window.innerWidth - margin) left = r.right + 14;
    else if (r.left - 14 - w >= margin) left = r.left - 14 - w;
    top = r.top;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  top = Math.max(HEADER_HEIGHT + margin, Math.min(top, window.innerHeight - h - margin));
  infoCard.style.left = `${Math.round(left)}px`;
  infoCard.style.top = `${Math.round(top)}px`;
}

function closeInfoCard() {
  infoCardSkinId = null;
  infoDim.classList.add('is-hidden');
  infoCard.classList.add('is-hidden');
  infoCard.innerHTML = '';
}

// "[RP icon] 1,350 RP", or "Special distribution" / "Battle Pass" / ...
function infoPriceHtml(price) {
  if (!price) return '';
  if (price.rp) {
    return `<span class="info-card__price"><img src="assets/icon-riot-points.png" alt="" draggable="false" />${price.rp.toLocaleString('en-US')} RP</span>`;
  }
  return `<span class="info-card__price is-special">${escapeHtml(price.label === 'Special' ? 'Special distribution' : price.label)}</span>`;
}

infoDim.addEventListener('click', closeInfoCard);
infoCard.addEventListener('click', (e) => {
  if (e.target.closest('[data-info-close]')) { closeInfoCard(); return; }
  const equipBtn = e.target.closest('[data-equip]');
  if (equipBtn) { equipFrom(equipBtn); return; }
  const link = e.target.closest('[data-info-panel]');
  if (link) {
    // Open that page in the side panel, for this skin (it's already the selected one)
    panelMode = link.dataset.infoPanel;
    closeInfoCard();
    if (guideVisible()) { lastHtml.focus = ''; if (lastPayload) render(lastPayload); } else setGuideOpen(true);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && infoCardSkinId !== null && chromaPopSkinId === null) closeInfoCard();
});
window.addEventListener('resize', placeInfoCard);

// Skin you clicked: highlighted until you click another (or change champion)
function isSelectedSkin(champ, skinId) {
  return pickedSkinChampId === champ.id && pickedSkinId === skinId;
}

function focusHtml(champ) {
  lastFocusChamp = champ || null;
  if (infoCardSkinId !== null && (!champ || !findSkin(champ, infoCardSkinId))) closeInfoCard();
  // The chroma viewer and skin view belong to the champion they were opened for
  if (chromaPopSkinId !== null && (!champ || !findSkin(champ, chromaPopSkinId))) closeChromas();
  if (skinViewId !== null && !viewableSkins(champ).some(x => x.skin.id === skinViewId)) closeSkinView();
  if (!champ) {
    return `<div class="focus-empty">
      <div class="focus-empty__title">Pick a champion</div>
      <div>Click a champion in the League client${currentLayout() === 'focus' ? ' or an icon above' : ' or the list'} to see your skins here.</div>
    </div>`;
  }
  const unowned = unownedFor(champ);
  const missing = unownedList(champ);   // null while loading
  // The equip hint now lives in the tooltip, to keep the header short
  const hint = champ.noSkins ? '' : (champ.canEquip ? 'Click a skin to equip it and see its details' : (champ.isMine ? 'Lock in to equip from here' : ''));
  // "6 / 8 skins owned": owned in gold, total in gray. Until the total is
  // known, just "6 skins owned". "Show unowned" only when something is missing.
  const owned = champ.noSkins ? 0 : champ.skinCount;
  const countHtml = missing
    ? `<b class="focus-count__owned">${owned}</b> / ${owned + missing.length} skins owned`
    : `<b class="focus-count__owned">${owned}</b> skin${owned === 1 ? '' : 's'} owned`;
  const unownedBtn = missing && missing.length
    ? `<button class="scout-chip focus-count__toggle${showUnowned ? ' is-on' : ''}" data-toggle-unowned
        aria-pressed="${showUnowned}" title="${showUnowned ? 'Hide' : 'Also show'} the skins you don't own">Show unowned</button>`
    : '';
  const panelOpen = guideOpenWide;
  const cards = champ.skins.map(s => {
    const cls = ['focus-card', `focus-card--${escapeHtml(s.rarity)}`];
    if (champ.canEquip) cls.push('can-equip');
    if (s.id === champ.selectedSkinId) cls.push('is-equipped');
    if (isSelectedSkin(champ, s.id)) cls.push('is-selected');
    return `<figure class="${cls.join(' ')}" data-skin-id="${s.id}" data-champ-id="${champ.id}" title="${escapeHtml(s.name)}">
      <div class="focus-card__art">${imgTag(s.img, s.fallbacks)}${cardOverlaysHtml(s, champ, true)}</div>
      <figcaption class="focus-card__name">${escapeHtml(s.name)}</figcaption>
    </figure>`;
  }).join('') + unowned.map(s => {
    // Skins you don't own (toggle): dimmed with a lock; can be selected / opened
    const picked = isSelectedSkin(champ, s.id) ? ' is-selected' : '';
    return `<figure class="focus-card is-unowned${picked}" data-skin-id="${s.id}" data-champ-id="${champ.id}" title="${escapeHtml(s.name)} (not owned)">
      <div class="focus-card__art">${imgTag(s.img, s.fallbacks)}${cardOverlaysHtml(s, champ, false)}</div>
      <figcaption class="focus-card__name">${escapeHtml(s.name)}</figcaption>
    </figure>`;
  }).join('');
  // No skins owned: say so plainly, in the middle (no art, nothing to misread)
  const noSkinsMsg = `You don't own any<br><b>${escapeHtml(champ.name)}</b> skins`;
  const body = champ.noSkins && !unowned.length
    ? `<div class="noskins-center"><div>${noSkinsMsg}</div></div>`
    : `${champ.noSkins ? `<div class="noskins-line">You don't own any <b>${escapeHtml(champ.name)}</b> skins</div>` : ''}<div class="focus-cards">${cards}</div>`;
  return `
    <header class="focus-header">
      <img class="focus-header__icon${champ.noSkins ? ' is-none' : ''}" src="${escapeHtml(champ.iconUrl)}" alt="" />
      <div class="focus-header__text">
        <div class="focus-header__name">${escapeHtml(champ.name)} ${tagsFor(champ)}</div>
        <div class="focus-header__meta${champ.noSkins ? ' is-none' : ''}"${hint ? ` title="${hint}"` : ''}>
          <span class="focus-count">${countHtml}</span>${unownedBtn}
        </div>
      </div>
      <div class="focus-actions">
        <button class="focus-guide${panelOpen && panelMode === 'guide' ? ' is-active' : ''}" data-panel="guide"
          title="${panelOpen && panelMode === 'guide' ? 'Hide the build guide' : 'Show the Skill Capped build guide below'}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 4h2v5l-1-.75L9 9V4zm9 16H6V4h1v9l3-2.25L13 13V4h5v16z"/></svg>
          ${panelOpen && panelMode === 'guide' ? 'Hide guide' : 'Build guide'}
        </button>
        <div class="focus-links">
          ${['spotlight', 'model', 'wiki'].map(m => `
            <button class="focus-link${panelOpen && panelMode === m ? ' is-active' : ''}" data-panel="${m}"
              title="${panelOpen && panelMode === m ? 'Close' : `Show the ${PANEL_LABELS[m]} below`}">${PANEL_LABELS[m]}</button>`).join('')}
        </div>
      </div>
    </header>
    ${body}`;
}

function message(text) {
  return `<div class="scout-empty">${escapeHtml(text)}</div>`;
}

// ─── Main render ──────────────────────────────────────────────────────────────
let lastLobby = 0;

function render(payload) {
  lastPayload = payload;
  // A new champ select always starts with the skins showing
  if (payload.lobby && payload.lobby !== lastLobby) {
    lastLobby = payload.lobby;
    inGameChamp = null;
    panelMode = 'guide';
    pickedSkinId = 0;
    if (guideOnly) {
      guideOnly = false;
      try { localStorage.setItem('scoutGuideOnly', '0'); } catch (e) { /* not important */ }
    }
  }
  const layout = currentLayout();

  if (payload.state === 'loading' || payload.state === 'waiting') {
    const waiting = payload.state === 'waiting';
    subEl.textContent = waiting ? 'Waiting for League...' : 'Loading your skins...';
    const text = waiting
      ? 'Open the League client and your skins will appear here (checking every 10 seconds).'
      : 'Reading your collection from the League client. This takes a few seconds the first time.';
    setHtml(listEl, 'list', message(text));
    setHtml(stripEl, 'strip', '');
    // The big panel shows it too (in Focus layout the list is hidden)
    setHtml(focusEl, 'focus', layout === 'narrow' ? '' : `<div class="focus-empty">
      <div class="focus-empty__title">${waiting ? 'Waiting for League' : 'Loading your skins'}</div>
      <div>${escapeHtml(text)}</div></div>`);
    document.body.classList.remove('guide-open');
    return;
  }

  const { champions, availableCount, mode, hoverId } = payload;
  // ARAM gets bigger portraits/names and color-coded groups (see scout.css)
  document.body.classList.toggle('mode-aram', mode === 'bench');
  if (mode === 'preview') subEl.textContent = `Preview · ${champions.length} champs with skins`;
  else if (mode === 'bench') subEl.textContent = `ARAM · ${champions.length} of ${availableCount} available have skins`;
  else subEl.textContent = `${champions.length} of ${availableCount} pickable have skins`;

  // A new click in the League client takes over from a click made here
  if (hoverId && hoverId !== lastClientPickId) userPickId = 0;
  const clientPickChanged = hoverId !== lastClientPickId;
  lastClientPickId = hoverId;

  const noSkin = payload.noSkinChamps || [];
  // Search: champion name, or one of their skins / skin lines
  // Searching a skin or skin line (e.g. "high noon"):
  //   you own one  -> listed normally, highlighted, skin name underneath
  //   you don't    -> moved down to the gray "No skins" section
  const skinHits = skinSearch.query === searchQuery ? skinSearch.byChamp : new Map();
  const nameMatch = c => searchKey(c.name).includes(searchQuery);
  const ownsHit = c => (skinHits.get(c.id) || []).some(h => h.owned);
  const matches = c => !searchQuery || nameMatch(c) || ownsHit(c);
  let shown = champions.filter(matches);
  const unownedOnly = searchQuery ? champions.filter(c => !matches(c) && skinHits.has(c.id)) : [];
  let shownNoSkin = noSkin.filter(c => matches(c) || skinHits.has(c.id)).concat(unownedOnly);
  // Skin search: alphabetical, owners first ("Owned"), then the rest ("Not owned")
  const skinSearching = !!searchQuery && skinHits.size > 0;
  if (skinSearching) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    shown = [...shown].sort(byName);
    shownNoSkin = [...shownNoSkin].sort(byName);
  }
  const skinHitIds = new Set(shown.filter(ownsHit).map(c => c.id));

  // Which champion gets the big view (including ones you own no skins for)
  const byId = id => champions.find(c => c.id === id) || noSkin.find(c => c.id === id);
  const selected = byId(userPickId) || byId(hoverId) || champions.find(c => c.canEquip) || null;
  const selectedId = selected ? selected.id : 0;

  // List (small layout + Split)
  let listHtml;
  const openIds = new Set([...listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)')]
    .map(r => Number(r.dataset.id)));
  const row = (c, extra = {}) => rowHtml(c, { selectedId, openIds, layout, skinNote: skinNoteFor(c), skinHit: skinHitIds.has(c.id), ...extra });
  const noSkinSection = (list) => list.length
    ? `<div class="scout-section scout-section--none">${skinSearching ? 'Not owned' : 'No skins'} (${list.length})</div>` +
      list.map(c => row(c, { compact: true, dim: true, skinHit: false })).join('')
    : '';
  if (mode === 'bench') {
    // ARAM: you, the bench, teammates — then a gray "No skins" section.
    // Your own champion always shows, even with no skins.
    const myNoSkin = shownNoSkin.filter(c => c.isMine);
    listHtml = ARAM_SECTIONS.map(({ group, label }) => {
      const champs = shown.filter(c => groupOf(c) === group);
      const extraMine = group === 'you' ? myNoSkin.map(c => row(c, { note: 'No skins owned' })).join('') : '';
      if (!champs.length && !extraMine) return '';
      return `<div class="scout-section scout-section--${group}">${label}</div>` + extraMine + champs.map(c => row(c)).join('');
    }).join('') + noSkinSection(shownNoSkin.filter(c => !c.isMine));
    if (!listHtml) listHtml = message(searchQuery ? `No champions matching "${searchInput.value.trim()}".` : 'No champions yet.');
  } else {
    // Clicked a champion you own no skins for: show it at the top, grayed out
    // (unless the "No skins" list below already shows it)
    const inNoSkinList = selected && showNoSkinChamps && shownNoSkin.some(c => c.id === selected.id);
    const temp = selected && selected.noSkins && !inNoSkinList
      ? `<div class="temp-label">You clicked</div>${row(selected, { note: 'No skins owned' })}<div class="temp-gap"></div>`
      : '';
    const ownedRows = (skinSearching && shown.length
      ? `<div class="scout-section scout-section--owned">Owned (${shown.length})</div>` : '') +
      shown.map(c => row(c)).join('');
    // "No-skin champs" decides whether the gray section shows, while
    // searching too. When it's off, a short note says how many are hidden.
    const hiddenNote = !showNoSkinChamps && searchQuery && shownNoSkin.length
      ? `<div class="scout-hidden-hint">${shownNoSkin.length} more ${skinSearching ? 'without a matching skin' : 'with no skins'} · turn on "No-skin champs" to show</div>`
      : '';
    const extra = showNoSkinChamps ? noSkinSection(shownNoSkin) : hiddenNote;
    if (!ownedRows && !temp && !(showNoSkinChamps && shownNoSkin.length)) {
      listHtml = message(searchQuery
        ? `No champions matching "${searchInput.value.trim()}".`
        : 'None of your pickable champions have skins.') + hiddenNote;
    } else {
      listHtml = temp + (ownedRows || (temp || searchQuery ? '' : message('None of your pickable champions have skins.'))) + extra;
    }
  }
  const scrollTop = listEl.scrollTop;
  if (setHtml(listEl, 'list', layout === 'focus' ? '' : listHtml)) listEl.scrollTop = scrollTop;

  // Icon strip (Focus)
  const stripOrder = mode === 'bench'
    ? ['you', 'bench', 'team'].flatMap(g => shown.filter(c => groupOf(c) === g))
      .concat(shownNoSkin) // ARAM: no-skin champions at the end, grayed
    : shown.concat(showNoSkinChamps ? shownNoSkin : []);
  setHtml(stripEl, 'strip', layout === 'focus' ? stripHtml(stripOrder, selectedId) : '');

  // Big view (Split + Focus)
  if (layout !== 'narrow' && setHtml(focusEl, 'focus', focusHtml(selected))) fitFocusCards();
  if (layout === 'narrow') setHtml(focusEl, 'focus', '');

  // Build guide panel follows the selected champion (during a game: your champion)
  updateGuide(inGameChamp || selected);

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
// Whole page, so the skin view and chroma pop-up get backups too.
document.addEventListener('error', (e) => {
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
  // Build guide / Wiki / 3D model / Spotlight buttons: open (or close) the panel
  // "Show unowned" next to the skin count: same setting as the footer button
  if (e.target.closest('[data-toggle-unowned]')) {
    flipUnowned();
    return;
  }
  // Chromas button under a skin card: open the chroma viewer (doesn't equip)
  const chromaBtn = e.target.closest('[data-chromas]');
  if (chromaBtn) {
    const champId = Number(chromaBtn.dataset.champId);
    const champ = lastFocusChamp && lastFocusChamp.id === champId ? lastFocusChamp : null;
    openChromas(champ, Number(chromaBtn.dataset.chromas));
    return;
  }
  const panelBtn = e.target.closest('[data-panel]');
  if (panelBtn) {
    togglePanel(panelBtn.dataset.panel);
    return;
  }
  // Book icon on a list row: build guide for that champion
  const guideBtn = e.target.closest('[data-guide]');
  if (guideBtn) {
    userPickId = Number(guideBtn.dataset.id);
    inGameChamp = null; // you picked a champion: the panel follows it
    panelMode = 'guide';
    setGuideOpen(true);
    return;
  }
  // Check-mark button on a big card (or the skin view): equip that skin
  const equipBtn = e.target.closest('[data-equip]');
  if (equipBtn) {
    equipFrom(equipBtn);
    return;
  }
  // Clicking a big skin card: select it (highlighted, and used by 3D model /
  // Spotlight), equip it, and open its info card.
  const card = e.target.closest('.focus-card');
  if (card) {
    const skinId = Number(card.dataset.skinId);
    if (!isSelectedSkin({ id: Number(card.dataset.champId) }, skinId)) {
      pickedSkinId = skinId;
      pickedSkinChampId = Number(card.dataset.champId);
      pickedSkinName = '';
      bodyEl.querySelectorAll('.focus-card.is-selected').forEach(el => el.classList.remove('is-selected'));
      card.classList.add('is-selected');
      if (guideVisible() && (panelMode === 'model' || panelMode === 'spotlight') && lastPayload) render(lastPayload);
    }
    const champ = lastFocusChamp;
    const owned = champ && champ.skins.some(s => s.id === skinId);
    if (owned && champ.canEquip && champ.selectedSkinId !== skinId && !card.classList.contains('is-equipping')) {
      equipFrom(card, skinId);
    }
    openInfoCard(champ, skinId);
    return;
  }
  // Small layout thumbnails: click to equip (unchanged)
  const skinEl = e.target.closest('.scout-skin.can-equip');
  if (skinEl) {
    equipFrom(skinEl, Number(skinEl.dataset.skinId));
    return;
  }
  // Pick a champion for the big view (list rows in Split, icons in Focus)
  const pick = e.target.closest('.scout-strip__item') ||
    (currentLayout() !== 'narrow' && e.target.closest('.scout-row'));
  if (pick) {
    // Found through a skin search (skin name under the champion): open that
    // skin's info card on their page. The search stays, so you can keep going.
    if (pick.dataset.hitSkin) {
      openSearchedSkin({
        champId: Number(pick.dataset.id),
        skinId: Number(pick.dataset.hitSkin),
        owned: pick.dataset.hitOwned === '1',
      }, { keepSearch: true });
      return;
    }
    userPickId = Number(pick.dataset.id);
    inGameChamp = null; // you picked a champion: the panel follows it
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
  '.scout-skin, .scout-strip__item, .scout-layout-toggle, .scout-guide__view, .resize-grip, .chroma-pop, .skin-view,' +
  '.info-card, .info-dim, .scout-search';
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

// Game starting: show the guide for the champion you're playing, Guide only
window.scoutAPI.onGameStart(({ champ }) => {
  if (!champ) return;
  inGameChamp = champ;
  panelMode = 'guide'; // during the game the panel shows the build guide
  guideOnly = true; // not saved: the next champ select starts with skins again
  if (currentLayout() === 'narrow') guideOpenNarrow = true;
  else guideOpenWide = true;
  guideUrl = ''; // make sure the right page loads
  lastHtml.focus = '';
  render(lastPayload || { state: 'ready', champions: [], availableCount: 0, mode: 'draft', hoverId: 0 });
});

// New information from the app (champ select, preview, …) means the game is
// over: stop pinning the panel to the champion you played
window.scoutAPI.onUpdate((payload) => {
  if (inGameChamp) {
    // Coming back from a game: unpin the panel and show the skins again
    // (the game had switched on "Guide only")
    inGameChamp = null;
    guideOnly = false;
    panelMode = 'guide';
  }
  render(payload);
});
