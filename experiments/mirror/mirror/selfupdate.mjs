// Keeps this plugin up to date (docs/deployment.md, decision 8) through DSH's own plugin updates: the plugin manager
// lists the registry's newer versions (marking those whose engines.dsh rejects this DSH), and updateBundle replaces the
// installed one, putting the old one back when the new one does not install or start. The WSL half follows by itself:
// it is copied from this package on the next connect (setup.mjs, STAMP).
//
// Only a plugin installed from a registry can update this way; one installed from a folder or a Git URL reports
// `not-updatable`. The person can switch automatic updates off (config.json `autoUpdate: false`).

const FIRST_CHECK_MS = 60_000
const EVERY_MS = 6 * 60 * 60_000

/**
 * The version to update to: the newest that declares a bundle, works with this DSH, is not deprecated, and is a
 * release unless the installed version is itself a prerelease. `list` is the plugin manager's PluginVersionList.
 */
export function pickUpdate(list, installed) {
  if (list?.status !== 'listed') return undefined
  const onPrerelease = /-/.test(installed ?? '')
  return list.versions.find((v) => v.bundle && !v.incompatible && !v.deprecated && (onPrerelease || !v.prerelease))
}

/**
 * How the plugin manager can update a listed bundle: DSH 0.2.2-rc.2 lists `update: 'registry' | 'git'`, earlier
 * releases `updatable: boolean` (registry only). Only registry updates are used here.
 */
export const updateKind = (row) => row?.update ?? (row?.updatable ? 'registry' : undefined)

/**
 * Check now and then; returns {state(), check()}. `state()` is what the setup dialog shows:
 * {name, version, auto, status, latest?, error?, at?} with status one of: waiting, off, checking, not-updatable,
 * up-to-date, updating, updated, restart-required, failed.
 */
export function installSelfUpdate(ctx, { name, version, auto, log = () => {} }) {
  let state = { name, version, auto: auto(), status: 'waiting' }
  let manager
  let running
  const set = (patch) => { state = { ...state, ...patch, at: new Date().toISOString() } }

  async function check() {
    if (running) return running
    running = (async () => {
      set({ auto: auto() })
      if (!state.auto) { set({ status: 'off' }); return }
      if (!manager) { set({ status: 'failed', error: 'the plugin manager is not available' }); return }
      set({ status: 'checking', error: undefined })
      try {
        const row = (await manager.listBundles()).find((b) => b.name === name)
        if (updateKind(row) !== 'registry') { set({ status: 'not-updatable' }); return }
        const list = await manager.listVersions(name)
        if (list.status !== 'listed') { set({ status: 'failed', error: list.problem ?? list.status }); return }
        const next = pickUpdate(list, row.version ?? version)
        if (!next) { set({ status: 'up-to-date', latest: list.versions[0]?.version }); return }
        set({ status: 'updating', latest: next.version })
        log(`updating ${name} ${row.version} → ${next.version}`)
        // With HMR this disposes this plugin before the new version starts; nothing below may run then.
        const result = await manager.updateBundle(name, next.version, { registry: list.registry })
        const application = result.result.application
        if (application === 'applied') set({ status: 'updated' })
        else if (application === 'restart-required') set({ status: 'restart-required' })
        else set({ status: 'failed', error: result.result.error?.message ?? `${result.step}: ${application}` })
      } catch (error) {
        set({ status: 'failed', error: error.message })
      }
    })().finally(() => { running = undefined })
    return running
  }

  ctx.inject(['pluginManager'], (c) => {
    manager = c.pluginManager
    const first = setTimeout(() => void check(), FIRST_CHECK_MS); first.unref?.()
    const every = setInterval(() => void check(), EVERY_MS); every.unref?.()
    return () => { manager = undefined; clearTimeout(first); clearInterval(every) }
  })
  return {
    // The switch takes effect at once in what the dialog shows; a check in flight finishes.
    state: () => (auto() ? { ...state, auto: true, ...(state.status === 'off' ? { status: 'waiting' } : {}) } : { ...state, auto: false, status: state.status === 'updating' ? 'updating' : 'off' }),
    check,
  }
}
