// WSL side of the bridge.
//   node daemon.mjs --serve  [options]   long-running: runs the DSH Host, accepts bridges on a Unix socket
//   node daemon.mjs --bridge [options]   started by wsl.exe: joins its stdio to the daemon (starting it if needed)
// Options: --profile <name> (desktop-wsl); --dsh <DSH's entry script> (else searched); --stamp <bridge files stamp>;
// --dsh-home <dir> (else DSH's default ~/.dsh, shared with the person's own WSL DSH; the seam for moving sessions).
// A bridge whose stamp, DSH or DSH home differs from the running daemon's replaces that daemon (after a plugin or DSH
// update). Before starting DSH the daemon creates the profile from the web template and adds this plugin's WSL half
// (../agent) when they are missing; both are local operations.
// Run directory ~/.dsh-wsl/run/<profile>/ (mode 700): rpc.sock, daemon.token (600), daemon.log, daemon.json.
// The DSH Host listens on 127.0.0.2, which WSL's localhost forwarding does not expose to Windows; the only way in from
// Windows is a bridge, and a bridge must present the daemon token the run directory holds.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mux } from './mux.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const PROFILE = option('--profile', 'desktop-wsl')
const RUN = join(homedir(), '.dsh-wsl', 'run', PROFILE)
const SOCKET = join(RUN, 'rpc.sock')
const TOKEN_FILE = join(RUN, 'daemon.token')
const LOG = join(RUN, 'daemon.log')
const IDENTITY_FILE = join(RUN, 'daemon.json')
const DSH_OPTION = option('--dsh')
const STAMP = option('--stamp', '')
const DSH_HOME_OPTION = option('--dsh-home')
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent')
const DSH_HOST = '127.0.0.2'
// wsl.exe --exec starts us without a login shell, so PATH may lack ~/.local/bin: find DSH's entry script ourselves and
// run it with this same node; its own child processes get node's directory and ~/.local/bin on PATH.
function findDsh() {
  const candidates = [DSH_OPTION, process.env.DSH_BIN, join(homedir(), '.dsh-wsl', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), join(dirname(process.execPath), 'dsh'), join(homedir(), '.local', 'bin', 'dsh'), '/usr/local/bin/dsh', '/usr/bin/dsh']
  for (const c of candidates) if (c && existsSync(c)) return realpathSync(c)
  throw new Error('dsh is not installed in WSL (set DSH_BIN)')
}
// The WSL DSH Host always uses the default DSH home (~/.dsh): a DSH_HOME inherited from whoever started the daemon
// (a test Host, a shell) must not move it elsewhere.
const childEnv = () => ({ ...withoutDshHome(process.env), ...(DSH_HOME_OPTION ? { DSH_HOME: DSH_HOME_OPTION } : {}), DSH_WSL_RUN: RUN, PATH: [dirname(process.execPath), join(homedir(), '.local', 'bin'), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter) })
export const PROTOCOL = 1

function withoutDshHome(env) { const { DSH_HOME, ...rest } = env; return rest }
/** DSH's version, read from the package that holds its entry script. */
function dshVersion(entry) {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    try { const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (pkg.name === '@deepseek-ai/dsh') return pkg.version } catch {}
  }
  return undefined
}
/** What a daemon runs: a bridge started with a different identity replaces it. */
function identity() {
  let dsh = null
  try { dsh = findDsh() } catch {}
  return { stamp: STAMP, dsh, version: dsh ? dshVersion(dsh) ?? null : null, dshHome: DSH_HOME_OPTION ?? null }
}
const sameIdentity = (a, b) => a && b && a.stamp === b.stamp && a.dsh === b.dsh && a.version === b.version && a.dshHome === b.dshHome
/** Create the profile and add the WSL half of the plugin when missing. Local operations only (a link: dependency). */
function ensureProfile(dsh) {
  const home = DSH_HOME_OPTION ?? join(homedir(), '.dsh')
  const dir = join(home, 'profiles', PROFILE)
  const step = (what, argv) => {
    const r = spawnSync(process.execPath, [dsh, ...argv], { env: childEnv(), encoding: 'utf8', timeout: 180_000 })
    log(`profile: ${what}: exit ${r.status}${r.status === 0 ? '' : ` ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-400)}`}`)
  }
  if (!existsSync(join(dir, 'package.json'))) step(`create ${PROFILE} from the web template`, [PROFILE, '--from-default-profile', 'web', '--dump-config'])
  let pkg = {}
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch {}
  // The WSL half travels with the Desktop plugin (~/.dsh-wsl/bridge/agent): point the profile at that copy, so it is
  // updated together with the plugin. A daemon run from elsewhere (a development checkout) has no ../agent and leaves
  // the profile as it is.
  if (existsSync(join(AGENT_DIR, 'package.json'))) {
    const spec = `link:${realpathSync(AGENT_DIR)}`
    if (pkg.dependencies?.['dsh-wsl-agent'] !== spec) step(`point dsh-wsl-agent at ${AGENT_DIR}`, ['plugin', '--profile', PROFILE, 'add', spec])
  }
}
const log = (message) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }) } catch {} }
const masked = (text) => text.replace(/token=[A-Za-z0-9_-]+/g, 'token=***')

