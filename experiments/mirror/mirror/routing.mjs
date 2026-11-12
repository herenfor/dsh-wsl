// Per-session routing: each Session runs on this Host or on the WSL Host, and the page lists both.
//
// Unary calls arrive through client-connection's `connection/request` waterfall (see index.mjs); streams are opened by
// the Typert gateway's `openWireStream`, which this module wraps. A call or stream that names WSL identities (ids.mjs)
// goes to the WSL Host with the prefix removed, and what comes back gets it added. The Workspace list, Session list,
// Session control and forwarded-event streams are merged from both Hosts (sessions.mjs).
//
// Where a new Session runs is decided when the page asks for one (`session/create`): folders that live in WSL always
// run there; for other folders the run location chosen on the new-task page (`/wsl-bridge/run-target`) decides.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isWsl, routeOf, toPage, toWsl, translate } from './ids.mjs'
import { applyWorkspaceFrame, baselineFrames, localizeSessions, mergeWorkspaces, pathMapping, placeSession, prefixEvent, prefixProjections } from './sessions.mjs'
import { remoteError, upgradeHeaders, WslMux } from './remote-mux.mjs'

/** Namespaces that belong to this Host whatever they name (handled elsewhere or never per-session). */
const LOCAL_ONLY = /^(?:settings|credentials|plugins|pluginManager|pluginInventory|pluginMarket|pluginRegistryProbe|pluginRecommendations|cordis|account|remoteAccess|productAnalytics|llm|directoryPicker)\//
const MERGED_LISTS = new Set(['session/list', 'session/search'])
const MERGED_STREAMS = new Set(['workspace/follow', 'session/control', '$events'])
const RUN_TARGETS_FILE = join(homedir(), '.dsh-wsl', 'run-targets.json')

