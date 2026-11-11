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
