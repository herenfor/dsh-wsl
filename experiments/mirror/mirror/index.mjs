// Desktop side of the UI mirror experiment. Follows the WSL agent's event stream and makes this Host's client module
// registry publish the merged graph, so the page here mounts the WSL Host's user plugins; their bundle, chunk and asset
// requests are forwarded to the WSL Host. It patches two members of the registry instance (`composed` and
// `fetchBundle`) and restores them on dispose.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeGraphs, requestedPackages } from './merge.mjs'

export const name = 'wsl-mirror'
export const inject = ['clientModules']
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
  const { remote, token } = readRemote(config ?? {})
  if (!remote || !token) { writeStatus({ reason: 'no remote configured' }); ctx.logger.warn('wsl-mirror: no remote; set remote and token in config or %s', REMOTE_FILE); return }
  const reg = ctx.clientModules
  const { orderByModuleGraph } = await import(pathToFileURL(join(dirname(reg.clientPath(MODULES_ID)), 'index.js')).href)

  let raw = reg.composed
  let remoteGraph
  let state = mergeGraphs(raw, undefined, orderByModuleGraph)
  const recompute = () => {
    state = mergeGraphs(raw, remoteGraph, orderByModuleGraph)
    writeStatus({ local: raw.release, remote: remoteGraph?.graph.release, mirrored: [...state.mirrored.keys()], reason: state.reason })
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
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  })()
}
