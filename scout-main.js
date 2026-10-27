// ═══════════════════════════════════════════════════════════════════════════════
// SKIN SCOUT — main-process side
//
// A small always-on-top window that appears during champion select and lists
// every champion you can currently pick that you own skins for.
//
// main.js hands us three things through init():
//   - lcuRequest:      the existing helper for talking to the League client
//   - getSkinData:     returns RiftVault's loaded skin data (or null)
//   - loadSkinData:    asks RiftVault to load skin data from the client
// Then main.js calls update(session, creds) from its champ-select polling loop,
// and clear() when champ select ends.
// ═══════════════════════════════════════════════════════════════════════════════

const { BrowserWindow, app, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let scoutWindow = null;
let deps = null;

let isActive = false;          // true while champ select is showing the scout
let isPreview = false;         // true while the tray "Preview" mode is on
let dismissedThisLobby = false; // user clicked × during this champ select
let pickableIds = null;        // cached pickable champion IDs for this lobby
let pickableFetchedAt = 0;
let lastPayloadJson = '';
let skinLoadInFlight = false;
let lastUpdateSummary = '';
let surfaceOnNextShow = false;
let lobbyStamp = 0;

const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'scout-window.json');
const PREFS_FILE = () => path.join(app.getPath('userData'), 'scout-prefs.json');

// Pinned = always stays above other windows (including League).
// Unpinned = a normal window: clicking League brings League to the front.
let pinned = false;
// "Build guide during games": when a game starts, switch to Guide only for the
// champion you're playing and stay open (tray menu checkbox; on by default)
let guideInGame = true;
try {
  const prefs = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
  pinned = !!prefs.pinned;
  if (prefs.guideInGame === false) guideInGame = false;
} catch (e) { /* defaults */ }
function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify({ pinned, guideInGame })); } catch (e) { /* not important */ }
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────

function readSavedBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOUNDS_FILE(), 'utf8'));
    // Only reuse the saved position if it is still on a connected monitor
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return saved.x >= a.x - 50 && saved.y >= a.y - 50 &&
        saved.x < a.x + a.width - 50 && saved.y < a.y + a.height - 50;
    });
    if (onScreen) return saved;
  } catch (e) { /* no saved position yet */ }

  // Default: top-right corner of the main monitor
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 330, y: area.y + 80, width: 310, height: 520 };
}

let collapsedFromHeight = null; // window height before minimizing (null = not minimized)

let saveTimer = null;
function saveBoundsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!scoutWindow || scoutWindow.isDestroyed()) return;
    // Only remember the normal size, not the maximized or minimized one
    if (windowMode !== 'normal' || collapsedFromHeight !== null) return;
    try {
      fs.writeFileSync(BOUNDS_FILE(), JSON.stringify(scoutWindow.getBounds()));
    } catch (e) { /* not important */ }
  }, 400);
}

