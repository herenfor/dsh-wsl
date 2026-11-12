// The WSL tab of the Plugins page: which of the WSL Host's bundles it lists, and what it shows of each. The official
// Installed tab is left to this Host alone. Kept free of DSH imports so it can be unit-tested.

// Bundles the WSL side needs to be reached at all: listed nowhere, so they cannot be switched off from the page.
const INTERNAL = new Set(['dsh-wsl-agent'])

// Package text as the manifest gives it (a string, or translations by lowercase locale with English among them); the
// page resolves it in the active language. A map without English gets one, so the page's resolver always has it.
const text = (value, fallback) => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => typeof v === 'string')
    if (entries.length) return { en: value.en ?? entries[0][1], ...Object.fromEntries(entries) }
  }
  return fallback
}

/**
 * The rows of the WSL tab, as the official Installed tab picks them: the official optional bundles and the installed
 * ones (the profile's own base bundles are neither), installed ones first.
 */
export function wslBundles(bundles) {
  return bundles
    .filter((b) => !INTERNAL.has(b.name) && (b.official || b.installed))
    .map((b) => ({
      name: b.name,
      title: text(b.meta?.title, b.name),
      description: text(b.meta?.description ?? b.description, ''),
      icon: typeof b.meta?.icon === 'string' ? b.meta.icon : undefined,
      version: b.version ?? null,
      official: !!b.official,
      installed: !!b.installed,
      enabled: !!b.enabled,
      availability: b.availability,
      ...(b.error ? { error: b.error.message ?? String(b.error.code ?? b.error) } : {}),
    }))
    .sort((a, b) => Number(a.official) - Number(b.official))
}

// Official bundles the official page marks as experimental (its own list, by name).
const EXPERIMENTAL = /^@deepseek-ai\/dsh-(experimental-|cua-bundle$|personalized-recommendations$)/

/**
 * One bundle's page in the WSL tab, as the official bundle page shows it: the bundle with its rows joined to the
 * WSL Host's live entries (`listPlugins`).
 * @returns undefined when the WSL Host lists no such bundle, or one the tab does not list.
 */
export function wslBundlePage(bundles, plugins, name) {
  const bundle = bundles.find((b) => b.name === name)
  if (bundle === undefined || INTERNAL.has(name)) return undefined
  const [card] = wslBundles([bundle])
  if (card === undefined) return undefined
  const rows = (bundle.rows ?? []).map((row) => {
    const live = row.entryId === undefined ? undefined : plugins.find((p) => p.entryId === row.entryId)
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      title: text(row.meta?.title, row.rowId),
      description: text(row.meta?.description, ''),
      icon: typeof row.meta?.icon === 'string' ? row.meta.icon : undefined,
      enabled: live?.enabled ?? false,
      phase: live?.fiberPhase ?? null,
      ...(live?.diagnostic ? { diagnostic: live.diagnostic } : {}),
      ...(row.entryId !== undefined ? { entryId: row.entryId } : {}),
      // The official page locks a row the Host cannot address through the profile patch.
      locked: row.entryId === undefined || live?.readOnlyReason !== undefined,
    }
  })
  return {
    ...card,
    experimental: card.official && EXPERIMENTAL.test(name),
    removable: !!bundle.removable && !card.official,
    ...(bundle.source ? { source: bundle.source } : {}),
    ...(bundle.readOnlyReason ? { readOnly: true } : {}),
    rows,
  }
}