export function installSessionRouting(ctx, { bridge, remoteOrigin, cookie, forwardApi, remoteFetch, readBody, available, whenAvailable, distro, setupState = () => 'connected' }) {
  const logger = ctx.logger
  const paths = () => pathMapping(process.platform, distro())

  // State shared by every page: the latest Workspace lists seen on either Host, twin folders, event clients.
  let localWorkspaces
  let wslWorkspaces
  let twins = new Map()
  const eventClients = new Map()   // this Host's $events client id → the WSL Host's
  // Creator (cordis) in a WSL task asks the page through $events: inspection queries and run approvals carry ids the
  // page answers with; plugin runs it starts are named by pluginRunId. Remembered so the answers go back to WSL.
  const wslCordis = { requests: new Set(), runs: new Set(), manifest: undefined }
  let runTargets = new Map()
  try { runTargets = new Map(Object.entries(JSON.parse(readFileSync(RUN_TARGETS_FILE, 'utf8')))) } catch {}
  const saveRunTargets = () => {
    try { mkdirSync(dirname(RUN_TARGETS_FILE), { recursive: true }); writeFileSync(RUN_TARGETS_FILE, `${JSON.stringify(Object.fromEntries(runTargets), null, 2)}\n`) } catch {}
  }
  const remember = () => {
    const merged = mergeWorkspaces(localWorkspaces, wslWorkspaces, paths())
    twins = merged.twins
    return merged.value
  }

  // ---- the WSL Host's stream mux, over the bridge
  const mux = new WslMux(async () => {
    const origin = remoteOrigin()
    if (!origin) throw new Error('the WSL DSH Host is not available')
    const url = new URL('/api/remote.mux', origin)
    const { headers, accept } = upgradeHeaders()
    const cookieHeader = await cookie()
    return new Promise((resolve, reject) => {
      const req = http.request({ agent: bridge.agent, host: url.hostname, port: url.port, path: url.pathname, headers: { ...headers, host: url.host, origin, cookie: cookieHeader } })
      req.once('upgrade', (res, socket, head) => {
        if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); reject(new Error('the WSL Host answered the stream upgrade wrongly')); return }
        resolve({ socket, head })
      })
      req.once('response', (res) => { res.resume(); reject(new Error(`the WSL Host refused the stream connection (${res.statusCode})`)) })
      req.once('error', reject)
      req.end()
    })
  })
  ctx.effect(() => () => mux.close(), 'wsl-mirror: WSL stream mux')
  let lastToken = bridge.state.dsh.token
  bridge.on('state', (s) => { if (s.dsh.token !== lastToken) { lastToken = s.dsh.token; mux.close() } })

  // ---- unary calls
  const rpc = async (endpoint, args) => {
    const r = await forwardApi(`/api/${endpoint}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } })))
    const json = await r.json()
    if (!json?.result) throw new Error(`${endpoint} answered ${r.status}`)
    return json.result
  }
  const reply = (res, rpcId, result) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }
  const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })
  /** Forward one call to the WSL Host, identities rewritten both ways; non-JSON answers are passed through. */
  async function forward(res, pathname, message, payload) {
    const upstream = await forwardApi(pathname, Buffer.from(JSON.stringify({ ...message, payload: translate(payload, false) })))
    const type = upstream.headers.get('content-type') ?? ''
    if (!type.startsWith('application/json')) {
      res.writeHead(upstream.status, { 'content-type': type })
      res.end(Buffer.from(await upstream.arrayBuffer()))
      return
    }
    const json = await upstream.json()
    if (json?.result?.ok) json.result.value = translate(json.result.value, true)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(json))
  }
  const replay = (req, body) => { req[Symbol.asyncIterator] = async function* () { yield body }; req.headers['content-length'] = String(body.length) }
  const ownHost = async (req, pathname, body) => {
    const r = await fetch(`${ctx.webServer.getOrigin()}${pathname}`, {
      method: 'POST', body,
      headers: { cookie: req.headers.cookie ?? '', origin: ctx.webServer.getOrigin(), 'content-type': 'application/json', 'x-dsh-wsl-mirror-inner': '1' },
    })
    return r.json()
  }

  /** Returns true when the call was handled here; otherwise the caller passes it on (the body is replayed). */
  const debug = process.env.DSH_WSL_DEBUG ? (...a) => { try { writeFileSync(process.env.DSH_WSL_DEBUG, `${new Date().toISOString()} ${a.join(' ')}\n`, { flag: 'a' }) } catch {} } : () => {}
  async function call(req, res, next, pathname, endpoint) {
    debug('call', endpoint, available())
    if (pathname === '/api/session/uploadFileBinary') return upload(req, res, next)
    if (LOCAL_ONLY.test(endpoint) || !available()) return next()
    const body = await readBody(req)
    let message
    try { message = JSON.parse(body.toString('utf8')) } catch { replay(req, body); return next() }
    const payload = message?.payload
    const args = payload?.args ?? {}
    const local = (changed) => { replay(req, changed === undefined ? body : Buffer.from(JSON.stringify({ ...message, payload: { ...payload, args: changed } }))); return next() }

    if (MERGED_LISTS.has(endpoint)) {
      const [mine, theirs] = await Promise.all([ownHost(req, pathname, body), rpc(endpoint, translate(args, false)).catch(() => undefined)])
      if (mine?.result?.ok && theirs?.ok) mine.result.value = { ...mine.result.value, items: [...mine.result.value.items, ...localizeSessions(translate(theirs.value, true).items, paths())] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mine))
      return
    }
    if (endpoint === 'workspace/delete' && !isWsl(args.request?.workspaceId) && twins.has(args.request?.workspaceId)) {
      // Removing a Windows folder also removes the WSL Host's twin; otherwise its tasks would reappear as a row of
      // their own. Like the official delete, this only unregisters the folders: no file or task record is deleted.
      const workspaceId = args.request.workspaceId
      const mine = await ownHost(req, pathname, body)
      if (mine?.result?.ok) {
        const theirs = await rpc(endpoint, translate({ request: { workspaceId: twins.get(workspaceId) } }, false)).catch((error) => ({ ok: false, error }))
        if (!theirs.ok) ctx.logger?.warn?.('wsl-mirror: removing the WSL twin of %s failed: %s', workspaceId, theirs.error?.message)
        twins.delete(workspaceId)
        if (runTargets.delete(workspaceId)) saveRunTargets()
      }
      return reply(res, message.rpcId, mine?.result ?? failure('internal', 'workspace/delete failed'))
    }
    if ((endpoint === 'session/openWorkspacePath' || endpoint === 'session/workspacePathApplications') && typeof args.request?.path === 'string' && args.request.path.startsWith('/')) {
      // A WSL task's file paths are the WSL Host's (/home/..., /mnt/d/...). Opening happens on this desktop, so the
      // path is turned into this Host's form (\\wsl.localhost\<distro>\..., D:\...) and the call stays here.
      const path = paths().toLocal(args.request.path)
      if (path !== args.request.path) return local({ ...args, request: { ...args.request, path } })
    }
    if (endpoint.startsWith('dynamicCordisRunner/')) {
      const method = endpoint.slice('dynamicCordisRunner/'.length)
      if (method === 'syncInspectManifest') {
        // The page's own APIs: both Hosts' Creator may inspect them.
        wslCordis.manifest = args
        rpc(endpoint, args).catch(() => {})
        return local()
      }
      if (method === 'inventory') {
        const [mine, theirs] = await Promise.all([ownHost(req, pathname, body), rpc(endpoint, {}).catch(() => undefined)])
        if (mine?.result?.ok && theirs?.ok) mine.result.value = [...mine.result.value, ...translate(theirs.value, true)]
        return reply(res, message.rpcId, mine?.result ?? failure('internal', 'no inventory'))
      }
      const toWslHost = method === 'resolveRequestRun' ? wslCordis.requests.has(args.requestId)
        : method === 'invoke' ? wslCordis.runs.has(args.pluginRunId)
        : isWsl(args.agentId)
      if (!toWslHost) return local()
      if (method === 'getClientCode' && typeof args.pluginRunId === 'string') wslCordis.runs.add(args.pluginRunId)
      if (method === 'resolveInspectQuery' || method === 'resolveRequestRun') wslCordis.requests.delete(args.requestId)
      const result = await rpc(endpoint, translate(args, false))
      return reply(res, message.rpcId, result.ok ? { ok: true, value: translate(result.value, true) } : result)
    }
    if (endpoint === '$events/result') {
      if (!isWsl(args.eventId)) return local()
      const clientId = eventClients.get(args.clientId)
      if (clientId === undefined) return reply(res, message.rpcId, failure('wsl/events', 'No WSL event stream for this page.'))
      return reply(res, message.rpcId, await rpc(endpoint, { ...args, clientId, eventId: toWsl(args.eventId) }))
    }
    if (endpoint === 'workspace/create' && paths().insideWsl(args.request?.path)) {
      const result = await rpc(endpoint, { request: { ...args.request, path: paths().toWsl(args.request.path) } })
      if (result.ok) result.value = { ...translate(result.value, true), workspace: { ...translate(result.value.workspace, true), path: args.request.path } }
      return reply(res, message.rpcId, result)
    }
    if (endpoint === 'agentPresets/list') {
      const { mine, theirs } = await presets(req)
      if (!mine?.ok) return reply(res, message.rpcId, mine ?? failure('internal', 'no preset list'))
      return reply(res, message.rpcId, { ok: true, value: { ...mine.value, presets: mergePresets(mine.value.presets, theirs) } })
    }
    if (endpoint === 'agentPresets/read') {
      const mine = await ownHost(req, pathname, body)
      if (mine?.result?.ok || mine?.result?.error?.code !== 'agent-preset/not-found') return reply(res, message.rpcId, mine?.result)
      return reply(res, message.rpcId, await rpc(endpoint, args))
    }
    if (endpoint === 'agentPresets/select' && !isWsl(args.agentId)) {
      const refusal = await wslOnlyPreset(req, args.agentPreset)
      if (refusal) return reply(res, message.rpcId, refusal)
    }
    if (endpoint === 'session/create') {
      const request = args.request ?? {}
      const runsHere = !isWsl(request.workspaceId) && !paths().insideWsl(request.cwd) && (runTargets.get(request.workspaceId) ?? 'local') === 'local'
      const refusal = runsHere ? await wslOnlyPreset(req, request.agentPreset) : undefined
      if (refusal) return reply(res, message.rpcId, refusal)
      return create(req, res, next, message, args, local)
    }
    if (endpoint === 'workspace/insertSessionBefore' && isWsl(args.request?.sessionId) && !isWsl(args.request?.workspaceId)) {
      // Reordering a WSL Session inside a Windows folder: the order lives in the folder's twin on the WSL Host.
      const twin = twins.get(args.request.workspaceId)
      if (twin === undefined) return reply(res, message.rpcId, failure('wsl/no-twin', 'This folder has no WSL counterpart.'))
      const { beforeSessionId, ...rest } = args.request
      return forward(res, pathname, message, { ...payload, args: { request: { ...rest, workspaceId: twin, ...(isWsl(beforeSessionId) ? { beforeSessionId } : {}) } } })
    }
    let route
    try { route = routeOf(args, endpoint) } catch (error) { return reply(res, message.rpcId, failure(error.code, error.message)) }
    if (route === 'local') return local()
    return forward(res, pathname, message, payload)
  }

  // Agent presets (modes): plugins usually live in WSL, so the mode list shows both Hosts'. A mode only the WSL Host has
  // is marked, and choosing it for a task that runs here says to switch the run location.
  const presetCall = (req, endpoint) => ownHost(req, `/api/${endpoint}`, Buffer.from(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: {} } })))
  async function presets(req) {
    const [mine, theirs] = await Promise.all([presetCall(req, 'agentPresets/list').then((r) => r?.result), rpc('agentPresets/list', {}).catch(() => undefined)])
    return { mine, theirs: theirs?.ok ? theirs.value.presets : [] }
  }
  async function wslOnlyPreset(req, id) {
    if (typeof id !== 'string') return undefined
    const { mine, theirs } = await presets(req)
    if (!mine?.ok || mine.value.presets.some((p) => p.id === id)) return undefined
    const row = theirs.find((p) => p.id === id)
    if (!row) return undefined
    return failure('agent-preset/not-found', `"${row.name ?? id}" 模式来自 WSL 中的插件，只能用于在 WSL 中运行的任务。请在输入框下方把运行位置切换到 WSL。`)
  }

  async function create(req, res, next, message, args, local) {
    const request = args.request ?? {}
    if (request.workspaceId === undefined && paths().insideWsl(request.cwd)) {
      const result = await rpc('session/create', { request: { ...request, cwd: paths().toWsl(request.cwd) } })
      return reply(res, message.rpcId, result.ok ? { ok: true, value: translate(result.value, true) } : result)
    }
    const target = runTargets.get(request.workspaceId) ?? 'local'
    const place = placeSession(request, { target, twin: twins.get(request.workspaceId) })
    if (place.host === 'local') return local({ ...args, request: place.request })
    if (place.needsTwin) {
      const folder = localWorkspaces?.items.find((w) => w.workspaceId === request.workspaceId)
      if (folder === undefined) return reply(res, message.rpcId, failure('wsl/unknown-folder', 'This folder is not known yet; reopen the page and try again.'))
      const created = await rpc('workspace/create', { request: { path: paths().toWsl(folder.path) } })
      if (!created.ok) return reply(res, message.rpcId, created)
      place.request.workspaceId = toPage(created.value.workspace.workspaceId)
      twins.set(request.workspaceId, place.request.workspaceId)
    }
    const result = await rpc('session/create', translate({ request: place.request }, false))
    return reply(res, message.rpcId, result.ok ? { ok: true, value: translate(result.value, true) } : result)
  }

  async function upload(req, res, next) {
    const url = new URL(req.url, 'http://x')
    const sessionId = url.searchParams.get('sessionId')
    if (!isWsl(sessionId) || !available()) return next()
    url.searchParams.set('sessionId', toWsl(sessionId))
    const upstream = await remoteFetch(`${url.pathname}${url.search}`, {
      method: 'POST', body: req,
      headers: { cookie: await cookie(), origin: remoteOrigin(), 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    const text = await upstream.text()
    try { res.end(JSON.stringify(translate(JSON.parse(text), true))) } catch { res.end(text) }
  }

  // ---- run location of new Sessions in a folder of this Host: GET ?workspaceId= / POST {workspaceId, target}
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/wsl-bridge/run-target',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      let workspaceId = new URL(req.url, 'http://x').searchParams.get('workspaceId')
      let presetAvailable
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8'))
          workspaceId = body.workspaceId
          if (typeof workspaceId === 'string' && !isWsl(workspaceId) && (body.target === 'wsl' || body.target === 'local')) {
            if (body.target === 'local') runTargets.delete(workspaceId); else runTargets.set(workspaceId, 'wsl')
            saveRunTargets()
          }
          // Switching a blank task carries its mode over when the chosen side has it (the page asks with agentPreset).
          if (typeof body.agentPreset === 'string') {
            const { mine, theirs } = await presets(req)
            const side = (isWsl(workspaceId) || runTargets.get(workspaceId) === 'wsl') ? theirs : mine?.ok ? mine.value.presets : []
            presetAvailable = side.some((p) => p.id === body.agentPreset)
          }
        } catch {}
      }
      const folder = isWsl(workspaceId) ? wslWorkspaces?.items.find((w) => w.workspaceId === workspaceId) : localWorkspaces?.items.find((w) => w.workspaceId === workspaceId)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        workspaceId,
        target: isWsl(workspaceId) ? 'wsl' : runTargets.get(workspaceId) ?? 'local',
        insideWsl: isWsl(workspaceId),
        wslAvailable: available(),
        setup: setupState(),
        distro: distro() ?? null,
        wslPath: folder ? (isWsl(workspaceId) ? folder.path : paths().toWsl(folder.path)) : null,
        ...(presetAvailable === undefined ? {} : { presetAvailable }),
      }))
    },
  }), 'wsl-mirror: run target route')

  // ---- WSL directory browsing for the add-folder dialog: GET ?path= lists, POST {path, name} creates a folder.
  // Paths are the WSL Host's (/home/...); the page turns the chosen one into \\wsl.localhost\<distro>\...
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/wsl-bridge/dirs',
    async handler(req, res) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return }
      const send = (result) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result)) }
      if (!available()) return send(failure('wsl/unavailable', 'WSL 端未连接或版本不同'))
      try {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8'))
          return send(await rpc('directoryPicker/createDirectory', { path: body.path, name: body.name }))
        }
        const path = new URL(req.url, 'http://x').searchParams.get('path')
        return send(await rpc('directoryPicker/list', path ? { path } : {}))
      } catch (error) { return send(failure('wsl/unavailable', error.message)) }
    },
  }), 'wsl-mirror: WSL directory browsing route')

  // ---- streams
  const gateway = ctx.typertGateway
  const ownOpen = Object.hasOwn(gateway, 'openWireStream')
  const originalOpen = gateway.openWireStream
  gateway.openWireStream = async function (endpoint, payload, uplink, peer, signal, control, window) {
    const native = () => originalOpen.call(this, endpoint, payload, uplink, peer, signal, control, window)
    // The merged streams take in the WSL Host whenever it comes: one opened before WSL connected (Desktop starting,
    // the person still setting WSL up) keeps trying it, and picks it up once it is there.
    if (MERGED_STREAMS.has(endpoint)) return merged(endpoint, payload, signal, await native())
    if (!available()) return native()
    let route
    try { route = routeOf(payload?.args, endpoint) } catch (error) { throw remoteError({ code: error.code, message: error.message }) }
    if (route === 'local') return native()
    return (async function* () {
      for await (const value of mux.open(endpoint, translate(payload, false), signal, uplink)) yield translate(value, true)
    })()
  }
  ctx.effect(() => () => { if (ownOpen) gateway.openWireStream = originalOpen; else delete gateway.openWireStream }, 'wsl-mirror: restore gateway')

  /** One merged stream: this Host's (`native`, already open) and the WSL Host's, kept open with retries. */
  async function* merged(endpoint, payload, signal, native) {
    const queue = new Queue()
    const scope = new AbortController()
    const combined = AbortSignal.any([signal, scope.signal])
    void (async () => {
      try { for await (const value of native) queue.push({ source: 'local', value }); queue.push({ source: 'local', end: true }) } catch (error) { queue.push({ source: 'local', error }) }
    })()
    void (async () => {
      // While WSL is not there this waits for it to come (no polling); while the WSL stream is open nothing retries.
      // Only a stream that fails while WSL is there is retried, with backoff.
      for (let attempt = 0; !combined.aborted; attempt++) {
        if (!available()) {
          queue.push({ source: 'wsl', down: true })
          await whenAvailable(combined)
          attempt = 0
          continue
        }
        try {
          for await (const value of mux.open(endpoint, translate(payload, false), combined)) { attempt = 0; queue.push({ source: 'wsl', value: translate(value, true) }) }
        } catch (error) { if (combined.aborted) return; if (attempt === 0) logger.debug('wsl-mirror: %s from WSL: %s', endpoint, error.message) }
        queue.push({ source: 'wsl', down: true })
        await new Promise((r) => { const t = setTimeout(r, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))); combined.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
      }
    })()
    try {
      if (endpoint === 'workspace/follow') yield* followWorkspaces(queue, combined)
      else if (endpoint === 'session/control') yield* followControl(queue, combined)
      else yield* followEvents(queue, combined)
    } finally { scope.abort() }
  }

  async function* followWorkspaces(queue, signal) {
    // The first frame waits briefly for the WSL Host's folders, so the sidebar does not fill in twice.
    let started = false
    let localReady = false
    let wslReady = false
    let grace
    try {
      for (;;) {
        const item = await queue.next(signal)
        if (item.source === 'local' && item.end) return
        if (item.error) throw item.error
        if (item.down || item.graceOver) wslReady = true  // keep the last known WSL folders while it reconnects
        else if (item.source === 'local') { localWorkspaces = applyWorkspaceFrame(localWorkspaces, item.value); localReady = true }
        else { wslWorkspaces = applyWorkspaceFrame(wslWorkspaces, item.value); wslReady = true }
        if (!started) {
          if (!localReady) continue
          if (!wslReady) { grace ??= setTimeout(() => queue.push({ graceOver: true }), 1500); continue }
        } else if (item.down || item.graceOver) continue
        yield { type: started ? 'replace' : 'baseline', value: remember() }
        started = true
      }
    } finally { clearTimeout(grace) }
  }

  async function* followControl(queue, signal) {
    // One baseline per stream generation, from both Hosts; the WSL Host gets a short grace period.
    const snapshots = {}
    const waiting = new Set(['local', 'wsl'])
    const buffered = []
    const grace = setTimeout(() => queue.push({ source: 'wsl', down: true }), 3000)
    try {
      for (;;) {
        const item = await queue.next(signal)
        if (item.source === 'local' && item.end) return
        if (item.error) throw item.error
        if (waiting.size > 0) {
          if (item.down) waiting.delete('wsl')
          else if (item.value.type === 'baseline') {
            Object.assign(snapshots, item.source === 'wsl' ? prefixProjections(item.value.value).projections : item.value.value.projections)
            waiting.delete(item.source)
          } else buffered.push(item.value)
          if (waiting.size === 0) { yield { type: 'baseline', value: { projections: snapshots } }; yield* buffered.splice(0) }
          continue
        }
        if (item.down) continue
        if (item.value.type === 'baseline') {
          // The page does not reopen a failed control stream, so a WSL Host that connects late (it starts with the
          // Desktop, after the page) or reconnects is folded in as one projection frame per Session: the page's
          // stores keep the higher seq per key, as with any live frame.
          if (item.source === 'wsl') { yield* baselineFrames(prefixProjections(item.value.value)); continue }
          throw remoteError({ code: 'gateway/carrier', message: 'Session control restarted.' })
        }
        yield item.value
      }
    } finally { clearTimeout(grace) }
  }

  async function* followEvents(queue, signal) {
    let localClient
    let wslClient
    const buffered = []
    try {
      for (;;) {
        const item = await queue.next(signal)
        if (item.source === 'local' && item.end) return
        if (item.error) throw item.error
        if (item.down) continue
        const frame = item.value
        if (frame.type === 'ready') {
          if (item.source === 'local') { localClient = frame.clientId; yield frame; yield* buffered.splice(0) } else {
            wslClient = frame.clientId
            // A WSL Host that (re)connected has not seen the page's APIs yet.
            if (wslCordis.manifest !== undefined) rpc('dynamicCordisRunner/syncInspectManifest', wslCordis.manifest).catch(() => {})
            // The page lists Sessions once per connection (session/list); WSL may come after that (Desktop started
            // first, the person still setting WSL up, the WSL Host restarted). Its Sessions are announced to the page
            // as added, once per WSL connection, which the page merges by id.
            void rpc('session/list', { _request: {} }).then((result) => {
              if (!result?.ok || signal.aborted) return
              for (const summary of localizeSessions(translate(result.value, true).items, paths())) queue.push({ source: 'wsl', value: { type: 'emit', event: 'api-session/added', args: [summary] }, listed: true })
            }).catch((error) => logger.debug('wsl-mirror: WSL session list: %s', error.message))
          }
          if (localClient !== undefined && wslClient !== undefined) eventClients.set(localClient, wslClient)
          continue
        }
        if (item.source === 'wsl' && frame.type === 'emit') noteCordis(frame)
        let out = frame
        if (item.source === 'wsl' && !item.listed) {
          out = prefixEvent(frame)
          // A Session the WSL Host adds names its folder as WSL sees it; the page knows it as this side does.
          if (out.event === 'api-session/added' && typeof out.args?.[0]?.cwd === 'string') out = { ...out, args: [localizeSessions([out.args[0]], paths())[0], ...out.args.slice(1)] }
        }
        if (localClient === undefined) buffered.push(out); else yield out
      }
    } finally { if (localClient !== undefined) eventClients.delete(localClient) }
  }

  function noteCordis(frame) {
    const [request] = frame.args ?? []
    const id = request?.requestId
    if (typeof id !== 'string') return
    if (frame.event === 'cordis/inspect-query' || frame.event === 'cordis/request-run') wslCordis.requests.add(id)
    else if (frame.event === 'cordis/inspect-query-resolved' || frame.event === 'cordis/request-run-resolved') wslCordis.requests.delete(id)
  }

  // Raw ids of the WSL Host's Workspaces, for plugin bodies that name them.
  const wslWorkspaceIds = () => new Set((wslWorkspaces?.items ?? []).map((w) => toWsl(w.workspaceId)))
  return { call, wslWorkspaceIds }
}

/** Both Hosts' modes: this Host's as they are, then the WSL Host's that this one lacks, marked. */
export function mergePresets(mine, theirs) {
  const have = new Set(mine.map((p) => p.id))
  return [...mine, ...theirs.filter((p) => !have.has(p.id)).map((p) => ({ ...p, isDefault: false, name: `${p.name ?? p.id} · WSL` }))]
}

class Queue {
  values = [];
  push(value) { this.values.push(value); this.wake?.() }
  async next(signal) {
    while (!this.values.length) {
      signal.throwIfAborted()
      await new Promise((resolve) => { this.wake = resolve; this.signal = signal; signal.addEventListener('abort', resolve, { once: true }) })
      signal.removeEventListener('abort', this.wake)
      this.wake = undefined
    }
    return this.values.shift()
  }
}
