// Pure graph merge for the UI mirror. Kept free of DSH imports so it can be unit-tested.
import { createHash } from 'node:crypto'

/**
 * The two Hosts can work together: DSH of the same major.minor (docs/deployment.md). Patch and prerelease may differ;
 * the setup dialog offers to align them.
 */
export const compatibleReleases = (a, b) => {
  const pa = /^(\d+)\.(\d+)\./.exec(a?.version ?? ''); const pb = /^(\d+)\.(\d+)\./.exec(b?.version ?? '')
  return !!pa && !!pb && pa[1] === pb[1] && pa[2] === pb[2]
}

/**
 * Merge the user rows of a remote graph into the local one. A remote user row replaces a local row of the same id
 * (one UI for the window: the WSL side wins). Local rows of entries that a WSL plugin's bundle patch switches off
 * (`remote.disabled`, e.g. DS Bot turns off DSH's general settings shell to hold its seat) leave the page too: the
 * patch acts on the WSL Host's composition only, and the page must look as it would there.
 * Every local batch that contained a replaced or dropped row is split into single-row batches for its remaining rows,
 * because a batch script would register those rows' factories too.
 * @param local - this Host's graph.
 * @param remote - { graph, origin, disabled? } from the WSL agent, or undefined.
 * @param order - orderByModuleGraph from dsh-client-modules.
 * @param builtinHere - ids of this Host's rows that ship with its DSH. One is replaced only by a remote row a WSL
 *   third-party plugin owns (`remote.owner[id]`: a plugin standing in for an official package, as dsh-runtime-tuning's
 *   chat fix does); a row the remote merely calls 'user' never is, so the window keeps its own official UI when the
 *   WSL side misjudges its rows (0.1.4 did under pnpm, and the whole window became the WSL side's, blank).
 * @returns { graph, mirrored, dropped } where mirrored maps a package id to its remote row and dropped holds the ids of
 *   local rows left out.
 */
export function mergeGraphs(local, remote, order, builtinHere = new Set()) {
  const mirrored = new Map()
  const dropped = new Set()
  const kept = new Set()   // remote rows called the person's own that are part of this Host's DSH: never replaced
  if (remote === undefined) return { graph: local, mirrored, dropped, reason: 'no remote graph yet' }
  if (!compatibleReleases(local.release, remote.graph.release)) {
    return { graph: local, mirrored, dropped, reason: `release differs: local ${JSON.stringify(local.release)}, remote ${JSON.stringify(remote.graph.release)}` }
  }
  for (const row of remote.graph.entries) {
    if (remote.origin[row.id] !== 'user') continue
    // An official row of this Host is replaced only by a third-party plugin's stand-in for it (see the agent's owner).
    const owner = remote.owner?.[row.id]
    if (builtinHere.has(row.id) && !(typeof owner === 'string' && !owner.startsWith('@deepseek-ai/'))) kept.add(row.id)
    else mirrored.set(row.id, row)
  }
  const byId = new Map(local.entries.map((row) => [row.id, row]))
  for (const { name } of remote.disabled ?? []) if (byId.has(name) && !mirrored.has(name)) dropped.add(name)
  if (mirrored.size === 0 && dropped.size === 0) return { graph: local, mirrored, dropped, kept, reason: 'remote has no user rows' }
  const gone = (id) => mirrored.has(id) || dropped.has(id)
  const entries = order([...local.entries.filter((row) => !gone(row.id)), ...mirrored.values()])
  const batches = []
  for (const batch of local.batches) {
    if (!batch.entries.some(gone)) { batches.push(batch); continue }
    for (const id of batch.entries) {
      if (gone(id)) continue
      const row = byId.get(id)
      batches.push({ phase: batch.phase, url: row.url, rev: row.rev, entries: [id] })
    }
  }
  for (const row of mirrored.values()) batches.push({ phase: 'application', url: row.url, rev: row.rev, entries: [row.id] })
  const rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('base64url').slice(0, 12)
  return { graph: { rev, release: local.release, entries, batches }, mirrored, dropped, kept }
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
