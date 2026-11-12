// Host-wide lists: things each Host keeps for itself (scheduled tasks, presets, providers, models…), which the page
// asks for with calls that name no Session and so would only ever reach this Host. Here the page gets both Hosts'
// entries, the WSL Host's marked as such; WSL ids carry the `wsl:` prefix (ids.mjs), so a later call about one entry
// goes back to the Host it came from. Kept free of DSH imports so it can be unit-tested.
// See docs/cross-host-rules.md (C) for why.

// ---- scheduled tasks (dsh-schedule)

/** schedule/catalog: every task of both Hosts. `theirs` is already translated (WSL ids prefixed). */
export const mergeScheduleCatalog = (mine, theirs) => [...(mine ?? []), ...(theirs ?? [])]

/**
 * schedule/list is a page of a sorted list (active tasks first). Each Host is asked for the first offset+limit rows;
 * the merged page keeps that order (active first, each Host's own order within) and cuts the requested window.
 * @param request - the page's { active?, limit?, offset? }.
 * @returns the request to send each Host, and `combine(mine, theirs)` for the two answers.
 */
export function mergeScheduleList(request = {}) {
  const limit = request.limit ?? 100
  const offset = request.offset ?? 0
  const ask = { ...request, offset: 0, limit: Math.min(500, offset + limit) }
  const combine = (mine, theirs) => {
    const rows = [...(mine?.items ?? []), ...(theirs?.items ?? [])]
    const active = (row) => (row.status === 'active' ? 0 : 1)
    const ordered = rows.map((row, i) => [row, i]).sort((a, b) => active(a[0]) - active(b[0]) || a[1] - b[1]).map(([row]) => row)
    const items = ordered.slice(offset, offset + limit)
    return { items, shown: items.length, total: (mine?.total ?? 0) + (theirs?.total ?? 0), limit, offset }
  }
  return { ask, combine }
}

/** schedule/deleteInactive on both Hosts: the rows removed on either. */
export const mergeDeleteInactive = (mine, theirs) => ({ deleted: (mine?.deleted ?? 0) + (theirs?.deleted ?? 0) })

/**
 * Where schedule/create goes. A task delivered to an existing Session is placed by that Session's id (routeOf).
 * A task that creates its Session (`new`, `new_once`, or no target) runs where that Session would: in WSL for a
 * folder that lives there or a folder whose run location is WSL, else here.
 * @param request - the page's ScheduleCreateRequest.
 * @param where - (cwd) => 'wsl' | 'local' for the folder the new Session would use; undefined cwd means the Host's
 *   default folder, which is this Host's.
 * @returns 'by-id' (leave it to routeOf), or { host, cwdForWsl? }.
 */
export function placeSchedule(request, where) {
  const target = request?.target
  if (target?.kind === 'session') return 'by-id'
  const cwd = target?.create?.cwd
  if (typeof cwd !== 'string' || cwd === '') return { host: 'local' }
  return { host: where(cwd) }
}

/** Rewrite the folder of every task target that creates its Session (`create.cwd`), e.g. WSL path ↔ this Host's form. */
export function mapScheduleCwds(value, map) {
  if (Array.isArray(value)) return value.map((item) => mapScheduleCwds(item, map))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = mapScheduleCwds(item, map)
  if ((out.kind === 'new' || out.kind === 'new_once') && typeof out.create?.cwd === 'string' && out.create.cwd !== '') out.create = { ...out.create, cwd: map(out.create.cwd) }
  return out
}

// ---- lists a setting picks from (docs/cross-host-rules.md, A): presets, permission presets, search providers, models.
// WSL-only entries are added and marked; the default shown is the person's choice (refs.mjs), and when only one Host
// has it, that entry says what the other Host's tasks use instead. Texts come from the caller (language.mjs).

// The page shows a description as one paragraph (line breaks collapse to a space), so the note follows as a sentence.
const CJK_END = /[\u3000-\u9fff\uff00-\uffef]$/
function withNote(description, note) {
  const text = description?.trimEnd()
  if (!text) return note
  const cjk = CJK_END.test(text)
  const stop = /[。．.!！?？]$/.test(text) ? '' : cjk ? '。' : '.'
  return `${text}${stop}${cjk ? '' : ' '}${note}`
}