// ---- serve ----------------------------------------------------------------------------------------------------------
async function serve() {
  mkdirSync(RUN, { recursive: true, mode: 0o700 }); chmodSync(RUN, 0o700)
  if (await reachable()) { log('serve: another daemon already answers; exiting'); return }
  rmSync(SOCKET, { force: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  writeFileSync(IDENTITY_FILE, JSON.stringify({ pid: process.pid, ...identity() }), { mode: 0o600 })

  let dsh = { state: 'starting' }
  const bridges = new Set()
  const caps = new WeakMap()   // bridge mux → capabilities it announced ({type:'client', caps:[...]})
  const announce = () => { for (const mux of bridges) mux.control({ type: 'dsh', ...publicState() }) }
  const publicState = () => ({ state: dsh.state, origin: dsh.origin, token: dsh.token, version: dsh.version, exit: dsh.exit })
  let profileChecked = false
  let current        // the running DSH Host process
  let stopping = false

  let restarts = 0
  const startDsh = () => {
    dsh = { state: 'starting' }
    announce()
    let child
    try {
      const entry = findDsh()
      if (!profileChecked) { ensureProfile(entry); profileChecked = true }
      dsh.version = dshVersion(entry)
      child = current = spawn(process.execPath, [entry, '--profile', PROFILE, '--no-open', '--host', DSH_HOST, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    } catch (error) {
      dsh = { state: 'stopped', exit: { error: error.message } }; log(`dsh: ${error.message}`); announce()
      setTimeout(startDsh, 30_000).unref?.(); return
    }
    let out = ''
    const onLine = (chunk) => {
      out += chunk.toString('utf8')
      const m = /dsh web: (http:\/\/[^/\s]+)\/\?token=([A-Za-z0-9_-]+)/.exec(out)
      if (m && dsh.state === 'starting') { dsh = { state: 'running', origin: m[1], token: m[2], pid: child.pid, version: dsh.version }; restarts = 0; log(`dsh running at ${m[1]} pid ${child.pid}`); announce() }
      if (out.length > 65536) out = out.slice(-8192)
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', (c) => { onLine(c); log(`dsh stderr: ${masked(c.toString('utf8')).trimEnd().slice(0, 500)}`) })
    child.on('exit', (code, signal) => {
      dsh = { state: 'stopped', exit: { code, signal } }
      log(`dsh exited code ${code} signal ${signal}`)
      announce()
      if (stopping) return
      const delay = Math.min(30_000, 1000 * 2 ** restarts++)
      setTimeout(startDsh, delay).unref?.()
    })
  }
  const server = createServer((socket) => {
    // First line: the daemon token (a Desktop bridge), or the token and " broker" (the WSL DSH Host asking Desktop for
    // credentials; see brokerConnection). Anything else closes the connection.
    let head = Buffer.alloc(0)
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const nl = head.indexOf(10)
      if (nl < 0) { if (head.length > 256) socket.destroy(); return }
      socket.off('data', onData)
      const first = head.subarray(0, nl).toString('utf8')
      const rest = head.subarray(nl + 1)
      if (first === `${token} broker`) { brokerConnection(socket, rest); return }
      if (first !== token) { log('bridge rejected: bad token'); socket.destroy(); return }
      const mux = new Mux(socket, socket, { side: 'acceptor' })
      bridges.add(mux)
      log(`bridge joined (${bridges.size} open)`)
      mux.on('close', () => { bridges.delete(mux); log(`bridge left (${bridges.size} open)`) })
      mux.on('control', (m) => { if (m?.type === 'client' && Array.isArray(m.caps)) caps.set(mux, m.caps) })
      mux.on('stream', (stream, target) => {
        if (target?.kind !== 'dsh' || dsh.state !== 'running') { stream.destroy(new Error(`no target ${JSON.stringify(target)} (dsh ${dsh.state})`)); return }
        const port = Number(new URL(dsh.origin).port)
        const tcp = connect(port, DSH_HOST)
        stream.pipe(tcp).pipe(stream)
        const close = (e) => { tcp.destroy(); stream.destroy(e) }
        tcp.once('error', close); stream.once('error', () => tcp.destroy())
      })
      mux.control({ type: 'hello', protocol: PROTOCOL, profile: PROFILE, distro: process.env.WSL_DISTRO_NAME ?? null, node: process.version })
      mux.control({ type: 'dsh', ...publicState() })
      if (rest.length) socket.emit('data', rest)
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  // Credential requests from the WSL DSH Host: one JSON object per line, {id, op, ...}; each is passed to the newest
  // bridge that announced the 'credentials' capability and answered on the same line protocol, {id, ...answer}.
  function brokerConnection(socket, rest) {
    let buffer = rest.toString('utf8')
    const answer = (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`) }
    const handle = async (line) => {
      let request
      try { request = JSON.parse(line) } catch { return }
      const desktop = [...bridges].reverse().find((mux) => caps.get(mux)?.includes('credentials'))
      if (!desktop) { answer({ id: request.id, error: 'Desktop is not connected' }); return }
      const stream = desktop.open({ kind: 'credentials' })
      const parts = []
      const timer = setTimeout(() => stream.destroy(new Error('timeout')), 15_000)
      stream.on('data', (c) => parts.push(c))
      stream.once('end', () => {
        clearTimeout(timer)
        try { answer({ ...JSON.parse(Buffer.concat(parts).toString('utf8')), id: request.id }) } catch { answer({ id: request.id, error: 'bad answer from Desktop' }) }
      })
      stream.once('error', (e) => { clearTimeout(timer); answer({ id: request.id, error: e.message }) })
      const { id, ...body } = request
      stream.end(JSON.stringify(body))
    }
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); void handle(line) }
    }
    socket.on('data', onData)
    if (buffer) onData(Buffer.alloc(0))
  }

  server.once('error', (error) => { log(`serve: cannot listen on ${SOCKET}: ${error.message}`); current?.kill('SIGTERM'); process.exit(1) })
  // DSH starts only once the socket is ours: a daemon that cannot listen leaves nothing running behind it.
  server.listen(SOCKET, () => { chmodSync(SOCKET, 0o600); log(`serve: listening on ${SOCKET}`); startDsh() })
  const stop = () => {
    log('serve: stopping'); stopping = true; rmSync(SOCKET, { force: true })
    if (!current || current.exitCode !== null) process.exit(0)
    current.once('exit', () => process.exit(0)); current.kill('SIGTERM')
    setTimeout(() => { current.kill('SIGKILL'); process.exit(0) }, 5000).unref()
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}

function reachable() {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET)) return resolve(false)
    const s = connect(SOCKET)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

// ---- bridge ---------------------------------------------------------------------------------------------------------
async function bridge() {
  if (await reachable()) {
    // A daemon from older bridge files or another DSH: replace it (its DSH Host stops with it).
    let running
    try { running = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) } catch {}
    const wanted = identity()
    if (STAMP && !sameIdentity(running, wanted)) {
      log(`bridge: replacing daemon ${JSON.stringify(running)} with ${JSON.stringify(wanted)}`)
      try { process.kill(running.pid, 'SIGTERM') } catch {}
      const alive = () => { try { process.kill(running.pid, 0); return true } catch { return false } }
      for (let i = 0; i < 100 && (alive() || (await reachable())); i++) await new Promise((r) => setTimeout(r, 100))
    }
  }
  if (!(await reachable())) {
    mkdirSync(RUN, { recursive: true, mode: 0o700 })
    const out = openSync(LOG, 'a', 0o600)
    const pass = [['--profile', PROFILE], ['--dsh', DSH_OPTION], ['--stamp', STAMP || undefined], ['--dsh-home', DSH_HOME_OPTION]].flatMap(([k, v]) => (v ? [k, v] : []))
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', ...pass], { detached: true, stdio: ['ignore', out, out], env: withoutDshHome(process.env) }).unref()
    for (let i = 0; i < 100 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 100))
    if (!(await reachable())) {
      // Say why on stderr: the Desktop side shows it in the setup dialog.
      let last = ''
      try { last = readFileSync(LOG, 'utf8').trim().split('\n').filter((l) => /^\d{4}-/.test(l)).slice(-1)[0] ?? '' } catch {}
      process.stderr.write(`the WSL daemon did not start${last ? `: ${last.replace(/^\S+ /, '')}` : ''} (log: ${LOG})\n`)
      process.exit(1)
    }
  }
  const socket = connect(SOCKET)
  socket.once('connect', () => {
    socket.write(`${readFileSync(TOKEN_FILE, 'utf8')}\n`)
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
  })
  const quit = () => process.exit(0)
  socket.once('close', quit); socket.once('error', (e) => { process.stderr.write(`dsh-wsl bridge: ${e.message}\n`); process.exit(1) })
  process.stdin.once('end', () => socket.end())
}

if (args.includes('--serve')) serve()
else if (args.includes('--bridge')) bridge()
else { process.stderr.write('usage: daemon.mjs --serve|--bridge [--profile name]\n'); process.exit(2) }