function ensureWindow() {
  if (scoutWindow && !scoutWindow.isDestroyed()) return scoutWindow;

  const b = readSavedBounds();
  scoutWindow = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    // Not resizable by Windows: Electron 29 puts Windows' resize zone INSIDE
    // the top of frameless windows, which kept catching attempts to drag the
    // title bar. Skin Scout has its own resize handles instead (left, right,
    // bottom and bottom corners — never the top). See RESIZING below.
    resizable: false,
    maximizable: false,   // never use Windows' real maximize (see WINDOW SIZE MODES)
    fullscreenable: false,
    show: false,
    skipTaskbar: pinned,   // unpinned windows get a taskbar button so you can bring them back
    alwaysOnTop: pinned,
    backgroundColor: '#010a13',
    title: 'Skin Scout',
    webPreferences: {
      preload: path.join(__dirname, 'scout-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // lets the window show the Skill Capped guide inside it
    },
  });
  // 'floating' keeps it above the League client window
  // 'floating' keeps a pinned window above the League client
  if (pinned) scoutWindow.setAlwaysOnTop(true, 'floating');
  scoutWindow.loadFile('scout.html');

  scoutWindow.on('move', saveBoundsSoon);
  scoutWindow.on('resize', saveBoundsSoon);
  // Send the Skin Scout window's own errors and [Scout] messages to the
  // terminal / riftvault.log (otherwise they'd only be in a hidden console)
  scoutWindow.webContents.on('console-message', (...args) => {
    const first = args[0];
    const level = (first && first.level !== undefined) ? first.level : args[1];
    const message = (first && typeof first.message === 'string') ? first.message : args[2];
    const isError = level === 3 || level === 'error';
    if (typeof message === 'string' && (isError || /^\[Scout/.test(message))) {
      console.log(`[Scout window]${isError ? ' ERROR:' : ''} ${message}`);
    }
  });
  // If Windows maximizes it anyway (e.g. Win+Up), switch to our fill mode
  scoutWindow.on('maximize', () => {
    const before = scoutWindow.getNormalBounds();
    scoutWindow.unmaximize();
    setTimeout(() => {
      if (!scoutWindow || scoutWindow.isDestroyed()) return;
      fillScreen();
      normalBounds = before; // remember the size from before Windows maximized it
    }, 50);
  });
  scoutWindow.webContents.on('did-finish-load', () => {
    lastPayloadJson = ''; // force a fresh send after (re)load
    sendWindowState();
  });
  scoutWindow.on('closed', () => { scoutWindow = null; collapsedFromHeight = null; });
  return scoutWindow;
}

// ─── MINIMIZE / MAXIMIZE ──────────────────────────────────────────────────────
// "Minimize" folds the window up into just its title bar instead of sending it
// to the taskbar. That way it stays parked beside the League client and one
// click brings the list back.

function sendWindowState() {
  if (!scoutWindow || scoutWindow.isDestroyed()) return;
  scoutWindow.webContents.send('scout-window-state', {
    maximized: windowMode === 'filled', // drives the maximize/restore icon
    collapsed: collapsedFromHeight !== null,
    pinned,
  });
}

function expandFromCollapsed() {
  const b = scoutWindow.getBounds();
  scoutWindow.setBounds({ ...b, height: collapsedFromHeight });
  collapsedFromHeight = null;
}

// ─── WINDOW SIZE MODES ────────────────────────────────────────────────────────
// Skin Scout never uses Windows' real "maximized" state: that state locks the
// window in place and is slow to undo, which made dragging unreliable.
// Instead:
//   'normal'  – wherever and however big you made it
//   'filled'  – resized to exactly cover the screen (above the taskbar), but
//               still an ordinary window you can drag away
//   'snapped' – resized to half or a quarter of the screen
// normalBounds remembers your normal size/position so it can be restored.
let windowMode = 'normal';
let normalBounds = null;

function workAreaFor(point) {
  return screen.getDisplayNearestPoint(point).workArea;
}

function enterMode(mode, bounds) {
  if (windowMode === 'normal') normalBounds = scoutWindow.getBounds();
  windowMode = mode;
  scoutWindow.setBounds(bounds);
  sendWindowState();
}

function fillScreen() {
  const b = scoutWindow.getBounds();
  enterMode('filled', workAreaFor({ x: b.x + Math.round(b.width / 2), y: b.y + 20 }));
}

function restoreNormal() {
  if (windowMode === 'normal') return;
  windowMode = 'normal';
  if (normalBounds) scoutWindow.setBounds(normalBounds);
  sendWindowState();
}

// ─── SNAPPING ─────────────────────────────────────────────────────────────────
// Let go of the window with the cursor at a screen edge:
//   top edge → fill the screen   left/right edge → half   corner → quarter
const SNAP_EDGE_PX = 12;
function snapTarget(cursor) {
  const area = workAreaFor(cursor);
  const atLeft = cursor.x <= area.x + SNAP_EDGE_PX;
  const atRight = cursor.x >= area.x + area.width - 1 - SNAP_EDGE_PX;
  const atTop = cursor.y <= area.y + SNAP_EDGE_PX;
  const atBottom = cursor.y >= area.y + area.height - 1 - SNAP_EDGE_PX;
  const halfW = Math.round(area.width / 2);
  const halfH = Math.round(area.height / 2);
  const left = { x: area.x, width: halfW };
  const right = { x: area.x + halfW, width: area.width - halfW };
  const top = { y: area.y, height: halfH };
  const bottom = { y: area.y + halfH, height: area.height - halfH };
  if ((atLeft || atRight) && (atTop || atBottom)) {
    return { name: 'quarter', mode: 'snapped', bounds: { ...(atLeft ? left : right), ...(atTop ? top : bottom) } };
  }
  if (atTop) return { name: 'full screen', mode: 'filled', bounds: { ...area } };
  if (atLeft) return { name: 'left half', mode: 'snapped', bounds: { ...left, y: area.y, height: area.height } };
  if (atRight) return { name: 'right half', mode: 'snapped', bounds: { ...right, y: area.y, height: area.height } };
  return null;
}