/**
 * agentPresets/list. `choice` is the default the person chose (may be undefined); `text` gives
 * { label(name) → marked name, name(row) → display name, windowsUses(name), wslUses(name) }.
 */
export function mergePresets(mine, theirs = [], { choice, text } = {}) {
  const label = text?.label ?? ((name) => `${name} · WSL`)
  const name = text?.name ?? ((row) => row.name ?? row.id)
  const have = new Set(mine.map((p) => p.id))
  const wslOnly = theirs.filter((p) => !have.has(p.id))
  const rows = [...mine.map((p) => ({ ...p })), ...wslOnly.map((p) => ({ ...p, name: label(name(p)) }))]
  const def = rows.some((r) => r.id === choice) ? choice : mine.find((p) => p.isDefault)?.id
  for (const row of rows) row.isDefault = row.id === def
  const row = rows.find((r) => r.id === def)
  if (row && text && wslOnly.some((p) => p.id === def)) {
    const windowsDefault = mine.find((p) => p.isDefault) ?? mine.find((p) => p.id === 'standard')
    if (windowsDefault) row.description = withNote(row.description, text.windowsUses(name(windowsDefault)))
  } else if (row && text && theirs.length && !theirs.some((p) => p.id === def)) {
    const wslDefault = theirs.find((p) => p.isDefault) ?? theirs.find((p) => p.id === 'standard')
    if (wslDefault) row.description = withNote(row.description, text.wslUses(name(wslDefault)))
  }
  return rows
}

/** permissionPresets/catalog: { options: [{ value, name }], defaultOptions, defaultPreset }. */
export function mergePermissionCatalog(mine, theirs, { choice, label = (name) => `${name} · WSL` } = {}) {
  if (!theirs) return choice && mine.options?.some((o) => o.value === choice) ? { ...mine, defaultPreset: choice } : mine
  const have = new Set((mine.options ?? []).map((o) => o.value))
  const options = [...(mine.options ?? []), ...(theirs.options ?? []).filter((o) => !have.has(o.value)).map((o) => ({ ...o, name: label(o.name ?? o.value) }))]
  return { ...mine, options, defaultPreset: choice && options.some((o) => o.value === choice) ? choice : mine.defaultPreset }
}

/**
 * web/listProviders: { search: [{ id, description? }], fetch: [...] }. `describe(kind, entry)` gives a WSL-only
 * entry's description (a { lang: text } map like the official ones).
 */
export function mergeWebProviders(mine, theirs, { describe = () => undefined } = {}) {
  if (!theirs) return mine
  const out = { ...mine }
  for (const kind of ['search', 'fetch']) {
    const have = new Set((mine[kind] ?? []).map((e) => e.id))
    const extra = (theirs[kind] ?? []).filter((e) => !have.has(e.id)).map((e) => ({ ...e, description: describe(kind, e) ?? e.description }))
    if (mine[kind] || extra.length) out[kind] = [...(mine[kind] ?? []), ...extra]
  }
  return out
}

/** session/modelCatalog: { default: { provider, model }, routableProviders, groups: [{ id, name, models: [{ id, name }] }] }. */
export function mergeModelCatalog(mine, theirs, { choice, label = (name) => `${name} · WSL` } = {}) {
  const groups = (mine.groups ?? []).map((g) => ({ ...g, models: [...(g.models ?? [])] }))
  for (const g of theirs?.groups ?? []) {
    const here = groups.find((x) => x.id === g.id)
    if (!here) { groups.push({ ...g, name: label(g.name ?? g.id) }); continue }
    const have = new Set(here.models.map((m) => m.id))
    here.models.push(...(g.models ?? []).filter((m) => !have.has(m.id)).map((m) => ({ ...m, name: label(m.name ?? m.id) })))
  }
  const listed = (p) => p && groups.some((g) => g.id === p.provider && g.models.some((m) => m.id === p.model))
  const routable = [...new Set([...(mine.routableProviders ?? []), ...(theirs?.routableProviders ?? [])])]
  return { ...mine, groups, ...(mine.routableProviders || theirs?.routableProviders ? { routableProviders: routable } : {}), default: listed(choice) ? { ...mine.default, ...choice } : mine.default }
}
