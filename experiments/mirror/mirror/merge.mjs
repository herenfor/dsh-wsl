// Pure graph merge for the UI mirror. Kept free of DSH imports so it can be unit-tested.
import { createHash } from 'node:crypto'

export const sameRelease = (a, b) => a?.version === b?.version && a?.commit === b?.commit

/**
 * Merge the user rows of a remote graph into the local one. A remote user row replaces a local row of the same id
 * (one UI for the window: the WSL side wins). Every local batch that contained a replaced row is split into
 * single-row batches for its remaining rows, because a batch script would register the replaced row's factory too.
 * @param local - this Host's graph.
 * @param remote - { graph, origin } from the WSL agent, or undefined.
 * @param order - orderByModuleGraph from dsh-client-modules.
 * @returns { graph, mirrored } where mirrored maps a package id to its remote row.
 */
export function mergeGraphs(local, remote, order) {
  const mirrored = new Map()
  if (remote === undefined) return { graph: local, mirrored, reason: 'no remote graph yet' }
  if (!sameRelease(local.release, remote.graph.release)) {
    return { graph: local, mirrored, reason: `release differs: local ${JSON.stringify(local.release)}, remote ${JSON.stringify(remote.graph.release)}` }
  }
  for (const row of remote.graph.entries) if (remote.origin[row.id] === 'user') mirrored.set(row.id, row)
  if (mirrored.size === 0) return { graph: local, mirrored, reason: 'remote has no user rows' }
  const byId = new Map(local.entries.map((row) => [row.id, row]))
  const entries = order([...local.entries.filter((row) => !mirrored.has(row.id)), ...mirrored.values()])
  const batches = []
  for (const batch of local.batches) {
    if (!batch.entries.some((id) => mirrored.has(id))) { batches.push(batch); continue }
    for (const id of batch.entries) {
      if (mirrored.has(id)) continue
      const row = byId.get(id)
      batches.push({ phase: batch.phase, url: row.url, rev: row.rev, entries: [id] })
    }
  }
  for (const row of mirrored.values()) batches.push({ phase: 'application', url: row.url, rev: row.rev, entries: [row.id] })
  const rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('base64url').slice(0, 12)
  return { graph: { rev, release: local.release, entries, batches }, mirrored }
}

/**
 * The package ids a /plugins request addresses: every id of a combo (`/plugins/??a/client.js,b/client.js&rev=`),
 * or the package of a chunk or asset path (`/plugins/<id>/...`, scoped ids included).
 */
export function requestedPackages(url) {
  const { pathname, search } = new URL(url, 'http://x')
  if (search.startsWith('??')) {
    const list = search.slice(2).split('&')[0]
    return list.split(',').map((file) => file.replace(/\/client\.js(\.map)?$/, ''))
  }
  const parts = pathname.replace(/^\/plugins\//, '').split('/')
  return [parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]]
}