// ─── DRAGGING ─────────────────────────────────────────────────────────────────
// While you hold the mouse on empty space, the window follows the cursor.
// 7 ms between moves ≈ 144 per second, matching a 144 Hz monitor.
const DRAG_TICK_MS = 7;
const DRAG_SAFETY_MS = 20000; // stop following after 20 s, just in case
let dragTimer = null;
let dragStartBounds = null; // where the window was when the drag began

function stopDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  if (!scoutWindow || scoutWindow.isDestroyed()) return;
  const target = snapTarget(screen.getCursorScreenPoint());
  if (target) {
    console.log(`[Scout] Snapped to ${target.name}.`);
    enterMode(target.mode, target.bounds);
    // "Restore" brings it back to where it was before this drag, like Windows
    if (dragStartBounds) normalBounds = dragStartBounds;
  }
}

function startDrag() {
  stopDrag();
  console.log('[Scout] Window drag started.');
  const startCursor = screen.getCursorScreenPoint();
  const current = scoutWindow.getBounds();
  let start = current;

  if (windowMode !== 'normal' && normalBounds) {
    // Dragging a filled or snapped window: go back to your normal size,
    // keeping the spot you grabbed under the cursor (like Windows does)
    const grabRatio = (startCursor.x - current.x) / Math.max(1, current.width);
    start = {
      x: Math.round(startCursor.x - normalBounds.width * grabRatio),
      y: Math.max(current.y, startCursor.y - 20),
      width: normalBounds.width,
      height: normalBounds.height,
    };
    windowMode = 'normal';
    scoutWindow.setBounds(start);
    sendWindowState();
  }

  dragStartBounds = start;
  const startedAt = Date.now();
  dragTimer = setInterval(() => {
    if (!scoutWindow || scoutWindow.isDestroyed() || Date.now() - startedAt > DRAG_SAFETY_MS) {
      stopDrag();
      return;
    }
    const c = screen.getCursorScreenPoint();
    // Width/height stay fixed so moving between monitors with different
    // scaling doesn't slowly change the window's size
    scoutWindow.setBounds({
      x: start.x + (c.x - startCursor.x),
      y: start.y + (c.y - startCursor.y),
      width: start.width,
      height: start.height,
    });
  }, DRAG_TICK_MS);
}

// ─── RESIZING ─────────────────────────────────────────────────────────────────
// Skin Scout's own resize handles. While you hold one, the window edge follows
// the cursor (same 144 Hz rhythm as dragging). Electron still allows the app
// itself to resize a "not resizable" window; only Windows' own handles are off.
const MIN_WIDTH = 220;
const MIN_HEIGHT = 160;
let resizeTimer = null;

function stopResize() {
  if (resizeTimer) clearInterval(resizeTimer);
  resizeTimer = null;
}

