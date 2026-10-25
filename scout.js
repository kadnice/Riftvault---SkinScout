// ═══════════════════════════════════════════════════════════════════════════════
// SKIN SCOUT — window logic
// Receives a list of champions from the main process and draws one row per
// champion. Hovering a row (or hovering that champion in the League client)
// expands it to show the skins you own. The magnifying glass filters by name.
// ═══════════════════════════════════════════════════════════════════════════════

const listEl = document.getElementById('scout-list');
const subEl = document.getElementById('scout-sub');
const footerEl = document.querySelector('.scout-footer');
const searchBtn = document.getElementById('scout-search-btn');
const searchInput = document.getElementById('scout-search');

let lastPayload = null;
let lastHoverId = 0;
let searchQuery = '';

document.getElementById('scout-close').addEventListener('click', () => {
  window.scoutAPI.dismiss();
});
document.getElementById('scout-open-main').addEventListener('click', () => {
  window.scoutAPI.openMainWindow();
});

// ─── Size scaling ───
// The window is designed at ~310px wide. As you make it wider (or maximize it),
// everything — portraits, names, numbers — grows with it, up to 1.5× bigger.
// `zoom` scales the whole page at once, so every size stays in proportion.
const HEADER_HEIGHT = 56; // must match .scout-header height in scout.css
let currentScale = 1;

function updateScale() {
  currentScale = Math.min(1.5, Math.max(1, window.innerWidth / 310));
  document.body.style.zoom = currentScale;
}
window.addEventListener('resize', updateScale);
updateScale();

// ─── Minimize / maximize ───
document.getElementById('scout-min').addEventListener('click', () => {
  // Tell the main process how tall the title bar is, so it can fold down to it
  // (+2 for the 1px window border at the top and bottom)
  window.scoutAPI.windowAction('minimize', (HEADER_HEIGHT + 2) * currentScale);
});
document.getElementById('scout-max').addEventListener('click', () => {
  window.scoutAPI.windowAction('maximize');
});
// Double-clicking the title text also toggles minimize, like a window shade
document.querySelector('.scout-header__text').addEventListener('dblclick', () => {
  window.scoutAPI.windowAction('minimize', (HEADER_HEIGHT + 2) * currentScale);
});

window.scoutAPI.onWindowState(({ maximized, collapsed }) => {
  document.body.classList.toggle('is-maximized', maximized);
  document.body.classList.toggle('is-collapsed', collapsed);
  document.getElementById('scout-max').title = maximized ? 'Restore' : 'Maximize';
  document.getElementById('scout-min').title = collapsed ? 'Expand' : 'Minimize';
});

// ─── Search ───
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

// ─── Rendering ───
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

function renderMessage(text) {
  listEl.innerHTML = `<div class="scout-empty">${escapeHtml(text)}</div>`;
}

function renderRow(champ, hoverId, openIds) {
  const tags = [];
  if (champ.isMine) tags.push('<span class="scout-tag scout-tag--you">You</span>');
  if (champ.onBench) tags.push('<span class="scout-tag scout-tag--bench">Bench</span>');
  if (champ.onTeam) tags.push('<span class="scout-tag scout-tag--team">Team</span>');

  const skins = champ.skins.map(s => `
    <div class="scout-skin scout-skin--${escapeHtml(s.rarity)}" title="${escapeHtml(s.name)}">
      <img src="${escapeHtml(s.img)}" alt="" loading="lazy" />
    </div>`).join('');

  const classes = ['scout-row'];
  if (champ.id === hoverId) classes.push('is-hovered', 'is-open');
  else if (openIds.has(champ.id)) classes.push('is-open');

  return `
    <section class="${classes.join(' ')}" data-id="${champ.id}">
      <div class="scout-row__main">
        <img class="scout-row__icon" src="${escapeHtml(champ.iconUrl)}" alt="" />
        <div class="scout-row__name">${escapeHtml(champ.name)} ${tags.join('')}</div>
        <div class="scout-row__count" title="${champ.skinCount} owned skin${champ.skinCount === 1 ? '' : 's'}">
          ${champ.skinCount}
        </div>
      </div>
      <div class="scout-row__skins">${skins}</div>
    </section>`;
}

function render(payload) {
  lastPayload = payload;

  if (payload.state === 'loading') {
    subEl.textContent = 'Loading your skins…';
    renderMessage('Reading your collection from the League client. This takes a few seconds the first time.');
    return;
  }

  const { champions, availableCount, mode, hoverId } = payload;

  if (mode === 'preview') {
    subEl.textContent = `Preview · ${champions.length} champs with skins`;
  } else if (mode === 'bench') {
    subEl.textContent = `ARAM · ${champions.length} of ${availableCount} available have skins`;
  } else {
    subEl.textContent = `${champions.length} of ${availableCount} pickable have skins`;
  }

  if (champions.length === 0) {
    renderMessage(mode === 'bench'
      ? 'No skins on your champion, the bench, or your teammates right now.'
      : 'None of your pickable champions have skins.');
    return;
  }

  const shown = searchQuery
    ? champions.filter(c => c.name.toLowerCase().includes(searchQuery))
    : champions;

  if (shown.length === 0) {
    renderMessage(`No champions matching "${searchInput.value.trim()}".`);
    return;
  }

  // Keep rows the mouse has opened open across the twice-a-second refresh
  const openIds = new Set(
    [...listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)')].map(r => Number(r.dataset.id)));

  const scrollTop = listEl.scrollTop;
  listEl.innerHTML = shown.map(c => renderRow(c, hoverId, openIds)).join('');
  listEl.scrollTop = scrollTop;

  // When you hover a new champion in the client, scroll its row into view
  if (hoverId && hoverId !== lastHoverId) {
    const row = listEl.querySelector(`.scout-row[data-id="${hoverId}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  lastHoverId = hoverId;
}

// Mouse hover on a row expands it (in addition to client-hover expansion)
listEl.addEventListener('mouseover', (e) => {
  const row = e.target.closest('.scout-row');
  if (!row) return;
  listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)').forEach(r => {
    if (r !== row) r.classList.remove('is-open');
  });
  row.classList.add('is-open');
});
listEl.addEventListener('mouseleave', () => {
  listEl.querySelectorAll('.scout-row.is-open:not(.is-hovered)').forEach(r => r.classList.remove('is-open'));
});

window.scoutAPI.onUpdate(render);
