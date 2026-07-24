const path = require('path')
const { ipcRenderer, shell } = require('electron')

// --- Markdown file links ---------------------------------------------------
// Open the target of a Markdown link. Relative paths resolve against the source
// document's directory and open in the editor; http(s) links open as a Tranquil
// browser tab (via the workspace opener); other schemes are handed to the OS.
function openMarkdownLinkTarget(target, sourcePath) {
  if (!target) return
  target = target.trim().replace(/^<([\s\S]*)>$/, '$1') // strip surrounding <>
  if (target.startsWith('#')) return // in-page anchor — nothing to open
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)
  if (scheme) {
    const name = scheme[1].toLowerCase()
    if (name === 'http' || name === 'https' || name === 'atom') {
      atom.workspace.open(target)
    } else {
      shell.openExternal(target)
    }
    return
  }
  const base = sourcePath
    ? path.dirname(sourcePath)
    : atom.project.getPaths()[0] || ''
  const filePart = decodeURI(target.split('#')[0])
  if (filePart) atom.workspace.open(path.resolve(base, filePart))
}

// Find the inline Markdown link `[text](target)` whose span covers `column`.
// Returns the target string, or null.
function markdownLinkTargetAt(lineText, column) {
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(lineText)) !== null) {
    if (column >= m.index && column <= m.index + m[0].length) return m[1]
  }
  return null
}

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

// Rename the panel/tab title from upstream's "Project" to "Workspace". The tab
// reads getTitle() once at render and only re-renders on onDidChangeTitle, which
// tree-view never emits — so override getTitle for future renders and refresh
// any already-rendered tab title in the DOM.
function patchTreeViewTitle(treeView) {
  if (treeView.__tranquilTitle) return
  treeView.getTitle = function () { return 'Workspace' }
  for (const el of document.querySelectorAll('.tab > .title')) {
    if (el.textContent === 'Project') el.textContent = 'Workspace'
  }
  treeView.__tranquilTitle = true
}

// Apply every tree-view patch. Returns true once tree-view is available (patched
// or already was), false if it isn't active yet.
function patchTreeView() {
  const treeView = atom.packages.getActivePackage('tree-view')?.mainModule?.treeView
  if (!treeView) return false
  patchTreeViewNoHorizontalScroll(treeView)
  patchTreeViewTitle(treeView)
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

  // Surface the UI theme picker (normally buried in settings-view's Themes panel)
  // at the top of Tranquil Settings. Self-contained: reads/writes core.themes
  // directly, so it needs nothing from settings-view. Built with the same
  // `.control-group` markup core emits for an enum setting, so it's themed for
  // free and the description-reorder below treats it like any other setting.
  let uiThemeSub = null
  {
    // "tranquil-business-dark" → "Tranquil Business Dark" (mirrors settings-view's
    // undasherize/uncamelcase for theme menu labels).
    const themeTitle = (name) =>
      name
        .replace(/-(ui|syntax)/g, '')
        .replace(/-theme$/g, '')
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    const activeThemeOfKind = (kind) => {
      for (const { name, metadata } of atom.themes.getActiveThemes()) {
        if (metadata.theme === kind) return name
      }
      return null
    }

    // Mirror the structure settings-view emits for a setting (see
    // elementForEditor): `label.control-label` (title + description) as a direct
    // child of the control-group, then a separate `.controls` holding the input.
    // This is what stacks the label above the field and lets the description
    // reorder below — so the picker lays out exactly like Toast Duration.
    const group = document.createElement('div')
    group.classList.add('control-group', 'tranquil-ui-theme')

    const label = document.createElement('label')
    label.classList.add('control-label')
    const title = document.createElement('div')
    title.classList.add('setting-title')
    title.textContent = 'UI Theme'
    const description = document.createElement('div')
    description.classList.add('setting-description')
    description.textContent =
      'This styles the tabs, status bar, tree view, and dropdowns'
    label.appendChild(title)
    label.appendChild(description)
    group.appendChild(label)

    const controls = document.createElement('div')
    controls.classList.add('controls')
    group.appendChild(controls)

    const select = document.createElement('select')
    select.classList.add('form-control')
    const populate = () => {
      const active = activeThemeOfKind('ui')
      select.innerHTML = ''
      // Only offer Tranquil's own UI themes (business light/dark), not every
      // loaded UI theme — the tab is for Tranquil's curated look.
      const uiThemes = atom.themes
        .getLoadedThemes()
        .filter(
          ({ name, metadata }) =>
            metadata.theme === 'ui' && name.startsWith('tranquil-business-')
        )
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const { name } of uiThemes) {
        const option = document.createElement('option')
        option.value = name
        option.textContent = themeTitle(name)
        if (name === active) option.selected = true
        select.appendChild(option)
      }
    }
    populate()
    // Setting core.themes = [uiTheme, syntaxTheme] preserves the active syntax
    // theme (settings-view's Themes panel writes the pair the same way).
    select.addEventListener('change', () => {
      const themes = [select.value, activeThemeOfKind('syntax')].filter(Boolean)
      if (themes.length) atom.config.set('core.themes', themes)
    })
    // Reflect theme changes made elsewhere (e.g. the Themes panel).
    uiThemeSub = atom.themes.onDidChangeActiveThemes(() => populate())
    controls.appendChild(select)

    const body = settingsPanel.element.querySelector('.section-body')
    if (body) body.insertBefore(group, body.firstChild)
    else settingsPanel.element.insertBefore(group, settingsPanel.element.firstChild)
  }

  // Normalize every setting to ONE consistent vertical layout so all fields line
  // up — and so settings added over time inherit it for free. Core emits
  // different markup per control type (the label is sometimes nested inside
  // `.controls`), which is why fields rendered differently. Hoist the label to the
  // top of the control-group so it stacks above the control, and keep the
  // description tucked inside the label (directly under the title) so every
  // setting reads title → description → control. The stacked layout + shared field
  // width live in the theme's `.tranquil-settings` rules.
  element.querySelectorAll('.control-group').forEach((group) => {
    const label = group.querySelector('.control-label')
    const description = group.querySelector('.setting-description')
    if (label) group.insertBefore(label, group.firstChild)
    if (label && description && description.parentElement !== label) {
      label.appendChild(description)
    }
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
      if (uiThemeSub) uiThemeSub.dispose()
      if (settingsPanel.destroy) settingsPanel.destroy()
      element.remove()
    },
  }
}