function startResize(edge) {
  stopResize();
  if (!['left', 'right', 'bottom', 'bottom-left', 'bottom-right'].includes(edge)) return;
  const startCursor = screen.getCursorScreenPoint();
  const start = scoutWindow.getBounds();
  if (windowMode !== 'normal') { windowMode = 'normal'; sendWindowState(); } // resizing ends fill/snap
  const startedAt = Date.now();
  resizeTimer = setInterval(() => {
    if (!scoutWindow || scoutWindow.isDestroyed() || Date.now() - startedAt > DRAG_SAFETY_MS) {
      stopResize();
      return;
    }
    const c = screen.getCursorScreenPoint();
    const dx = c.x - startCursor.x;
    const dy = c.y - startCursor.y;
    const b = { ...start };
    if (edge.includes('left')) {
      b.width = Math.max(MIN_WIDTH, start.width - dx);
      b.x = start.x + (start.width - b.width); // right edge stays put
    }
    if (edge.includes('right')) b.width = Math.max(MIN_WIDTH, start.width + dx);
    // Height can't change while minimized to the title bar
    if (edge.includes('bottom') && collapsedFromHeight === null) {
      b.height = Math.max(MIN_HEIGHT, start.height + dy);
    }
    scoutWindow.setBounds(b);
  }, DRAG_TICK_MS);
}

function windowAction(action, headerHeight) {
  if (!scoutWindow || scoutWindow.isDestroyed()) return;

  if (action === 'drag-start') { startDrag(); return; }
  if (action === 'drag-end') { stopDrag(); stopResize(); return; }
  if (action === 'resize-start') { startResize(headerHeight); return; } // 2nd value = which edge

  if (action === 'pin') {
    pinned = !pinned;
    scoutWindow.setAlwaysOnTop(pinned, 'floating');
    scoutWindow.setSkipTaskbar(pinned);
    savePrefs();
  }

  if (action === 'maximize') {
    if (collapsedFromHeight !== null) expandFromCollapsed();
    if (windowMode === 'filled') restoreNormal();
    else fillScreen();
  }

  if (action === 'minimize') {
    if (collapsedFromHeight !== null) {
      expandFromCollapsed();
    } else {
      if (windowMode !== 'normal') restoreNormal();
      const b = scoutWindow.getBounds();
      const h = Math.max(36, Math.ceil(headerHeight || 56));
      collapsedFromHeight = b.height;
      scoutWindow.setBounds({ ...b, height: h });
    }
  }

  sendWindowState();
}

let pendingPayload = null; // newest update waiting for the window to finish loading

function send(payload) {
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) return; // nothing changed — avoid flicker
  const win = ensureWindow();
  if (win.webContents.isLoading()) {
    // Remember only the newest update, and wait for the page ONCE
    // (adding a new wait on every check used to pile up listeners)
    const firstWait = pendingPayload === null;
    pendingPayload = { json, payload };
    if (firstWait) {
      win.webContents.once('did-finish-load', () => {
        const p = pendingPayload;
        pendingPayload = null;
        if (p && !win.isDestroyed()) {
          lastPayloadJson = p.json;
          win.webContents.send('scout-update', p.payload);
        }
      });
    }
    return;
  }
  lastPayloadJson = json;
  win.webContents.send('scout-update', payload);
}

function showWindow() {
  const win = ensureWindow();
  // showInactive: appear without stealing keyboard focus from the League client
  if (!win.isVisible()) win.showInactive();
  // When unpinned, bring it in front of League once at the start of champ
  // select (without taking keyboard focus); after that, normal window rules apply
  if (surfaceOnNextShow) {
    surfaceOnNextShow = false;
    if (!pinned) win.moveTop();
  }
}

function hideWindow() {
  if (scoutWindow && !scoutWindow.isDestroyed() && scoutWindow.isVisible()) {
    scoutWindow.hide();
  }
}

// ─── DATA ─────────────────────────────────────────────────────────────────────

/** Champion id → { id, key, name }, for ANY champion (owned skins or not) */
const champInfoCache = new WeakMap();
function allChampInfo(data) {
  champInfo(data, 0); // builds the cache
  return champInfoCache.get(data);
}

/** A champion you own no skins for, in the same shape as the others */
function noSkinEntry(data, id) {
  const info = champInfo(data, id);
  if (!info) return null;
  return {
    ...info,
    iconUrl: `https://ddragon.leagueoflegends.com/cdn/${data.version}/img/champion/${info.key}.png`,
    skins: [],
    skinCount: 0,
    noSkins: true,
  };
}

/** A skin's chromas, trimmed to what the window needs:
 *  [{ id, name, owned, colors }] (empty list when the skin has none) */
