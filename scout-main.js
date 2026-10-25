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

const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'scout-window.json');
const PREFS_FILE = () => path.join(app.getPath('userData'), 'scout-prefs.json');

// Pinned = always stays above other windows (including League).
// Unpinned = a normal window: clicking League brings League to the front.
let pinned = false;
try { pinned = !!JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')).pinned; } catch (e) { /* default: unpinned */ }
function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify({ pinned })); } catch (e) { /* not important */ }
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

function send(payload) {
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) return; // nothing changed — avoid flicker
  const win = ensureWindow();
  const deliver = () => {
    lastPayloadJson = json;
    win.webContents.send('scout-update', payload);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
  else deliver();
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

/** Builds { championId: { id, name, key, iconUrl, skins: [...] } } for owned non-base skins */
function buildOwnedIndex(data) {
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
    index[s.championId].skins.push({
      id: s.id,
      name: s.name,
      rarity: s.rarity,
      img: s.loadingUrl,
      fallbacks: s.imageFallbacks || [],
    });
  }
  return index;
}

function getSkinDataOrLoad() {
  const data = deps.getSkinData();
  if (data) return data;
  if (!skinLoadInFlight) {
    skinLoadInFlight = true;
    deps.loadSkinData()
      .then(() => { if (isPreview) renderPreview(); })
      .catch(e => console.warn('[Scout] Skin load failed:', e.message))
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

async function update(session, creds) {
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
  for (const id of candidateIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = owned[id];
    if (!entry) continue; // no owned skins → hidden (keeps the list short)
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
    myRole: me.assignedPosition || '', // top/jungle/middle/bottom/utility ('' in ARAM)
    mode: isBenchMode ? 'bench' : 'draft',
    hoverId,
    champions,
    availableCount: seen.size,
  });
  showWindow();
}

function clear() {
  if (!isActive) return;
  isActive = false;
  dismissedThisLobby = false;
  pickableIds = null;
  if (!isPreview) hideWindow();
}

function renderPreview() {
  const data = getSkinDataOrLoad();
  if (!data) {
    send({ state: 'loading', preview: true });
    return;
  }
  const champions = Object.values(buildOwnedIndex(data))
    .map(c => ({ ...c, skinCount: c.skins.length, isMine: false, onBench: false }))
    .sort((a, b) => (b.skinCount - a.skinCount) || a.name.localeCompare(b.name));
  send({ state: 'ready', mode: 'preview', preview: true, hoverId: 0, champions, availableCount: champions.length });
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
  hideWindow();
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
  isPreviewOn: () => isPreview,
};
