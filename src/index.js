const path = require('path')
const { ipcRenderer, shell } = require('electron')

// --- Browser User-Agent presets --------------------------------------------
// Options for the "Browser User-Agent" combobox in the Tranquil settings tab
// (and the schema default). The macOS Chrome value is the clean default: the
// app's own UA with the Electron/Tranquil tokens stripped; the other presets
// swap the platform token.
//
// Version tokens are NOT the bundled Chromium's — that freezes with each
// Electron release and ages into a bot signal (HN 429s /login for Chrome/124).
// They come from `tranquil.browserVersions`, filled by the "Check Current
// Versions" action in the settings tab (user-triggered fetch of the vendors'
// official version endpoints — see 'fetch-browser-versions' in cz-init.js),
// with pinned fallbacks for before the first check. Real Chrome reports the
// frozen 0.0.0 minor; Firefox reports major.0. Keep the Chrome fallback in
// sync with cleanUserAgent() in tranquil-browser/lib/utils.js.
const UA_VERSION_FALLBACKS = { chrome: '139.0.0.0', firefox: '142.0', safari: '26.0' }
const uaVersions = () => ({
  ...UA_VERSION_FALLBACKS,
  ...(atom.config.get('tranquil.browserVersions') || {}),
})
const UA_WINDOWS = 'Windows NT 10.0; Win64; x64'
const UA_LINUX = 'X11; Linux x86_64'
const buildUaPresets = () => {
  const v = uaVersions()
  const chromeUaFor = (platform) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v.chrome} Safari/537.36`
  const firefoxUaFor = (platform) =>
    `Mozilla/5.0 (${platform}; rv:${v.firefox}) Gecko/20100101 Firefox/${v.firefox}`
  const chromeMac = navigator.userAgent
    .replace(/ (?:Tranquil|Electron)\/\S+/g, '')
    .replace(/Chrome\/[\d.]+/, `Chrome/${v.chrome}`)
  return [
    { label: 'Chrome — macOS', value: chromeMac },
    { label: 'Chrome — Windows', value: chromeUaFor(UA_WINDOWS) },
    { label: 'Chrome — Linux', value: chromeUaFor(UA_LINUX) },
    { label: 'Firefox — macOS', value: firefoxUaFor('Macintosh; Intel Mac OS X 10.15') },
    { label: 'Firefox — Windows', value: firefoxUaFor(UA_WINDOWS) },
    { label: 'Firefox — Linux', value: firefoxUaFor(UA_LINUX) },
    { label: 'Edge — macOS', value: `${chromeMac} Edg/${v.chrome}` },
    { label: 'Edge — Windows', value: `${chromeUaFor(UA_WINDOWS)} Edg/${v.chrome}` },
    { label: 'Safari — macOS', value: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.safari} Safari/605.1.15` },
  ]
}
// Rewrite the version tokens inside an existing UA string (the user's active
// value) after a version check; tokens that don't appear are left alone.
const bumpUaVersions = (ua, v) =>
  ua
    .replace(/Chrome\/[\d.]+/, `Chrome/${v.chrome}`)
    .replace(/Edg\/[\d.]+/, `Edg/${v.chrome}`)
    .replace(/rv:[\d.]+/, `rv:${v.firefox}`)
    .replace(/Firefox\/[\d.]+/, `Firefox/${v.firefox}`)

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

// Keep the tree-view selection when the active pane item isn't a project file.
// Upstream selectActiveFile() selects the matching entry when the active item
// has a path in the tree, but deselects everything otherwise — so activating a
// browser tab, settings, or any pathless item (e.g. clicking a row in the
// vertical tab list) wipes the highlight. Preserve it: sync the selection only
// when the item maps to a real tree entry, leave it alone when it doesn't.
function patchTreeViewKeepSelection(treeView) {
  if (treeView.__tranquilKeepSelection) return
  treeView.selectActiveFile = function () {
    const activeFilePath = this.getActivePath()
    if (this.entryForPath(activeFilePath)) {
      return this.selectEntryForPath(activeFilePath)
    }
    // No matching entry — keep the current selection instead of deselecting.
  }
  treeView.__tranquilKeepSelection = true
}