function chromaInfo(skin) {
  const list = (skin.chromas && skin.chromas.list) || [];
  return list.map(c => ({
    id: c.id,
    name: c.name || '',
    owned: c.ownership?.owned === true || c.owned === true || c.isOwned === true || c.unlocked === true,
    colors: Array.isArray(c.colors) ? c.colors.slice(0, 2) : [],
  }));
}

// ─── Skin prices (RiftVault's price list, assets/skin_prices.json) ──────────
// Keys look like "aatrox_justicar": champion + skin name, lowercase, letters
// and numbers only, champion name removed from the skin name. Values are an
// RP amount ("1350") or how the skin was sold ("Special", "Battle Pass", ...).
let priceList = null;
function loadPrices() {
  if (priceList) return priceList;
  try {
    priceList = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'skin_prices.json'), 'utf8'));
  } catch (e) {
    console.warn('[Scout] Could not load skin prices:', e.message);
    priceList = {};
  }
  return priceList;
}

const clean = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Tiers that always cost the same RP (used for skins newer than the price list)
const TIER_RP = { epic: 1350, legendary: 1820, ultimate: 3250 };

/** { rp: 1350 } for RP skins, { label: 'Battle Pass' } for others, or null */
function skinPrice(s) {
  if (s.isBase) return null;
  const prices = loadPrices();
  const champ = clean(s.championName);
  const name = clean(s.name);
  const candidates = [
    name !== champ && name.includes(champ) ? `${champ}_${name.replace(champ, '')}` : null,
    `${champ}_${name}`,
    `${clean(s.championKey)}_${name.replace(champ, '')}`, // e.g. Wukong = MonkeyKing
  ];
  for (const key of candidates) {
    const value = key && prices[key];
    if (!value) continue;
    const rp = Number(value);
    return rp > 0 ? { rp } : { label: value === 'Special' ? 'Special' : value };
  }
  // Not in the list (newer skin): Epic / Legendary / Ultimate have fixed prices
  if (TIER_RP[s.rarity]) return { rp: TIER_RP[s.rarity] };
  // Mythic / Exalted / Transcendent and Victorious skins are never sold for RP
  if (['mythic', 'exalted', 'transcendent'].includes(s.rarity) || /^victorious /i.test(s.name)) {
    return { label: 'Special' };
  }
  return null; // unknown: show nothing rather than guess
}

/** What the window needs to draw one skin card */
function skinCard(s) {
  return {
    id: s.id,
    name: s.name,
    rarity: s.rarity,
    isLegacy: !!s.isLegacy,
    clientGemPath: s.clientGemPath === undefined ? null : s.clientGemPath,
    price: skinPrice(s),
    img: s.loadingUrl,
    fallbacks: s.imageFallbacks || [],
    splash: s.splashUrl,          // wide art for the full-window skin view
    chromas: chromaInfo(s),
  };
}

/** Skins of one champion that you DON'T own (asked for by the window when
 *  the "Unowned skins" toggle is on) */
function unownedSkins(champId) {
  const data = deps.getSkinData();
  if (!data) return [];
  return (data.skins || [])
    .filter(s => s.championId === champId && !s.owned && !s.isBase)
    .map(skinCard);
}

function champInfo(data, id) {
  if (!champInfoCache.has(data)) {
    const map = {};
    for (const s of data.skins || []) {
      if (!map[s.championId] && s.championKey && s.championKey !== 'Unknown') {
        map[s.championId] = { id: s.championId, key: s.championKey, name: s.championName };
      }
    }
    champInfoCache.set(data, map);
  }
  return champInfoCache.get(data)[id] || null;
}

/** Builds { championId: { id, name, key, iconUrl, skins: [...] } } for owned non-base skins.
 *  Remembered per collection, so it's built once instead of ~3 times a second. */
