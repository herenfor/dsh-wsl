// The official Plugins page over both Hosts: its list calls answer with this Host's items and the WSL Host's items,
// every item labelled with its side; WSL items carry a `wsl:` prefix on their ids, so a later call that names one is
// sent to the WSL Host with the prefix removed. Kept free of DSH imports so it can be unit-tested.

export const PREFIX = 'wsl:'
export const SIDE_LABEL = { local: 'Windows', wsl: 'WSL' }
export const LIST_METHODS = new Set(['pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginInventory/list'])
export const PLUGIN_NAMESPACES = new Set(['pluginManager', 'pluginInventory'])

const prefixed = (id) => (typeof id === 'string' ? `${PREFIX}${id}` : id)

// Append the side to the title the page shows: a plain string, or every language of a localized title.
function labelled(meta, fallback, side) {
  const tag = ` · ${SIDE_LABEL[side]}`
  const title = meta?.title
  if (typeof title === 'string') return { ...meta, title: title + tag }
  if (title && typeof title === 'object') return { ...meta, title: Object.fromEntries(Object.entries(title).map(([lang, t]) => [lang, `${t}${tag}`])) }
  return { ...(meta ?? {}), title: fallback + tag }
}

// Labels appended to a title. An official bundle both Hosts ship keeps one row (the page styles official bundles by
// their exact names); its row switch stays this Host's, so the title tells both sides' states.
const state = (zh, on) => (zh ? (on ? '已启用' : '未启用') : (on ? 'on' : 'off'))
const both = (zh, localOn, wslOn) => ` · Windows ${state(zh, localOn)} · WSL ${state(zh, wslOn)}`
function labelledBoth(meta, fallback, localEnabled, wslEnabled) {
  const title = meta?.title
  if (title && typeof title === 'object') {
    return { ...meta, title: Object.fromEntries(Object.entries(title).map(([lang, t]) => [lang, t + both(lang === 'zh', localEnabled, wslEnabled)])) }
  }
  return { ...(meta ?? {}), title: (typeof title === 'string' ? title : fallback) + both(true, localEnabled, wslEnabled) }
}

/** Whether a bundle both Hosts have is the official one, shown as a single row. */
export const sharedOfficial = (mine, theirs) => mine !== undefined && theirs !== undefined && (mine.official || theirs.official)

/**
 * @param local - this Host's bundles.
 * @param remote - the WSL Host's bundles, or undefined when it did not answer (then only this Host's are labelled).
 */
export function mergeBundles(local, remote) {
  const theirsByName = new Map((remote ?? []).map((b) => [b.name, b]))
  const out = local.map((b) => {
    const twin = theirsByName.get(b.name)
    if (sharedOfficial(b, twin)) return { ...b, meta: labelledBoth(b.meta, b.name, b.enabled, twin.enabled) }
    return { ...b, meta: labelled(b.meta, b.name, 'local') }
  })
  const localByName = new Map(local.map((b) => [b.name, b]))
  for (const b of remote ?? []) {
    if (sharedOfficial(localByName.get(b.name), b)) continue
    out.push({
      ...b,
      name: prefixed(b.name),
      meta: labelled(b.meta, b.name, 'wsl'),
      ...(b.rows ? { rows: b.rows.map((r) => ({ ...r, entryId: prefixed(r.entryId) })) } : {}),
    })
  }
  return out
}

export function mergePlugins(local, remote) {
  return [...local, ...(remote ?? []).map((p) => ({ ...p, entryId: prefixed(p.entryId), ...(p.patchId ? { patchId: prefixed(p.patchId) } : {}) }))]
}

// Inventory: entries from both sides; agent presets and management availability stay this Host's.
export function mergeInventory(local, remote) {
  return { ...local, entries: [...local.entries, ...(remote?.entries ?? []).map((e) => ({ ...e, entryId: prefixed(e.entryId) }))] }
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
