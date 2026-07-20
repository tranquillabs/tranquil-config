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

// Build the content for our top-level "Tranquil" settings tab. We reuse core
// settings-view's own SettingsPanel (which auto-renders config-bound controls
// for a whole namespace, and — since it emits the same markup as Core/Editor —
// gets themed for free by the business themes). SettingsPanel has destroy() but
// not show()/focus(), so we wrap it in a `.panels-item` shell that satisfies the
// panel contract settings-view expects (element + show/focus/destroy), mirroring
// core's general-panel.js.
//
// The require is lazy + guarded: it only runs when the tab is first opened, and
// resolves settings-view by its installed path rather than a bare module id, so a
// missing/moved dependency degrades to "no Tranquil tab" instead of throwing.
function createTranquilSettingsPanel() {
  const svPath = atom.packages.resolvePackagePath('settings-view')
  if (!svPath) return null
  const mod = require(path.join(svPath, 'lib', 'settings-panel'))
  const SettingsPanel = mod.default || mod

  // settings-view clamps integer fields to the schema's minimum/maximum on every
  // keystroke pause and rewrites the input, so a value can't be typed freely
  // (settings-panel.js reads the schema live in its change handler). Strip those
  // bounds off the live schema so the field accepts any value.
  const durationSchema = atom.config.getSchema('tranquil.toastDuration')
  if (durationSchema) {
    delete durationSchema.minimum
    delete durationSchema.maximum
  }
  const settingsPanel = new SettingsPanel({
    namespace: 'tranquil',
    icon: 'gear',
    title: 'Tranquil Settings',
  })

  const element = document.createElement('div')
  element.classList.add('panels-item', 'tranquil-settings')
  element.tabIndex = 0
  element.appendChild(settingsPanel.element)

  // Match the main-view.html form spec: the description reads as a `.form-hint`,
  // which sits BELOW the input. Core renders it above (inside the label), so move
  // each setting's description to the end of its control-group (after the input).
  // (Styling for this layout is scoped to `.tranquil-settings` in the theme.)
  element.querySelectorAll('.control-group').forEach((group) => {
    const description = group.querySelector('.setting-description')
    const controls = group.querySelector('.controls')
    if (description && controls) group.appendChild(description)
  })

  // Replace the auto-generated Toast Duration mini-editor with a native number
  // input (integer value + increment/decrement steppers), bound to config, and
  // add a "Test" button beside it that previews a toast at the current value.
  let durationConfigSub = null
  const durationEditor = element.querySelector('[id="tranquil.toastDuration"]')
  const durationControls = durationEditor && durationEditor.closest('.controls')
  if (durationControls) {
    // The field shows whole SECONDS (a friendly integer for the stepper); the
    // stored config value stays in milliseconds, which is what the toasts read.
    const msToSeconds = (ms) => Math.max(1, Math.round((ms || 3000) / 1000))
    const numberInput = document.createElement('input')
    numberInput.type = 'number'
    // `native-key-bindings` lets standard editing keys (backspace, select-all,
    // copy/paste, arrows) reach the input instead of being captured by Atom's keymap.
    numberInput.classList.add('tranquil-number-input', 'native-key-bindings')
    numberInput.min = '1'
    numberInput.step = '1'
    numberInput.value = String(msToSeconds(atom.config.get('tranquil.toastDuration')))
    numberInput.addEventListener('input', () => {
      const seconds = parseInt(numberInput.value, 10)
      if (Number.isFinite(seconds)) atom.config.set('tranquil.toastDuration', seconds * 1000)
    })
    // Reflect external config changes, but don't fight the user while they type.
    durationConfigSub = atom.config.onDidChange('tranquil.toastDuration', ({ newValue }) => {
      if (document.activeElement !== numberInput) numberInput.value = String(msToSeconds(newValue))
    })

    const editorContainer = durationEditor.closest('.editor-container') || durationEditor
    editorContainer.replaceWith(numberInput)

    // "Test" previews a toast at the CURRENT setting. Dismiss any prior preview
    // and label each toast with the duration so the notifications view never
    // de-dupes it into a stale toast (which reads as "the value has no effect").
    let previewToast = null
    const testButton = document.createElement('button')
    testButton.classList.add('btn', 'tranquil-toast-test')
    testButton.textContent = 'Test'
    testButton.addEventListener('click', () => {
      // Read the field directly so the preview always matches what's shown (no
      // dependency on the config write from the input's change event landing first).
      const seconds = parseInt(numberInput.value, 10)
      const ms = (Number.isFinite(seconds) && seconds > 0 ? seconds : 3) * 1000
      if (previewToast) previewToast.dismiss()
      previewToast = atom.notifications.addInfo(`Toast preview — ${ms / 1000}s (${ms} ms)`, {
        dismissable: true,
      })
      const shown = previewToast
      setTimeout(() => shown.dismiss(), ms)
    })
    durationControls.appendChild(testButton)
  }

  return {
    element,
    show() { element.style.display = '' },
    focus() { element.focus() },
    destroy() {
      if (durationConfigSub) durationConfigSub.dispose()
      if (settingsPanel.destroy) settingsPanel.destroy()
      element.remove()
    },
  }
}

// Register the "Tranquil" tab on a settings-view instance (idempotent).
function addTranquilPanel(settingsView) {
  if (settingsView.panelCreateCallbacks && settingsView.panelCreateCallbacks['Tranquil']) return
  settingsView.addCorePanel('Tranquil', 'gear', () => createTranquilSettingsPanel())
}

module.exports = {
  activate() {
    // Tranquil's own config namespace (`tranquil.*`), surfaced in the "Tranquil"
    // settings tab below. Registered here (not via package.json configSchema) so
    // the keys live under `tranquil.*` rather than the package name.
    // NB: no `minimum`/`maximum` here on purpose. settings-view clamps integer
    // fields to those bounds on every keystroke pause and rewrites the input,
    // which makes typing a new value impossible (intermediate digits below the
    // min snap back). We enforce a sane floor where the value is consumed instead.
    atom.config.setSchema('tranquil', {
      type: 'object',
      properties: {
        toastDuration: {
          type: 'integer',
          default: 3000,
          title: 'Toast Duration',
          description:
            'How long transient corner notifications (toasts) stay on screen before auto-hiding, in seconds.',
        },
      },
    })

    // The `notify()` helpers in tranquil-automations / tranquil-browser read
    // `tranquil.toastDuration` directly. Bridge it one-way to the core
    // notifications timeout too, so the handful of direct `atom.notifications.add*`
    // callers (tranquil-drag-drop, tranquil-window-color) honor the same setting.
    // Clamp to the notifications schema's own minimum (1000) so the write sticks.
    atom.config.observe('tranquil.toastDuration', (value) => {
      const ms = Math.max(1000, Number(value) || 3000)
      atom.config.set('notifications.defaultTimeout', ms)
    })

    // Add a top-level "Tranquil" tab to every settings-view instance as it opens.
    atom.workspace.observePaneItems((item) => {
      if (item && typeof item.addCorePanel === 'function' && item.constructor && item.constructor.name === 'SettingsView') {
        addTranquilPanel(item)
      }
    })

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
          setTimeout(() => n.dismiss(), atom.config.get('tranquil.toastDuration') || 3000)
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
