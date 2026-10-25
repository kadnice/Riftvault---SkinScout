const { app, BrowserWindow, ipcMain, dialog, screen, shell, Tray, Menu, session } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const scout = require('./scout-main');
let scoutDiskCache = null;
let mainWindow = null; // the main RiftVault window (created in createWindow)

// ─── LCU LOCKFILE READER ───────────────────────────────────────────────────────

// Common install roots across all drives
const DRIVES = ['C', 'D', 'E', 'F', 'G'];
const INSTALL_SUBDIRS = [
  'Riot Games\\League of Legends',
  'Games\\Riot Games\\League of Legends',
  'Program Files\\Riot Games\\League of Legends',
  'Program Files (x86)\\Riot Games\\League of Legends',
];

function buildDefaultPaths() {
  const paths = [];
  for (const drive of DRIVES) {
    for (const sub of INSTALL_SUBDIRS) {
      paths.push(`${drive}:\\${sub}\\lockfile`);
    }
  }
  return paths;
}

function parseLockfile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const parts = content.split(':');
    if (parts.length < 5) return null;
    const [name, pid, port, password, protocol] = parts;
    return { name, pid: parseInt(pid), port: parseInt(port), password, protocol };
  } catch (e) {
    return null;
  }
}

// Run a command in the background without freezing the app (and without
// flashing a console window on screen)
function runHidden(command, timeoutMs) {
  return new Promise((resolve) => {
    exec(command, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

function credsFromCommandLine(cmdLine) {
  const portMatch = cmdLine.match(/--app-port=(\d+)/);
  const tokenMatch = cmdLine.match(/--remoting-auth-token=([\w-]+)/);
  if (!portMatch || !tokenMatch) return null;
  return { name: 'LeagueClientUx', pid: 0, port: parseInt(portMatch[1]), password: tokenMatch[1], protocol: 'https' };
}

/**
 * Slow path: ask Windows where the running League client is. Only used when
 * the lockfile isn't in any of the usual folders. Runs in the background.
 */
async function findLockfileViaPowerShell() {
  // Strategy 1: the running client's .exe location → lockfile sits next to it
  const exePath = await runHidden(
    'powershell -NoProfile -NonInteractive -Command "' +
    '(Get-Process -Name \'LeagueClientUx\' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
    8000);
  if (exePath && fs.existsSync(exePath)) {
    const lockfilePath = path.join(path.dirname(exePath), 'lockfile');
    if (fs.existsSync(lockfilePath)) {
      console.log('[LCU] Found lockfile via the running client:', lockfilePath);
      knownLockfilePath = lockfilePath; // remember it for next time
      return parseLockfile(lockfilePath);
    }
  }

  // Strategy 2: the client's launch command contains the port and password
  const cmdLine = await runHidden(
    'powershell -NoProfile -NonInteractive -Command "' +
    '(Get-CimInstance Win32_Process -Filter \\"name=\'LeagueClientUx.exe\'\\" | Select-Object -First 1).CommandLine"',
    8000);
  if (cmdLine) {
    const creds = credsFromCommandLine(cmdLine);
    if (creds) {
      console.log('[LCU] Got credentials from the client\'s launch command');
      return creds;
    }
    const dirMatch = cmdLine.match(/--install-directory=([^\s"]+)/);
    if (dirMatch) {
      const lockfilePath = path.join(dirMatch[1].replace(/"/g, ''), 'lockfile');
      if (fs.existsSync(lockfilePath)) {
        knownLockfilePath = lockfilePath;
        return parseLockfile(lockfilePath);
      }
    }
  }
  return null;
}

let lastLockfileLogged = null;
let knownLockfilePath = null;   // where we last found League's lockfile
let lastSlowSearchAt = 0;       // when we last ran the PowerShell search
let slowSearchInFlight = null;  // the running PowerShell search, if any
const SLOW_SEARCH_COOLDOWN_MS = 30000;

/**
 * Finds League's port + password. Fast path: read the lockfile from where we
 * found it before, or from the usual install folders (a few quick file checks).
 * Slow path (PowerShell) runs at most once every 30 seconds, in the
 * background, so RiftVault never freezes while League is closed.
 */
async function getLCUCredentials() {
  const candidates = knownLockfilePath ? [knownLockfilePath, ...buildDefaultPaths()] : buildDefaultPaths();
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const creds = parseLockfile(p);
    if (creds) {
      knownLockfilePath = p;
      if (lastLockfileLogged !== p) {
        console.log('[LCU] Found lockfile at:', p);
        lastLockfileLogged = p;
      }
      return creds;
    }
  }

  // League probably isn't running. Don't hammer Windows with searches.
  if (slowSearchInFlight) return slowSearchInFlight;
  if (Date.now() - lastSlowSearchAt < SLOW_SEARCH_COOLDOWN_MS) return null;
  lastSlowSearchAt = Date.now();
  slowSearchInFlight = findLockfileViaPowerShell()
    .catch(() => null)
    .finally(() => { slowSearchInFlight = null; });
  const found = await slowSearchInFlight;
  if (!found) console.log('[LCU] League client not found (will check again shortly).');
  return found;
}

// ─── LCU HTTP CLIENT ──────────────────────────────────────────────────────────

function lcuRequest(port, password, endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${password}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers,
      rejectUnauthorized: false, // LCU uses self-signed cert
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('LCU request timed out'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── DATA DRAGON CLIENT ───────────────────────────────────────────────────────

let ddVersion = null;
let championData = null; // { key -> { name, id } }

async function fetchJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // discard the body
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    // Never wait forever on a slow server
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

/**
 * Downloads JSON once per League patch and keeps a copy on disk. Later startups
 * on the same patch read the saved copy instead of downloading again.
 */
async function fetchJsonCachedPerPatch(name, patch, url) {
  const cacheFile = path.join(app.getPath('userData'), `cache-${name}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (saved && saved.patch === patch && saved.data) return saved.data;
  } catch (e) { /* no saved copy yet */ }
  const data = await fetchJson(url, 60000);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ patch, data }));
  } catch (e) { /* saving is optional */ }
  return data;
}

async function getDataDragonVersion() {
  if (ddVersion) return ddVersion;
  const versions = await fetchJson('https://ddragon.leagueoflegends.com/api/versions.json');
  ddVersion = versions[0];
  return ddVersion;
}

async function getChampionData() {
  if (championData) return championData;
  const version = await getDataDragonVersion();
  const data = await fetchJsonCachedPerPatch('ddragon-champions', version,
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  // Build map: numeric key -> { name, id }
  championData = {};
  for (const [id, champ] of Object.entries(data.data)) {
    championData[champ.key] = { name: champ.name, id: champ.id };
  }
  return championData;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RARITY DETECTION (via CommunityDragon skins.json)
// ═══════════════════════════════════════════════════════════════════════════════

let cdRarityMap = null; // skinId → { rarity, isLegacy, skinLines, image paths }

/**
 * Turns a League asset path like "/lol-game-data/assets/ASSETS/Characters/Sona/..."
 * into a public CommunityDragon web address. CommunityDragon stores every file
 * in lowercase, so the path is lowercased too.
 */
function cdAssetUrl(assetPath) {
  if (!assetPath || typeof assetPath !== 'string') return null;
  const rel = assetPath.replace(/^\/?lol-game-data\/assets\//i, '');
  if (rel === assetPath) return null; // not a game-data path we know how to convert
  return 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/' + rel.toLowerCase();
}

async function fetchCDRarityMap(patch) {
  if (cdRarityMap) return cdRarityMap;
  try {
    console.log('[CDragon] Loading skin metadata...');
    const raw = await fetchJsonCachedPerPatch('cdragon-skins', patch,
      'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/skins.json'
    );
    cdRarityMap = {};
    const rarityMap = {
      kultimate: 'ultimate',
      kmythic: 'mythic',
      klegendary: 'legendary',
      kepic: 'epic',
      ktranscendent: 'transcendent',
      kexalted: 'exalted',
      krare: 'epic',
      kcommon: 'standard',
      knorarity: 'standard',
    };
    let legacyCount = 0;
    for (const [skinId, skinData] of Object.entries(raw)) {
      const r = (skinData.rarity || 'kNoRarity').toLowerCase();
      const isLegacy = !!skinData.isLegacy;
      if (isLegacy) legacyCount++;
      cdRarityMap[skinId] = {
        rarity: rarityMap[r] || 'standard',
        isLegacy,
        skinLines: Array.isArray(skinData.skinLines) ? skinData.skinLines : [],
        // Exact image files for this skin (used when Data Dragon has no image)
        loadScreenPath: skinData.loadScreenPath || null,
        tilePath: skinData.tilePath || null,
        splashPath: skinData.uncenteredSplashPath || skinData.splashPath || null,
      };
    }
    console.log(`[CDragon] Loaded metadata for ${Object.keys(cdRarityMap).length} skins (${legacyCount} legacy)`);
  } catch (e) {
    console.error('[CDragon] Failed to fetch skin metadata:', e.message);
    cdRarityMap = {};
  }
  return cdRarityMap;
}

let cdSkinLineNames = null; // id → name string

async function fetchSkinLineNames(patch) {
  if (cdSkinLineNames) return cdSkinLineNames;
  try {
    console.log('[CDragon] Loading skin line names...');
    const raw = await fetchJsonCachedPerPatch('cdragon-skinlines', patch,
      'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/skinlines.json'
    );
    cdSkinLineNames = {};
    for (const entry of raw) {
      if (entry.id && entry.name) {
        cdSkinLineNames[entry.id] = entry.name;
      }
    }
    console.log(`[CDragon] Loaded ${Object.keys(cdSkinLineNames).length} skin line names`);
  } catch (e) {
    console.error('[CDragon] Failed to fetch skin line names:', e.message);
    cdSkinLineNames = {};
  }
  return cdSkinLineNames;
}

function detectRarity(skin, cdMap) {
  const id = String(skin.id);

  // 1. CommunityDragon authoritative data (always trust if available)
  if (cdMap && cdMap[id] && cdMap[id].rarity) {
    return cdMap[id].rarity;
  }

  // 2. LCU rarityGemPath
  const gemPath = (skin.rarityGemPath || '').toLowerCase();
  if (gemPath) {
    if (gemPath.includes('transcendent')) return 'transcendent';
    if (gemPath.includes('ultimate')) return 'ultimate';
    if (gemPath.includes('mythic') || gemPath.includes('exalted')) return 'mythic';
    if (gemPath.includes('legendary')) return 'legendary';
    if (gemPath.includes('epic')) return 'epic';
  }

  // 3. LCU rarity enum
  if (skin.rarity && skin.rarity !== 'kNoRarity') {
    const map = {
      kUltimate: 'ultimate', kMythic: 'mythic', kLegendary: 'legendary',
      kEpic: 'epic', kRare: 'epic', kCommon: 'standard',
    };
    return map[skin.rarity] || 'standard';
  }

  // 4. Name heuristics (last resort)
  const n = (skin.name || '').toLowerCase();
  if (/prestige/.test(n)) return 'mythic';

  return 'standard';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIN DATA BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

async function buildOwnedSkins(creds) {
  const summoner = await lcuRequest(creds.port, creds.password, '/lol-summoner/v1/current-summoner');
  if (!summoner?.summonerId) throw new Error('Could not fetch summoner data');

  const summonerId = summoner.summonerId;
  const version = await getDataDragonVersion();
  // Start the CommunityDragon downloads now so they run *while* we talk to the
  // League client below, instead of waiting until the end
  const cdPromise = Promise.all([fetchCDRarityMap(version), fetchSkinLineNames(version)]);
  const champions = await getChampionData();

  // Fetch ALL skins (not just owned) — skins-minimal includes ownership flags
  const allSkinsRaw = await lcuRequest(creds.port, creds.password,
    `/lol-champions/v1/inventories/${summonerId}/skins-minimal`);
  if (!Array.isArray(allSkinsRaw)) throw new Error('Unexpected skins response');

  // Group skins by champion for batch chroma fetching
  const skinsByChamp = {};
  for (const s of allSkinsRaw) {
    const cid = Math.floor(s.id / 1000);
    if (!skinsByChamp[cid]) skinsByChamp[cid] = [];
    skinsByChamp[cid].push(s);
  }

  // Fetch mastery data
  const masteryMap = {};
  try {
    let mastery = await lcuRequest(creds.port, creds.password, '/lol-champion-mastery/v1/local-player/champion-mastery');
    
    // Fallback to older puuid endpoint if the above fails
    if (!Array.isArray(mastery) && summoner.puuid) {
      mastery = await lcuRequest(creds.port, creds.password, '/lol-collections/v1/inventories/' + summoner.puuid + '/champion-mastery');
    }
    // Fallback to older summonerId endpoint
    if (!Array.isArray(mastery)) {
      mastery = await lcuRequest(creds.port, creds.password, '/lol-collections/v1/inventories/' + summonerId + '/champion-mastery');
    }

    if (Array.isArray(mastery)) {
      for (const m of mastery) {
        masteryMap[m.championId] = { level: m.championLevel, points: m.championPoints };
      }
    }
  } catch (err) {
    console.warn('[LCU] Failed to fetch mastery:', err.message);
  }

  // Fetch chromas per champion (Chunked properly to avoid LCU Rate Limit drop)
  const chromaMap = {};
  const champIds = Object.keys(skinsByChamp);

  for (let i = 0; i < champIds.length; i += 15) {
    const chunk = champIds.slice(i, i + 15);
    await Promise.all(chunk.map(async champId => {
      try {
        const skins = await lcuRequest(creds.port, creds.password,
          `/lol-champions/v1/inventories/${summonerId}/champions/${champId}/skins`);
        if (Array.isArray(skins)) {
          for (const sk of skins) {
            const chromaList = sk.chromas || sk.childSkins || [];
            if (chromaList.length > 0) {
              const ownedChromas = chromaList.filter(c =>
                c.ownership?.owned === true || c.owned === true || c.isOwned === true || c.unlocked === true
              );
              const finalChromas = ownedChromas;
              if (finalChromas.length > 0) {
                chromaMap[sk.id] = { total: chromaList.length, owned: finalChromas.length, list: chromaList };
              } else if (ownedChromas.length > 0) {
                chromaMap[sk.id] = { total: chromaList.length, owned: ownedChromas.length, list: chromaList };
              } else {
                chromaMap[sk.id] = { total: chromaList.length, owned: 0, list: chromaList };
              }
            }
          }
        }
      } catch { }
    }));
  }

  console.log(`[LCU] Chromas found for ${Object.keys(chromaMap).length} skins`);

  // Fetch CommunityDragon rarity data + skin line names in parallel
  const [cdMap, skinLineNames] = await cdPromise;

  // Drop "ghost" entries: skins whose ID doesn't belong to a real champion, or
  // that CommunityDragon's complete skin list doesn't know about. These showed
  // up as blank cards and duplicates (e.g. a second Star Nemesis Fiddlesticks).
  const cdLoaded = Object.keys(cdMap).length > 1000; // only trust the list if it loaded
  const dropped = [];
  const realSkinsRaw = allSkinsRaw.filter(skin => {
    const isRealChampion = !!champions[String(Math.floor(skin.id / 1000))];
    const isKnownSkin = !cdLoaded || !!cdMap[skin.id];
    if (isRealChampion && isKnownSkin) return true;
    dropped.push(`${skin.name || 'unnamed'} (${skin.id})`);
    return false;
  });
  if (dropped.length) {
    console.log(`[Skins] Skipped ${dropped.length} game-mode copies that aren't normal skins (e.g. ${dropped.slice(0, 3).join(', ')}).`);
  }

  // Enrich all skins
  const skins = realSkinsRaw.map(skin => {
    const champId = Math.floor(skin.id / 1000);
    const skinNum = skin.id % 1000;
    const champ = champions[String(champId)] || { name: 'Unknown', id: 'Unknown' };
    const owned = !!(skin.ownership?.owned);
    const chromas = chromaMap[skin.id] || { total: 0, owned: 0 };
    const mastery = masteryMap[champId] || { level: 0, points: 0 };
    const rarity = skinNum === 0 ? 'standard' : detectRarity(skin, cdMap);

    const cdEntry = cdMap[skin.id] || {};
    // Backup image addresses, in order of preference. CommunityDragon's paths
    // come first; the League client's own paths (if it reported any) after.
    const imageFallbacks = [
      cdAssetUrl(cdEntry.loadScreenPath),
      cdAssetUrl(skin.loadScreenPath),
      cdAssetUrl(cdEntry.tilePath),
      cdAssetUrl(skin.tilePath),
      cdAssetUrl(cdEntry.splashPath),
      cdAssetUrl(skin.splashPath),
    ].filter((u, i, all) => u && all.indexOf(u) === i); // drop blanks & duplicates
    return {
      id: skin.id,
      name: skin.name || `${champ.name} ${skinNum === 0 ? 'Classic' : 'Skin'}`,
      championId: champId,
      championName: champ.name,
      championKey: champ.id,
      skinNum,
      owned,
      isBase: skinNum === 0,
      isLegacy: !!cdEntry.isLegacy,
      rarity,
      chromas,
      mastery,
      splashUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champ.id}_${skinNum}.jpg`,
      loadingUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${champ.id}_${skinNum}.jpg`,
      imageFallbacks,
      skinLines: (cdEntry.skinLines && cdEntry.skinLines.length) ? cdEntry.skinLines : (skin.skinLines || []),
    };
  });

  // Sort by champion name, then skin num
  skins.sort((a, b) => a.championName.localeCompare(b.championName) || a.skinNum - b.skinNum);

  // Compute stats
  const ownedSkins = skins.filter(s => s.owned && !s.isBase);
  const stats = {
    total: ownedSkins.length,
    totalAll: skins.filter(s => !s.isBase).length,
    byRarity: { transcendent: 0, exalted: 0, ultimate: 0, mythic: 0, legendary: 0, epic: 0, standard: 0 },
    legacy: 0,
    totalChromas: 0, ownedChromas: 0,
  };
  for (const s of ownedSkins) {
    stats.byRarity[s.rarity] = (stats.byRarity[s.rarity] || 0) + 1;
    if (s.isLegacy) stats.legacy++;
  }
  for (const c of Object.values(chromaMap)) {
    stats.totalChromas += c.total;
    stats.ownedChromas += c.owned;
  }

  return {
    summoner: {
      displayName: summoner.displayName,
      gameName: summoner.gameName,
      summonerId,
      summonerLevel: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      profileIconUrl: `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png`,
    },
    skins,
    stats,
    total: ownedSkins.length,
    version,
    lcuPort: creds.port,
    skinLineNames,
  };
}

let tray = null;
let isQuitting = false;
let trayBalloonShown = false;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.floor(width * 0.66),
    height: Math.floor(height * 0.78),
    minWidth: 1175,
    minHeight: 900,
    icon: path.join(__dirname, 'assets/icon.ico'),
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile('index.html');

  // Show the window's own [Images] and [3D] messages in the terminal too.
  // (Newer Electron passes one "details" object; older passes separate values.)
  mainWindow.webContents.on('console-message', (...args) => {
    const first = args[0];
    const message = (first && typeof first.message === 'string') ? first.message : args[2];
    if (typeof message === 'string' && /^\[(Images|3D)\]/.test(message)) console.log(message);
  });

  // ─── SYSTEM TRAY ───────────────────────────────────────────────────────────
  tray = new Tray(path.join(__dirname, 'assets/icon.ico'));
  tray.setToolTip('RiftVault');
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Show RiftVault', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { id: 'scout-preview', label: 'Preview Skin Scout', type: 'checkbox', checked: false, click: (item) => { item.checked = scout.togglePreview(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });

  // Intercept close to hide to tray
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!trayBalloonShown) {
        trayBalloonShown = true;
        try {
          tray.displayBalloon({
            title: 'RiftVault',
            content: 'Still running in the tray. Right-click the icon to quit.',
          });
        } catch (err) { /* balloon unsupported on some systems */ }
      }
    }
  });

  // ─── SKIN SCOUT ─────────────────────────────────────────────────────────────
  scout.init({
    lcuRequest,
    getSkinData: () => {
      if (cachedData) return cachedData;
      // Fall back to the on-disk cache (read once, not on every poll)
      if (scoutDiskCache) return scoutDiskCache;
      try {
        const cachePath = path.join(app.getPath('userData'), 'skin-cache.json');
        if (fs.existsSync(cachePath)) scoutDiskCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch (e) { /* fall through to a live load */ }
      return scoutDiskCache;
    },
    loadSkinData: () => fetchSkinsData(),
    // Untick the tray checkbox when a real champ select turns preview off
    onPreviewChange: (on) => {
      const item = trayMenu.getMenuItemById('scout-preview');
      if (item) item.checked = on;
    },
  });
  ipcMain.on('scout-dismiss', () => scout.dismiss());
  ipcMain.on('scout-window', (event, action, headerHeight) => scout.windowAction(action, headerHeight));
  ipcMain.on('scout-open-main', () => { mainWindow.show(); mainWindow.focus(); });

  startChampSelectPolling();

  // Custom titlebar controls
  ipcMain.on('window-minimize', () => mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window-close', () => mainWindow.close());
  ipcMain.on('open-external', (event, url) => shell.openExternal(url));
}
// ─── IPC HANDLERS ─────────────────────────────────────────────────────────────

let cachedData = null;

async function fetchSkinsData() {
  const creds = await getLCUCredentials();
  if (!creds) {
    throw new Error('LEAGUE_NOT_RUNNING');
  }
  const data = await buildOwnedSkins(creds);
  cachedData = data;
  try {
    const cachePath = path.join(app.getPath('userData'), 'skin-cache.json');
    fs.writeFileSync(cachePath, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to write skin cache to disk', e.message);
  }
  return data;
}

ipcMain.handle('get-cached-skins', async () => {
  try {
    const cachePath = path.join(app.getPath('userData'), 'skin-cache.json');
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      return { success: true, data: JSON.parse(data), cached: true };
    }
  } catch (err) {
    console.warn('Failed to read skin cache:', err.message);
  }
  return { success: false, error: 'NO_CACHE' };
});

ipcMain.handle('get-skins', async () => {
  try {
    return { success: true, data: await fetchSkinsData() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('refresh-skins', async () => {
  cachedData = null;
  ddVersion = null;
  championData = null;
  try {
    return { success: true, data: await fetchSkinsData() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── WIKI SCRAPING (NOW STATIC JSON) ──────────────────────────────────────────
let skinPricesCache = null;

ipcMain.handle('get-skin-prices', async () => {
  try {
    const prices = require('./assets/skin_prices.json');
    return { success: true, data: prices };
  } catch (e) {
    console.error('[Skin Prices Load Error]', e.message);
    return { success: false, error: e.message };
  }
});

// ─── APPLY SKIN IN CLIENT ─────────────────────────────────────────────────────

ipcMain.handle('select-skin', async (event, skinId) => {
  const creds = await getLCUCredentials();
  if (!creds) return { success: false, error: 'NO_CLIENT' };
  try {
    const result = await lcuRequest(
      creds.port, creds.password,
      '/lol-champ-select/v1/session/my-selection',
      'PATCH',
      { selectedSkinId: skinId }
    );
    return { success: true, data: result };
  } catch (err) {
    console.error('[Select Skin Error]', err.message);
    return { success: false, error: err.message };
  }
});

// ─── SAVE SHARE CARD ─────────────────────────────────────────────────────────

ipcMain.handle('save-share-card', async (event, byteArray, suggestedName) => {
  const result = await dialog.showSaveDialog({
    title: 'Save Achievement Card',
    defaultPath: suggestedName || 'achievement-card.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (result.canceled) return { success: false };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(byteArray));
    return { success: true };
  } catch (err) {
    console.error('[Save Share Card]', err.message);
    return { success: false, error: err.message };
  }
});

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

app.on('before-quit', () => {
  isQuitting = true;
  scout.destroy();
  if (tray) { tray.destroy(); tray = null; }
});

// ─── AD BLOCKING FOR IN-APP TABS ──────────────────────────────────────────────
// Uses the Ghostery adblocker library (same blocklists as uBlock Origin). It
// downloads the latest lists once, saves a copy in RiftVault's data folder so
// later startups are instant, and refreshes them when that copy is a week old.
// If the library isn't installed, RiftVault simply runs without ad blocking.
async function enableAdBlocking() {
  let ElectronBlocker;
  try {
    ({ ElectronBlocker } = require('@ghostery/adblocker-electron'));
  } catch (e) {
    console.warn('[AdBlock] Library not installed. Run: npm install @ghostery/adblocker-electron');
    return;
  }
  const listCache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    // Throw away a cached copy older than 7 days so the lists stay current
    if (fs.existsSync(listCache) && Date.now() - fs.statSync(listCache).mtimeMs > 7 * 24 * 3600 * 1000) {
      fs.unlinkSync(listCache);
    }
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: listCache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    // The in-app tabs use the default session, so this covers all of them
    try {
      // Full blocking: stops ad downloads AND hides leftover ad boxes on pages.
      // Newer versions of the library need Electron 35+ for the "hiding" part.
      blocker.enableBlockingInSession(session.defaultSession);
      console.log('[AdBlock] Ad blocking is on for in-app tabs.');
    } catch (fullModeError) {
      // Fallback: network blocking only. Ads are still stopped from loading;
      // a page may just show an empty space where an ad would have been.
      const ses = session.defaultSession;
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => blocker.onBeforeRequest(details, cb));
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, cb) => blocker.onHeadersReceived(details, cb));
      console.log('[AdBlock] Ad blocking is on for in-app tabs (network mode: this Electron version is too old for page-cleanup mode).');
    }
  } catch (e) {
    console.warn('[AdBlock] Could not start ad blocking:', e.message);
  }
}

// ─── ONE COPY AT A TIME ───────────────────────────────────────────────────────
// Closing the window only hides RiftVault in the tray, so it's easy to start a
// second copy by accident. If one is already running, focus it and quit this one.
if (!app.requestSingleInstanceLock()) {
  console.log('[App] RiftVault is already running. Showing the existing window instead.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  // Start ad blocking before any tab opens, but never hold up the app more than
  // 5 seconds (the very first run has to download the blocklists)
  await Promise.race([enableAdBlocking(), new Promise(r => setTimeout(r, 5000))]);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── LIVE GAME POLLING ────────────────────────────────────────────────────────
let pollingInterval = null;
let lastHoveredChampId = null;

let lastChampSelectActive = false;
let lastLockedIn = false;

// ─── HIDE TO TRAY WHEN A GAME STARTS ──────────────────────────────────────────
// The League client reports a "gameflow phase": Lobby, ChampSelect, InProgress
// (you're in the game), EndOfGame, and so on. When it switches to InProgress,
// tuck RiftVault away into the system tray. It keeps running there, so Skin
// Scout is ready again for your next champ select.
let lastGameflowPhase = '';
async function hideToTrayWhenGameStarts(creds) {
  let phase = '';
  try {
    phase = await lcuRequest(creds.port, creds.password, '/lol-gameflow/v1/gameflow-phase');
  } catch (e) { return; }
  if (typeof phase !== 'string' || phase === lastGameflowPhase) return;
  console.log(`[App] League status: ${phase}`);
  lastGameflowPhase = phase;
  // GameStart = loading screen, InProgress = in game, Reconnect = rejoining
  if (['GameStart', 'InProgress', 'Reconnect'].includes(phase)) {
    // hide() fully removes a window from the screen, the taskbar AND Alt+Tab,
    // even if it was minimized. RiftVault keeps running in the tray.
    if (mainWindow) mainWindow.hide();
    scout.hideForGame();
    console.log('[App] Game starting: RiftVault is hidden in the system tray.');
  }
}

// Prints a status line to the terminal only when the status changes, so the
// terminal shows a readable story ("waiting…", "champ select found…") instead
// of the same line twice a second.
let lastScoutStatus = '';
function scoutStatus(msg) {
  if (msg === lastScoutStatus) return;
  lastScoutStatus = msg;
  console.log(`[Scout ${new Date().toLocaleTimeString()}] ${msg}`);
}

function startChampSelectPolling() {
  if (pollingInterval) return;

  async function poll() {
    if (!mainWindow) { pollingInterval = setTimeout(poll, 2500); return; }
    const creds = await getLCUCredentials();
    if (!creds) {
      scoutStatus('Cannot find the League client (no lockfile/credentials).');
      pollingInterval = setTimeout(poll, 2500);
      return;
    }

    let nextDelay = 2500; // default idle rate

    try {
      const session = await lcuRequest(creds.port, creds.password, '/lol-champ-select/v1/session');
      if (session && session.localPlayerCellId !== undefined) {
        const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
        const localPlayer = myTeam.find(p => p.cellId === session.localPlayerCellId);
        scoutStatus(localPlayer
          ? `Champ select detected (you are cell ${session.localPlayerCellId}, ${myTeam.length} on your team).`
          : `Champ select detected, but you weren't found on your team list (cell ${session.localPlayerCellId}; team cells: ${myTeam.map(p => p.cellId).join(', ') || 'none'}).`);

        // Skin Scout runs whether or not the local player was found above
        scout.update(session, creds).catch(e => console.warn('[Scout] update failed:', e.stack || e.message));
        nextDelay = 300; // check often in champ select so hovers show up quickly

        if (localPlayer) {
          const champId = localPlayer.championId || localPlayer.championPickIntent;
          if (champId && champId !== lastHoveredChampId && champId !== 0) {
            lastHoveredChampId = champId;
            mainWindow.webContents.send('live-game-event', { type: 'champ-hover', championId: champId });
          }

          // Check if the local player has locked in (pick action completed)
          const isLockedIn = (session.actions || []).flat().some(
            a => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && a.completed
          );

          // Emit champ select state so renderer can show/hide the Apply button
          mainWindow.webContents.send('live-game-event', {
            type: 'champ-select-state',
            active: isLockedIn,
            championId: champId || 0,
            currentSkinId: localPlayer.selectedSkinId || 0,
          });
          // (The original app popped the main window up when you locked in.
          // Skin Scout can equip skins now, so that pop-up was turned off to
          // keep fewer windows open.)
          lastLockedIn = isLockedIn;
          lastChampSelectActive = true;
        }
      } else {
        const reason = session && (session.message || session.errorCode)
          ? `${session.errorCode || ''} ${session.message || ''}`.trim()
          : 'unexpected reply';
        scoutStatus(`Connected to League. Not in champ select (client says: ${reason}).`);
        lastHoveredChampId = null;
        scout.clear();
        await hideToTrayWhenGameStarts(creds);
        if (lastChampSelectActive) {
          mainWindow.webContents.send('live-game-event', {
            type: 'champ-select-state',
            active: false,
            championId: 0,
            currentSkinId: 0,
          });
          lastChampSelectActive = false;
        }
        lastLockedIn = false;
      }
    } catch (e) {
      scoutStatus(`Error talking to the League client: ${e.message}`);
      lastHoveredChampId = null;
      scout.clear();
      await hideToTrayWhenGameStarts(creds); // the client can be slow mid-game; still check
      if (lastChampSelectActive) {
        mainWindow.webContents.send('live-game-event', {
          type: 'champ-select-state',
          active: false,
          championId: 0,
          currentSkinId: 0,
        });
        lastChampSelectActive = false;
      }
      lastLockedIn = false;
    }
    pollingInterval = setTimeout(poll, nextDelay);
  }
  pollingInterval = setTimeout(poll, 500);
}
