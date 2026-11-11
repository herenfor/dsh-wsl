// Desktop side of the UI mirror experiment. Follows the WSL agent's event stream and makes this Host's client module
// registry publish the merged graph, so the page here mounts the WSL Host's user plugins; their bundle, chunk and asset
// requests are forwarded to the WSL Host. It patches two members of the registry instance (`composed` and
// `fetchBundle`) and restores them on dispose. HTTP routes that only the WSL Host serves (those of plugins installed
// only in WSL) are registered here too and forwarded, after this Host's own login and origin check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { mergeGraphs, requestedPackages, sameRelease } from './merge.mjs'
import { DROP_RESPONSE_HEADERS, FORWARD_REQUEST_HEADERS, routesToForward } from './routes.mjs'
import { mergeDescribe, settingsMethod, SETTINGS_WRITES } from './settings.mjs'

export const name = 'wsl-mirror'
export const inject = ['clientModules', 'webServer', 'connection']
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const EVENTS = '/wsl-bridge/events'
const FORWARDED_HEADERS = ['content-type', 'cache-control', 'etag', 'content-length']

// Experiment only: without remote and token in the entry config, read them from ~/.dsh-wsl/remote.json.
export const REMOTE_FILE = join(homedir(), '.dsh-wsl', 'remote.json')
// Experiment only: the latest merge outcome, so a test can read it without access to the Host's logger.
export const STATUS_FILE = join(homedir(), '.dsh-wsl', 'mirror-status.json')
function writeStatus(status) {
  try { mkdirSync(dirname(STATUS_FILE), { recursive: true }); writeFileSync(STATUS_FILE, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...status }, null, 2)}\n`) } catch {}
}
function readRemote(config) {
  if (config.remote && config.token) return config
  try { return JSON.parse(readFileSync(REMOTE_FILE, 'utf8')) } catch { return {} }
}

export async function apply(ctx, config = {}) {
  // let: re-read after a failed connection, so a restarted WSL Host's new token takes effect without restarting this one.
  let { remote, token } = readRemote(config ?? {})
  if (!remote || !token) { writeStatus({ reason: 'no remote configured' }); ctx.logger.warn('wsl-mirror: no remote; set remote and token in config or %s', REMOTE_FILE); return }
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
      const upstream = await fetch(`${remote}${req.url}`, {
        method: req.method, headers, signal: abort.signal, redirect: 'manual',
        ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      })
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
  const callRemoteApi = async (method, body) => fetch(`${remote}/api/settings/${method}`, {
    method: 'POST', body,
    headers: { cookie: await cookie(), origin: remote, 'content-type': 'application/json' },
  })
  const answer = async (res, upstream) => {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  }
  ctx.on('connection/request', async (req, res, next) => {
    const method = settingsMethod(new URL(req.url ?? '/', 'http://x').pathname)
    const sameVersion = remoteGraph !== undefined && sameRelease(raw.release, remoteGraph.graph.release)
    if (method === undefined || !sameVersion || req.headers[INNER] !== undefined) return next()
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
    return next()
  })

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
    const res = await fetch(`${remote}${pathname}${search}`, { method: request.method, headers })
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
  let cookieValue
  async function cookie() {
    if (cookieValue) return cookieValue
    const res = await fetch(`${remote}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
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
        const res = await fetch(`${remote}${EVENTS}`, { headers: { cookie: await cookie() }, signal: controller.signal })
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
            remoteGraph = JSON.parse(data)
            recompute()
            reg.notifyGraphChanged()
          }
        }
      } catch (error) {
        if (stopped) return
        writeStatus({ local: raw.release, mirrored: [...state.mirrored.keys()], reason: `connection: ${error.message}` })
        ctx.logger.warn('wsl-mirror: %s', error.message)
        cookieValue = undefined
        ;({ remote, token } = readRemote(config ?? {}))
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  })()
}