const ownedIndexCache = new WeakMap();
function buildOwnedIndex(data) {
  if (ownedIndexCache.has(data)) return ownedIndexCache.get(data);
  const index = {};
  for (const s of data.skins || []) {
    if (!s.owned || s.isBase) continue;
    // Skip "champions" that aren't real League champions (e.g. game-mode-only
    // characters the client also reports). They show up as "Unknown".
    if (!s.championKey || s.championKey === 'Unknown') continue;
    if (!index[s.championId]) {
      index[s.championId] = {
        id: s.championId,
        name: s.championName,
        key: s.championKey,
        iconUrl: `https://ddragon.leagueoflegends.com/cdn/${data.version}/img/champion/${s.championKey}.png`,
        skins: [],
      };
    }
    index[s.championId].skins.push(skinCard(s));
  }
  ownedIndexCache.set(data, index);
  return index;
}

let lastLoadError = '';
let previewRetryTimer = null;

function getSkinDataOrLoad() {
  const data = deps.getSkinData();
  if (data) return data;
  if (!skinLoadInFlight) {
    skinLoadInFlight = true;
    deps.loadSkinData()
      .then(() => { lastLoadError = ''; if (isPreview) renderPreview(); })
      .catch(e => {
        lastLoadError = e.message;
        console.warn('[Scout] Skin load failed:', e.message);
        // Preview open but League isn't running yet: try again in 10 s
        if (isPreview) {
          clearTimeout(previewRetryTimer);
          previewRetryTimer = setTimeout(() => { if (isPreview) renderPreview(); }, 10000);
          renderPreview();
        }
      })
      .finally(() => { skinLoadInFlight = false; });
  }
  return null;
}

async function getPickableIds(creds) {
  // Re-ask the client every 10s — pickable champs can change (e.g. a trade)
  if (pickableIds && Date.now() - pickableFetchedAt < 10000) return pickableIds;
  try {
    const ids = await deps.lcuRequest(creds.port, creds.password,
      '/lol-champ-select/v1/pickable-champion-ids');
    if (Array.isArray(ids)) {
      pickableIds = ids;
      pickableFetchedAt = Date.now();
    }
  } catch (e) { /* keep whatever we had */ }
  return pickableIds;
}

/** Champions that are no longer available: banned, or picked by someone else */
function getUnavailableIds(session) {
  const out = new Set();
  const me = session.localPlayerCellId;
  for (const a of (session.actions || []).flat()) {
    if (a.type === 'ban' && a.completed && a.championId) out.add(a.championId);
    if (a.type === 'pick' && a.completed && a.championId && a.actorCellId !== me) out.add(a.championId);
  }
  for (const p of [...(session.myTeam || []), ...(session.theirTeam || [])]) {
    if (p.cellId !== me && p.championId) out.add(p.championId);
  }
  const bans = session.bans || {};
  for (const id of [...(bans.myTeamBans || []), ...(bans.theirTeamBans || [])]) {
    if (id) out.add(id);
  }
  return out;
}

// ─── PUBLIC API (called from main.js) ─────────────────────────────────────────

function init(dependencies) {
  deps = dependencies;
}

let updateRunning = false;

/** Called ~3 times a second during champ select. Skips a check if the previous
 *  one is still waiting on the League client, so slow replies don't pile up. */
async function update(session, creds) {
  if (updateRunning) return;
  updateRunning = true;
  try {
    await runUpdate(session, creds);
  } finally {
    updateRunning = false;
  }
}

