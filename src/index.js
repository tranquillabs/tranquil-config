const fs = require('fs')
const path = require('path')

const commandHistory = []
let mruInstalled = false

// Keep every Pulsar/Atom command in the palette EXCEPT any that are about a
// browser — Tranquil's own browser is the only one we surface. Our own
// (`tranquil-*`) commands are always kept.
function keepInPalette(cmd) {
  const name = cmd && cmd.name
  if (!name) return true
  if (name.startsWith('tranquil-')) return true
  const label = ((cmd.displayName || '') + ' ' + name).toLowerCase()
  return !label.includes('browser')
}

// Show tranquil-browser commands as "Browser: …" (drop the "Tranquil" prefix).
// Computed from the command id so word-splitting and "URL" casing stay correct
// regardless of how Pulsar humanizes the name.
function relabelBrowser(cmd) {
  if (!cmd || !cmd.name || !cmd.name.startsWith('tranquil-browser:')) return cmd
  const words = cmd.name
    .slice('tranquil-browser:'.length)
    .split('-')
    .map((w) => (w === 'url' ? 'URL' : w.charAt(0).toUpperCase() + w.slice(1)))
  return {...cmd, displayName: 'Browser: ' + words.join(' ')}
}

function recordCommand(name) {
  if (!name) return
  const idx = commandHistory.indexOf(name)
  if (idx > -1) commandHistory.splice(idx, 1)
  commandHistory.unshift(name)
}

// Wrap the command palette's select-list: MRU ordering + hide/relabel the browser
// namespace. Idempotent (guarded by __tranquil* flags). The order is injected via
// the update wrapper (not a one-off update call), so it applies on every
// repopulation without us re-rendering.
function wrapSelectList(slv) {
  if (!slv.__tranquilMRUConfirm) {
    // MRU is fed only by commands confirmed *through the palette*, so commands
    // fired by a key combo don't reorder the list. select-list reads
    // props.didConfirmSelection at confirm time (passing the selected command).
    const originalConfirm = slv.props.didConfirmSelection
    slv.props.didConfirmSelection = (item) => {
      if (item) recordCommand(item.name)
      return originalConfirm(item)
    }
    slv.__tranquilMRUConfirm = true
  }
  if (!slv.__tranquilPaletteFilter) {
    const order = (a, b) => {
      if (slv.getQuery().length > 0) return 0
      const aIdx = commandHistory.indexOf(a.name)
      const bIdx = commandHistory.indexOf(b.name)
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
      if (aIdx !== -1) return -1
      if (bIdx !== -1) return 1
      return 0
    }
    const originalUpdate = slv.update.bind(slv)
    slv.update = (props = {}) => {
      // Filter + relabel + MRU-order on every repopulation (command-palette calls
      // update({items}) on each open), dropping the hidden browser namespace.
      if (Array.isArray(props.items)) {
        props = {...props, items: props.items.filter(keepInPalette).map(relabelBrowser), order}
      }
      return originalUpdate(props)
    }
    slv.__tranquilPaletteFilter = true
  }
}

// The palette's select-list straight from the (loaded) command-palette package —
// its CommandPaletteView, and thus the select-list, is created in the package's
// activate(). Wrapping it here, BEFORE the user's first toggle populates the
// list, means the first open is already filtered (no first-open flash).
function paletteSelectList() {
  const slv = atom.packages.getLoadedPackage('command-palette')
    ?.mainModule?.commandPaletteView?.selectListView
  return slv && slv.element && slv.element.classList.contains('command-palette') ? slv : null
}

// Fallback for when the palette can't be grabbed eagerly: wrap it once it's open
// (found via its modal panel). We install from the toggle's did-dispatch, which
// fires while show() is still in flight, so re-render on the next tick to filter
// the already-visible first list without racing show() (a synchronous re-render
// closed the panel). This path still flashes; the eager path avoids it.
function installMRU() {
  for (const panel of atom.workspace.getModalPanels()) {
    const slv = panel.getItem()
    if (!slv || !slv.element || !slv.element.classList.contains('command-palette')) continue
    wrapSelectList(slv)
    setTimeout(() => {
      try {
        slv.update({items: slv.props.items})
      } catch (e) {
        // Palette torn down before the deferred render — nothing to do.
      }
    }, 0)
    mruInstalled = true
    return
  }
}

// ── Tree-view patches ───────────────────────────────────────────────────────
// All tree-view modifications live here in tranquil-config (not automations).
// tree-view is third-party, so we patch the live instance's methods.

// Map an http(s) URL back to the project `.url` bookmark file that points at it,
// by matching each file's `URL=` line (same match the browser's .url opener
// uses). Cached for a few seconds so tab switching doesn't re-read the tree on
// every activation.
let urlIndex = null
let urlIndexAt = 0

function buildUrlIndex() {
  const index = new Map()
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch (e) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name.endsWith('.url')) {
        try {
          const match = fs.readFileSync(full, 'utf8').match(/^URL=(.+)$/im)
          if (match) index.set(match[1].trim().replace(/\/$/, ''), full)
        } catch (e) {
          // Unreadable .url — skip it.
        }
      }
    }
  }
  for (const root of atom.project.getPaths()) walk(root, 0)
  return index
}

function resolveUrlFile(url) {
  if (!url || url === 'tranquil-browser://blank') return null
  const key = String(url).replace(/\/$/, '')
  const now = Date.now()
  if (!urlIndex || now - urlIndexAt > 5000) {
    urlIndex = buildUrlIndex()
    urlIndexAt = now
  }
  return urlIndex.get(key) || null
}

