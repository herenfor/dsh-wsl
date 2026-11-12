// Session and Workspace identities of the WSL Host, as the page sees them: prefixed with `wsl:` so they cannot collide
// with this Host's own and so every call that names one can be sent to the right Host.
//
// The list of identity-bearing fields and the special cases for `id`, `owner` and `val` are adapted from
// dsh-ssh-workspaces (src/backend-protocol.ts), MIT License, Copyright (c) 2026 czp0312 and dsh-ssh-workspaces
// contributors. Kept free of DSH imports so it can be unit-tested.

export const PREFIX = 'wsl:'

const IDENTITY = /^(?:workspaceIds?|beforeWorkspaceId|(?:[a-zA-Z]*Session|session)Ids?|parentSession|agentId|workspaceFileScopeId|eventId)$/
const resource = (value) => value?.kind === 'session' || value?.kind === 'workspace'
const member = (value) => (value?.role === 'lead' || value?.role === 'teammate') && typeof value?.name === 'string'

export const isWsl = (id) => typeof id === 'string' && id.startsWith(PREFIX)
export const toPage = (id) => `${PREFIX}${id}`
export const toWsl = (id) => (isWsl(id) ? id.slice(PREFIX.length) : id)

/** The field name an identity value is read under: `id` of a session or workspace reference counts as `sessionId`. */
function fieldOf(object, name, key) {
  if (name === 'id' && (resource(object) || member(object) || key === 'subagentCatalog' || (key === 'header' && typeof object.version === 'number'))) return 'sessionId'
  if (name === 'owner' && typeof object.startedAt === 'number' && object.output && typeof object.kind === 'string') return 'sessionId'
  if (name === 'val' && typeof object.key === 'string') return object.key
  return name
}

/**
 * Rewrite every identity in a value. `incoming` (WSL Host → page) adds the prefix; outgoing removes it and refuses a
 * value that mixes this Host's identities with the WSL Host's.
 */
export function translate(value, incoming, key = '') {
  if (typeof value === 'string' && IDENTITY.test(key)) return incoming ? toPage(value) : toWsl(value)
  if (Array.isArray(value)) return value.map((item) => translate(item, incoming, key))
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out = {}
    for (const [name, item] of Object.entries(value)) out[name] = translate(item, incoming, fieldOf(value, name, key))
    return out
  }
  return value
}

/** Every identity a value names, with the field it was found under. */
export function identities(value) {
  const found = []
  const walk = (item, key = '') => {
    if (typeof item === 'string' && IDENTITY.test(key)) found.push({ key, value: item })
    else if (Array.isArray(item)) item.forEach((child) => walk(child, key))
    else if (item && typeof item === 'object' && !ArrayBuffer.isView(item)) for (const [name, child] of Object.entries(item)) walk(child, fieldOf(item, name, key))
  }
  walk(value)
  return found
}

/**
 * Which Host a call belongs to: 'wsl' when it names only WSL identities, 'local' when it names only this Host's or
 * none. A call naming both is refused (the error says why), except the identity of a new Session in `session/create`,
 * which the router decides itself.
 */
export function routeOf(payload, endpoint = '') {
  const items = identities(payload).filter((item) => !(endpoint === 'session/create' && item.key === 'sessionId'))
  const wsl = items.filter((item) => isWsl(item.value)).length
  if (wsl === 0) return 'local'
  if (wsl === items.length) return 'wsl'
  throw Object.assign(new Error('This action mixes a Windows session or folder with a WSL one.'), { code: 'wsl/mixed-hosts' })
}

// Plugins installed only in WSL talk to their own Host part over Fetch routes with bodies of their own shape, so the
// identities in them are found by value, not by field: a Session id has a fixed form, a Workspace id is one the WSL
// Host lists. Map keys count as values (a plugin may index by Session).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_ID = new RegExp(`^session-${UUID}$`)
const PAGE_ID = new RegExp(`^${PREFIX}(?:session-)?${UUID}$`)

/** `incoming` (WSL Host → page) prefixes WSL Session ids and the given WSL Workspace ids; outgoing strips the prefix. */
export function translateLoose(value, incoming, workspaceIds = new Set()) {
  const one = (text) => incoming
    ? (SESSION_ID.test(text) || workspaceIds.has(text) ? toPage(text) : text)
    : (PAGE_ID.test(text) ? toWsl(text) : text)
  const walk = (item) => {
    if (typeof item === 'string') return one(item)
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object' && !ArrayBuffer.isView(item)) {
      const out = {}
      for (const [name, child] of Object.entries(item)) out[one(name)] = walk(child)
      return out
    }
    return item
  }
  return walk(value)
}