async function runUpdate(session, creds) {
  // A real champ select always wins over preview mode
  if (isPreview) {
    isPreview = false;
    lastPayloadJson = '';
    if (deps.onPreviewChange) deps.onPreviewChange(false);
  }

  // First tick of a new champ select
  if (!isActive) {
    isActive = true;
    dismissedThisLobby = false;
    pickableIds = null;
    surfaceOnNextShow = true; // pop above League once when champ select starts
    lobbyStamp = Date.now();  // lets the window know this is a NEW champ select
  }
  if (dismissedThisLobby) return;

  const data = getSkinDataOrLoad();
  if (!data) {
    if (lastUpdateSummary !== 'loading') {
      lastUpdateSummary = 'loading';
      console.log('[Scout] Waiting for your skin collection to finish loading...');
    }
    send({ state: 'loading' });
    showWindow();
    return;
  }

  const owned = buildOwnedIndex(data);
  const me = (session.myTeam || []).find(p => p.cellId === session.localPlayerCellId) || {};
  // The champion you're actually playing (locked in, or your ARAM roll), even
  // if you own no skins for it, so its build guide can be shown in game
  lastMyChamp = me.championId ? champInfo(data, me.championId) : null;
  const myChampId = me.championId || 0;
  const hoverId = me.championPickIntent || me.championId || 0;
  const benchIds = session.benchEnabled
    ? (session.benchChampions || []).map(b => b.championId)
    : [];
  const isBenchMode = !!session.benchEnabled; // ARAM-style modes
  const teammateIds = isBenchMode
    ? (session.myTeam || [])
      .filter(p => p.cellId !== session.localPlayerCellId && p.championId)
      .map(p => p.championId)
    : [];

  // Can you equip a skin right now? Only on your own champion, and only once it's
  // really yours: locked in (draft/blind) or assigned (ARAM, where there's no lock-in).
  const lockedIn = (session.actions || []).flat().some(
    a => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && a.completed);
  const canEquip = !!myChampId && (isBenchMode || lockedIn);
  const selectedSkinId = me.selectedSkinId || 0;

  let candidateIds;
  if (isBenchMode) {
    // ARAM: your rolled champ, the bench, and teammates' champs (you can trade)
    candidateIds = [myChampId, ...benchIds, ...teammateIds];
  } else {
    const pickable = (await getPickableIds(creds)) || Object.keys(owned).map(Number);
    const unavailable = getUnavailableIds(session);
    candidateIds = pickable.filter(id => !unavailable.has(id));
    if (myChampId) candidateIds.push(myChampId);
  }

  const seen = new Set();
  const champions = [];
  const noSkinChamps = []; // available champions you own no skins for
  for (const id of candidateIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = owned[id];
    if (!entry) {
      const info = noSkinEntry(data, id);
      if (info) {
        noSkinChamps.push({
          ...info,
          isMine: id === myChampId,
          onBench: benchIds.includes(id),
          onTeam: teammateIds.includes(id),
        });
      }
      continue;
    }
    champions.push({
      ...entry,
      skinCount: entry.skins.length,
      isMine: id === myChampId,
      onBench: benchIds.includes(id),
      onTeam: teammateIds.includes(id),
      canEquip: canEquip && id === myChampId,
      selectedSkinId: id === myChampId ? selectedSkinId : 0,
    });
  }

  // Your current champ first (ARAM), then most skins, then alphabetical
  champions.sort((a, b) =>
    (b.isMine - a.isMine) || (b.skinCount - a.skinCount) || a.name.localeCompare(b.name));

  const summary = `Showing ${champions.length} of ${seen.size} available champions (${isBenchMode ? 'ARAM' : 'draft/blind'} mode).`;
  if (summary !== lastUpdateSummary) {
    lastUpdateSummary = summary;
    console.log(`[Scout] ${summary}`);
  }

  send({
    state: 'ready',
    lobby: lobbyStamp,
    myChamp: lastMyChamp,
    myRole: me.assignedPosition || '', // top/jungle/middle/bottom/utility ('' in ARAM)
    mode: isBenchMode ? 'bench' : 'draft',
    hoverId,
    champions,
    noSkinChamps: noSkinChamps.sort((a, b) => a.name.localeCompare(b.name)),
    availableCount: seen.size,
  });
  showWindow();
}

// "Guide only" mode (set from the window): keep Skin Scout open through the
// game so the build guide stays on screen
let keepOpenForGuide = false;
function setKeepOpenForGuide(keep) {
  keepOpenForGuide = !!keep;
}

let lastMyChamp = null;       // { id, key, name } of the champion you're playing
let waitingForGame = null;    // timer: hide if champ select ended without a game
let guideShownInGame = false; // Skin Scout is showing the guide during a game

function willShowGuideInGame() {
  return guideInGame && !!lastMyChamp && !dismissedThisLobby;
}

