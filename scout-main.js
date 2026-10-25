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

const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'scout-window.json');

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
    if (scoutWindow.isMaximized() || collapsedFromHeight !== null) return;
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
    minWidth: 220, minHeight: 160,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#010a13',
    title: 'Skin Scout',
    webPreferences: {
      preload: path.join(__dirname, 'scout-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 'floating' keeps it above the League client window
  scoutWindow.setAlwaysOnTop(true, 'floating');
  scoutWindow.loadFile('scout.html');

  scoutWindow.on('move', saveBoundsSoon);
  scoutWindow.on('resize', saveBoundsSoon);
  scoutWindow.on('maximize', sendWindowState);
  scoutWindow.on('unmaximize', sendWindowState);
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
    maximized: scoutWindow.isMaximized(),
    collapsed: collapsedFromHeight !== null,
  });
}

function expandFromCollapsed() {
  const b = scoutWindow.getBounds();
  scoutWindow.setMinimumSize(220, 160);
  scoutWindow.setBounds({ ...b, height: collapsedFromHeight });
  collapsedFromHeight = null;
}

function windowAction(action, headerHeight) {
  if (!scoutWindow || scoutWindow.isDestroyed()) return;

  if (action === 'maximize') {
    if (collapsedFromHeight !== null) expandFromCollapsed();
    if (scoutWindow.isMaximized()) scoutWindow.unmaximize();
    else scoutWindow.maximize();
  }

  if (action === 'minimize') {
    if (scoutWindow.isMaximized()) scoutWindow.unmaximize();
    if (collapsedFromHeight !== null) {
      expandFromCollapsed();
    } else {
      const b = scoutWindow.getBounds();
      const h = Math.max(36, Math.ceil(headerHeight || 56));
      collapsedFromHeight = b.height;
      scoutWindow.setMinimumSize(220, h);
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
  }
  if (dismissedThisLobby) return;

  const data = getSkinDataOrLoad();
  if (!data) {
    if (lastUpdateSummary !== 'loading') {
      lastUpdateSummary = 'loading';
      console.log('[Scout] Waiting for your skin collection to finish loading…');
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
  init, update, clear, togglePreview, dismiss, destroy, windowAction,
  isPreviewOn: () => isPreview,
};
