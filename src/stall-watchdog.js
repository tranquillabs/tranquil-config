// Freeze diagnostics for the renderer.
//
// The main process has its own event-loop lag check (tranquil-client
// src/main-process/stall-watchdog.js) which catches a blocked main process — the case where
// every window locks up at once. This is the other half: a stall confined to one window's
// renderer thread.
//
// Electron does notice hung renderers and emits 'unresponsive', but Chromium won't call a
// renderer hung until roughly 30s of unacknowledged input. A shorter freeze — long enough to be
// obvious, short enough that no dialog ever appears — produces no event and no log line, which
// is precisely the gap this fills. The threshold is deliberately far below Chromium's.
//
// Reports only; it never intervenes. The `[tranquil-config]` tag is what keeps these lines
// through the dev-terminal filter in scripts/dev.js.
const TAG = '[tranquil-config]'

const TICK_MS = 1000
const STALL_MS = 1500

// Upper bound on what gets reported. The renderer has no view of the power state — a suspended
// machine simply stops the loop, and on wake the drift is minutes or hours. Hiding the window
// usually covers that (see below), but not reliably, so anything beyond a minute is treated as
// suspend rather than a stall. Nothing is lost: a freeze that long crosses Chromium's ~30s hang
// threshold, and the main process logs those as 'renderer unresponsive' with their duration.
const MAX_REPORT_MS = 60000

let started = false

// Chromium throttles timers in hidden or occluded windows (down to about once a minute), so an
// unfocused window accrues drift that has nothing to do with a stall. Any visibility change
// since the last tick, or a tick that lands while hidden, is therefore not reported — it is
// used to rebase instead.
function startRendererStallWatchdog() {
  if (started) return
  started = true

  let expected = Date.now() + TICK_MS
  let skipNextTick = false

  const onVisibilityChange = () => {
    skipNextTick = true
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  const timer = setInterval(() => {
    const now = Date.now()
    const drift = now - expected
    expected = now + TICK_MS
    if (skipNextTick || document.hidden) {
      skipNextTick = false
      return
    }
    if (drift >= STALL_MS && drift < MAX_REPORT_MS) {
      console.log(
        `${TAG} renderer stall: ${drift}ms in "${document.title}", ended ${new Date(now).toISOString()}`
      )
    }
  }, TICK_MS)

  return {
    dispose() {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      started = false
    },
  }
}

module.exports = { startRendererStallWatchdog }