function clear() {
  if (!isActive) return;
  isActive = false;
  pickableIds = null;
  // Closed with × during champ select: don't bring it back for the game either
  if (dismissedThisLobby) lastMyChamp = null;
  if (isPreview || keepOpenForGuide) { dismissedThisLobby = false; return; }
  if (willShowGuideInGame()) {
    // Stay up for the loading screen; if no game starts (e.g. a dodge), hide
    clearTimeout(waitingForGame);
    waitingForGame = setTimeout(() => {
      waitingForGame = null;
      if (!guideShownInGame) hideWindow();
    }, 20000);
    dismissedThisLobby = false;
    return;
  }
  dismissedThisLobby = false;
  hideWindow();
}

/** Called when a game has ended: tuck away a guide that was kept open */
function afterGame() {
  if (keepOpenForGuide || guideShownInGame) {
    console.log('[Scout] Game over: hiding the build guide.');
    hideWindow();
  }
  guideShownInGame = false;
  lastMyChamp = null;
}

function renderPreview() {
  const data = getSkinDataOrLoad();
  if (!data) {
    send({ state: lastLoadError === 'LEAGUE_NOT_RUNNING' ? 'waiting' : 'loading', preview: true });
    return;
  }
  const owned = buildOwnedIndex(data);
  const champions = Object.values(owned)
    .map(c => ({ ...c, skinCount: c.skins.length, isMine: false, onBench: false }))
    .sort((a, b) => (b.skinCount - a.skinCount) || a.name.localeCompare(b.name));
  // Every other champion: the ones you own no skins for
  const noSkinChamps = Object.keys(allChampInfo(data))
    .map(Number).filter(id => !owned[id])
    .map(id => noSkinEntry(data, id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  send({
    state: 'ready', mode: 'preview', preview: true, hoverId: 0,
    champions, noSkinChamps, availableCount: champions.length + noSkinChamps.length,
  });
}

/** Tray "Preview" — shows every champion you own skins for, no lobby needed */
function togglePreview() {
  isPreview = !isPreview;
  if (!isPreview) {
    lastPayloadJson = '';
    hideWindow();
    return isPreview;
  }
  renderPreview();
  showWindow();
  return isPreview;
}

/** Called when a game starts: close any preview and hide the window */
function hideForGame() {
  if (isPreview) {
    isPreview = false;
    lastPayloadJson = '';
    if (deps.onPreviewChange) deps.onPreviewChange(false);
  }
  clearTimeout(waitingForGame);
  waitingForGame = null;
  if (guideInGame && lastMyChamp) {
    // Switch to Guide only for the champion you're playing, and stay open
    guideShownInGame = true;
    console.log(`[Scout] Game starting: showing the ${lastMyChamp.name} build guide.`);
    const win = ensureWindow();
    showWindow();
    win.webContents.send('scout-game', { champ: lastMyChamp });
    return;
  }
  if (keepOpenForGuide) {
    console.log('[Scout] Game starting: keeping the build guide open ("Guide only" mode).');
    return;
  }
  hideWindow();
}

function toggleGuideInGame() {
  guideInGame = !guideInGame;
  savePrefs();
  return guideInGame;
}

function dismiss() {
  if (isPreview) { togglePreview(); return; }
  dismissedThisLobby = true;
  hideWindow();
}

function destroy() {
  if (scoutWindow && !scoutWindow.isDestroyed()) scoutWindow.destroy();
  scoutWindow = null;
}

module.exports = {
  init, update, clear, togglePreview, dismiss, destroy, windowAction, hideForGame,
  afterGame, setKeepOpenForGuide, toggleGuideInGame, unownedSkins,
  // Is this the Skin Scout window? (used to keep panel links inside the panel)
  isScoutHost: (wc) => !!(wc && scoutWindow && !scoutWindow.isDestroyed() && wc === scoutWindow.webContents),
  // Tell the window to show this skin's Spotlight in its panel. False if it can't.
  showSpotlightInPanel: (skinId, skinName) => {
    if (!scoutWindow || scoutWindow.isDestroyed() || !skinId) return false;
    scoutWindow.webContents.send('scout-spotlight', { skinId, skinName });
    return true;
  },
  isGuideInGameOn: () => guideInGame,
  isPreviewOn: () => isPreview,
};