// Register the "Tranquil" tab on a settings-view instance (idempotent).
function addTranquilPanel(settingsView) {
  const menu = settingsView.refs && settingsView.refs.panelMenu
  // Idempotent: bail if the callback, the built panel, or the nav item already exist.
  const alreadyAdded =
    (settingsView.panelCreateCallbacks && settingsView.panelCreateCallbacks['Tranquil']) ||
    (settingsView.panelsByName && settingsView.panelsByName['Tranquil']) ||
    (menu && menu.querySelector('li[name="Tranquil"]'))
  if (alreadyAdded) return

  settingsView.addCorePanel('Tranquil', 'gear', () => createTranquilSettingsPanel())

  // addCorePanel appends the nav item just before the menu separator, so where it
  // lands depends on whether we run before or after settings-view's own
  // initializePanels() (scheduled on process.nextTick) — a race that put the tab at
  // the top or bottom unpredictably. Pin it to the top: move its <li> to the front
  // of the menu. Core panels added later still insert before the separator (i.e.
  // after our item), so it stays first regardless of ordering.
  const item = menu && menu.querySelector('li[name="Tranquil"]')
  if (menu && item && item !== menu.firstElementChild) {
    menu.insertBefore(item, menu.firstElementChild)
  }

  // Land on the Tranquil tab by default whenever Settings is opened (including a
  // window reload, where the pane is restored and already showing "Core"). The
  // only thing we respect is an explicit deep-link open — atom://config/<panel>,
  // e.g. "view this package's settings" — which settings-view records as an
  // options.uri on the pending/active panel.
  const pending = settingsView.activePanel || settingsView.deferredPanel
  const targetUri = pending && pending.options && pending.options.uri
  const isDeepLink = targetUri && /config\/[a-z]/i.test(targetUri)
  if (!isDeepLink) {
    if (settingsView.activePanel) {
      // Already initialized (restored/open) → switch to Tranquil now.
      settingsView.showPanel('Tranquil')
    } else {
      // Fresh open, before initializePanels() → it will show this deferred panel.
      settingsView.deferredPanel = { name: 'Tranquil' }
    }
  }
}

