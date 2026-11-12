// Settings that name an entry of a per-Host list (docs/cross-host-rules.md, A), and settings that only make sense on
// the machine they were set on (B). Kept free of DSH imports so it can be unit-tested.
//
// A: DSH keeps one value (the default preset, the default permission preset, the search provider, the default model)
// and each Host resolves it against its own list; a WSL plugin adds entries only the WSL Host has. The person's
// choice is kept here (`choices`), and each Host stores what the choice resolves to there: the choice when that Host
// has it, otherwise nothing, so the Host falls back to its own default and no Host ever holds a value it cannot use.
// The page is shown the choice.
//
// B: a few values name things of one machine (an MCP server's command, the name of an environment variable). They are
// not copied from Desktop to WSL: each side keeps its own.

/** Calls that list what a Host has, and how to read each list. */
export const ROSTER_CALLS = {
  presets: ['agentPresets/list', {}],
  permissionPresets: ['permissionPresets/catalog', {}],
  webProviders: ['web/listProviders', {}],
  models: ['session/modelCatalog', {}],
}
const MODEL = (provider, model) => `${provider}\u0000${model}`

/**
 * What a Host has, from the answers to ROSTER_CALLS (a missing or failed answer leaves that list unknown, and values
 * checked against an unknown list are kept as they are).
 * @param answers - { presets, permissionPresets, webProviders, models }: each the call's value or undefined.
 */
export function rosterOf(answers = {}) {
  const ids = (list, key = 'id') => (Array.isArray(list) ? new Set(list.map((x) => x?.[key]).filter((x) => typeof x === 'string')) : undefined)
  const models = answers.models?.groups ? new Set(answers.models.groups.flatMap((g) => (g.models ?? []).map((m) => MODEL(g.id, m.id)))) : undefined
  return {
    presets: ids(answers.presets?.presets),
    permissionPresets: ids(answers.permissionPresets?.options, 'value'),
    searchProviders: ids(answers.webProviders?.search),
    fetchProviders: ids(answers.webProviders?.fetch),
    models,
  }
}

// Each reference field: the namespace, the field (or the pair of fields) and the list it names an entry of.
const ID_FIELDS = {
  'agent-preset-registry': { selectedDefault: 'presets' },
  permission: { defaultPreset: 'permissionPresets' },
  web: { searchProvider: 'searchProviders', fetchProvider: 'fetchProviders' },
}
const MODEL_PAIRS = { 'agent-default-model': ['provider', 'model'] }
const MODEL_LISTS = { 'subagent-model-selection-settings': ['allowedModels'] }
export const REFERENCE_NAMESPACES = new Set([...Object.keys(ID_FIELDS), ...Object.keys(MODEL_PAIRS), ...Object.keys(MODEL_LISTS)])

/** The reference fields of one namespace's user section (what is kept as the person's choice). */
export function referencePart(ns, section = {}) {
  const keys = [...Object.keys(ID_FIELDS[ns] ?? {}), ...(MODEL_PAIRS[ns] ?? []), ...(MODEL_LISTS[ns] ?? [])]
  return Object.fromEntries(keys.filter((k) => section?.[k] !== undefined).map((k) => [k, section[k]]))
}

const has = (set, value) => set === undefined || set.has(value)

/**
 * A user section with its reference fields resolved against one Host's list: a value the Host does not have is
 * removed (the Host then uses its own default); a model list keeps the models the Host has.
 */
export function resolveSection(ns, section = {}, roster = {}) {
  const out = { ...section }
  for (const [field, list] of Object.entries(ID_FIELDS[ns] ?? {})) {
    if (typeof out[field] === 'string' && !has(roster[list], out[field])) delete out[field]
  }
  const pair = MODEL_PAIRS[ns]
  if (pair && typeof out[pair[0]] === 'string' && typeof out[pair[1]] === 'string' && !has(roster.models, MODEL(out[pair[0]], out[pair[1]]))) {
    delete out[pair[0]]; delete out[pair[1]]
  }
  for (const field of MODEL_LISTS[ns] ?? []) {
    if (Array.isArray(out[field])) out[field] = out[field].filter((m) => !m || typeof m !== 'object' || has(roster.models, MODEL(m.provider, m.model)))
  }
  return out
}

/** Whether one Host can use a model (unknown list: yes). */
export const hasModel = (roster, provider, model) => has(roster?.models, MODEL(provider, model))

/** Apply settings/mutate ops ({ op: 'set' | 'unset', path, value }) to a section, without changing the original. */
export function applyOps(section = {}, ops = []) {
  const out = structuredClone(section)
  for (const { op, path, value } of ops) {
    if (!Array.isArray(path) || path.length === 0) continue
    let at = out
    for (const key of path.slice(0, -1)) { if (!at[key] || typeof at[key] !== 'object') at[key] = {}; at = at[key] }
    const last = path.at(-1)
    if (op === 'unset') delete at[last]; else at[last] = structuredClone(value)
  }
  return out
}

