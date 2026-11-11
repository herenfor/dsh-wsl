// Settings for plugins installed only in WSL. Kept free of DSH imports so it can be unit-tested.
// The page reads every settings namespace with settings/describe and writes one namespace at a time with
// settings/update, settings/replace or settings/mutate (argument `ns`). A namespace only the WSL Host serves belongs
// to a plugin installed only there: describe shows it next to this Host's own, and writes to it go to the WSL Host.
// Namespaces both Hosts serve stay on this Host (which side they should follow is an open design question).

export const SETTINGS_WRITES = new Set(['update', 'replace', 'mutate'])

/** The settings method an /api path names, or undefined. */
export function settingsMethod(pathname) {
  const m = /^\/api\/settings\/([A-Za-z]+)$/.exec(pathname)
  return m?.[1]
}

/**
 * @param local - this Host's describe value { writable, hasDocument, namespaces: [{ ns, ... }] }.
 * @param remote - the WSL Host's describe value.
 * @returns { value, remoteNamespaces } where value lists this Host's namespaces, then the WSL-only ones.
 */
export function mergeDescribe(local, remote) {
  const mine = new Set(local.namespaces.map((view) => view.ns))
  const extra = (remote?.namespaces ?? []).filter((view) => !mine.has(view.ns))
  return { value: { ...local, namespaces: [...local.namespaces, ...extra] }, remoteNamespaces: new Set(extra.map((view) => view.ns)) }
}

// Desktop is the source of truth for every setting both Hosts have: those are copied to the WSL Host, one way.
// Never copied: secret fields (each side keeps its own), and namespaces that describe one machine only.
export const NEVER_SYNC = new Set(['bash-sandbox', 'pwsh-sandbox'])

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const secretKeys = (view) => new Set((view?.secrets ?? []).map((s) => s.path?.[0]).filter(Boolean))

/**
 * The mutate ops that make the WSL Host's user section of one namespace match this Host's, top-level field by field.
 * @param desktop - this Host's view { user, secrets }.
 * @param wsl - the WSL Host's view { user, secrets }.
 * @returns ops: set for a differing field, unset for a field only the WSL Host has; secret fields untouched.
 */
export function syncOps(desktop, wsl) {
  const skip = new Set([...secretKeys(desktop), ...secretKeys(wsl)])
  const mine = desktop?.user && typeof desktop.user === 'object' ? desktop.user : {}
  const theirs = wsl?.user && typeof wsl.user === 'object' ? wsl.user : {}
  const ops = []
  for (const [key, value] of Object.entries(mine)) if (!skip.has(key) && !same(theirs[key], value)) ops.push({ op: 'set', path: [key], value })
  for (const key of Object.keys(theirs)) if (!skip.has(key) && !(key in mine)) ops.push({ op: 'unset', path: [key] })
  return ops
}

/** The namespaces to copy: both Hosts have them and none is machine-specific. */
export function sharedNamespaces(desktopViews, wslViews) {
  const theirs = new Map(wslViews.map((v) => [v.ns, v]))
  return desktopViews.filter((v) => theirs.has(v.ns) && !NEVER_SYNC.has(v.ns)).map((v) => ({ ns: v.ns, desktop: v, wsl: theirs.get(v.ns) }))
}