module.exports = {
  activate() {
    // "File → New Default Window" → ask the main process to seed (if needed) and
    // open the bundled example project in a new window. Classic Electron IPC,
    // matching the browser's new-window command.
    atom.commands.add('atom-workspace', {
      'tranquil:new-default-window': () =>
        ipcRenderer.send('tranquil:new-default-window'),
    })

    // Place "New Default Window" as the SECOND File-menu item (right after "New
    // Window"). A package `menus/*.cson` contribution can't do this — the app-menu
    // merge only appends to the bottom — so insert it into the menu template
    // directly. Idempotent; located by the `application:new-window` command so it
    // works across darwin/linux/win32 without matching the (accelerator-decorated)
    // "File" label.
    const placeNewDefaultWindowItem = () => {
      const fileMenu = atom.menu.template.find(
        (m) =>
          Array.isArray(m.submenu) &&
          m.submenu.some((i) => i && i.command === 'application:new-window')
      )
      if (!fileMenu) return
      if (
        fileMenu.submenu.some(
          (i) => i && i.command === 'tranquil:new-default-window'
        )
      )
        return
      const afterIdx = fileMenu.submenu.findIndex(
        (i) => i && i.command === 'application:new-window'
      )
      fileMenu.submenu.splice(afterIdx + 1, 0, {
        label: 'New Default Window',
        command: 'tranquil:new-default-window',
      })
      atom.menu.update()
    }
    // Run now (template is usually built by activation time) and again once all
    // initial packages have loaded, so it lands regardless of menu-load ordering.
    placeNewDefaultWindowItem()
    atom.packages.onDidActivateInitialPackages(placeNewDefaultWindowItem)

    // Let editor tabs be dragged into the right/bottom docks, matching browser
    // tabs. Core `TextEditor.getAllowedLocations()` returns `['center']`, so a
    // dock refuses an editor on drop (`isItemAllowed()` in dock.js). Override it
    // per instance to the same set browser tabs use — left stays reserved for the
    // tree-view.
    atom.workspace.observeTextEditors((editor) => {
      editor.getAllowedLocations = () => ['center', 'right', 'bottom']

      // Cmd/Ctrl-click a Markdown link in the SOURCE to open its target. Only
      // fires on `.md` files and only when the click lands on a link, so plain
      // cmd-click (multi-cursor) is unaffected elsewhere.
      const el = atom.views.getView(editor)
      if (!el || el.__tranquilMdLinks) return
      el.__tranquilMdLinks = true
      el.addEventListener(
        'mousedown',
        (event) => {
          if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return
          const filePath = editor.getPath && editor.getPath()
          if (!filePath || !/\.(md|markdown|mdown|mkd)$/i.test(filePath)) return
          const component = el.getComponent && el.getComponent()
          if (!component) return
          const screenPos = component.screenPositionForMouseEvent(event)
          const pos = editor.bufferPositionForScreenPosition(screenPos)
          const target = markdownLinkTargetAt(
            editor.lineTextForBufferRow(pos.row) || '',
            pos.column
          )
          if (!target) return
          event.preventDefault()
          event.stopPropagation()
          openMarkdownLinkTarget(target, filePath)
        },
        true // capture phase, to beat the editor's own mousedown handling
      )
    })

    // Click a link in a Markdown PREVIEW to open its target. Core
    // markdown-preview attaches no anchor handler, so relative file links are
    // dead; intercept them and route through the same opener.
    atom.workspace.observePaneItems((item) => {
      if (
        !item ||
        !item.element ||
        !item.constructor ||
        item.constructor.name !== 'MarkdownPreviewView' ||
        item.element.__tranquilMdLinks
      )
        return
      item.element.__tranquilMdLinks = true
      item.element.addEventListener('click', (event) => {
        const anchor =
          event.target &&
          event.target.closest &&
          event.target.closest('a[href]')
        if (!anchor) return
        const href = anchor.getAttribute('href')
        if (!href || href.startsWith('#')) return // let in-page anchors scroll
        event.preventDefault()
        const sourcePath =
          (item.getPath && item.getPath()) || item.filePath || null
        openMarkdownLinkTarget(href, sourcePath)
      })
    })

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