// Revealing/selecting a file never scrolls the pane horizontally. Upstream
// scrollToEntry uses scrollIntoViewIfNeeded, which scrolls BOTH axes — a
// filename wider than the pane yanks the view right. Restore the horizontal
// scroll position around the call so only vertical scrolling happens.
function patchTreeViewNoHorizontalScroll(treeView) {
  if (treeView.__tranquilNoHScroll) return
  const original = treeView.scrollToEntry.bind(treeView)
  treeView.scrollToEntry = function (entry, center = true) {
    const left = this.element.scrollLeft
    const result = original(entry, center)
    this.element.scrollLeft = left
    return result
  }
  treeView.__tranquilNoHScroll = true
}

// Upstream tree-view clears the selection whenever the active pane item has no
// file path (selectActiveFile → deselect()). Tranquil uses pathless tabs heavily
// (browser tabs), so switching to one wipes the tree highlight — and single-
// clicking a file appears to need two clicks. Patch selectActiveFile to keep the
// current selection when there's no active project file, and gate it on the
// autoReveal "file sync" toggle.
function patchTreeViewKeepSelection(treeView) {
  if (treeView.__tranquilKeepSelection) return
  const original = treeView.selectActiveFile.bind(treeView)
  treeView.selectActiveFile = function () {
    // "File sync" (tranquil-config:toggle-tree-view-sync) is gated on
    // tree-view.autoReveal. Upstream calls selectActiveFile unconditionally on
    // every active-pane-item change, so the highlight follows the active tab even
    // with autoReveal off — meaning the toggle never truly turned sync off. When
    // it's off, leave the current selection alone.
    if (!atom.config.get('tree-view.autoReveal')) return
    // A browser tab restored/reopened without its source .url reports no path, so
    // the tree can't follow it. Reverse-map the tab's URL back to its .url
    // bookmark and restore the link so getActivePath() (and revealActiveFile) can
    // highlight/expand it. tranquil-browser now persists filePath, so this only
    // backfills legacy/pre-fix tabs.
    const item = atom.workspace.getCenter().getActivePaneItem()
    if (item && item.getURL && !item.getPath?.()) {
      const mapped = resolveUrlFile(item.getURL())
      if (mapped) item.filePath = mapped
    }
    const activeFilePath = this.getActivePath()
    // No active project file (e.g. a blank browser tab) → keep the current
    // selection rather than clearing it. If the file exists but isn't rendered
    // yet (collapsed parent), autoReveal handles expand + select.
    if (!activeFilePath || !this.entryForPath(activeFilePath)) return
    return original()
  }
  treeView.__tranquilKeepSelection = true
}

// Apply every tree-view patch. Returns true once tree-view is available (patched
// or already was), false if it isn't active yet.
function patchTreeView() {
  const treeView = atom.packages.getActivePackage('tree-view')?.mainModule?.treeView
  if (!treeView) return false
  patchTreeViewNoHorizontalScroll(treeView)
  patchTreeViewKeepSelection(treeView)
  return true
}

module.exports = {
  activate() {
    atom.config.setDefaults('tree-view', {
      hideIgnoredNames: true,
      hideVcsIgnoredFiles: true,
      autoReveal: true,      // sync tree selection with the active tab
      focusOnReveal: false,  // keep keyboard focus in the editor when revealing
    })

    atom.packages.disablePackage('background-tips')

    document.addEventListener('mousedown', (event) => {
      const treeView = event.target.closest('.tree-view')
      if (treeView) treeView.focus()
    }, true)

    // Patch tree-view now if it's active, otherwise once it activates.
    if (!patchTreeView()) {
      const sub = atom.packages.onDidActivatePackage((pkg) => {
        if (pkg.name === 'tree-view' && patchTreeView()) {
          sub.dispose()
        }
      })
    }

    // Toggle the tree-view ↔ active-tab "file sync" (gated on autoReveal, which
    // patchTreeViewKeepSelection honors). Also surfaced in the View menu.
    atom.commands.add('atom-workspace', {
      'tranquil-config:toggle-tree-view-sync': {
        displayName: 'Tree View: Toggle File Sync',
        didDispatch: () => {
          const next = !atom.config.get('tree-view.autoReveal')
          atom.config.set('tree-view.autoReveal', next)
          const n = atom.notifications.addInfo(`Tree view sync ${next ? 'on' : 'off'}`, {dismissable: true})
          setTimeout(() => n.dismiss(), 1500)
        },
      },
    })

    // Prefer wrapping the palette eagerly — before its first open — so the first
    // toggle is already filtered (no flash). If it isn't reachable yet, retry
    // when command-palette activates, and fall back to a lazy wrap on first open.
    const eager = paletteSelectList()
    if (eager) {
      wrapSelectList(eager)
      mruInstalled = true
    } else {
      const sub = atom.packages.onDidActivatePackage((pkg) => {
        if (pkg.name !== 'command-palette') return
        const slv = paletteSelectList()
        if (slv) {
          wrapSelectList(slv)
          mruInstalled = true
          sub.dispose()
        }
      })
      atom.commands.onDidDispatch((event) => {
        if (event.type === 'command-palette:toggle' && !mruInstalled) {
          installMRU()
        }
      })
    }
  }
}
