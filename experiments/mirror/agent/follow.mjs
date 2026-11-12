// Reuse mode: Desktop's WSL profile (desktop-wsl) follows the person's own profile (`web` unless chosen otherwise) for
// plugins, as it shares their DSH and its data (docs/deployment.md). Run by the daemon before DSH starts, and by the
// agent when the WSL tab changes a plugin.
//
//   plugins     the source's dependencies and enabled bundles are carried into desktop-wsl; ones that came from the
//               source leave when they leave it. Plugins installed in desktop-wsl alone stay as they are.
//   on / off    as in the source.
//   config      the cordis.patch.yml items of the followed plugins (for an entry one of them inserts, or naming one of
//               their modules) are merged three ways against what both sides had at the last sync: the side that changed an
//               item wins, the source when both did. A setting changed in Desktop reaches the person's own DSH.
// Official settings (model, theme, language: items for official entries) are not followed: Desktop's
// settings sync owns them in desktop-wsl, and they are never written to the person's own profile.
// What was followed is kept in ~/.dsh-wsl/follow/<profile>.json.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AGENT = 'dsh-wsl-agent'
// The bundles every web-template profile starts with; never followed, never removed.
export const BASE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
export const STATE_DIR = join(homedir(), '.dsh-wsl', 'follow')

const bundlesOf = (pkg) => (Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** The package a module name belongs to: `dsh-x/part` → dsh-x, `@scope/name/part` → @scope/name. */
export const packageOf = (name) => (typeof name !== 'string' ? undefined : name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0])

/**
 * desktop-wsl's plugin manifest after following the source. `state` is what the last sync followed ({ deps, bundles }).
 * @returns { add: [[name, spec]], remove: [name], bundles: [...], state }
 */
export function planManifest(source, target, state = {}) {
  const sourceDeps = Object.fromEntries(Object.entries(source.dependencies ?? {}).filter(([name]) => name !== AGENT))
  const sourceBundles = bundlesOf(source).filter((n) => n !== AGENT && !BASE.has(n))
  const targetDeps = target.dependencies ?? {}
  const add = Object.entries(sourceDeps).filter(([name, spec]) => targetDeps[name] !== spec)
  const remove = (state.deps ?? []).filter((name) => !(name in sourceDeps) && name in targetDeps && name !== AGENT)
  // Bundles the source decides: whatever it has or had; the rest of desktop-wsl's list (base, agent, its own extras)
  // stays in place.
  const decided = new Set([...(state.bundles ?? []), ...sourceBundles, ...Object.keys(sourceDeps)])
  const kept = bundlesOf(target).filter((n) => !decided.has(n) || BASE.has(n) || n === AGENT)
  const bundles = [...new Set([...kept, ...sourceBundles])]
  return { add, remove, bundles, state: { deps: Object.keys(sourceDeps), bundles: sourceBundles } }
}

/** Entry ids a bundle inserts (its cordis.patch.yml `insert:` lists, at any depth): its own entries. */
export function insertedIds(items) {
  const ids = new Set()
  // An inserted entry may insert entries of its own.
  const entries = (list) => { for (const entry of Array.isArray(list) ? list : []) { if (typeof entry?.id === 'string') ids.add(entry.id); entries(entry?.insert) } }
  for (const item of Array.isArray(items) ? items : []) if (item && typeof item === 'object') entries(item.insert)
  return ids
}

/**
 * Three-way merge of the followed plugins' config items. `source` and `target` are the two patch lists, `base` the
 * followed items as of the last sync ({ id: item }); an item is followed when `owned(item)`.
 * @returns { source, target, base, changed: { source: bool, target: bool } } with the lists in their original order
 *   (new items appended).
 */
export function mergePatches(source, target, base, owned) {
  const index = (list) => new Map(list.filter((i) => i && typeof i.id === 'string' && owned(i)).map((i) => [i.id, i]))
  const s = index(source); const t = index(target)
  const ids = new Set([...s.keys(), ...t.keys(), ...Object.keys(base ?? {})])
  const result = {}
  for (const id of ids) {
    const sv = s.get(id); const tv = t.get(id); const bv = base?.[id]
    // Unchanged on one side: the other side's version. Both changed: the source's.
    const pick = same(sv, tv) ? sv : same(tv, bv) ? sv : same(sv, bv) ? tv : sv
    if (pick !== undefined) result[id] = pick
  }
  const apply = (list, side) => {
    let changed = false
    const out = []
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !side.has(item.id)) { out.push(item); continue }
      const want = result[item.id]
      if (want === undefined) { changed = true; continue }
      if (!same(want, item)) changed = true
      out.push(want)
    }
    for (const [id, item] of Object.entries(result)) if (!side.has(id) && !list.some((i) => i?.id === id)) { out.push(item); changed = true }
    return { list: out, changed }
  }
  const ns = apply(source, s); const nt = apply(target, t)
  return { source: ns.list, target: nt.list, base: result, changed: { source: ns.changed, target: nt.changed } }
}

