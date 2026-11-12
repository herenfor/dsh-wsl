// Step 1 of the cross-host scan (docs/cross-host-scan.md): every method the page can call on a Host, read from the
// `typert.remote-client.d.ts` of every @deepseek-ai package in the dsh install, with its parameters (request types
// expanded one level) and how our router treats it today.
//   node dev/scan/inventory.mjs [out.json]      prints a summary; writes the full list as JSON when given a path
// Static only: nothing is called. probe.mjs uses the JSON.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { identities } = await import(join(REPO, 'experiments/mirror/mirror/ids.mjs'))

export function dshRoot() {
  const bin = process.env.DSH_WSL_DEV_DSH ?? (() => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) if (existsSync(join(dir, 'dsh'))) return realpathSync(join(dir, 'dsh'))
    throw new Error('dsh not found on PATH; set DSH_WSL_DEV_DSH to its lib/bin.js')
  })()
  let dir = dirname(bin)
  while (!existsSync(join(dir, 'node_modules', '@deepseek-ai'))) { const up = dirname(dir); if (up === dir) throw new Error(`no node_modules/@deepseek-ai above ${bin}`); dir = up }
  return join(dir, 'node_modules', '@deepseek-ai')
}

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) { if (name !== 'node_modules') walk(p, out) } else if (name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Text between the brace at `open` and its match. */
function block(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return ''
}

/** Top-level fields of an object type body: [{ name, optional, type, doc }]. */
function fields(body) {
  const out = []
  let depth = 0, line = '', doc = ''
  for (const raw of body.split('\n')) {
    const l = raw.trim()
    if (depth === 0) {
      const d = /\/\*\*\s*(.*?)\s*\*\//.exec(l)
      if (d) { doc = d[1]; continue }
      if (l.startsWith('/**') || l.startsWith('*')) { doc += l.replace(/^\/?\*+\/?\s?/, '') + ' '; continue }
    }
    line += (line ? ' ' : '') + l
    for (const c of l) { if (c === '{' || c === '(' || c === '<' || c === '[') depth++; else if (c === '}' || c === ')' || c === '>' || c === ']') depth-- }
    if (depth > 0) continue
    const m = /^(?:readonly\s+)?['"]?([\w$]+)['"]?(\?)?\s*:\s*(.+?);?$/.exec(line)
    if (m) out.push({ name: m[1], optional: !!m[2], type: m[3].trim(), doc: doc.trim() || undefined })
    line = ''; doc = ''; depth = 0
  }
  return out
}

/** name → { fields, extends } for every exported interface and object type alias in the given files. */
function typeIndex(files) {
  const index = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const re = /export (?:declare )?(?:interface\s+([\w$]+)(?:<[^>{]*>)?(?:\s+extends\s+([^{]+))?\s*\{|type\s+([\w$]+)(?:<[^>=]*>)?\s*=\s*\{)/g
    let m
    while ((m = re.exec(text))) {
      const name = m[1] ?? m[3]
      const open = re.lastIndex - 1
      if (!index.has(name)) index.set(name, { fields: fields(block(text, open)), extends: (m[2] ?? '').split(',').map((s) => s.trim().replace(/<.*$/, '')).filter(Boolean) })
    }
  }
  return index
}

function expand(index, type, seen = new Set()) {
  const name = type.replace(/^readonly\s+/, '').replace(/\s*\|\s*undefined$/, '').trim()
  const t = index.get(name)
  if (!t || seen.has(name)) return undefined
  seen.add(name)
  const inherited = t.extends.flatMap((p) => expand(index, p, seen) ?? [])
  return [...inherited, ...t.fields]
}

// Our router, restated from experiments/mirror/mirror/routing.mjs and index.mjs (keep in step with them).
const LOCAL_ONLY = /^(?:settings|credentials|plugins|pluginManager|pluginInventory|pluginMarket|pluginRegistryProbe|pluginRecommendations|cordis|account|remoteAccess|productAnalytics|llm|directoryPicker)\//
const SPECIAL = {
  'session/list': 'merged: both Hosts, WSL rows prefixed',
  'session/search': 'merged: both Hosts, WSL rows prefixed',
  'workspace/follow': 'merged stream',
  'session/control': 'merged stream',
  'settings/describe': 'merged: WSL-only namespaces appended',
  'settings/update': 'WSL-only namespace → WSL; else Windows, then copied to WSL',
  'settings/replace': 'WSL-only namespace → WSL; else Windows, then copied to WSL',
  'settings/mutate': 'WSL-only namespace → WSL; else Windows, then copied to WSL',
  'workspace/delete': 'Windows, and the WSL twin too',
  'session/openWorkspacePath': 'WSL path rewritten to a Windows path, stays on Windows',
  'session/workspacePathApplications': 'WSL path rewritten to a Windows path, stays on Windows',
  'dynamicCordisRunner/syncInspectManifest': 'sent to both',
  'dynamicCordisRunner/inventory': 'merged: both Hosts',
  'dynamicCordisRunner/resolveRequestRun': 'by remembered request id',
  'dynamicCordisRunner/invoke': 'by remembered run id',
  'workspace/create': 'WSL path → WSL; else Windows',
  'agentPresets/list': 'merged: WSL-only presets appended, isDefault false, name + " · WSL"',
  'agentPresets/read': 'Windows, then WSL on not-found',
  'agentPresets/select': 'by agentId; WSL-only preset refused for a Windows task',
  'session/create': 'by run location (folder in WSL / run target / twin); WSL-only preset refused for a Windows task',
  'workspace/insertSessionBefore': 'WSL session in a Windows folder → the twin on WSL',
  'pluginManager/listBundles': 'Windows (the WSL tab uses /wsl-bridge/plugins)',
}
// Fields that name something a Host has its own list of (category 1 and 4 of the scan).
const REFERENCE = /preset|model|provider|skill|command|subagent|mcp|permission|plugin|schedule|bundle|profile|theme|language|locale|sandbox|shell|tool/i

export function inventory(root = dshRoot()) {
  const packages = readdirSync(root).filter((p) => existsSync(join(root, p, 'lib', 'typert.remote-client.d.ts')))
  const index = typeIndex(readdirSync(root).flatMap((p) => existsSync(join(root, p, 'lib')) ? walk(join(root, p, 'lib')) : []))
  const methods = []
  for (const pkg of packages) {
    const text = readFileSync(join(root, pkg, 'lib', 'typert.remote-client.d.ts'), 'utf8')
    const scoped = new Set([...text.matchAll(/'agent:([\w$]+\/[\w$]+)'/g)].map((m) => m[1]))
    for (const m of text.matchAll(/readonly '([\w$]+\/[\w$]+)': TypertRemoteMethod<\{(.*?)\}, (.+?)>\s*$/gm)) {
      const [, endpoint, paramText, rest] = m
      const params = fields(paramText.replace(/;\s*readonly/g, ';\nreadonly').split(';').join(';\n'))
      const kind = /,\s*'stream'/.test(rest) ? 'stream' : 'unary'
      const returns = rest.split(/,\s*'(?:stream|unary)'/)[0].trim()
      const deepen = (list, depth) => { for (const p of list) { const sub = depth < 3 && expand(index, p.type); if (sub) p.fields = deepen(sub.map((f) => ({ ...f })), depth + 1) } return list }
      deepen(params, 0)
      // A synthetic call naming every field, to see which ones our router reads as identities.
      const sampleOf = (list) => Object.fromEntries(list.map((p) => [p.name, p.fields ? sampleOf(p.fields) : 'x']))
      const ids = [...new Set(identities(sampleOf(params)).map((i) => i.key))]
      const flat = (list, at = '') => list.flatMap((p) => [{ ...p, name: at + p.name }, ...flat(p.fields ?? [], `${at}${p.name}.`)])
      const refs = flat(params).filter((f) => REFERENCE.test(f.name.split('.').pop()) && !ids.includes(f.name.split('.').pop())).map((f) => f.name)
      const route = SPECIAL[endpoint] ?? (LOCAL_ONLY.test(endpoint) ? 'Windows only (namespace kept local)' : ids.length ? `by id (${ids.join(', ')})` : 'Windows only (no id in the call)')
      const readOnly = kind === 'unary' && /\/(?:list\w*|read\w*|describe|catalog|status|state|get\w*|enabled|generation|limits|registries|capabilities|relay|identity|inventory|modelCatalog|canOpenWorkspacePath|deliveryLimits|systemStatus|applications|applicationIcons|ptcConfiguration|history|view|environment|shells|branches|candidates|stat|search|hasRunningAccountTasks|fastest)$/.test(endpoint)
      methods.push({ endpoint, namespace: endpoint.split('/')[0], package: pkg, kind, agentScoped: scoped.has(endpoint), params, returns, identities: ids, references: refs, route, readOnly })
    }
  }
  return { root, packages, methods }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inv = inventory()
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(inv, null, 2))
  const by = (f) => inv.methods.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map())
  console.log(`${inv.methods.length} methods in ${inv.packages.length} packages (${inv.root})`)
  for (const [route, n] of [...by((x) => x.route.replace(/ \(.*\)$/, '').replace(/:.*/, '')).entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${route}`)
  console.log('\nNo id in the call, so it only ever reaches the Windows Host:')
  for (const x of inv.methods.filter((x) => x.route.startsWith('Windows only (no id'))) console.log(`  ${x.kind === 'stream' ? '~' : x.readOnly ? 'r' : 'w'} ${x.endpoint}${x.params.length ? ` (${x.params.map((p) => p.name).join(', ')})` : ''}`)
  console.log('\nFields that name a per-Host thing:')
  for (const x of inv.methods.filter((x) => x.references.length)) console.log(`  ${x.endpoint}: ${x.references.join(', ')}  [${x.route}]`)
}