/**
 * The user section the person means after a page write, from the section the page last saw (this Host's user section
 * with the choices on top) and the write itself.
 * @param method - 'update' | 'replace' | 'mutate'; args - the page's arguments.
 */
export function intendedSection(method, args, current = {}) {
  if (method === 'replace') return { ...(args.section ?? {}) }
  if (method === 'update') return { ...current, ...(args.patch ?? {}) }
  return applyOps(current, args.ops)
}

/** A namespace view (settings/describe row or a write's answer) as the page should see it: the choices on top. */
export function overlayView(view, choice) {
  if (!view || !choice || Object.keys(choice).length === 0) return view
  return { ...view, user: { ...(view.user ?? {}), ...choice }, value: { ...(view.value ?? {}), ...choice } }
}

// ---- B: values of one machine

/** Namespaces never copied to WSL: they describe one machine (sandboxes, MCP servers and their commands). */
export const MACHINE_NAMESPACES = new Set(['bash-sandbox', 'pwsh-sandbox', 'mcp-manager'])
/** Fields naming an environment variable of one machine, at any depth (apiKeyEnv, searchApiKeyEnv…). */
const MACHINE_FIELD = /apikeyenv$/i

/**
 * Desktop's value with the WSL Host's own value kept for every machine field the WSL Host already has (a field it
 * does not have yet takes Desktop's value as a start).
 */
export function keepMachineFields(desktop, wsl) {
  if (Array.isArray(desktop) || !desktop || typeof desktop !== 'object') return desktop
  const out = {}
  for (const [key, value] of Object.entries(desktop)) {
    const theirs = wsl && typeof wsl === 'object' && !Array.isArray(wsl) ? wsl[key] : undefined
    out[key] = MACHINE_FIELD.test(key) && theirs !== undefined ? theirs : keepMachineFields(value, theirs)
  }
  return out
}

/**
 * The user section the WSL Host should hold for one namespace both Hosts have: Desktop's (with the choices on top),
 * reference fields resolved against the WSL Host's list, machine fields kept as the WSL Host has them.
 */
export function wslSection(ns, desktopUser = {}, wslUser = {}, choice = {}, wslRoster = {}) {
  const intended = REFERENCE_NAMESPACES.has(ns) ? { ...desktopUser, ...choice } : desktopUser
  const resolved = REFERENCE_NAMESPACES.has(ns) ? resolveSection(ns, intended, wslRoster) : intended
  return keepMachineFields(resolved, wslUser)
}

// ---- the person's choices, and what each Host has

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The choices (per namespace: the reference fields the person chose, and what this Host was last given for them) and
 * a short-lived cache of both Hosts' lists.
 * @param load - () => saved state or undefined; save - (state) => void.
 * @param call - { windows(endpoint, args, cookie), wsl(endpoint, args) } → the call's value, or throws.
 */
export function createChoices({ load = () => undefined, save = () => {}, call, cacheMs = 2000, now = Date.now }) {
  let state = load() ?? {}
  let cookie
  const cache = { windows: undefined, wsl: undefined }
  return {
    /** The page's cookie, so this Host's lists can be read outside a page request (the periodic sync). */
    noteCookie(value) { if (value) cookie = value },
    /** The reference fields the person chose for a namespace ({} when none). */
    choice: (ns) => state[ns]?.choice ?? {},
    /**
     * Take this Host's user section as it is now. A value set elsewhere (a settings file, an older version of this
     * plugin) differs from what was last given to this Host, and becomes the choice.
     */
    reconcile(ns, windowsUser) {
      const now = referencePart(ns, windowsUser)
      if (!state[ns] || !same(state[ns].windows, now)) { state = { ...state, [ns]: { choice: now, windows: now } }; save(state) }
      return state[ns].choice
    },
    /** After a write: the person's intended section, and the section this Host was given. */
    record(ns, intended, given) {
      state = { ...state, [ns]: { choice: referencePart(ns, intended), windows: referencePart(ns, given) } }
      save(state)
    },
    /** One Host's lists (rosterOf); unknown lists when that Host cannot be asked. */
    async roster(side, pageCookie) {
      const hit = cache[side]
      if (hit && now() - hit.at < cacheMs) return hit.roster
      if (side === 'windows' && !(pageCookie ?? cookie)) return rosterOf({})
      const answers = {}
      await Promise.all(Object.entries(ROSTER_CALLS).map(async ([key, [endpoint, args]]) => {
        try { answers[key] = side === 'windows' ? await call.windows(endpoint, args, pageCookie ?? cookie) : await call.wsl(endpoint, args) } catch {}
      }))
      const roster = rosterOf(answers)
      cache[side] = { at: now(), roster }
      return roster
    },
    forget() { cache.windows = undefined; cache.wsl = undefined },
  }
}
