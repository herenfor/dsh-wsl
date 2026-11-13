// Desktop side of the UI mirror experiment. Follows the WSL agent's event stream and makes this Host's client module
// registry publish the merged graph, so the page here mounts the WSL Host's user plugins; their bundle, chunk and asset
// requests are forwarded to the WSL Host. It patches two members of the registry instance (`composed` and
// `fetchBundle`) and restores them on dispose. HTTP routes that only the WSL Host serves (those of plugins installed
// only in WSL) are registered here too and forwarded, after this Host's own login and origin check.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { Readable } from 'node:stream'
import { startBridge } from './transport/client.mjs'
import { mergeGraphs, requestedPackages, compatibleReleases } from './merge.mjs'
import { DROP_RESPONSE_HEADERS, eventStreamRewriter, FORWARD_REQUEST_HEADERS, isJson, routesToForward } from './routes.mjs'
import { mergeDescribe, settingsMethod, SETTINGS_WRITES, sharedNamespaces, syncOps } from './settings.mjs'
import { wslBundles, wslBundlePage } from './plugins.mjs'
import { toWslSpec, wslFilePath } from './paths.mjs'
import { installSessionRouting } from './routing.mjs'
import { createChoices, intendedSection, overlayView, REFERENCE_NAMESPACES, resolveSection, wslSection } from './refs.mjs'
import { translateLoose } from './ids.mjs'
import { builtinRoot, isBuiltin } from './agent/index.mjs'
import { stableDshEntry, check as checkWsl, compareVersions, commandsFor, promptFor } from './setup.mjs'
import { noteLanguage, language, pick } from './language.mjs'

export const name = 'wsl-mirror'
export const inject = ['clientModules', 'webServer', 'connection', 'settings', 'typertGateway']
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const EVENTS = '/wsl-bridge/events'
const FORWARDED_HEADERS = ['content-type', 'cache-control', 'etag', 'content-length']

