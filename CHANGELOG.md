# Changelog

All notable changes to this project will be documented in this file.

---

## [0.4.3] - 2026-10-27

### Fixed
- **Skin Scout opened tiny (310 × 520) with an overlapping title bar.** It now opens at a standard 1100 × 740, centered (smaller on small monitors); windows saved smaller than the new minimum (460 × 240) reset to that size. The title bar no longer overlaps: the toggles use short labels ("No-skin", "Unowned") on narrow windows.
- **Pre-rework skin art.** Skin portraits and splash art now come from the current game files first, so champions with visual updates show their new art (e.g. Fiddlesticks: Spectral, Union Jack, Surprise Party). Data Dragon, which still serves some pre-rework art, is now only a backup. Fixes RiftVault's main window too.
- **The full-window splash view covered the Wiki / 3D model / Spotlight buttons.** It's switched off.
- **Skin pictures could be dragged out as a ghost copy** when the mouse moved slightly during a click. Pictures can no longer be dragged; they're still clickable.

### Added
- **Skin info card:** click a skin portrait to open a card beside it with its splash art, tier, name, RP cost, Legacy status, chromas owned, buttons for **Build guide · Spotlight · 3D model · Wiki** (they open in the side panel, for that skin) and an **Equip** button. Close with ✕, Esc or a click outside it.

### Changed
- **Clicking a skin portrait selects it, equips it and opens its info card.** The selected skin keeps a teal outline (gold = equipped, cream = mouse over) and is the one the 3D model and Spotlight buttons show.
- **"No-skin champs" and "Unowned skins" toggles moved to the title bar.**
- **Bigger skin portraits, natural shape.** The champion sidebar is narrower (280 → 222 px; 272 px in ARAM) and fits the names closely; the book button only takes room on mouse-over. Thinner margins and gaps around the skins. The freed space makes portraits about 10% bigger when the window's width is the limit.
- **Top-right buttons reordered** to match the info card: Build guide on top, then Spotlight · 3D model · Wiki.
- **Search is always visible** at the bottom, as a bigger box (taller, wider, larger text). Esc clears it.
- **Search by skin or skin line.** Typing a skin or skin line (e.g. "demon cursed", "star guardian") lists every champion with a matching skin, with the skin's name under theirs. Enter on a full skin name (e.g. "demon cursed vayne") opens that champion with the skin selected and its info card open (turning on "Unowned skins" if you don't own it).
- **Skin-line search splits owned from not owned.** Searching e.g. "high noon": champions you own a High Noon skin for are listed and highlighted in teal with the skin name; champions whose High Noon skin you don't own move to the gray "No skins" section. Skin matching starts at 3 letters.
- **Skin-line search results are sorted alphabetically in two groups:** "Owned" (you own a matching skin, teal) and "Not owned" (gray).
- **"No-skin champs" now applies while searching.** Off: the gray "No skins" / "Not owned" group is hidden and a short note says how many are hidden. On: they show.
- **Click a skin-search result to open that skin.** Clicking e.g. Twitch under "high noon" opens Twitch's page with High Noon Twitch selected and its info card open; the search stays so you can keep going down the list.
- **Press Enter in the search box to open that champion's page** (best match; capitals and punctuation don't matter, so "kaisa" finds Kai'Sa). The box shakes red if nothing matches.

---

## [0.4.2] - 2026-10-26

Bug fixes and polish for Skin Scout's skin cards and full-window skin view.

### Fixed
- **Tier gems now match the League client exactly.** Skins with no tier in the client (e.g. Neon Strike Vi, Victorious Draven, Totemic Maokai) show no gem; Epic, Legendary, Ultimate, Mythic, Exalted and Transcendent show theirs. Checked against all 2,132 skins: no mismatches.
- **975 RP "Rare" skins** (e.g. Arcane Undercity Vi, Victorious Maokai) were labeled Epic. They now count as having no tier, like in the client. This also fixes RiftVault's main collection window.
- **Splash art on vertical monitors** was cut off on both sides. The whole picture now always shows, never cropped.
- **Splash art stayed small on big monitors.** It now scales up to fit the window (up to 30% larger than its original size).

