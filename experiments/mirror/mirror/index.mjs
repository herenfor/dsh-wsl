// Desktop side of the UI mirror experiment. Follows the WSL agent's event stream and makes this Host's client module
// registry publish the merged graph, so the page here mounts the WSL Host's user plugins; their bundle, chunk and asset
// requests are forwarded to the WSL Host. It patches two members of the registry instance (`composed` and
// `fetchBundle`) and restores them on dispose. HTTP routes that only the WSL Host serves (those of plugins installed
// only in WSL) are registered here too and forwarded, after this Host's own login and origin check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { startBridge } from './transport/client.mjs'
import { mergeGraphs, requestedPackages, sameRelease } from './merge.mjs'
import { DROP_RESPONSE_HEADERS, FORWARD_REQUEST_HEADERS, routesToForward } from './routes.mjs'
import { mergeDescribe, settingsMethod, SETTINGS_WRITES, sharedNamespaces, syncOps } from './settings.mjs'
import { LIST_METHODS, mergeList, PLUGIN_NAMESPACES, prefixResult, stripPrefix } from './plugins.mjs'
import { toWindowsSpec, toWslSpec } from './paths.mjs'
import { installSessionRouting } from './routing.mjs'

export const name = 'wsl-mirror'
export const inject = ['clientModules', 'webServer', 'connection', 'settings', 'typertGateway']
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const EVENTS = '/wsl-bridge/events'
const FORWARDED_HEADERS = ['content-type', 'cache-control', 'etag', 'content-length']

