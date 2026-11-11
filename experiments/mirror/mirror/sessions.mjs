// Merging the two Hosts' Workspace and Session views for the page. Frames from the WSL Host have already had their
// identities prefixed (ids.mjs). Kept free of DSH imports so it can be unit-tested.
//
// A folder can be known to both Hosts: a Windows folder whose Sessions run in WSL has a twin Workspace on the WSL Host
// (D:\code\proj here, /mnt/d/code/proj there). The page shows one folder row; the twin's Sessions are listed in it.
// A folder only the WSL Host knows (\\wsl.localhost\Ubuntu\home\...) is a row of its own.

import { isWsl, toPage } from './ids.mjs'
import { toWindowsSpec, toWslSpec } from './paths.mjs'

const empty = () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })

/** How the WSL Host names a path of this Host, and how this Host shows a WSL Host path. */
export function pathMapping(platform, distro) {
  const win = platform === 'win32'
  const unc = (path) => typeof path === 'string' && /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]/i.test(path)
  return {
    toWsl: (path) => (win || unc(path) ? toWslSpec(path) : path),
    toLocal: (path) => (win ? toWindowsSpec(path, distro) : path),
    /** A path naming a folder that lives in WSL (\\wsl.localhost\..., \\wsl$\...). */
    insideWsl: unc,
  }
}

/** Apply one `workspace/follow` frame to a source's state. */
export function applyWorkspaceFrame(state, frame) {
  switch (frame.type) {
    case 'baseline': case 'replace': return { ...frame.value, items: [...frame.value.items] }
    case 'upsert': return { ...state, items: [...state.items.filter((w) => w.workspaceId !== frame.workspace.workspaceId), frame.workspace] }
    case 'remove': return { ...state, items: state.items.filter((w) => w.workspaceId !== frame.workspaceId) }
    case 'order': return { ...state, items: [...state.items].sort((a, b) => frame.workspaceIds.indexOf(a.workspaceId) - frame.workspaceIds.indexOf(b.workspaceId)) }
    case 'archived': return { ...state, archivedSessionIds: frame.archivedSessionIds }
    case 'pinned': return { ...state, pinnedSessionIds: frame.pinnedSessionIds }
    default: return state
  }
}

/**
 * The page's view of both Hosts' Workspaces. Returns the merged baseline and the twin pairs found
 * (local workspaceId → WSL workspaceId, both as the page names them).
 */
export function mergeWorkspaces(local = empty(), wsl = empty(), paths) {
  const byWslPath = new Map(wsl.items.map((w) => [w.path, w]))
  const twins = new Map()
  const items = local.items.map((w) => {
    const twin = byWslPath.get(paths.toWsl(w.path))
    if (!twin) return w
    twins.set(w.workspaceId, twin.workspaceId)
    return { ...w, sessionIds: [...w.sessionIds, ...twin.sessionIds] }
  })
  const folded = new Set(twins.values())
  for (const w of wsl.items) if (!folded.has(w.workspaceId)) items.push({ ...w, path: paths.toLocal(w.path) })
  return {
    value: {
      items,
      archivedSessionIds: [...local.archivedSessionIds, ...wsl.archivedSessionIds],
      pinnedSessionIds: [...local.pinnedSessionIds, ...wsl.pinnedSessionIds],
    },
    twins,
  }
}

/** Session summaries from the WSL Host, with paths as this Host shows them. */
export const localizeSessions = (items, paths) => items.map((s) => (typeof s.cwd === 'string' ? { ...s, cwd: paths.toLocal(s.cwd) } : s))

/** `session/control` baseline from the WSL Host: its projections are keyed by Session id. */
export const prefixProjections = (baseline) => ({
  ...baseline,
  projections: Object.fromEntries(Object.entries(baseline.projections ?? {}).map(([id, block]) => [toPage(id), block])),
})

/** One `$events` frame from the WSL Host: `api-session/*` events name their Session as the first argument. */
export function prefixEvent(frame) {
  if (frame.type === 'emit' && /^api-session\//.test(frame.event) && typeof frame.args?.[0] === 'string' && !isWsl(frame.args[0])) {
    return { ...frame, args: [toPage(frame.args[0]), ...frame.args.slice(1)] }
  }
  return frame
}

/**
 * Where a new Session goes. `target` is the run location chosen for the folder ('wsl' or 'local'); `twin` is the WSL
 * Host's Workspace for a local folder, if it has one. Returns the Host and the request to send there (identities as
 * the page names them; the caller strips the prefix for the WSL Host), or `needsTwin` when the WSL Host must first
 * adopt the folder.
 */
export function placeSession(request, { target, twin }) {
  const { workspaceId, sessionId, ...rest } = request
  if (workspaceId === undefined) return { host: 'local', request }
  if (isWsl(workspaceId)) return { host: 'wsl', request: { ...rest, workspaceId, ...(isWsl(sessionId) ? { sessionId } : {}) } }
  if (target !== 'wsl') return { host: 'local', request: { ...rest, workspaceId, ...(sessionId !== undefined && !isWsl(sessionId) ? { sessionId } : {}) } }
  if (twin === undefined) return { host: 'wsl', needsTwin: true, request: { ...rest, ...(isWsl(sessionId) ? { sessionId } : {}) } }
  return { host: 'wsl', request: { ...rest, workspaceId: twin, ...(isWsl(sessionId) ? { sessionId } : {}) } }
}
