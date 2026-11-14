// Real DSH lifecycle checks in disposable homes. No production profiles or running Hosts are touched.
// node scripts/check-installation.mjs /path/to/dsh/lib/bin.js /outside/repo/output-directory
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [entryArg, outArg] = process.argv.slice(2)
if (!entryArg || !outArg) throw Error('Usage: node scripts/check-installation.mjs /path/to/dsh/lib/bin.js /outside/repo/output-directory')
const entry = realpathSync(entryArg), out = resolve(outArg)
const repo = fileURLToPath(new URL('..', import.meta.url)), bundle = join(repo, 'experiments/mirror/mirror')
if (out === repo || out.startsWith(repo + '/')) throw Error('Keep runtime artifacts outside the repository')
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'dsh-wsl-install-')), desk = join(root, 'desktop'), wsl = join(root, 'wsl')
const fixture = join(root, 'bridge-fixture'), profileName = 'lifecycle-web'
const { initializeProfileFromDefault } = await import(pathToFileURL(join(dirname(entry), 'profile-boot.js')))
const manifestPath = join(desk, '.dsh/profiles', profileName, 'package.json')
const patchPath = join(dirname(manifestPath), 'cordis.patch.yml')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const env = {
  ...process.env, HOME: desk, DSH_HOME: join(desk, '.dsh'),
  XDG_CONFIG_HOME: join(desk, '.config'), XDG_CACHE_HOME: join(desk, '.cache'),
  DSH_WSL_COMMAND: '/explicit-private-simulator', DSH_WSL_NO_BROKER: '1',
  DEEPSEEK_API_KEY: 'local-lifecycle-placeholder', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/anthropic',
}
const checks = [], hosts = new Set()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const record = (label) => { checks.push(label); console.log(`PASS ${label}`) }
const redact = (text) => text.replace(/token=[^\s"'<>]+/g, 'token=[redacted]')
let host, api, origin, loginUrl, logs = ''

async function command(args) {
  const child = spawn(process.execPath, [entry, 'plugin', '--profile', profileName, ...args], { env, cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', (b) => { text += b }); child.stderr.on('data', (b) => { text += b })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
  try { const code = await new Promise((r, j) => { child.once('error', j); child.once('exit', r) }); return { code, text } }
  finally { clearTimeout(timer) }
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  host.kill('SIGTERM')
  await Promise.race([new Promise((r) => host.once('exit', r)), wait(7000)])
  if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await new Promise((r) => host.once('exit', r)) }
}
async function start(label) {
  logs = ''
  host = spawn(process.execPath, [entry, '--profile', profileName, '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  hosts.add(host)
  for (const stream of [host.stdout, host.stderr]) stream.on('data', (b) => { logs += b })
  for (let i = 0; i < 300; i++) {
    loginUrl = /dsh web:\s+(http:\/\/[^\s]+)/.exec(logs)?.[1]
    if (loginUrl) break
    if (host.exitCode !== null || host.signalCode !== null) throw Error(redact(logs))
    await wait(100)
  }
  assert.ok(loginUrl, redact(logs))
  origin = new URL(loginUrl).origin
  const login = await fetch(loginUrl, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  api = async (method, args = {}) => {
    const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'lifecycle', method, payload: { args } }) })
    const result = await response.json(); assert.ok(result.result?.ok, JSON.stringify(result)); return result.result.value
  }
  api.route = (path, body) => fetch(origin + path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { origin, cookie, 'content-type': 'application/json' } })
  writeFileSync(join(out, label + '.log'), redact(logs))
}
async function connected() {
  for (let i = 0; i < 300; i++) {
    const response = await api.route('/wsl-bridge/plugins')
    const value = await response.json()
    if (value.connected) return value
    await wait(100)
  }
  throw Error('Bridge did not connect: ' + redact(logs))
}

try {
  mkdirSync(desk, { recursive: true }); mkdirSync(wsl, { recursive: true })
  initializeProfileFromDefault(profileName, 'web', join(desk, '.dsh'))
  const originalPatch = '- id: agent-preset-registry\n  config:\n    selectedDefault: standard\n'
  writeFileSync(patchPath, originalPatch)
  await start('baseline')
  const { sessionId } = await api('session/create', { request: { cwd: root, agentPreset: 'standard' } })
  await api('session/rename', { request: { sessionId, title: 'Lifecycle history must survive' } })
  await stop()

  const refused = await command(['add', 'link:' + bundle])
  writeFileSync(join(out, 'wrong-location.log'), refused.text)
  assert.notEqual(refused.code, 0); assert.match(refused.text, /supports Host platforms win32|running linux/)
  assert.ok(!readJson(manifestPath).dsh.profile.bundles.includes('@herenfor/dsh-wsl'))
  assert.equal(readFileSync(patchPath, 'utf8'), originalPatch)
  record('real manager rejects production bridge activation in WSL without changing user settings')
  const removed = await command(['remove', '@herenfor/dsh-wsl'])
  assert.equal(removed.code, 0, removed.text)
  assert.ok(!readJson(manifestPath).dependencies?.['@herenfor/dsh-wsl'])
  await start('after-wrong-remove')
  assert.ok(await api('session/state', { request: { sessionId } }))
  assert.ok((await api('session/create', { request: { cwd: root } })).sessionId)
  assert.equal((await api.route('/wsl-bridge/setup')).status, 404)
  await stop()
  record('wrong-side removal leaves history intact and new standard sessions usable')

  cpSync(bundle, fixture, { recursive: true })
  const pkg = readJson(join(fixture, 'package.json')); pkg.private = true; pkg.dsh.bundle.platforms = ['linux']
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(pkg))
  const helper = join(root, 'bridge.mjs')
  writeFileSync(helper, `process.env.HOME=${JSON.stringify(wsl)};delete process.env.DSH_HOME;process.argv=[process.execPath,${JSON.stringify(join(fixture, 'transport/daemon.mjs'))},...process.argv.slice(2)];await import(${JSON.stringify(pathToFileURL(join(fixture, 'transport/daemon.mjs')).href)});`)
  const installed = await command(['add', 'link:' + fixture]); assert.equal(installed.code, 0, installed.text)
  // JSON objects are valid YAML entries; retain the user's existing registry override.
  writeFileSync(patchPath, originalPatch + '- ' + JSON.stringify({ id: 'wsl-mirror', config: { command: process.execPath, args: [helper, '--bridge', '--profile', 'desktop-wsl', '--dsh', entry, '--stamp', 'lifecycle-isolated'] } }) + '\n')
  await start('correct-location-simulator'); await connected()
  const setup = await (await api.route('/wsl-bridge/setup')).json(); assert.equal(setup.state, 'connected')
  for (const [spec, expected] of [['@herenfor/dsh-wsl@0.1.12', /安装位置不正确|Wrong installation location/], ['0.2.17', /版本号|version alone/]]) {
    const response = await api.route('/wsl-bridge/plugins', { action: 'install', spec, ...(spec.includes('dsh-wsl') ? { name: '@herenfor/dsh-wsl' } : {}) })
    const result = await response.json(); assert.match(result.error, expected)
  }
  const localInspection = await (await api.route('/wsl-bridge/plugins', { action: 'inspect', spec: bundle })).json()
  assert.match(localInspection.error, /安装位置不正确|Wrong installation location/)
  record('private Desktop simulator connects a real second Host and gives actionable installation errors')
  if (process.env.DSH_WSL_TEST_BROWSER_HOOK) {
    // Private automation may capture this authenticated page without exposing its token in output.
    await import(pathToFileURL(process.env.DSH_WSL_TEST_BROWSER_HOOK)).then((m) => m.capture({ loginUrl, out }))
  }
  await stop(); await wait(6500)
  const clean = await command(['remove', '@herenfor/dsh-wsl']); assert.equal(clean.code, 0, clean.text)
  await start('after-normal-remove')
  assert.equal((await api.route('/wsl-bridge/setup')).status, 404)
  assert.ok(await api('session/state', { request: { sessionId } }))
  assert.ok((await api('session/create', { request: { cwd: root } })).sessionId)
  await stop()
  record('normal removal restores native routing and preserves session history')
  const again = await command(['add', 'link:' + fixture]); assert.equal(again.code, 0, again.text)
  writeFileSync(patchPath, originalPatch + '- ' + JSON.stringify({ id: 'wsl-mirror', config: { command: process.execPath, args: [helper, '--bridge', '--profile', 'desktop-wsl', '--dsh', entry, '--stamp', 'lifecycle-isolated'] } }) + '\n')
  await start('reinstalled'); await connected()
  assert.ok(await api('session/state', { request: { sessionId } }))
  record('reinstallation reconnects without losing existing sessions')
  writeFileSync(join(out, 'results.json'), JSON.stringify({ pluginVersion: readJson(join(bundle, 'package.json')).version, dsh: readJson(join(dirname(dirname(entry)), 'package.json')).version, checks, scope: 'Actual Linux DSH manager and two Hosts; Windows Desktop simulated with a private Linux-only fixture. Production metadata and entry guards unchanged.' }, null, 2))
} finally {
  await stop(); await wait(6500)
  for (const child of hosts) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
