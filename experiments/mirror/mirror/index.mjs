// Desktop side of the UI mirror experiment. Follows the WSL agent's event stream and makes this Host's client module
// registry publish the merged graph, so the page here mounts the WSL Host's user plugins; their bundle, chunk and asset
// requests are forwarded to the WSL Host. It patches two members of the registry instance (`composed` and
// `fetchBundle`) and restores them on dispose. HTTP routes that only the WSL Host serves (those of plugins installed
// only in WSL) are registered here too and forwarded, after this Host's own login and origin check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { wslBundles } from './plugins.mjs'
import { toWslSpec } from './paths.mjs'
import { installSessionRouting } from './routing.mjs'
import { translateLoose } from './ids.mjs'
import { check as checkWsl, compareVersions } from './setup.mjs'
import { installSelfUpdate } from './selfupdate.mjs'

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
export const CONFIG_FILE = join(homedir(), '.dsh-wsl', 'config.json')   // { distro, mode } chosen by the person
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

export async function apply(ctx, config = {}) {
  const bridgeConfig = readBridgeConfig(config ?? {})
  // First-run setup (setup.mjs): the state of the WSL side, asked again before every connect and on "re-check".
  let setup = { state: 'checking' }
  let checking
  let job          // the install/update the person started: { running, log[], code?, error? }
  async function resolveBridge() {
    if (bridgeConfig.command) { setup = { state: 'ready', dev: true }; return { command: bridgeConfig.command, args: bridgeConfig.args ?? [] } }
    if (job?.running) return null
    checking ??= checkWsl({
      wsl: process.env.DSH_WSL_COMMAND ?? 'wsl.exe',
      desktopVersion: ctx.clientModules.composed?.release?.version,
      chosen: readJson(CONFIG_FILE),
      pluginDir: PLUGIN_DIR,
    }).then((status) => { setup = status; return status }, (error) => { setup = { state: 'error', error: error.message }; return setup }).finally(() => { checking = undefined })
    const status = await checking
    if (status.state !== 'ready') ctx.logger.info('wsl-mirror: WSL side not ready: %s%s', status.state, status.distro ? ` (${status.distro})` : '')
    return status.bridge ?? null
  }
  const bridge = startBridge({ resolve: resolveBridge, caps: process.env.DSH_WSL_NO_BROKER ? [] : ['credentials'], log: (m) => ctx.logger.info('wsl-mirror: %s', m) })
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
  ctx.effect(() => ws.register({
    kind: 'exact', path: '/wsl-bridge/plugins',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
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
          }[body.action]
          if (call === undefined) return reply({ connected: true, distro, error: `unknown action ${body.action}` })
          return reply({ connected: true, distro, result: await call() })
        }
        reply({ connected: true, distro, bundles: wslBundles(await callWsl('listBundles', {})) })
      } catch (error) { reply({ connected: true, distro, error: error.message, code: error.code }) }
    },
  }), 'wsl-mirror: WSL plugins route')
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
      mode: s.mode ?? null, own: s.own ? { version: s.own.version, path: s.own.entry } : null,
      // Once connected, the versions that matter are the running ones.
      drift: state === 'connected' ? ((o) => (o === 0 ? null : o < 0 ? 'wsl-older' : 'wsl-newer'))(compareVersions(wslVersion, desktopVersion)) : s.drift ?? null,
      desktopVersion, installed: s.installed ?? wslVersion, wslVersion,
      commands: s.commands ?? '', prompt: s.prompt ?? '', canInstall: !!s.script && !s.dev, probeError: s.probeError ?? null,
      plugin: selfUpdate.state(),
      job: job ? { running: job.running, log: job.log.slice(-12).join('\n'), code: job.code ?? null, error: job.error ?? null } : null,
      error: s.error ?? (dsh.state === 'stopped' ? dsh.exit?.error ?? `DSH exited (${dsh.exit?.code ?? dsh.exit?.signal ?? '?'})` : failed ? bridge.state.lastError : null),
      log: s.home ? `${s.home}/.dsh-wsl/run/desktop-wsl/daemon.log` : null,
    }
  }
  // This plugin's own updates (selfupdate.mjs).
  const own = readJson(join(PLUGIN_DIR, 'package.json'))
  const selfUpdate = installSelfUpdate(ctx, {
    name: own.name, version: own.version,
    auto: () => readJson(CONFIG_FILE).autoUpdate !== false,
    log: (m) => ctx.logger.info('wsl-mirror: %s', m),
  })

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
        current.error = /ETARGET|No matching version|notarget/i.test(text) ? `npm 上还没有 @deepseek-ai/dsh@${version}，要等它发布后再装。`
          : /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(text) ? '网络连接失败，可以稍后重试。'
            : error ?? current.log.filter((l) => /err/i.test(l)).slice(-1)[0] ?? `安装失败（退出码 ${code}）`
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
      if (req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)).toString('utf8')) } catch {}
        const remember = (patch) => { try { mkdirSync(dirname(CONFIG_FILE), { recursive: true }); writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...readJson(CONFIG_FILE), ...patch }, null, 2)}\n`) } catch {} }
        if (typeof body.distro === 'string' && body.distro !== readJson(CONFIG_FILE).distro) {
          remember({ distro: body.distro })
          await resolveBridge(); bridge.restart()
        } else if ((body.mode === 'reuse' || body.mode === 'private') && body.mode !== readJson(CONFIG_FILE).mode) {
          // Another DSH and another DSH home: the daemon is replaced on the next connect.
          remember({ mode: body.mode })
          await resolveBridge(); bridge.restart()
        } else if (typeof body.autoUpdate === 'boolean') {
          remember({ autoUpdate: body.autoUpdate })
          if (body.autoUpdate) void selfUpdate.check()
        } else if (body.action === 'check-plugin') {
          await selfUpdate.check()
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
      writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], dropped: [...(state.dropped ?? [])], routes: [...forwarded.keys()], settingsSync: lastSync })
    }
  }
  ctx.effect(() => { const t = setInterval(() => void syncSettings('periodic'), 60_000); t.unref(); return () => clearInterval(t) }, 'wsl-mirror: periodic settings sync')

  ctx.on('connection/request', guarded(async (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const method = settingsMethod(pathname)
    const sameVersion = remoteGraph !== undefined && compatibleReleases(raw.release, remoteGraph.graph.release)
    if (req.headers[INNER] !== undefined) return next()
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
  const availability = new EventTarget()   // "change" when the WSL Host comes or goes (routing waits on it)
  let state = mergeGraphs(raw, undefined, orderByModuleGraph)
  const recompute = () => {
    state = mergeGraphs(raw, remoteGraph, orderByModuleGraph)
    syncRoutes()
    writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], dropped: [...(state.dropped ?? [])], routes: [...forwarded.keys()], reason: state.reason })
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
