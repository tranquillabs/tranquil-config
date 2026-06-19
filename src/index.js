const commandHistory = []
let mruInstalled = false

function shouldTrackCommand(name) {
  if (name.startsWith('command-palette:')) return false
  if (/^core:(move-|scroll-|select-)/.test(name)) return false
  if (/^editor:(move-|scroll-|select-)/.test(name)) return false
  return true
}

function installMRU() {
  for (const panel of atom.workspace.getModalPanels()) {
    const slv = panel.getItem()
    if (!slv || !slv.element || !slv.element.classList.contains('command-palette')) continue
    const order = (a, b) => {
      if (slv.getQuery().length > 0) return 0
      const aIdx = commandHistory.indexOf(a.name)
      const bIdx = commandHistory.indexOf(b.name)
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
      if (aIdx !== -1) return -1
      if (bIdx !== -1) return 1
      return 0
    }
    slv.update({order, items: slv.props.items})
    mruInstalled = true
    return
  }
}

module.exports = {
  activate() {
    atom.config.setDefaults('tree-view', {
      hideIgnoredNames: true,
      hideVcsIgnoredFiles: true,
    })

    atom.packages.disablePackage('background-tips')

    atom.commands.onDidDispatch((event) => {
      if (event.type === 'command-palette:toggle' && !mruInstalled) {
        installMRU()
      }

      if (!shouldTrackCommand(event.type)) return
      const idx = commandHistory.indexOf(event.type)
      if (idx > -1) commandHistory.splice(idx, 1)
      commandHistory.unshift(event.type)
    })
  }
}