// How to reach the WSL side: a bridge command speaking the transport protocol (see ../../transport). Taken from the
// entry config, else ~/.dsh-wsl/bridge.json: { "command": "wsl.exe", "args": ["-d", "Ubuntu", "--exec", "<node>",
// "<daemon.mjs>", "--bridge", "--profile", "desktop-wsl"] }. The WSL Host's address and launch token arrive over the
// bridge and stay in memory.
export const BRIDGE_FILE = join(homedir(), '.dsh-wsl', 'bridge.json')
export const STATUS_FILE = join(homedir(), '.dsh-wsl', 'mirror-status.json')
function writeStatus(status) {
  try { mkdirSync(dirname(STATUS_FILE), { recursive: true }); writeFileSync(STATUS_FILE, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...status }, null, 2)}\n`) } catch {}
}
function readBridgeConfig(config) {
  if (config.command) return config
  try { return JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) } catch { return {} }
}

export async function apply(ctx, config = {}) {
  const bridgeConfig = readBridgeConfig(config ?? {})
  if (!bridgeConfig.command) { writeStatus({ reason: 'no bridge configured' }); ctx.logger.warn('wsl-mirror: no bridge; set command and args in config or %s', BRIDGE_FILE); return }
  const bridge = startBridge({ command: bridgeConfig.command, args: bridgeConfig.args ?? [], log: (m) => ctx.logger.info('wsl-mirror: %s', m) })
  ctx.effect(() => () => bridge.close(), 'wsl-mirror: bridge')
  let lastToken
  let cookieValue
  bridge.on('state', (s) => { if (s.dsh.token !== lastToken) { lastToken = s.dsh.token; cookieValue = undefined } })
  const remoteOrigin = () => bridge.state.dsh.origin

  /** fetch-like request to the WSL DSH Host over the bridge. `body` may be a Buffer, a string or a Node stream. */
  function remoteFetch(path, { method = 'GET', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const origin = remoteOrigin()
      if (!origin) return reject(new Error('the WSL DSH Host is not available'))
      const url = new URL(path, origin)
      const req = http.request({ agent: bridge.agent, host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...headers, host: url.host } }, (res) => {
        const out = new Headers()
        for (const [name, value] of Object.entries(res.headers)) for (const v of [].concat(value)) out.append(name, v)
        const empty = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304
        if (empty) res.resume()
        resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: out }))
      })
      req.once('error', reject)
      signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      if (body === undefined || body === null) req.end()
      else if (typeof body.pipe === 'function') body.pipe(req)
      else req.end(body)
    })
  }
  const reg = ctx.clientModules
  const { orderByModuleGraph } = await import(pathToFileURL(join(dirname(reg.clientPath(MODULES_ID)), 'index.js')).href)

  // Routes this mirror registered on the local web server, as `${kind}:${path}` → disposer.
  const ws = ctx.webServer
  const forwarded = new Map()
  function syncRoutes() {
    const sameVersion = remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release)
    const local = {
      exact: [...ws.exact.keys()].filter((path) => !forwarded.has(`exact:${path}`)),
      prefix: [...ws.prefixes.keys()].filter((path) => !forwarded.has(`prefix:${path}`)),
    }
    const want = new Map((sameVersion ? routesToForward(remoteGraph.routes, local) : []).map((r) => [`${r.kind}:${r.path}`, r]))
    for (const [key, dispose] of forwarded) if (!want.has(key)) { dispose(); forwarded.delete(key) }
    for (const [key, route] of want) {
      if (forwarded.has(key)) continue
      try { forwarded.set(key, ws.register({ kind: route.kind, path: route.path, handler: forwardRequest })) } catch (error) { ctx.logger.warn('wsl-mirror: cannot forward %s: %s', key, error.message) }
    }
  }
  ctx.effect(() => () => { for (const dispose of forwarded.values()) dispose(); forwarded.clear() }, 'wsl-mirror: forwarded routes')

  async function forwardRequest(req, res) {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    try {
      const headers = { cookie: await cookie() }
      for (const name of FORWARD_REQUEST_HEADERS) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const upstream = await remoteFetch(req.url, { method: req.method, headers, signal: abort.signal, ...(hasBody ? { body: req } : {}) })
      const out = {}
      for (const [name, value] of upstream.headers) if (!DROP_RESPONSE_HEADERS.has(name)) out[name] = value
      res.writeHead(upstream.status, out)
      if (upstream.body) for await (const chunk of upstream.body) { if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)) }
      res.end()
    } catch (error) {
      if (abort.signal.aborted) return
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`wsl-mirror: the WSL Host did not answer (${error.message})\n`)
    }
  }

  // Settings of plugins installed only in WSL, through the /api request hook client-connection runs after admission.
  const INNER = 'x-dsh-wsl-mirror-inner'
  let remoteNamespaces = new Set()
  const readBody = async (req) => { const parts = []; for await (const c of req) parts.push(c); return Buffer.concat(parts) }
  const forwardApi = async (path, body) => remoteFetch(path, {
    method: 'POST', body,
    headers: { cookie: await cookie(), origin: remoteOrigin(), 'content-type': 'application/json' },
  })
  const callRemoteApi = async (method, body) => remoteFetch(`/api/settings/${method}`, {
    method: 'POST', body,
    headers: { cookie: await cookie(), origin: remoteOrigin(), 'content-type': 'application/json' },
  })
  const answer = async (res, upstream) => {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  }
  // The official Plugins page over both Hosts (see plugins.mjs). Installs started on the WSL Host are remembered by
  // request id, so waiting for or cancelling them goes there too.
  const wslInstalls = new Set()
  // Where the official "Install a third-party plugin" dialog installs: 'wsl' (default) or 'local'. Shown and switched by
  // this package's item in the Add plugin menu; GET/POST /wsl-bridge/install-target {"target": "wsl" | "local"}.
  let installTarget = 'wsl'
  const INSTALL_ENDPOINTS = new Set(['pluginManager/inspect', 'pluginManager/installBundle'])
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/install-target',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      if (req.method === 'POST') {
        try { const t = JSON.parse((await readBody(req)).toString('utf8')).target; if (t === 'wsl' || t === 'local') installTarget = t } catch {}
      }
      const sameVersion = remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ target: installTarget, wslAvailable: sameVersion, distro: remoteGraph?.distro ?? null }))
    },
  }), 'wsl-mirror: install target route')
  // The WSL side of one official bundle, for the switch on its detail page: GET ?name= reads it, POST {name, enabled}
  // switches it. Answers {connected, bundle?, result?}.
  const callWsl = async (method, args) => {
    const r = await forwardApi(`/api/pluginManager/${method}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'mirror', method: `pluginManager/${method}`, payload: { args } })))
    const json = await r.json()
    if (!json?.result?.ok) throw new Error(json?.result?.error?.message ?? `HTTP ${r.status}`)
    return json.result.value
  }
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/bundle',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
      const sameVersion = remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release)
      if (!sameVersion) return reply({ connected: false })
      try {
        let result
        let name = new URL(req.url, 'http://x').searchParams.get('name')
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8'))
          name = body.name
          result = await callWsl('setBundleEnabled', { name, enabled: body.enabled === true })
        }
        const bundle = (await callWsl('listBundles', {})).find((b) => b.name === name)
        reply({ connected: true, bundle: bundle && { name: bundle.name, enabled: bundle.enabled, installed: bundle.installed, availability: bundle.availability }, result })
      } catch (error) { reply({ connected: true, error: error.message }) }
    },
  }), 'wsl-mirror: bundle route')
  const withSpec = (payload, convert) => {
    const args = payload?.args
    return typeof args?.spec === 'string' ? { ...payload, args: { ...args, spec: convert(args.spec) } } : payload
  }
  const ownHost = (req, body) => fetch(`${ws.getOrigin()}${new URL(req.url, 'http://x').pathname}`, {
    method: 'POST', body,
    headers: { cookie: req.headers.cookie ?? '', origin: ws.getOrigin(), 'content-type': 'application/json', [INNER]: '1' },
  }).then((r) => r.json())
  async function pluginCall(req, res, next, pathname, endpoint) {
    const body = await readBody(req)
    const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (LIST_METHODS.has(endpoint)) {
      const [mine, theirs] = await Promise.all([ownHost(req, body), forwardApi(pathname, body).then((r) => r.json()).catch(() => undefined)])
      if (mine?.result?.ok) mine.result.value = mergeList(endpoint, mine.result.value, theirs?.result?.ok ? theirs.result.value : undefined)
      return json(mine)
    }
    let message
    try { message = JSON.parse(body.toString('utf8')) } catch {}
    const stripped = stripPrefix(message?.payload)
    const requestId = message?.payload?.args?.requestId ?? message?.payload?.args?.options?.requestId
    const install = INSTALL_ENDPOINTS.has(endpoint)
    const toWsl = stripped.wsl || (requestId !== undefined && wslInstalls.has(requestId)) || (install && installTarget === 'wsl')
    if (!toWsl) {
      // Installing here: a WSL path typed into the dialog becomes the Windows path of the same directory.
      const local = install && process.platform === 'win32' ? withSpec(message.payload, (spec) => toWindowsSpec(spec, remoteGraph?.distro)) : undefined
      const replay = local && local !== message.payload ? Buffer.from(JSON.stringify({ ...message, payload: local })) : body
      req[Symbol.asyncIterator] = async function* () { yield replay }
      if (replay !== body) req.headers['content-length'] = String(replay.length)
      return next()
    }
    if (install) stripped.value = withSpec(stripped.value, toWslSpec)
    if (endpoint === 'pluginManager/installBundle' && requestId !== undefined) wslInstalls.add(requestId)
    const answerJson = await forwardApi(pathname, Buffer.from(JSON.stringify({ ...message, payload: stripped.value }))).then((r) => r.json())
    if (answerJson?.result?.ok) answerJson.result.value = prefixResult(answerJson.result.value)
    return json(answerJson)
  }

  const failed = (res, body, error) => {
    let rpcId = null
    try { rpcId = JSON.parse(body.toString('utf8')).rpcId } catch {}
    if (res.headersSent) { res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'internal', message: `The WSL Host did not answer: ${error.message}` } } }))
  }
  const guarded = (handler) => async (req, res, next, ...rest) => {
    let body = Buffer.alloc(0)
    const read = req[Symbol.asyncIterator].bind(req)
    req[Symbol.asyncIterator] = async function* () { for await (const c of read()) { body = Buffer.concat([body, c]); yield c } }
    try { return await handler(req, res, next, ...rest) } catch (error) { ctx.logger.warn('wsl-mirror: %s', error.message); failed(res, body, error) }
  }

  // Each Session runs on this Host or the WSL Host (routing.mjs).
  const routing = installSessionRouting(ctx, {
    bridge, remoteOrigin, cookie, forwardApi, remoteFetch, readBody,
    available: () => remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release),
    distro: () => remoteGraph?.distro,
  })

  // Desktop → WSL settings sync for the namespaces both Hosts have (see settings.mjs): on connecting, after this Host
  // writes settings, and once a minute.
  let lastSync = null
  let syncing = false
  let syncAgain = false
  const callSettings = async (method, args) => {
    const r = await forwardApi(`/api/settings/${method}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'mirror-sync', method: `settings/${method}`, payload: { args } })))
    const json = await r.json()
    if (!json?.result?.ok) throw new Error(`settings/${method}: ${json?.result?.error?.message ?? r.status}`)
    return json.result.value
  }
  async function syncSettings(reason) {
    if (syncing) { syncAgain = true; return }
    syncing = true
    try {
      do {
        syncAgain = false
        if (remoteGraph === undefined || !sameRelease(raw.release, remoteGraph.graph.release)) return
        const mine = ctx.settings.describe({ redactSecrets: true })
        const theirs = await callSettings('describe', {})
        const changed = []
        for (const { ns, desktop, wsl } of sharedNamespaces(mine, theirs.namespaces)) {
          const ops = syncOps(desktop, wsl)
          if (ops.length === 0) continue
          await callSettings('mutate', { ns, ops, expectedRevision: wsl.revision })
          changed.push({ ns, fields: ops.map((o) => `${o.op} ${o.path.join('.')}`) })
        }
        lastSync = { at: new Date().toISOString(), reason, changed }
        if (changed.length) ctx.logger.info('wsl-mirror: settings copied to WSL: %s', changed.map((c) => c.ns).join(', '))
      } while (syncAgain)
    } catch (error) {
      lastSync = { at: new Date().toISOString(), reason, error: error.message }
      ctx.logger.warn('wsl-mirror: settings sync failed: %s', error.message)
    } finally {
      syncing = false
      writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], routes: [...forwarded.keys()], settingsSync: lastSync })
    }
  }
  ctx.effect(() => { const t = setInterval(() => void syncSettings('periodic'), 60_000); t.unref(); return () => clearInterval(t) }, 'wsl-mirror: periodic settings sync')

  ctx.on('connection/request', guarded(async (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const method = settingsMethod(pathname)
    const sameVersion = remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release)
    if (req.headers[INNER] !== undefined) return next()
    const endpoint = /^\/api\/([\w$]+\/[\w$]+)$/.exec(pathname)?.[1]
    if (!sameVersion && installTarget === 'wsl' && INSTALL_ENDPOINTS.has(endpoint)) {
      // Never fall back to installing on this Host when the person chose WSL.
      let rpcId = null
      try { rpcId = JSON.parse((await readBody(req)).toString('utf8')).rpcId } catch {}
      const message = remoteGraph === undefined ? 'The WSL Host is not connected.' : `The WSL Host runs DSH ${remoteGraph.graph.release?.version}, this one ${raw.release?.version}.`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'internal', message: `${message} Switch the install location to Windows in the Add plugin menu, or fix the WSL side first.` } } }))
      return
    }
    if (!sameVersion) return next()
    if (endpoint && PLUGIN_NAMESPACES.has(endpoint.split('/')[0])) return pluginCall(req, res, next, pathname, endpoint)
    if (method === undefined) return endpoint ? routing.call(req, res, next, pathname, endpoint) : next()
    const body = await readBody(req)
    if (method === 'describe') {
      const headers = { cookie: req.headers.cookie ?? '', origin: ws.getOrigin(), 'content-type': 'application/json', [INNER]: '1' }
      const [mine, theirs] = await Promise.all([
        fetch(`${ws.getOrigin()}/api/settings/describe`, { method: 'POST', headers, body }).then((r) => r.json()),
        callRemoteApi('describe', body).then((r) => r.json()).catch(() => undefined),
      ])
      if (mine?.result?.ok && theirs?.result?.ok) {
        const merged = mergeDescribe(mine.result.value, theirs.result.value)
        remoteNamespaces = merged.remoteNamespaces
        mine.result.value = merged.value
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mine))
      return
    }
    let ns
    try { ns = JSON.parse(body.toString('utf8'))?.payload?.args?.ns } catch {}
    if (SETTINGS_WRITES.has(method) && remoteNamespaces.has(ns)) return answer(res, await callRemoteApi(method, body))
    req[Symbol.asyncIterator] = async function* () { yield body }  // client-connection reads the body with for-await
    const result = await next()
    if (SETTINGS_WRITES.has(method)) void syncSettings(`desktop ${method} ${ns ?? ''}`.trim())
    return result
  }))

  let raw = reg.composed
  let remoteGraph
  let state = mergeGraphs(raw, undefined, orderByModuleGraph)
  const recompute = () => {
    state = mergeGraphs(raw, remoteGraph, orderByModuleGraph)
    syncRoutes()
    writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], routes: [...forwarded.keys()], reason: state.reason })
    ctx.logger.info('wsl-mirror: %d mirrored rows%s', state.mirrored.size, state.reason ? ` (${state.reason})` : `: ${[...state.mirrored.keys()].join(', ')}`)
  }
  const originalFetch = reg.fetchBundle
  Object.defineProperty(reg, 'composed', {
    configurable: true, enumerable: true,
    get: () => state.graph,
    set: (value) => { raw = value; recompute() },
  })
  reg.fetchBundle = async function (request) {
    const ids = requestedPackages(request.url)
    if (!ids.every((id) => state.mirrored.has(id))) return originalFetch.call(this, request)
    const { pathname, search } = new URL(request.url, 'http://x')
    const headers = { cookie: await cookie() }
    const etag = request.headers.get('if-none-match'); if (etag) headers['if-none-match'] = etag
    const res = await remoteFetch(`${pathname}${search}`, { method: request.method, headers })
    const out = new Headers()
    for (const h of FORWARDED_HEADERS) { const v = res.headers.get(h); if (v) out.set(h, v) }
    return new Response(res.body, { status: res.status, headers: out })
  }
  ctx.effect(() => () => {
    delete reg.composed
    reg.composed = raw
    delete reg.fetchBundle
    if (reg.fetchBundle !== originalFetch) reg.fetchBundle = originalFetch
    reg.notifyGraphChanged()
  }, 'wsl-mirror: restore registry')

  // Launch-token exchange: GET /?token= on the WSL Host answers with its signed browser cookie.
  async function cookie() {
    if (cookieValue) return cookieValue
    const token = bridge.state.dsh.token
    if (!token) throw new Error('the WSL DSH Host has not started')
    const res = await remoteFetch(`/?token=${encodeURIComponent(token)}`)
    const set = res.headers.getSetCookie()
    if (set.length === 0) throw new Error(`wsl-mirror: token exchange answered ${res.status} without a cookie`)
    return (cookieValue = set.map((c) => c.split(';')[0]).join('; '))
  }

  let stopped = false
  const controller = new AbortController()
  ctx.effect(() => () => { stopped = true; controller.abort() }, 'wsl-mirror: stop following')
  ;(async () => {
    for (let delay = 500; !stopped; delay = Math.min(delay * 2, 10_000)) {
      try {
        await bridge.ready(24 * 3600_000)
        const res = await remoteFetch(EVENTS, { headers: { cookie: await cookie() }, signal: controller.signal })
        if (!res.ok) throw new Error(`events answered ${res.status}`)
        delay = 500
        let buffer = ''
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            const data = event.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
            if (!data) continue
            const firstAfterConnect = remoteGraph === undefined
            remoteGraph = JSON.parse(data)
            recompute()
            if (firstAfterConnect) void syncSettings('connected')
            reg.notifyGraphChanged()
          }
        }
        throw new Error('events stream ended')
      } catch (error) {
        if (stopped) return
        // Disconnected: stop mirroring and forwarding until the WSL Host is back, rather than act on a stale graph.
        if (remoteGraph !== undefined) { remoteGraph = undefined; recompute(); reg.notifyGraphChanged() }
        writeStatus({ local: raw.release, mirrored: [...state.mirrored.keys()], reason: `connection: ${error.message}` })
        ctx.logger.warn('wsl-mirror: %s', error.message)
        cookieValue = undefined
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  })()
}
