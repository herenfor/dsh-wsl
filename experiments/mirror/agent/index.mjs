// WSL side of the UI mirror experiment. Serves GET /wsl-bridge/events: a server-sent event stream that sends
// { graph, origin } on connect and after every graph change. `graph` is this Host's client module graph as is;
// `origin[id]` is 'builtin' when the row's bundle ships inside the DSH installation, 'user' otherwise.
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { BrokerClient, brokerCredentials } from './broker.mjs'

export const name = 'wsl-agent'
export const inject = ['clientModules', 'webServer']
export const EVENTS = '/wsl-bridge/events'
const MODULES_ID = '@deepseek-ai/dsh-client-modules'

const real = (p) => { try { return realpathSync(p) } catch { return p } }

// The node_modules directory the DSH installation keeps its own packages in, found from the client-modules bundle:
// <root>/@deepseek-ai/dsh-client-modules/lib/client.js
export function builtinRoot(modulesClientPath) {
  return dirname(dirname(dirname(dirname(real(modulesClientPath)))))
}

// The WSL Host's HTTP route table (path names only), read from the web server's private maps, and the exact Fetch
// routes plugins register under /api (`ctx.connection.fetch.register`, e.g. DS Bot's /api/bot), with their methods.
export function routeTable(ws, connection) {
  const fetch = [...(connection?.fetchRoutes ?? [])].map(([path, route]) => ({ path, methods: [...(route.methods ?? [])] }))
  return { exact: [...(ws.exact?.keys() ?? [])], prefix: [...(ws.prefixes?.keys() ?? [])], upgrade: [...(ws.upgrades?.keys() ?? [])], fetch }
}

/**
 * Entries that the bundle patches of third-party plugins switch off: top-level patch items `{ id, disabled: true }`
 * (no insert). `patches` is [{ bundle, items }] with each bundle's parsed cordis.patch.yml; `names` maps an entry id to
 * its package name (the client graph row id). Returns [{ id, name, by }] for the ids that have a name.
 */
export function disabledByPatches(patches, names) {
  const out = []
  for (const { bundle, items } of patches) {
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.disabled !== true || 'insert' in item) continue
      const name = names.get(item.id)
      if (typeof name === 'string') out.push({ id: item.id, name, by: bundle })
    }
  }
  return out
}

/**
 * The parsed cordis.patch.yml of each enabled third-party bundle of a profile: [{ bundle, items }]. Enabled bundles are
 * the profile manifest's `dsh.profile.bundles`; official ones (@deepseek-ai/) are skipped.
 */
export function bundlePatches(profileDir, parseYaml) {
  let pkg
  try { pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) } catch { return [] }
  const out = []
  for (const bundle of pkg.dsh?.profile?.bundles ?? []) {
    if (typeof bundle !== 'string' || bundle.startsWith('@deepseek-ai/')) continue
    try {
      const dir = join(profileDir, 'node_modules', bundle)
      const patch = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.bundle?.patch
      if (typeof patch === 'string') out.push({ bundle, items: parseYaml(readFileSync(join(dir, patch), 'utf8')) })
    } catch {}
  }
  return out
}

/** This Host's profile folder: <DSH home>/profiles/<--profile>. */
function profileDir() {
  const i = process.argv.indexOf('--profile')
  const profile = i >= 0 ? process.argv[i + 1] : undefined
  return profile ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile) : undefined
}

export function snapshot(cm, root, ws, connection, disabled) {
  const graph = cm.graph()
  const origin = {}
  for (const row of graph.entries) {
    const path = cm.clientPath(row.id)
    origin[row.id] = path !== undefined && real(path).startsWith(root + sep) ? 'builtin' : 'user'
  }
  return { graph, origin, routes: ws ? routeTable(ws, connection) : undefined, disabled, distro: process.env.WSL_DISTRO_NAME }
}

export function apply(ctx) {
  const cm = ctx.clientModules
  const root = builtinRoot(cm.clientPath(MODULES_ID))
  const clients = new Set()
  const connection = () => { try { return ctx.get('connection') } catch { return undefined } }
  // Official entries that WSL plugins' bundle patches switch off: Desktop drops their client rows from the page too.
  let parseYaml
  try {
    // DSH's own `!!js` expressions (a `disabled:` decided at run time) are kept as opaque values: they are not the literal
    // `disabled: true` looked for here, and leaving the tag unknown printed a YAML warning on every read.
    const { parse } = createRequire(join(root, 'wsl-agent.js'))('yaml')
    const customTags = [{ tag: 'tag:yaml.org,2002:js', resolve: (source) => ({ $js: source }) }]
    parseYaml = (text) => parse(text, { customTags })
  } catch (error) { ctx.logger.warn('wsl-agent: no YAML parser: %s', error.message) }
  const disabled = () => {
    const dir = profileDir()
    if (!dir || !parseYaml) return []
    const names = new Map()
    try { for (const entry of ctx.get('loader').entries()) if (typeof entry.options?.id === 'string' && typeof entry.options?.name === 'string') names.set(entry.options.id, entry.options.name) } catch {}
    return disabledByPatches(bundlePatches(dir, parseYaml), names)
  }
  const frame = () => `data: ${JSON.stringify(snapshot(cm, root, ctx.webServer, connection(), disabled()))}\n\n`
  const push = () => { const f = frame(); for (const res of clients) res.write(f) }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS,
    handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(frame())
      clients.add(res)
      res.on('close', () => clients.delete(res))
    },
  }), 'wsl-agent: events route')
  ctx.effect(() => cm.onGraphChanged(push), 'wsl-agent: graph changes')
  // Routes change when plugins start or stop and the web server announces nothing, so compare every two seconds.
  ctx.effect(() => {
    let last = JSON.stringify(routeTable(ctx.webServer, connection()))
    const timer = setInterval(() => { const now = JSON.stringify(routeTable(ctx.webServer, connection())); if (now !== last) { last = now; push() } }, 2000)
    timer.unref()
    return () => clearInterval(timer)
  }, 'wsl-agent: route changes')
  ctx.effect(() => () => { for (const res of clients) res.destroy(); clients.clear() }, 'wsl-agent: close streams')
  ctx.logger.info('wsl-agent: builtin root %s', root)
  // Started by the bridge daemon (which sets DSH_WSL_RUN): credentials not set in WSL are asked of Desktop.
  const runDir = process.env.DSH_WSL_RUN
  if (runDir) ctx.inject(['credentials'], (c) => brokerCredentials(c.credentials, new BrokerClient(runDir), c.logger))
}