/** js-yaml with DSH's `!!js` expressions kept as they are (read and written back unchanged). */
export function yamlFor(dshEntry) {
  // From DSH's real folder: under pnpm only a package's own folder sees its dependencies.
  const yaml = createRequire(realpathSync(dshEntry))('js-yaml')
  class Js { constructor(source) { this.source = source } toJSON() { return { $js: this.source } } }
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => new Js(data), instanceOf: Js, represent: (v) => v.source })
  const schema = yaml.DEFAULT_SCHEMA.extend([js])
  return {
    load: (text) => yaml.load(text, { schema }) ?? [],
    dump: (value) => yaml.dump(value, { schema, lineWidth: -1, noRefs: true }),
  }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
const writeAtomic = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file) }
const PATCH_HEADER = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n'

/**
 * Bring `to` (desktop-wsl) in line with `from` (the person's profile). `run(argv)` runs `dsh <argv>` and returns
 * { status, stderr }; `log(message)`. Does nothing when the source profile does not exist.
 */
export function syncFollow({ home, from, to, dshEntry, run, log, stateDir = STATE_DIR, yaml: yamlLib }) {
  const sourceDir = join(home, 'profiles', from)
  const targetDir = join(home, 'profiles', to)
  const source = readJson(join(sourceDir, 'package.json'))
  if (!source) { log(`follow: no profile ${from} in ${home}; nothing to follow`); return { followed: false } }
  const stateFile = join(stateDir, `${to}.json`)
  const state = readJson(stateFile) ?? {}
  if (state.from !== undefined && state.from !== from) { state.deps = []; state.bundles = []; state.patch = {} }

  // 1. Plugins and their on/off.
  let target = readJson(join(targetDir, 'package.json')) ?? {}
  const plan = planManifest(source, target, state)
  if (plan.add.length) {
    const r = run(['plugin', '--profile', to, 'add', '--prefer-offline', ...plan.add.map(([name, spec]) => installArg(name, spec))])
    log(`follow: add ${plan.add.map(([n]) => n).join(', ')}: exit ${r.status}${r.status === 0 ? '' : ` ${r.stderr.trim().slice(-300)}`}`)
  }
  if (plan.remove.length) {
    const r = run(['plugin', '--profile', to, 'remove', ...plan.remove])
    log(`follow: remove ${plan.remove.join(', ')}: exit ${r.status}${r.status === 0 ? '' : ` ${r.stderr.trim().slice(-300)}`}`)
  }
  target = readJson(join(targetDir, 'package.json')) ?? target
  // A bundle whose package did not install is left off rather than failing the Host's start.
  const installed = (name) => BASE.has(name) || name === AGENT || name.startsWith('@deepseek-ai/') || existsSync(join(targetDir, 'node_modules', ...name.split('/'), 'package.json'))
  const bundles = plan.bundles.filter(installed)
  if (!same(bundlesOf(target), bundles)) {
    target.dsh = { ...target.dsh, profile: { ...target.dsh?.profile, bundles } }
    writeAtomic(join(targetDir, 'package.json'), `${JSON.stringify(target, null, 2)}\n`)
    log(`follow: bundles ${bundles.filter((n) => !BASE.has(n)).join(', ')}`)
  }

  // 2. The followed plugins' config.
  let patch = state.patch ?? {}
  try {
    const yaml = yamlLib ?? yamlFor(dshEntry)
    const followed = new Set(Object.keys(source.dependencies ?? {}).filter((n) => n !== AGENT))
    const owned = new Set()
    for (const name of followed) {
      const file = join(targetDir, 'node_modules', ...name.split('/'), 'cordis.patch.yml')
      try { for (const id of insertedIds(yaml.load(readFileSync(file, 'utf8')))) owned.add(id) } catch {}
    }
    // An entry a followed plugin inserts is its config even when it runs an official module (a preset, say).
    const isFollowed = (item) => owned.has(item.id) || (typeof item.name === 'string' && followed.has(packageOf(item.name)))
    const text = (dir) => { try { return readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') } catch { return '' } }
    // The comment lines a file starts with are kept when it is written (the items' own comments are not).
    const header = (t) => { const lines = t.split('\n'); const n = lines.findIndex((l) => !/^\s*(#|$)/.test(l)); const head = (n < 0 ? lines : lines.slice(0, n)).join('\n').trim(); return head ? `${head}\n` : PATCH_HEADER }
    const sourceText = text(sourceDir); const targetText = text(targetDir)
    const merged = mergePatches(yaml.load(sourceText), yaml.load(targetText), patch, isFollowed)
    // Back to plain values for comparing next time (Js objects compare by their JSON form).
    patch = JSON.parse(JSON.stringify(merged.base))
    if (merged.changed.target) { writeAtomic(join(targetDir, 'cordis.patch.yml'), header(targetText) + yaml.dump(merged.target)); log('follow: config copied to desktop-wsl') }
    if (merged.changed.source) { writeAtomic(join(sourceDir, 'cordis.patch.yml'), header(sourceText) + yaml.dump(merged.source)); log(`follow: config changed in Desktop written to ${from}`) }
  } catch (error) { log(`follow: config not followed: ${error.message}`) }

  writeAtomic(stateFile, `${JSON.stringify({ from, deps: plan.state.deps, bundles: plan.state.bundles, patch }, null, 2)}\n`)
  return { followed: true, names: [...new Set([...plan.state.deps, ...plan.state.bundles])] }
}

/** The `pnpm add` argument for a dependency as a manifest records it. */
export const installArg = (name, spec) => (typeof spec !== 'string' || spec === '' ? name
  : /^(link:|file:|git[+:]|github:|https?:|\/|\.)/.test(spec) ? spec : `${name}@${spec}`)

/** What the source profile follows today (for the WSL tab): its plugin names, or undefined without a sync yet. */
export function followState(to, stateDir = STATE_DIR) {
  const state = readJson(join(stateDir, `${to}.json`))
  return state && { from: state.from, names: [...new Set([...(state.deps ?? []), ...(state.bundles ?? [])])] }
}

/**
 * A change the WSL tab makes, applied to the source profile as well (the tab applies it to desktop-wsl itself):
 * install (spec, name), remove (name), enable / disable (name). The person's own DSH sees it when it next starts.
 */
export function changeSource({ home, from, action, name, spec, run }) {
  const dir = join(home, 'profiles', from)
  const file = join(dir, 'package.json')
  const pkg = readJson(file)
  if (!pkg) return { skipped: `no profile ${from}` }
  const official = typeof name === 'string' && name.startsWith('@deepseek-ai/')
  const has = typeof name === 'string' && (official || name in (pkg.dependencies ?? {}))
  if (action === 'install') {
    const r = run(['plugin', '--profile', from, 'add', spec])
    if (r.status !== 0) return { error: r.stderr.trim().slice(-300) || `exit ${r.status}` }
  } else if (action === 'remove') {
    if (!(name in (pkg.dependencies ?? {}))) return { skipped: 'not in the source' }
    const r = run(['plugin', '--profile', from, 'remove', name])
    if (r.status !== 0) return { error: r.stderr.trim().slice(-300) || `exit ${r.status}` }
  } else if (action !== 'enable' && action !== 'disable') return { error: `unknown action ${action}` }
  else if (!has) return { skipped: 'not in the source' }
  // The bundle list: on after install / enable, off after remove / disable.
  const now = readJson(file) ?? pkg
  const list = bundlesOf(now).filter((n) => n !== name)
  if (action === 'install' || action === 'enable') list.push(name)
  if (!same(list, bundlesOf(now))) {
    now.dsh = { ...now.dsh, profile: { ...now.dsh?.profile, bundles: list } }
    writeAtomic(file, `${JSON.stringify(now, null, 2)}\n`)
  }
  return { ok: true }
}

/** `dsh <argv>` with this Host's node, for the agent (the daemon has its own). */
export function runDsh(dshEntry, env) {
  return (argv) => {
    const r = spawnSync(process.execPath, [dshEntry, ...argv], { env, encoding: 'utf8', timeout: 300_000 })
    return { status: r.status, stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` }
  }
}

/** Record a change the WSL tab made in both profiles, so the tab shows it as followed before the next sync. */
export function noteFollowed(to, { action, name }, stateDir = STATE_DIR) {
  const file = join(stateDir, `${to}.json`)
  const state = readJson(file)
  if (!state || typeof name !== 'string') return
  const without = (list) => (list ?? []).filter((n) => n !== name)
  if (action === 'install') { state.deps = [...without(state.deps), name]; state.bundles = [...without(state.bundles), name] }
  else if (action === 'remove') { state.deps = without(state.deps); state.bundles = without(state.bundles) }
  else if (action === 'enable') state.bundles = [...without(state.bundles), name]
  else if (action === 'disable') state.bundles = without(state.bundles)
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}