// Apply every tree-view patch. Returns true once tree-view is available (patched
// or already was), false if it isn't active yet.
function patchTreeView() {
  const treeView = atom.packages.getActivePackage('tree-view')?.mainModule?.treeView
  if (!treeView) return false
  patchTreeViewNoHorizontalScroll(treeView)
  patchTreeViewTitle(treeView)
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

  // `tranquil.browserVersions` is plumbing for the UA version-check action, not
  // a user-editable setting — SettingsPanel renders every key stored under the
  // namespace, so drop its auto-generated sub-section once it exists.
  const versionsEditor = element.querySelector('[id^="tranquil.browserVersions."]')
  if (versionsEditor) {
    const section = versionsEditor.closest('section.sub-section')
    if (section) section.remove()
  }

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

  // Replace the auto-generated Browser User-Agent text field with an editable
  // combobox: type any value, or pick a Chrome/Firefox/Edge/Safari preset. The
  // schema key is a plain string (no enum) so custom values are accepted; the
  // preset list is our own DOM because stock settings-view can't render an
  // editable dropdown.
  let uaConfigSub = null
  let uaVersionsSub = null
  let uaDocMouseDown = null
  const uaEditor = element.querySelector('[id="tranquil.browserUserAgent"]')
  const uaControls = uaEditor && uaEditor.closest('.controls')
  if (uaControls) {
    const KEY = 'tranquil.browserUserAgent'

    const combo = document.createElement('div')
    combo.classList.add('tq-ua-combobox')

    const input = document.createElement('input')
    input.type = 'text'
    // `native-key-bindings` lets standard editing keys (backspace, select-all,
    // copy/paste) reach the field instead of being captured by Atom's keymap.
    input.classList.add('form-input', 'native-key-bindings')
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'false')
    input.setAttribute('aria-controls', 'tq-ua-listbox')
    input.setAttribute('spellcheck', 'false')
    input.value = atom.config.get(KEY) || ''

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.classList.add('tq-ua-toggle')
    toggle.textContent = '▾'
    toggle.tabIndex = -1
    toggle.setAttribute('aria-label', 'Choose a preset browser')

    const list = document.createElement('ul')
    list.classList.add('tq-ua-presets')
    list.id = 'tq-ua-listbox'
    list.setAttribute('role', 'listbox')
    list.hidden = true
    // Rebuilt (not static) so a version check refreshes the preset values.
    const renderPresets = () => {
      list.textContent = ''
      for (const preset of buildUaPresets()) {
        const li = document.createElement('li')
        li.setAttribute('role', 'option')
        li.dataset.ua = preset.value
        li.textContent = preset.label
        list.appendChild(li)
      }
    }
    renderPresets()

    // Mark the preset row matching the current value (themes render a checkmark
    // via [aria-selected]) — the UA strings all share the same visible prefix in
    // the field, so this is what makes the active choice legible.
    const syncSelected = () => {
      const current = input.value.trim()
      for (const li of list.children) {
        li.setAttribute('aria-selected', li.dataset.ua === current ? 'true' : 'false')
      }
    }

    const openList = () => {
      syncSelected()
      list.hidden = false
      input.setAttribute('aria-expanded', 'true')
    }
    const closeList = () => {
      list.hidden = true
      input.setAttribute('aria-expanded', 'false')
    }

    toggle.addEventListener('click', () => {
      if (list.hidden) openList()
      else closeList()
      input.focus()
    })
    input.addEventListener('focus', openList)
    // Write on change (blur / Enter), not on every keystroke, to avoid config churn.
    input.addEventListener('change', () => atom.config.set(KEY, input.value.trim()))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeList()
    })
    // mousedown (not click) so the pick lands before the input's blur closes the list.
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[role="option"]')
      if (!li) return
      e.preventDefault()
      input.value = li.dataset.ua
      atom.config.set(KEY, li.dataset.ua)
      closeList()
    })
    // Close when a click/focus lands outside the combobox.
    uaDocMouseDown = (e) => {
      if (!combo.contains(e.target)) closeList()
    }
    document.addEventListener('mousedown', uaDocMouseDown, true)

    // Reflect external config changes, but don't fight the user while they type.
    uaConfigSub = atom.config.onDidChange(KEY, ({ newValue }) => {
      if (document.activeElement !== input) input.value = newValue || ''
    })

    combo.appendChild(input)
    combo.appendChild(toggle)
    combo.appendChild(list)
    const editorContainer = uaEditor.closest('.editor-container') || uaEditor
    editorContainer.replaceWith(combo)

    // "Check Current Versions": user-triggered fetch of the latest stable
    // Chrome/Firefox versions (main process — 'fetch-browser-versions' in
    // cz-init.js; nothing is fetched automatically). The result is stored in
    // tranquil.browserVersions, the presets rebuild from it, and the version
    // tokens in the active value are bumped in place so it applies live.
    const versionRow = document.createElement('div')
    versionRow.classList.add('tq-ua-version-row')

    const checkButton = document.createElement('button')
    checkButton.type = 'button'
    checkButton.classList.add('btn')
    checkButton.textContent = 'Get current UA'

    const versionStatus = document.createElement('span')
    versionStatus.classList.add('tq-ua-version-status')
    const versionHint = document.createElement('span')
    versionHint.classList.add('tq-ua-version-hint')
    versionHint.hidden = true
    const describeVersions = () => {
      const v = uaVersions()
      const stored = atom.config.get('tranquil.browserVersions') || {}
      // Dates arrive as YYYY-MM-DD (or ISO datetimes); pin to midday so the
      // local rendering can't slip a day across timezones.
      const midday = (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00')
      const fmtDay = (iso) =>
        midday(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const chromePart =
        `Chrome ${v.chrome.split('.')[0]}` +
        (stored.chromeReleased ? ` (${fmtDay(stored.chromeReleased)})` : '')
      const firefoxPart =
        `Firefox ${v.firefox.split('.')[0]}` +
        (stored.firefoxReleased ? ` (${fmtDay(stored.firefoxReleased)})` : '')
      const source = stored.checkedAt
        ? `checked ${fmtDay(stored.checkedAt)}`
        : 'built-in'
      versionStatus.textContent = `${chromePart} · ${firefoxPart} — ${source}`

      // Staleness hint: Firefox publishes its next release date outright;
      // Chrome ships on a ~4-week cadence, so infer from the release date of
      // the version we hold. Purely informational — nothing refetches.
      let hint = ''
      if (stored.checkedAt) {
        const CHROME_CADENCE_MS = 28 * 24 * 60 * 60 * 1000
        const chromeStale =
          stored.chromeReleased &&
          Date.now() - midday(stored.chromeReleased).getTime() > CHROME_CADENCE_MS
        const firefoxStale =
          stored.firefoxNextRelease &&
          Date.now() > midday(stored.firefoxNextRelease).getTime()
        if (chromeStale || firefoxStale) {
          hint = 'Newer versions have likely shipped — check again'
        }
      }
      versionHint.textContent = hint
      versionHint.hidden = !hint
    }
    describeVersions()

    checkButton.addEventListener('click', () => {
      checkButton.disabled = true
      versionStatus.textContent = 'Checking…'
      ipcRenderer
        .invoke('fetch-browser-versions')
        .then((fetched) => {
          atom.config.set('tranquil.browserVersions', {
            ...fetched,
            checkedAt: new Date().toISOString(),
          })
          const current = (atom.config.get(KEY) || '').trim()
          if (current) {
            const bumped = bumpUaVersions(current, uaVersions())
            if (bumped !== current) atom.config.set(KEY, bumped)
          }
          describeVersions()
        })
        .catch((e) => {
          versionStatus.textContent = `Check failed: ${e.message.replace(/^Error invoking remote method '[^']+': */, '')}`
        })
        .finally(() => {
          checkButton.disabled = false
        })
    })

    versionRow.appendChild(checkButton)
    versionRow.appendChild(versionStatus)
    versionRow.appendChild(versionHint)
    // Direct child of the .control-group — the themes lay that out as a column
    // (label / controls / this row, via order), so the row gets its own line
    // below the field like every other setting's second row.
    const uaGroup = uaControls.closest('.control-group') || uaControls.parentElement
    uaGroup.appendChild(versionRow)

    // Keep this window's presets/status in step when the versions change (this
    // window's check or another's — config syncs across windows).
    uaVersionsSub = atom.config.onDidChange('tranquil.browserVersions', () => {
      renderPresets()
      describeVersions()
    })
  }

  return {
    element,
    show() { element.style.display = '' },
    focus() { element.focus() },
    destroy() {
      if (durationConfigSub) durationConfigSub.dispose()
      if (uaConfigSub) uaConfigSub.dispose()
      if (uaVersionsSub) uaVersionsSub.dispose()
      if (uaDocMouseDown) document.removeEventListener('mousedown', uaDocMouseDown, true)
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

    // Ctrl+Tab always cycles the CENTER's tabs, even when focus is in a dock.
    // Core `pane:show-next-item` acts on `workspace.getActivePane()`, which
    // follows the active pane *container* — so clicking the tree-view (left
    // dock) makes ctrl+tab cycle the dock's single item and appear dead. Target
    // the center's active pane explicitly. ctrl-tab is bound to these in
    // keymaps/darwin.cson + keymaps/linux.cson.
    const cycleCenterItem = (method) => {
      const pane = atom.workspace.getCenter().getActivePane()
      if (!pane) return
      pane[method]()
      // Move DOM focus into the center pane. Cycling only changes the active
      // item, not focus — so after ctrl+tab from a dock (tree-view) focus stays
      // in the dock, and after switching away from a browser guest it can strand
      // on <body>. Either way, focus sits outside the center: atom-workspace-
      // scoped keys misfire (cmd-t would open the new tab in the focused dock)
      // and browser guest keyHandler keys (cmd-t/cmd-w) never fire. Focusing the
      // pane delegates to the active item view (and, via model.focus(), makes the
      // center the active container so the browser focuses its guest webview).
      atom.views.getView(pane).focus()
    }
    atom.commands.add('atom-workspace', {
      'tranquil:show-next-item-in-center': () =>
        cycleCenterItem('activateNextItem'),
      'tranquil:show-previous-item-in-center': () =>
        cycleCenterItem('activatePreviousItem'),
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
        // Plain string (NO enum) so any custom value is accepted — Pulsar's config
        // core rejects out-of-enum values, and stock settings-view renders an enum
        // as a closed <select>. The preset dropdown is our own combobox (below).
        // Default is the clean derived Chrome UA; blank falls back to it too.
        browserUserAgent: {
          type: 'string',
          default: buildUaPresets()[0].value,
          title: 'Browser User-Agent',
          description:
            'Identity browser tabs send to sites. Pick a preset or type any value; blank = stock Chrome.',
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

    // Drop the "Search" pane from Settings. settings-view only adds that panel
    // (and its sidebar entry) when `enableSettingsSearch` is on, so turning the
    // default off removes it wholesale — no post-hoc DOM surgery. Still a
    // default, so a user can re-enable it.
    atom.config.setDefaults('settings-view', {
      enableSettingsSearch: false,
    })

    // Terminals belong in the bottom dock. `terminal.behavior.defaultContainer`
    // (default 'Center' upstream) is where the package sends any terminal opened
    // without an explicit location — `Terminal: Open`, the status-bar button, and
    // programmatic opens. Pairs with the startup preload below.
    atom.config.setDefaults('terminal', {
      behavior: {
        defaultContainer: 'Bottom Dock',
      },
    })

    // Keep docks closed across a window reload. A dock correctly restores its
    // pre-reload visibility (see dock.js `deserialize`), but some dock items grab
    // DOM focus while they initialize — most notably a restored terminal, whose
    // xterm view boots and focuses even while its dock is clipped shut — and that
    // focus activates the dock's pane, which re-opens a dock the user had closed.
    // Snapshot which docks restored hidden and, for the brief load-settling
    // window, re-hide any that get reopened on their own. Release the guard the
    // moment the user interacts (so an intentional open sticks) and, as a
    // backstop, after a few seconds — after which docks behave normally.
    //
    // The LEFT dock is deliberately excluded: tree-view *owns* the left dock's
    // startup visibility and shows it asynchronously on activation (unless
    // `tree-view.hiddenOnStartup` is set), which lands after this synchronous
    // snapshot. In a fresh New Window the left dock is still hidden here, so
    // guarding it would re-hide tree-view's legitimate startup open the instant
    // it happens — leaving new windows with no tree-view. The focus-theft problem
    // this guard exists for is a terminal/browser (bottom/right) concern, not a
    // left-dock one.
    const hiddenAtLoad = [
      atom.workspace.getRightDock(),
      atom.workspace.getBottomDock(),
    ].filter((dock) => !dock.isVisible())
    if (hiddenAtLoad.length) {
      let released = false
      let releaseTimer = null
      const guardSubs = hiddenAtLoad.map((dock) =>
        dock.onDidChangeVisible((visible) => {
          if (visible && !released) dock.hide()
        })
      )
      const releaseDockGuard = () => {
        if (released) return
        released = true
        guardSubs.forEach((sub) => sub.dispose())
        document.removeEventListener('mousedown', releaseDockGuard, true)
        document.removeEventListener('keydown', releaseDockGuard, true)
        if (releaseTimer) clearTimeout(releaseTimer)
      }
      document.addEventListener('mousedown', releaseDockGuard, true)
      document.addEventListener('keydown', releaseDockGuard, true)
      releaseTimer = setTimeout(releaseDockGuard, 5000)
    }

    // Make sure the bottom dock always has a terminal ready — but WITHOUT
    // revealing the dock on startup. We cannot preload one eagerly: a terminal
    // element boots as soon as it's mounted (its readiness `IntersectionObserver`
    // uses the terminal element itself as the root, so it fires even while the
    // dock is clipped to zero size), and on boot it calls `focusTerminal()`,
    // which pulls DOM focus into the dock's pane, activates it, and reveals the
    // dock. So instead we open the terminal lazily the first time the bottom
    // dock actually becomes visible. Paired with defaultContainer='Bottom Dock'
    // above, the dock stays closed until the user opens it, and a terminal is
    // waiting the moment they do. Skipped when the dock already holds a terminal
    // (e.g. restored from the last session) so we never stack a duplicate.
    atom.workspace.getBottomDock().onDidChangeVisible((visible) => {
      if (!visible) return
      const bottomDock = atom.workspace.getBottomDock()
      const hasTerminal = bottomDock
        .getPaneItems()
        .some(
          (item) =>
            item &&
            typeof item.getURI === 'function' &&
            String(item.getURI() || '').startsWith('terminal://')
        )
      if (hasTerminal) return
      // Pin the default terminal's cwd to ~/.tranquil using the `cwd` query
      // parameter the terminal model reads off its URI. Without it, the model
      // falls back to the active item's project root — or, in dev, the process
      // cwd (tranquil-client) — so every fresh window opened somewhere arbitrary.
      const cwd = encodeURIComponent(atom.getConfigDirPath())
      atom.workspace.open(`terminal://${crypto.randomUUID()}/?cwd=${cwd}`, {
        location: 'bottom',
      })
    })

    // Cmd-K clears the focused terminal, matching Terminal.app / iTerm muscle
    // memory. This can't be a keymap binding: bare cmd-k is the pane-chord
    // prefix (`cmd-k <arrow>`, `cmd-k cmd-w`, …), so an exact match on
    // `pulsar-terminal` would stall in the keymap's pending state until the
    // partial-match timeout — and shadowing the chords with `unset!` is worse,
    // since `findPartialMatches` ignores an unset binding's keystrokes
    // globally, killing the chords in editors too. Instead, intercept at
    // capture phase, scoped to focus inside a terminal — the same pattern the
    // browser package uses for its split chord. While a terminal is focused,
    // cmd-k chords are unavailable; that's the intended trade.
    document.addEventListener(
      'keydown',
      (e) => {
        if (process.platform !== 'darwin') return
        if (e.code !== 'KeyK' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        const terminal =
          e.target instanceof Element && e.target.closest('pulsar-terminal')
        if (!terminal) return
        e.preventDefault()
        e.stopImmediatePropagation()
        atom.commands.dispatch(terminal, 'terminal:clear')
      },
      true
    )

    atom.packages.disablePackage('background-tips')

    // Trim the Packages menu / reduce noise: features Tranquil doesn't surface.
    atom.packages.disablePackage('git-diff')
    atom.packages.disablePackage('open-on-github')
    atom.packages.disablePackage('timecop')
    atom.packages.disablePackage('about')
    atom.packages.disablePackage('autoflow')
    atom.packages.disablePackage('dalek')
    atom.packages.disablePackage('incompatible-packages')
    atom.packages.disablePackage('package-generator')
    atom.packages.disablePackage('styleguide')
    atom.packages.disablePackage('pulsar-updater')

    // Retire a "core" application command (one registered in Pulsar's
    // register-default-commands.js, NOT by a package) from both the command
    // palette and the menus. Disabling a package removes its own `pkg:*`
    // commands and menu contributions, but core `application:*` commands tied
    // to that feature survive on their own. `application:about` is one: with the
    // `about` package disabled above it only opens a now-dead `atom://about`, so
    // strip it everywhere it's still surfaced.
    const retireCoreCommand = (command) => {
      // Command palette: it lists `atom.commands.findCommands()` filtered by
      // `hiddenInCommandPalette` (see command-palette-view.js). We can't
      // unregister a core command from here, but flipping that flag on its
      // descriptor(s) hides it from the palette while leaving the binding intact.
      const listeners =
        atom.commands.selectorBasedListenersByCommandName[command]
      if (Array.isArray(listeners)) {
        for (const listener of listeners) {
          if (listener.descriptor) listener.descriptor.hiddenInCommandPalette = true
        }
      }
      // Menus: drop every item that dispatches the command, at any depth, then
      // ask the menu bar to rebuild.
      const prune = (items) => {
        if (!Array.isArray(items)) return
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]
          if (!item) continue
          if (item.command === command) {
            items.splice(i, 1)
            continue
          }
          if (Array.isArray(item.submenu)) prune(item.submenu)
        }
      }
      prune(atom.menu.template)
      atom.menu.update()
    }
    // Run now and again once initial packages have loaded, so the prune lands
    // regardless of when the base menu template finishes building.
    retireCoreCommand('application:about')
    atom.packages.onDidActivateInitialPackages(() =>
      retireCoreCommand('application:about')
    )

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
