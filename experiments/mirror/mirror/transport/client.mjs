// Desktop side of the bridge: starts `wsl.exe ... daemon.mjs --bridge` (or any command speaking the same protocol),
// multiplexes HTTP connections to the WSL DSH Host over its stdio, and keeps the Host's address and launch token in
// memory only. Reconnects with backoff when the bridge process ends.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Mux } from './mux.mjs'

/**
 * @param options.command - executable, e.g. 'wsl.exe' (or process.execPath in tests)
 * @param options.args - its arguments, ending in '--bridge'
 * @param options.resolve - instead of command/args: async () => {command, args} or null when the WSL side is not set
 *   up; asked before every (re)connect. While it answers null the bridge waits for retry().
 * @param options.caps - what this side serves for the WSL side, e.g. ['credentials'] (announced after hello)
 * @returns a Bridge: events 'state' ({ connected, dsh, hello }); request(); agent; close()
 */
export function startBridge({ command, args, resolve, caps = [], log = () => {} }) {
  const bridge = new EventEmitter()
  let mux, child, stopped = false, delay = 500, timer, starting = false
  bridge.state = { connected: false, dsh: { state: 'unknown' }, hello: null }
  const set = (patch) => { bridge.state = { ...bridge.state, ...patch }; bridge.emit('state', bridge.state) }

  const run = async () => {
    timer = undefined
    if (stopped || starting || child) return
    starting = true
    let target = { command, args }
    try { if (resolve) target = await resolve() } catch (error) { log(`bridge: ${error.message}`); target = null }
    starting = false
    if (stopped) return
    if (!target) { set({ connected: false, dsh: { state: 'unknown' } }); return }
    child = spawn(target.command, target.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.on('data', (c) => { const text = c.toString('utf8').trimEnd(); log(`bridge stderr: ${text}`); if (text) set({ lastError: text.split('\n').slice(-1)[0] }) })
    mux = new Mux(child.stdout, child.stdin, { side: 'opener' })
    // Streams the WSL side opens (e.g. {kind:'credentials'}) go to the 'stream' listeners; none → refused.
    mux.on('stream', (stream, target) => { if (bridge.listenerCount('stream') > 0) bridge.emit('stream', stream, target); else stream.destroy(new Error('not served')) })
    mux.on('control', (m) => {
      if (m.type === 'hello') { delay = 500; mux.control({ type: 'client', caps }); set({ connected: true, hello: m, lastError: undefined }) }
      else if (m.type === 'dsh') set({ dsh: { state: m.state, origin: m.origin, token: m.token, exit: m.exit } })
    })
    const down = (why) => {
      if (!bridge.state.connected && why === undefined) return
      set({ connected: false, dsh: { state: 'unknown' } })
      if (stopped) return
      log(`bridge down${why ? `: ${why}` : ''}; retry in ${delay} ms`)
      timer = setTimeout(run, delay); timer.unref?.()
      delay = Math.min(delay * 2, 15_000)
    }
    const own = child
    child.once('exit', (code) => { mux.close(); if (child === own) child = undefined; down(`exit ${code}`) })
    child.once('error', (e) => down(e.message))
  }
  run()
  /** Connect now if not connected (after the person set up the WSL side). */
  bridge.retry = () => {
    if (stopped || child || starting) return
    clearTimeout(timer); delay = 500; void run()
  }
  /** Drop the connection and connect again (another distribution, a re-check). */
  bridge.restart = () => {
    if (stopped) return
    clearTimeout(timer); delay = 500
    if (child) child.kill()   // its exit reconnects after `delay`
    else void run()
  }

  // HTTP over the bridge: every connection is one multiplexed stream to the DSH Host.
  bridge.agent = new (class extends http.Agent {
    createConnection(_options, callback) {
      if (!mux || mux.closed || bridge.state.dsh.state !== 'running') {
        const error = new Error(`WSL DSH Host not available (${bridge.state.connected ? bridge.state.dsh.state : 'bridge disconnected'})`)
        if (callback) { process.nextTick(callback, error); return undefined }
        throw error
      }
      const stream = mux.open({ kind: 'dsh' })
      stream.setTimeout = () => stream; stream.setNoDelay = () => stream; stream.setKeepAlive = () => stream; stream.ref = () => stream; stream.unref = () => stream
      if (callback) process.nextTick(callback, null, stream)
      return stream
    }
  })({ keepAlive: false })

  /** Resolve once the WSL DSH Host is running (or reject after timeoutMs). */
  bridge.ready = (timeoutMs = 60_000) => new Promise((resolve, reject) => {
    if (bridge.state.dsh.state === 'running') return resolve(bridge.state)
    const timer = setTimeout(() => { bridge.off('state', on); reject(new Error('WSL DSH Host did not start in time')) }, timeoutMs)
    const on = (s) => { if (s.dsh.state === 'running') { clearTimeout(timer); bridge.off('state', on); resolve(s) } }
    bridge.on('state', on)
  })

  /** A Node http request to the WSL DSH Host; the Host header is its own authority, as its trust fence expects. */
  bridge.request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const { origin } = bridge.state.dsh
    if (!origin) return reject(new Error('WSL DSH Host not available'))
    const url = new URL(path, origin)
    const req = http.request({ agent: bridge.agent, host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { host: url.host, ...headers } }, resolve)
    req.once('error', reject)
    if (body !== undefined) req.end(body); else req.end()
  })

  bridge.close = () => { stopped = true; child?.kill(); mux?.close() }
  return bridge
}
