// WSL side of the UI mirror experiment. Serves GET /wsl-bridge/events: a server-sent event stream that sends
// { graph, origin } on connect and after every graph change. `graph` is this Host's client module graph as is;
// `origin[id]` is 'builtin' when the row's bundle ships inside the DSH installation, 'user' otherwise.
import { realpathSync } from 'node:fs'
import { dirname, sep } from 'node:path'

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

// The WSL Host's HTTP route table (path names only), read from the web server's private maps.
export function routeTable(ws) {
  return { exact: [...(ws.exact?.keys() ?? [])], prefix: [...(ws.prefixes?.keys() ?? [])], upgrade: [...(ws.upgrades?.keys() ?? [])] }
}

export function snapshot(cm, root, ws) {
  const graph = cm.graph()
  const origin = {}
  for (const row of graph.entries) {
    const path = cm.clientPath(row.id)
    origin[row.id] = path !== undefined && real(path).startsWith(root + sep) ? 'builtin' : 'user'
  }
  return { graph, origin, routes: ws ? routeTable(ws) : undefined, distro: process.env.WSL_DISTRO_NAME }
}

export function apply(ctx) {
  const cm = ctx.clientModules
  const root = builtinRoot(cm.clientPath(MODULES_ID))
  const clients = new Set()
  const frame = () => `data: ${JSON.stringify(snapshot(cm, root, ctx.webServer))}\n\n`
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
    let last = JSON.stringify(routeTable(ctx.webServer))
    const timer = setInterval(() => { const now = JSON.stringify(routeTable(ctx.webServer)); if (now !== last) { last = now; push() } }, 2000)
    timer.unref()
    return () => clearInterval(timer)
  }, 'wsl-agent: route changes')
  ctx.effect(() => () => { for (const res of clients) res.destroy(); clients.clear() }, 'wsl-agent: close streams')
  ctx.logger.info('wsl-agent: builtin root %s', root)
}
