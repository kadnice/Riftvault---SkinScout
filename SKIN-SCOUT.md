# Skin Scout (added to RiftVault)

A small always-on-top window that appears during champion select and lists every
champion you can currently play **that you own skins for**, with a gold number
showing how many. Hover a row to see thumbnails of those skins.

- **Normal / ranked:** shows your pickable champions, minus anything banned or picked.
- **ARAM:** shows your rolled champion (tagged YOU) plus bench champions (tagged BENCH).
- The champion you're hovering in the League client gets a gold outline and scrolls into view.
- Drag the header to move it; drag the edges to resize. It remembers its spot.
- **×** hides it until your next champ select.
- **Test it without queueing:** right-click the RiftVault tray icon → *Preview Skin Scout*.

## Files

| File | What it does |
|---|---|
| `scout-main.js` | The "brain": decides which champions to list and shows/hides the window |
| `scout-preload.js` | The safe bridge between the window and the brain |
| `scout.html` / `scout.js` | The window itself and the code that draws the rows |
| `css/scout.css` | How it looks |
| `main.js` | ~25 new lines that plug Skin Scout into RiftVault's existing champ-select check |
