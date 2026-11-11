// The official Plugins page over both Hosts: its list calls answer with this Host's items and the WSL Host's items,
// every item labelled with its side; WSL items carry a `wsl:` prefix on their ids, so a later call that names one is
// sent to the WSL Host with the prefix removed. Kept free of DSH imports so it can be unit-tested.

export const PREFIX = 'wsl:'
export const SIDE_LABEL = { local: 'Windows', wsl: 'WSL' }
export const LIST_METHODS = new Set(['pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginInventory/list'])
export const PLUGIN_NAMESPACES = new Set(['pluginManager', 'pluginInventory'])

const prefixed = (id) => (typeof id === 'string' ? `${PREFIX}${id}` : id)

function labelled(meta, fallback, side) {
  const tag = ` · ${SIDE_LABEL[side]}`
  if (meta && typeof meta.title === 'string') return { ...meta, title: meta.title + tag }
  return { ...(meta ?? {}), title: fallback + tag }
}

export function mergeBundles(local, remote) {
  return [
    ...local.map((b) => ({ ...b, meta: labelled(b.meta, b.name, 'local') })),
    ...remote.map((b) => ({
      ...b,
      name: prefixed(b.name),
      meta: labelled(b.meta, b.name, 'wsl'),
      ...(b.rows ? { rows: b.rows.map((r) => ({ ...r, entryId: prefixed(r.entryId) })) } : {}),
    })),
  ]
}

export function mergePlugins(local, remote) {
  return [...local, ...remote.map((p) => ({ ...p, entryId: prefixed(p.entryId), ...(p.patchId ? { patchId: prefixed(p.patchId) } : {}) }))]
}

// Inventory: entries from both sides; agent presets and management availability stay this Host's.
export function mergeInventory(local, remote) {
  return { ...local, entries: [...local.entries, ...remote.entries.map((e) => ({ ...e, entryId: prefixed(e.entryId) }))] }
}

export function mergeList(method, local, remote) {
  if (method === 'pluginManager/listBundles') return mergeBundles(local, remote)
  if (method === 'pluginManager/listPlugins') return mergePlugins(local, remote)
  return mergeInventory(local, remote)
}

/** Remove the `wsl:` prefix from every string in a value; `wsl` tells whether any was found. */
export function stripPrefix(value) {
  let wsl = false
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith(PREFIX)) { wsl = true; return v.slice(PREFIX.length) } return v }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const out = walk(value)
  return { value: out, wsl }
}

/** Put the prefix back on the ids a WSL Host's action result names (ChangeResult `target` and `bundle`). */
export function prefixResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...value }
  for (const key of ['target', 'bundle']) if (typeof out[key] === 'string') out[key] = prefixed(out[key])
  return out
}
