// WSL side of the UI mirror experiment. Serves GET /wsl-bridge/events: a server-sent event stream that sends
// { graph, origin } on connect and after every graph change. `graph` is this Host's client module graph as is;
// `origin[id]` is 'builtin' when the row's bundle ships inside the DSH installation, 'user' otherwise.
import { realpathSync } from 'node:fs'
import { dirname, sep } from 'node:path'
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

export function snapshot(cm, root, ws, connection) {
  const graph = cm.graph()
  const origin = {}
  for (const row of graph.entries) {
    const path = cm.clientPath(row.id)
    origin[row.id] = path !== undefined && real(path).startsWith(root + sep) ? 'builtin' : 'user'
  }
  return { graph, origin, routes: ws ? routeTable(ws, connection) : undefined, distro: process.env.WSL_DISTRO_NAME }
}

export function apply(ctx) {
  const cm = ctx.clientModules
  const root = builtinRoot(cm.clientPath(MODULES_ID))
  const clients = new Set()
  const connection = () => { try { return ctx.get('connection') } catch { return undefined } }
  const frame = () => `data: ${JSON.stringify(snapshot(cm, root, ctx.webServer, connection()))}\n\n`
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