// How to reach the WSL side: normally found by setup.mjs (the distribution, its Node and DSH; the bridge files are
// copied into it). A bridge command given in the entry config or ~/.dsh-wsl/bridge.json overrides that (development):
// { "command": "wsl.exe", "args": ["-d", "Ubuntu", "--exec", "<node>", "<daemon.mjs>", "--bridge", "--profile",
// "desktop-wsl"] }. DSH_WSL_COMMAND names another wsl.exe (tests) and ignores bridge.json. The WSL Host's address and
// launch token arrive over the bridge and stay in memory.
export const BRIDGE_FILE = join(homedir(), '.dsh-wsl', 'bridge.json')
export const STATUS_FILE = join(homedir(), '.dsh-wsl', 'mirror-status.json')
export const CONFIG_FILE = join(homedir(), '.dsh-wsl', 'config.json')   // { distro, mode, dshEntry } chosen by the person
export const PROBE_LOG = join(homedir(), '.dsh-wsl', 'setup-probe.log')  // the last look into the distribution
export const BRIDGE_LOG = join(homedir(), '.dsh-wsl', 'bridge.log')       // the bridge's own lines and the WSL side's stderr
export const CHOICES_FILE = join(homedir(), '.dsh-wsl', 'choices.json')   // settings choices each Host resolves (refs.mjs)
/** Append to the bridge log, kept under 512 KB (the older half moves to bridge.log.old). */
function logBridge(line) {
  try {
    mkdirSync(dirname(BRIDGE_LOG), { recursive: true })
    try { if (statSync(BRIDGE_LOG).size > 512 << 10) renameSync(BRIDGE_LOG, `${BRIDGE_LOG}.old`) } catch {}
    appendFileSync(BRIDGE_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
function writeStatus(status) {
  try { mkdirSync(dirname(STATUS_FILE), { recursive: true }); writeFileSync(STATUS_FILE, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...status }, null, 2)}\n`) } catch {}
}
function readBridgeConfig(config) {
  if (config.command) return config
  if (process.env.DSH_WSL_COMMAND) return {}
  try { return JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) } catch { return {} }
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }

// Installed, updated or switched on while Desktop runs: the page and its streams were opened before this plugin could
// route them, so it would half work (WSL folders without their tasks, a composer that stays grey). Such a load takes
// over nothing and asks for a restart instead. The first load in the process decides, and a load of another version
// (an update from the Plugins page) asks for a restart too; a plugin that came up with the Desktop and is loaded again
// at the same version (a service it uses restarted) works as before.
const HOT_LOAD_SECONDS = Number(process.env.DSH_WSL_HOT_LOAD_SECONDS ?? 60)
const OWN_VERSION = readJson(join(PLUGIN_DIR, 'package.json')).version
export function loadKind(seen, version, uptime, hotSeconds = HOT_LOAD_SECONDS) {
  if (seen === undefined) return { mode: uptime > hotSeconds ? 'restart-required' : 'boot', version }
  if (seen.mode === 'restart-required' || seen.version !== version) return { mode: 'restart-required', version: seen.version }
  return seen
}
function loadedWhileRunning() {
  globalThis.__dshWslLoad = loadKind(globalThis.__dshWslLoad, OWN_VERSION, process.uptime())
  return globalThis.__dshWslLoad.mode === 'restart-required'
}

/** The plugin when it needs a Desktop restart: its routes say so and nothing else is touched (no WSL, no routing). */
function applyRestartRequired(ctx) {
  ctx.logger.info('wsl-mirror: loaded while Desktop was running; it starts working after Desktop restarts')
  const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const route = (path, value) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path,
    handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      json(res, value)
    },
  }), `wsl-mirror: ${path} (restart required)`)
  route('/wsl-bridge/setup', { state: 'restart-required', distro: null, distros: [], dev: false, mode: null, own: null, commands: '', prompt: '', canInstall: false, plugin: null, job: null })
  route('/wsl-bridge/plugins', { connected: false, distro: null, setup: 'restart-required' })
}

export async function apply(ctx, config = {}) {
  if (loadedWhileRunning()) return applyRestartRequired(ctx)
  const bridgeConfig = readBridgeConfig(config ?? {})
  // First-run setup (setup.mjs): the state of the WSL side, asked again before every connect and on "re-check".
  let setup = { state: 'checking' }
  let checking
  let job          // the install/update the person started: { running, log[], code?, error? }
  async function resolveBridge() {
    if (bridgeConfig.command) { setup = { state: 'ready', dev: true }; return { command: bridgeConfig.command, args: bridgeConfig.args ?? [] } }
    if (job?.running) return null
    const chosen = readJson(CONFIG_FILE)
    checking ??= checkWsl({
      wsl: process.env.DSH_WSL_COMMAND ?? 'wsl.exe',
      desktopVersion: ctx.clientModules.composed?.release?.version,
      chosen,
      pluginDir: PLUGIN_DIR,
    }).then((status) => {
      // Migrate only when the WSL probe validated the stable replacement, and the
      // saved selection has not changed while this asynchronous check was running.
      const saved = readJson(CONFIG_FILE)
      if (saved.distro === chosen.distro && saved.dshEntry === chosen.dshEntry && saved.dshEntry && status.configuredEntry && status.configuredEntry !== saved.dshEntry &&
          status.configuredEntry === stableDshEntry(saved.dshEntry)) {
        try {
          writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...saved, dshEntry: status.configuredEntry }, null, 2)}\n`)
          ctx.logger.info('wsl-mirror: dsh entry migrated %s -> %s', saved.dshEntry, status.configuredEntry)
        } catch (error) { ctx.logger.warn('wsl-mirror: could not save stable DSH entry: %s', error.message) }
      }
      if (status.probeOutput) { try { mkdirSync(dirname(PROBE_LOG), { recursive: true }); writeFileSync(PROBE_LOG, `${status.probeOutput}\n`) } catch {} }
      delete status.probeOutput
      setup = status; return status
    }, (error) => { setup = { state: 'error', error: error.message }; return setup }).finally(() => { checking = undefined })
    const status = await checking
    if (status.state !== 'ready') ctx.logger.info('wsl-mirror: WSL side not ready: %s%s', status.state, status.distro ? ` (${status.distro})` : '')
    return status.bridge ?? null
  }
  const bridge = startBridge({ resolve: resolveBridge, caps: process.env.DSH_WSL_NO_BROKER ? [] : ['credentials'], log: (m) => { ctx.logger.info('wsl-mirror: %s', m); logBridge(m) } })
  ctx.effect(() => () => bridge.close(), 'wsl-mirror: bridge')

  // Credential broker, Desktop half (docs/credentials.md, option 3): the WSL DSH Host asks for a credential when it
  // has none of its own, and this Host answers from its own credential service. Values cross the bridge per request
  // and are kept by neither side. A token refresh on the WSL side is written back as a compare-and-swap.
  let credentials
  ctx.inject(['credentials'], (c) => { credentials = c.credentials; return () => { credentials = undefined } })
  const CREDENTIAL_OPS = {
    resolve: async ({ ref }) => { const r = await credentials.resolve(ref); return r ? { value: r.value, source: `desktop-${r.source}` } : null },
    describe: ({ ref }) => credentials.describe(ref),
    readRecord: async ({ key }) => (await credentials.readRecord(key)) ?? null,
    describeRecord: ({ key }) => credentials.describeRecord(key),
    listRecords: () => credentials.listRecords(),
    swapRecord: async ({ key, expected, next }) => {
      let swapped = false
      const after = await credentials.modifyRecord(key, async (current) => {
        if (!isDeepStrictEqual(current ?? null, expected ?? null)) return undefined
        swapped = true
        return next
      })
      return { swapped, record: after ?? null }
    },
  }
  bridge.on('stream', (stream, target) => {
    if (target?.kind !== 'credentials') { stream.destroy(new Error('not served')); return }
    const parts = []
    stream.on('data', (c) => parts.push(c))
    stream.once('error', () => {})
    stream.once('end', async () => {
      let out
      try {
        const request = JSON.parse(Buffer.concat(parts).toString('utf8'))
        const op = Object.hasOwn(CREDENTIAL_OPS, request.op) ? CREDENTIAL_OPS[request.op] : undefined
        if (!op) throw new Error(`unknown op ${request.op}`)
        if (!credentials) throw new Error('Desktop has no credential service')
        if ((request.ref !== undefined && typeof request.ref !== 'string') || (request.key !== undefined && typeof request.key !== 'string')) throw new Error('bad request')
        out = { value: await op(request) }
      } catch (error) { out = { error: error.message } }
      stream.end(JSON.stringify(out))
    })
  })
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
        // The WSL Host no longer takes the cookie (it expired): exchange the launch token again on the next call.
        if (res.statusCode === 401 && headers.cookie !== undefined && headers.cookie === cookieValue) cookieValue = undefined
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
    const sameVersion = remoteGraph !== undefined && compatibleReleases(raw.release, remoteGraph.graph.release)
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

  async function forwardRequest(req, res, { origin = false } = {}) {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    try {
      const headers = { cookie: await cookie(), ...(origin ? { origin: remoteOrigin() } : {}) }
      for (const name of FORWARD_REQUEST_HEADERS) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      // A plugin's own route names Sessions and Workspaces in its own shapes: JSON bodies, event streams and the
      // query are rewritten by value so the page sees `wsl:` ids and the WSL Host its own.
      const url = new URL(req.url, 'http://x')
      for (const [name, value] of [...url.searchParams]) url.searchParams.set(name, translateLoose(value, false))
      let body = hasBody ? req : undefined
      if (hasBody && isJson(req.headers['content-type'])) {
        const raw = await readBody(req)
        try { body = Buffer.from(JSON.stringify(translateLoose(JSON.parse(raw.toString('utf8')), false))) } catch { body = raw }
        delete headers['content-length']
      }
      const upstream = await remoteFetch(`${url.pathname}${url.search}`, { method: req.method, headers, signal: abort.signal, ...(body !== undefined ? { body } : {}) })
      const out = {}
      for (const [name, value] of upstream.headers) if (!DROP_RESPONSE_HEADERS.has(name)) out[name] = value
      const type = upstream.headers.get('content-type') ?? ''
      const ids = routing?.wslWorkspaceIds?.() ?? new Set()
      if (isJson(type) && upstream.body) {
        const text = await upstream.text()
        let rewritten = text
        try { rewritten = JSON.stringify(translateLoose(JSON.parse(text), true, ids)) } catch {}
        delete out['content-length']
        res.writeHead(upstream.status, out)
        res.end(rewritten)
        return
      }
      res.writeHead(upstream.status, out)
      const sse = type.startsWith('text/event-stream') ? eventStreamRewriter((value) => translateLoose(value, true, ids)) : undefined
      if (upstream.body) for await (const chunk of upstream.body) { if (!res.write(sse ? sse(chunk) : chunk)) await new Promise((r) => res.once('drain', r)) }
      res.end()
    } catch (error) {
      if (abort.signal.aborted) return
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`wsl-mirror: the WSL Host did not answer (${error.message})\n`)
    }
  }

  // Response headers of a file read passed back as they are (no body is rewritten, so the length stays).
  const FILE_DROP = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding'])
  const fileDebug = process.env.DSH_WSL_DEBUG ? (...a) => { try { appendFileSync(process.env.DSH_WSL_DEBUG, `${new Date().toISOString()} file ${a.join(' ')}\n`) } catch {} } : () => {}
  /**
   * GET/HEAD /api/file on the WSL Host. Its redirect to the versioned URL (`?path=…&v=…`) is relative, so the page
   * comes back here with the WSL path. A POSIX path the WSL side does not have (404), or a WSL side that cannot be
   * reached, falls back to this Host: a path like /x is also a path on this computer's current drive.
   */
  async function wslFile(req, res, next, url, wslPath) {
    const fromUnc = wslPath !== url.searchParams.get('path')
    url.searchParams.set('path', wslPath)
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const headers = {}
    for (const name of FORWARD_REQUEST_HEADERS) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    let upstream
    try {
      for (let attempt = 0; ; attempt++) {
        upstream = await remoteFetch(`/api/file${url.search}`, { method: req.method, headers: { ...headers, cookie: await cookie() }, signal: abort.signal })
        if (upstream.status !== 401 || attempt > 0) break
        await upstream.body?.cancel()   // remoteFetch dropped the cookie: one more try with a new one
      }
    } catch (error) {
      if (abort.signal.aborted) return
      ctx.logger.debug?.('wsl-mirror: /api/file on the WSL side failed: %s', error.message)
      fileDebug(wslPath, 'WSL failed:', error.message)
      return fromUnc ? fileFailure(res, 502) : next()
    }
    fileDebug(req.method, wslPath, 'WSL', upstream.status, upstream.status === 404 && !fromUnc ? '→ this Host' : '')
    if (upstream.status === 404 && !fromUnc) { await upstream.body?.cancel(); return next() }
    const out = {}
    for (const [name, value] of upstream.headers) if (!FILE_DROP.has(name)) out[name] = value
    res.writeHead(upstream.status, out)
    try {
      if (upstream.body) for await (const chunk of upstream.body) { if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)) }
    } catch {}
    res.end()
  }
  const fileFailure = (res, status) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }); res.end('the WSL side did not answer') }

  /** Whether `path` is an exact Fetch route the WSL Host has for `method` and this Host does not. */
  function wslFetchRoute(path, method) {
    const route = remoteGraph?.routes?.fetch?.find((r) => r.path === path)
    if (!route?.methods.includes(method)) return false
    let mine
    try { mine = ctx.connection.fetchRoutes?.get(path) } catch {}
    return !mine?.methods?.has(method)
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
  // The person's choices for settings that name an entry of a per-Host list (refs.mjs), and both Hosts' lists.
  const callOwn = async (endpoint, args, cookieHeader) => {
    const r = await fetch(`${ws.getOrigin()}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie: cookieHeader ?? '', origin: ws.getOrigin(), 'content-type': 'application/json', [INNER]: '1' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'mirror-refs', method: endpoint, payload: { args } }),
    })
    const json = await r.json()
    if (!json?.result?.ok) throw new Error(`${endpoint}: ${json?.result?.error?.message ?? r.status}`)
    return json.result.value
  }
  const callWslApi = async (endpoint, args) => {
    const r = await forwardApi(`/api/${endpoint}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'mirror-refs', method: endpoint, payload: { args } })))
    const json = await r.json()
    if (!json?.result?.ok) throw new Error(`${endpoint}: ${json?.result?.error?.message ?? r.status}`)
    return json.result.value
  }
  const choices = createChoices({
    load: () => readJson(CHOICES_FILE),
    save: (state) => { try { mkdirSync(dirname(CHOICES_FILE), { recursive: true }); writeFileSync(CHOICES_FILE, `${JSON.stringify(state, null, 2)}\n`) } catch {} },
    call: { windows: callOwn, wsl: callWslApi },
  })
  /** A describe value as the page sees it: the person's choices instead of what this Host resolved them to. */
  const withChoices = (value) => ({
    ...value,
    namespaces: value.namespaces.map((view) => (REFERENCE_NAMESPACES.has(view.ns) && !remoteNamespaces.has(view.ns) ? overlayView(view, choices.reconcile(view.ns, view.user)) : view)),
  })

  const answer = async (res, upstream) => {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  }
  // The WSL tab of the Plugins page (client.js): the WSL Host's bundles, switched, removed and installed there. The
  // official Installed tab stays this Host's own. GET → {connected, distro, bundles}; POST {action, name | spec}.
  const callWsl = async (method, args) => {
    const r = await forwardApi(`/api/pluginManager/${method}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'mirror', method: `pluginManager/${method}`, payload: { args } })))
    const json = await r.json()
    if (!json?.result?.ok) throw Object.assign(new Error(json?.result?.error?.message ?? `HTTP ${r.status}`), { code: json?.result?.error?.code })
    return json.result.value
  }
  // Reuse mode: the WSL profile follows the person's own (agent/follow.mjs). { from, names } or { from: null } (the
  // plugin's own copy, or a WSL side without the route).
  const followInfo = async () => {
    try { const r = await remoteFetch('/wsl-bridge/follow', { headers: { cookie: await cookie() } }); return r.ok ? await r.json() : { from: null } } catch { return { from: null } }
  }
  const followChange = async (change) => {
    const r = await remoteFetch('/wsl-bridge/follow', { method: 'POST', body: Buffer.from(JSON.stringify(change)), headers: { cookie: await cookie(), origin: remoteOrigin(), 'content-type': 'application/json' } })
    return r.ok ? r.json() : { error: `HTTP ${r.status}` }
  }
  // MCP servers of the WSL side (docs/cross-host-rules.md, B): their commands run in WSL, so they are set there and
  // never copied from Desktop. GET → { connected, distro, servers, revision, windows: [names set on Desktop] };
  // POST { servers, revision } → replaces the WSL side's `servers`.
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/mcp',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      noteLanguage(req)
      const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
      const distro = remoteGraph?.distro ?? setup.distro ?? null
      if (remoteGraph === undefined || !compatibleReleases(raw.release, remoteGraph.graph.release)) return reply({ connected: false, distro })
      const windows = Object.keys(ctx.settings.describe({ redactSecrets: true }).find((v) => v.ns === 'mcp-manager')?.value?.servers ?? {})
      const read = async () => (await callWslApi('settings/describe', {})).namespaces.find((v) => v.ns === 'mcp-manager')
      try {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          if (!body.servers || typeof body.servers !== 'object' || Array.isArray(body.servers)) return reply({ error: pick({ zh: '服务器列表必须是一个对象：{ "名字": { … } }', en: 'The server list must be an object: { "name": { … } }' }) })
          const view = await read()
          if (!view) return reply({ error: pick({ zh: 'WSL 端没有 MCP 管理器', en: 'The WSL side has no MCP manager' }) })
          await callWslApi('settings/replace', { ns: 'mcp-manager', section: { ...(view.user ?? {}), servers: body.servers }, ...(typeof body.revision === 'number' ? { expectedRevision: body.revision } : {}) })
        }
        const view = await read()
        return reply({ connected: true, distro, available: view !== undefined, servers: view?.user?.servers ?? {}, revision: view?.revision, windows })
      } catch (error) { return reply({ connected: true, distro, error: error.message }) }
    },
  }), 'wsl-mirror: WSL MCP servers route')
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/plugins',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      noteLanguage(req)
      const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
      const distro = remoteGraph?.distro ?? setup.distro ?? null
      if (remoteGraph === undefined || !compatibleReleases(raw.release, remoteGraph.graph.release)) return reply({ connected: false, distro, setup: publicSetup().state })
      try {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8'))
          const call = {
            enable: () => callWsl('setBundleEnabled', { name: body.name, enabled: true }),
            disable: () => callWsl('setBundleEnabled', { name: body.name, enabled: false }),
            remove: () => callWsl('removeBundle', { name: body.name }),
            inspect: () => callWsl('inspect', { spec: toWslSpec(String(body.spec ?? '')) }),
            install: () => callWsl('installBundle', { spec: toWslSpec(String(body.spec ?? '')), options: { enabled: true } }),
            // One component of a bundle, by its Loader entry id, as the official bundle page switches rows.
            row: () => callWsl('setPluginEnabled', { id: body.entryId, enabled: body.enabled === true }),
          }[body.action]
          if (call === undefined) return reply({ connected: true, distro, error: `unknown action ${body.action}` })
          const result = await call()
          // Followed: the person's own profile gets the same change (after this one worked here).
          let follow
          if (['install', 'remove', 'enable', 'disable'].includes(body.action) && typeof body.name === 'string' && !result?.error && result?.application !== 'failed') {
            const info = await followInfo()
            if (info.from) follow = await followChange({ action: body.action, name: body.name, spec: toWslSpec(String(body.spec ?? '')) })
          }
          return reply({ connected: true, distro, result, ...(follow ? { follow } : {}) })
        }
        const query = new URL(req.url, 'http://x').searchParams
        const name = query.get('name')
        if (name !== null) {
          // One bundle's page; its document is read on its own, so a failed read leaves the rest of the page.
          if (query.has('language')) {
            try { return reply({ connected: true, distro, detail: await callWsl('readBundleDetail', { name, language: query.get('language'), options: { npmFileSources: [] } }) }) } catch (error) { return reply({ connected: true, distro, detailError: error.code === 'plugin-manager/detail-unavailable' ? 'unavailable' : 'other', error: error.message }) }
          }
          const [bundles, plugins] = await Promise.all([callWsl('listBundles', {}), callWsl('listPlugins', {})])
          return reply({ connected: true, distro, bundle: wslBundlePage(bundles, plugins, name) ?? null })
        }
        const [bundles, follow] = await Promise.all([callWsl('listBundles', {}), followInfo()])
        reply({ connected: true, distro, bundles: wslBundles(bundles), follow: follow.from ? follow : null })
      } catch (error) { reply({ connected: true, distro, error: error.message, code: error.code }) }
    },
  }), 'wsl-mirror: WSL plugins route')
  // Images beside a WSL bundle's detail document: the WSL Host's own detail-file route, read with this bridge's cookie.
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/plugin-file',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      noteLanguage(req)
      if (remoteGraph === undefined) { res.writeHead(503); res.end(); return }
      try {
        const upstream = await remoteFetch(`/api/plugin-manager/detail-file${new URL(req.url, 'http://x').search}`, { headers: { cookie: await cookie() } })
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(Buffer.from(await upstream.arrayBuffer()))
      } catch (error) { if (!res.headersSent) res.writeHead(502); res.end() }
    },
  }), 'wsl-mirror: WSL plugin detail images')
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
  const available = () => remoteGraph !== undefined && compatibleReleases(raw.release, remoteGraph.graph.release)
  const routing = installSessionRouting(ctx, {
    choices,
    bridge, remoteOrigin, cookie, forwardApi, remoteFetch, readBody, available,
    whenAvailable: (signal) => new Promise((resolve) => {
      const done = () => { if (!available() && !signal.aborted) return; availability.removeEventListener('change', done); signal.removeEventListener('abort', done); resolve() }
      availability.addEventListener('change', done); signal.addEventListener('abort', done); done()
    }),
    distro: () => remoteGraph?.distro ?? setup.distro,
    setupState: () => publicSetup().state,
  })

  // ---- first-run setup: GET answers where the WSL side stands; POST {action:'recheck'} checks again and connects,
  // POST {distro} switches the distribution. The page shows this in the environment menu and the setup dialog.
  const publicSetup = () => {
    const s = setup
    let state = s.state
    const dsh = bridge.state.dsh
    const failed = !bridge.state.connected && bridge.state.lastError
    const wslVersion = remoteGraph?.graph.release?.version ?? null
    const desktopVersion = raw.release?.version ?? null
    if (state === 'ready') {
      if (remoteGraph !== undefined && !compatibleReleases(raw.release, remoteGraph.graph.release)) state = compareVersions(wslVersion, desktopVersion) < 0 ? 'version-mismatch' : 'desktop-outdated'
      else state = remoteGraph !== undefined ? 'connected' : dsh.state === 'stopped' || failed ? 'error' : 'starting'
    }
    if (job?.running) state = 'installing'
    return {
      state, distro: s.distro ?? remoteGraph?.distro ?? null, distros: (s.distros ?? []).map((d) => d.name), dev: !!s.dev,
      mode: s.mode ?? null, own: s.own ? { version: s.own.version, path: s.own.entry, dir: s.own.pkgDir, kind: s.own.kind ?? null, configured: !!s.own.configured } : null,
      // Where setup looked for DSH and Node, and the DSH location the person named (config dshEntry).
      checked: s.checked ?? null, dshEntry: s.configuredEntry ?? null, entryMissing: s.entryMissing ?? null, chosenMode: s.chosenMode ?? null,
      probeLog: s.checked ? PROBE_LOG : null,
      // Once connected, the versions that matter are the running ones.
      drift: state === 'connected' ? ((o) => (o === 0 ? null : o < 0 ? 'wsl-older' : 'wsl-newer'))(compareVersions(wslVersion, desktopVersion)) : s.drift ?? null,
      desktopVersion, installed: s.installed ?? wslVersion, wslVersion,
      commands: commandsFor(s, desktopVersion, language()), prompt: promptFor(s, desktopVersion, language()), canInstall: !!s.script && !s.dev, probeError: s.probeError ?? null,
      plugin: { name: own.name, version: own.version },
      job: job ? { running: job.running, log: job.log.slice(-12).join('\n'), code: job.code ?? null, error: job.failure === 'not-published' ? pick({ zh: `npm 上还没有 @deepseek-ai/dsh@${job.version}，要等它发布后再装。`, en: `@deepseek-ai/dsh@${job.version} is not on npm yet; install it once it is published.` })
        : job.failure === 'network' ? pick({ zh: '网络连接失败，可以稍后重试。', en: 'The network connection failed; try again later.' })
          : job.failure === 'exit' ? pick({ zh: `安装失败（退出码 ${job.code}）`, en: `The install failed (exit code ${job.code})` }) : job.error ?? null } : null,
      error: s.error ?? (dsh.state === 'stopped' ? dsh.exit?.error ?? `DSH exited (${dsh.exit?.code ?? dsh.exit?.signal ?? '?'})` : failed ? bridge.state.lastError : null),
      log: s.home ? `${s.home}/.dsh-wsl/run/desktop-wsl/daemon.log` : null, bridgeLog: BRIDGE_LOG,
    }
  }
  // This plugin's own version, for the setup window. It is updated only from the Plugins page, by the person: an
  // update in the background could cut off the WSL tasks running at that moment.
  const own = readJson(join(PLUGIN_DIR, 'package.json'))

  // The install/update button: runs setup's script in WSL (it stops the daemon first, then installs or updates DSH).
  // Only on the person's click; the bridge stays down meanwhile and connects again when it is done.
  function startInstall() {
    if (job?.running || !setup.script || setup.dev) return
    const version = raw.release?.version
    job = { running: true, log: [], startedAt: Date.now() }
    const current = job
    const child = spawn(process.env.DSH_WSL_COMMAND ?? 'wsl.exe', ['-d', setup.distro, '--exec', 'bash', '-c', setup.script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let partial = ''
    const take = (chunk) => {
      partial += chunk.toString('utf8').replace(/\r/g, '\n')
      const lines = partial.split('\n'); partial = lines.pop()
      for (const line of lines) if (line.trim()) current.log.push(line.slice(0, 300))
      if (current.log.length > 400) current.log.splice(0, current.log.length - 200)
    }
    child.stdout.on('data', take); child.stderr.on('data', take)
    const timer = setTimeout(() => child.kill(), 30 * 60_000); timer.unref?.()
    let finished = false
    const finish = async (code, error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (partial.trim()) current.log.push(partial)
      const text = current.log.join('\n')
      current.code = code
      if (code !== 0) {
        // Known failures are worded when the page asks, in its language.
        current.version = version
        current.failure = /ETARGET|No matching version|notarget/i.test(text) ? 'not-published' : /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(text) ? 'network' : undefined
        current.error = error ?? current.log.filter((l) => /err/i.test(l)).slice(-1)[0]
        if (current.failure === undefined && current.error === undefined) current.failure = 'exit'
      }
      current.running = false
      ctx.logger.info('wsl-mirror: WSL install finished with %s', code)
      await resolveBridge(); bridge.retry()
    }
    child.once('error', (e) => void finish(null, e.message))
    child.once('exit', (code) => void finish(code))
  }
  ctx.effect(() => () => { if (job?.running) job.running = false }, 'wsl-mirror: install job')

  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/setup',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      noteLanguage(req)
      if (req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)).toString('utf8')) } catch {}
        const remember = (patch) => { try { mkdirSync(dirname(CONFIG_FILE), { recursive: true }); writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...readJson(CONFIG_FILE), ...patch }, null, 2)}\n`) } catch {} }
        if (typeof body.distro === 'string' && body.distro !== readJson(CONFIG_FILE).distro) {
          remember({ distro: body.distro })
          await resolveBridge(); bridge.restart()
        } else if (typeof body.dshEntry === 'string') {
          // The person names their DSH (a dsh command, a file in its package or the package folder): it is looked for
          // first and reused. An empty one goes back to finding it.
          const entry = toWslSpec(body.dshEntry.trim())
          remember(entry ? { dshEntry: entry, mode: 'reuse' } : { dshEntry: undefined })
          await resolveBridge(); bridge.restart()
        } else if ((body.mode === 'reuse' || body.mode === 'private') && body.mode !== readJson(CONFIG_FILE).mode) {
          // Another DSH and another DSH home: the daemon is replaced on the next connect.
          remember({ mode: body.mode })
          await resolveBridge(); bridge.restart()
        } else if (body.action === 'install') {
          startInstall()
        } else if (body.action === 'recheck') {
          if (!bridge.state.connected) { await resolveBridge(); bridge.retry() }
        }
        // Give a fresh connection a moment, so the answer already says whether it came up.
        for (let i = 0; i < 40 && setup.state === 'ready' && publicSetup().state === 'starting'; i++) await new Promise((r) => setTimeout(r, 250))
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(publicSetup()))
    },
  }), 'wsl-mirror: setup route')

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
        if (remoteGraph === undefined || !compatibleReleases(raw.release, remoteGraph.graph.release)) return
        let mine = ctx.settings.describe({ redactSecrets: true })
        const theirs = await callSettings('describe', {})
        const changed = []
        // This Host first: a choice it cannot use (a WSL-only preset…) is not kept here, so it uses its own default.
        const winRoster = await choices.roster('windows')
        let fixedHere = false
        for (const view of mine) {
          if (!REFERENCE_NAMESPACES.has(view.ns)) continue
          const intended = { ...(view.user ?? {}), ...choices.reconcile(view.ns, view.user) }
          const given = resolveSection(view.ns, intended, winRoster)
          if (isDeepStrictEqual(given, view.user ?? {})) continue
          await ctx.settings.replace(view.ns, given, view.revision)
          choices.record(view.ns, intended, given)
          changed.push({ ns: view.ns, host: 'desktop', fields: Object.keys(intended).filter((k) => !(k in given)).map((k) => `unset ${k}`) })
          fixedHere = true
        }
        if (fixedHere) mine = ctx.settings.describe({ redactSecrets: true })
        const wslRoster = await choices.roster('wsl')
        for (const { ns, desktop, wsl } of sharedNamespaces(mine, theirs.namespaces)) {
          const want = wslSection(ns, desktop.user ?? {}, wsl.user ?? {}, choices.choice(ns), wslRoster)
          const ops = syncOps({ ...desktop, user: want }, wsl)
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
      writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], dropped: [...(state.dropped ?? [])], routes: [...forwarded.keys()], settingsSync: lastSync })
    }
  }
  ctx.effect(() => { const t = setInterval(() => void syncSettings('periodic'), 60_000); t.unref(); return () => clearInterval(t) }, 'wsl-mirror: periodic settings sync')

  ctx.on('connection/request', guarded(async (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const method = settingsMethod(pathname)
    const sameVersion = remoteGraph !== undefined && compatibleReleases(raw.release, remoteGraph.graph.release)
    if (req.headers[INNER] !== undefined) return next()
    choices.noteCookie(req.headers.cookie)
    // Pictures and files the page shows by path (GET /api/file?path=…: the chat's images, their viewer, dragging one
    // out). The URL names no task, so the path decides: a WSL path is read on the WSL side (wslFilePath).
    if (pathname === '/api/file' && (req.method === 'GET' || req.method === 'HEAD') && remoteOrigin()) {
      const url = new URL(req.url ?? '/', 'http://x')
      const wslPath = wslFilePath(url.searchParams.get('path'), remoteGraph?.distro ?? setup.distro)
      if (wslPath !== undefined) return wslFile(req, res, next, url, wslPath)
    }
    // A Fetch route only a WSL plugin registered (DS Bot's /api/bot and its live feed): pass the request through.
    if (sameVersion && wslFetchRoute(pathname, req.method)) return forwardRequest(req, res, { origin: true })
    const endpoint = /^\/api\/([\w$]+\/[\w$]+)$/.exec(pathname)?.[1]
    if (!sameVersion) return next()
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
      if (mine?.result?.ok) mine.result.value = withChoices(mine.result.value)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mine))
      return
    }
    let ns
    try { ns = JSON.parse(body.toString('utf8'))?.payload?.args?.ns } catch {}
    if (SETTINGS_WRITES.has(method) && remoteNamespaces.has(ns)) return answer(res, await callRemoteApi(method, body))
    if (SETTINGS_WRITES.has(method) && REFERENCE_NAMESPACES.has(ns)) {
      // A setting naming an entry of a per-Host list: keep what the person chose, give this Host what it can use
      // (the whole user section, replaced at the revision the page read), show the page the choice (refs.mjs).
      let message
      try { message = JSON.parse(body.toString('utf8')) } catch {}
      const args = message?.payload?.args ?? {}
      const view = ctx.settings.describe({ redactSecrets: true }).find((v) => v.ns === ns)
      const intended = intendedSection(method, args, { ...(view?.user ?? {}), ...choices.reconcile(ns, view?.user) })
      const section = resolveSection(ns, intended, await choices.roster('windows', req.headers.cookie))
      const r = await fetch(`${ws.getOrigin()}/api/settings/replace`, {
        method: 'POST',
        headers: { cookie: req.headers.cookie ?? '', origin: ws.getOrigin(), 'content-type': 'application/json', [INNER]: '1' },
        body: JSON.stringify({ type: 'client-request', rpcId: message?.rpcId, method: 'settings/replace', payload: { args: { ns, section, ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}) } } }),
      })
      const json = await r.json()
      if (json?.result?.ok) {
        choices.record(ns, intended, section)
        json.result.value = overlayView(json.result.value, choices.choice(ns))
        void syncSettings(`desktop ${method} ${ns}`)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
      return
    }
    req[Symbol.asyncIterator] = async function* () { yield body }  // client-connection reads the body with for-await
    const result = await next()
    if (SETTINGS_WRITES.has(method)) void syncSettings(`desktop ${method} ${ns ?? ''}`.trim())
    return result
  }))

  let raw = reg.composed
  let remoteGraph
  const availability = new EventTarget()   // "change" when the WSL Host comes or goes (routing waits on it)
  // This Host's own official rows, which no WSL row replaces.
  const localRoot = builtinRoot(reg.clientPath(MODULES_ID))
  const builtinHere = () => new Set(raw.entries.filter((row) => { try { return isBuiltin(reg.clientPath(row.id), localRoot) } catch { return false } }).map((row) => row.id))
  let state = mergeGraphs(raw, undefined, orderByModuleGraph)
  const recompute = () => {
    state = mergeGraphs(raw, remoteGraph, orderByModuleGraph, builtinHere())
    syncRoutes()
    if (state.kept?.size) ctx.logger.warn('wsl-mirror: the WSL side calls %d official rows its own; kept this Host\'s: %s', state.kept.size, [...state.kept].slice(0, 5).join(', '))
    writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], dropped: [...(state.dropped ?? [])], kept: [...(state.kept ?? [])], routes: [...forwarded.keys()], reason: state.reason })
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
            availability.dispatchEvent(new Event('change'))
          }
        }
        throw new Error('events stream ended')
      } catch (error) {
        if (stopped) return
        // Disconnected: stop mirroring and forwarding until the WSL Host is back, rather than act on a stale graph.
        if (remoteGraph !== undefined) { remoteGraph = undefined; recompute(); reg.notifyGraphChanged(); availability.dispatchEvent(new Event('change')) }
        writeStatus({ local: raw.release, mirrored: [...state.mirrored.keys()], reason: `connection: ${error.message}` })
        ctx.logger.warn('wsl-mirror: %s', error.message)
        cookieValue = undefined
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  })()
}