### Added
- **Legacy emblem** in the bottom-left corner of legacy skin cards, and "Legacy" in the skin view.
- **RP price** in the skin view, with the RP icon (from RiftVault's price list; newer Epic / Legendary / Ultimate skins use their fixed price). Skins not sold for RP say "Special distribution", "Battle Pass" or "Sanctum".
- **Skin counter** ("9 of 20") moved to the top-left corner of the skin view, in larger text.

### Changed
- **Stronger hover effect** on skin portraits: the card lifts, gets a cream outline and glow, and the art brightens and zooms slightly. (Gold still means "equipped".)
- **Skin view layout:** the splash sits in a thin gold frame over a blurred copy of itself, with a small margin instead of running edge to edge.
- **Bigger close button** (round, gold ring, white X; turns gold on hover).
- **Bigger, more readable text** in the bottom-left corner of the skin view: skin name, info line (tier, RP, Legacy) and icons.
- "No tier" is no longer written for skins without a tier; that spot is left out.
- The League client's own gem information is saved with each skin (`clientGemPath`) for future checks.

---

## [0.4.1] - 2026-10-26

### Added
- **Skin count out of the total**: the big view header now reads "6 / 8 skins owned" (owned in gold, total released skins in gray) instead of "6 owned skins · Click a skin to equip it". The equip hint moved to the tooltip.
- **"Show unowned" button next to the skin count**: the same setting as the "Unowned skins" button at the bottom; clicking either one updates both. Hidden when you own every skin for that champion.
- **No-skins states**: champions you own no skins for are shown in gray (never red), with a "No skins" section in ARAM.
- **RiftVault-style skin cards**: tier gem (Epic, Legendary, Ultimate, Mythic, Exalted, Transcendent) at the bottom center of each portrait, a chroma badge in the top-right corner (number = chromas you own), and an equip check mark in the top-left corner.
- **Chroma viewer**: click a chroma badge to see every chroma of that skin, owned first, unowned dimmed with a lock.
- **Full-window skin view**: click a skin to show its splash art across the whole window, with its tier, chromas and an Equip button. Left/right arrows (or the ← → keys) flip through the skins; Esc or ✕ closes it.
- **Footer toggles**: "No-skin champs" (also list champions you own no skins for) and "Unowned skins" (show skins you don't own, dimmed with a lock). Both are remembered.

### Changed
- **Clicking a big skin card now opens it full-window instead of equipping it.** Equip with the check mark on the card or the Equip button in the full view. (The small one-column layout still equips on click.)
- Bigger section labels in ARAM.

---

## [0.4.0] - 2026-10-25 (Skin Scout edition, private fork)

Built in one night on a private copy of RiftVault. The main goal: see which champions you own skins for **before** locking in.

### Added
- **Skin Scout window**: appears automatically in champ select and lists the champions you can pick that you own skins for, each with a gold skin count. Hides at the game's loading screen.
  - **ARAM support**: your champion (YOU), bench champions (BENCH) and teammates' champions (TEAM).
  - **Follows your clicks**: the champion you click in the client (your "pick intent") is highlighted and shown instantly.
  - **Three layouts**: a compact one-column list for small windows; **Split** (list + big skins) and **Focus** (big skins + icon strip) for large windows. Skin art is sized so every skin fits on screen at once, as large as possible.
  - **Click a skin to equip it** after lock-in (or anytime in ARAM).
  - **Search**, **Preview Skin Scout** (tray menu), **pin on top** toggle, minimize-to-title-bar.
  - **Window handling**: drag from any empty space (144 Hz), edge snapping (top = fill screen, sides = half, corners = quarter), borderless fill mode, and custom resize handles on the left, right and bottom (the top edge only moves the window).
  - **Vertical-monitor layout**: in tall windows the guide stacks under the skins at full width.
- **Skill Capped build guides**: a **Build Guide** link in the skin detail view, plus a **guide panel inside Skin Scout** that follows the champion you click and opens the page for your assigned role. A pop-out button opens the guide in a RiftVault tab instead.
- **Ad blocking** in in-app tabs (Ghostery adblocker library; full page-cleanup mode on Electron 35+).
- **Video speed keys** in in-app tabs: S slower, D faster, R reset, Z/X back/forward 10 seconds.
- **Start RiftVault.vbs**: launches RiftVault with no terminal window; messages are written to `riftvault.log`.
- **Hide to tray during games**: RiftVault and Skin Scout hide at the loading screen and stay in the tray (not in Alt+Tab).
- **Skin ID** shown in the skin detail view.
- **Diagnostic log messages** (`[Scout]`, `[App]`, `[Skins]`, `[AdBlock]`, `[Images]`, `[3D]`).

### Changed
- **Electron 29 → 45** and electron-builder 24 → 26.
- **Faster startup**: CommunityDragon and champion data are saved per League patch, and downloads run while RiftVault talks to the League client.
- **League client detection** runs in the background with a 30-second cooldown, so RiftVault no longer freezes while League is closed; downloads have time limits.
- **Only one copy** of RiftVault can run at a time; starting it again brings the existing window forward.
- **Smoother search** in the collection view (waits until you pause typing).

### Fixed
- **Blank skin images** (e.g. Star Guardian Sona, Star Nemesis Fiddlesticks): backup images from CommunityDragon are tried when Data Dragon has none.
- **Ghost entries**: 551 game-mode copies of champions (IDs like 60001000) no longer appear as blank cards, duplicates or "Unknown" champions.
- **Khada 3D links** retry automatically if the site bounces to its home page.
- The main window variable is now properly declared.

### Removed
- **Auto-Surface on Lock-In**: the main window no longer pops up when you lock in (Skin Scout handles equipping skins now).
- Unused `node-fetch` dependency.
- *Tried and removed during development:* a YouTube ad skipper (felt slower).

### Build history (commits in the private repo)
| Time | Commit | Message |
|---|---|---|
| 12:03 AM | `6a09ed9` | Starting copy: RiftVault + first Skin Scout |
| 1:23 AM | `f5abfe5` | Skin Scout features, image fixes, ad blocking, video speed keys |
| 2:28 AM | `d633d81` | Launcher without terminal; reliable hide-to-tray during games |
| 3:25 AM | `78a0637` | Save point before Electron upgrade |
| 3:29 AM | `a58c924` | Upgrade Electron |

---

## [0.3.0] - 2026-04-29

### Added
- **Wishlist**: Click the heart on any unowned skin to save it to your personal wishlist. A dedicated Wishlist tab gives you a clean view of every skin you're chasing, complete with a live count. Wishlists persist locally and auto-prune entries the moment a skin becomes owned.
- **In-App Browser Tabs**: External links no longer kick you out to your default browser. The Champion Wiki, Khada 3D Model Viewer, and the new Skin Spotlight link all open as tabs *inside* RiftVault, with a tab bar across the top of the window (up to 8 simultaneous tabs).
- **Skin Spotlight Link**: A third link in the skin detail modal that opens a YouTube `@SkinSpotlights` search for the skin in an in-app tab.
- **Group by Set**: A new grouping mode that organizes your collection by skin line / universe (Star Guardian, PROJECT, K/DA, etc.). Skin-line names are sourced from CommunityDragon's `skinlines.json`. An "Other" bucket catches uncategorized skins and is always pinned to the bottom.
- **Most Complete % Sort**: A new sort option that orders groups by ownership percentage — perfect for finding sets you're one or two skins away from completing. Available in `Champion` and `Set` modes.
- **Collection RP Value**: A new mini-stat in the sidebar that sums the RP cost of every owned non-base skin, with an estimated USD equivalent.
- **System Tray**: Closing the window now hides RiftVault to the system tray instead of quitting. Right-click the tray icon to re-open or quit. A one-time balloon notification explains this on first close.
- **Auto-Surface on Lock-In**: RiftVault now unhides and focuses itself the moment you lock in a champion during champion select, so the Apply controls are right there waiting.

### Changed
- **Mastery Endpoint Hardening**: Mastery data is now fetched with a 3-tier fallback (`/lol-champion-mastery/v1/local-player/...` → puuid endpoint → legacy summonerId endpoint) to keep the Mastery sort working as Riot iterates on the LCU.
- **Skin-Line Authority**: Skin-line metadata and the `isLegacy` flag are now sourced from CommunityDragon rather than the LCU. This fixes a class of mis-grouped or mis-tagged skins.
- **Titlebar Refactor**: The Refresh button moved out of the old top bar and now lives in the titlebar alongside a new Wishlist toggle. The standalone "ALL SKINS" header was removed in favor of the cleaner tabbed layout.
- **Locked Sort Modes**: When grouping by `All` or `Tier`, the Sort dropdown is now greyed out and locked to the only meaningful order, removing a small UI footgun.

### Improved
- **Within-Group Mastery Sort**: When sorting by Mastery, individual skins inside a champion group are now also ordered by mastery points (owned first, then by mastery descending).
- **Completed-Group Styling**: Group headers display with a subtle highlight when you've collected every skin in the group.
- **Parallel CDragon Fetches**: `skins.json` and `skinlines.json` are now fetched in parallel during inventory build for a small startup speedup.

---

## [0.2.0] - 2026-03-03

### Added
- **Apply Skin In-Client**: A highly requested feature! You can now apply any owned skin directly from RiftVault to your League of Legends client.
  - Contextual golden "Apply in Client" button appears on skin cards and inside the detailed modal.
  - Buttons only activate *after* you have securely locked in your champion during champion select.
  - Real-time polling instantly tracks which skin is currently equipped, updating the UI with a green "Applied ✓" checkmark automatically, even if changed from within the League client itself.

### Changed
- **Massive Rebrand**: The project has officially been renamed from *LoL Skin Viewer* to **RiftVault**.
  - Updated all internal links, GitHub references, and the primary application title.
  - The portable executable output is now named `RiftVault.x.x.x.exe`.
- Optimized the main application window default layout, adjusting the optimal start dimensions and reducing the minimum height/width boundaries to better accommodate smaller screens. 

### Improved
- Cleaned up the IPC bridge, transitioning from `window.lolAPI` to `window.riftVaultAPI` for long-term maintainability.
- Full `README.md` revamp including new feature documentation, architecture breakdowns, and updated installation instructions.

---

## [0.1.0] - 2026-02-28

### Added
- Initial public release of the desktop application.
- Complete skin collection viewer interfacing cleanly with local LCU and Riot Data Dragon.
- Intelligent tier & rarity detection using CommunityDragon parameters.
- Comprehensive UI stats dashboard and interactive Chroma galleries.