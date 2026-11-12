// Join the fake WSL side's running daemon and call its Host's page API, the way the Desktop plugin does.
// Used by dev/bridge-call.mjs and dev/scan/probe.mjs. Refuses to run against your real home: it must not touch your
// real daemon.
//
// The daemon replaces itself when a bridge joins with a different identity (STAMP, dsh, --dsh-home, --follow), which
// would restart the WSL Host under the test Desktop. So the join repeats the identity the running daemon recorded in
// run/<profile>/daemon.json, and falls back to the bridge's STAMP and the dsh on PATH when none is running.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

export async function connectWslHost({ profile = 'desktop-wsl', timeoutMs = 60000 } = {}) {
  const home = process.env.HOME
  if (!home || home === userInfo().homedir) throw new Error('run with HOME set to the fake WSL home (dev/env.sh FAKE_HOME), not your real home')
  const bridge = join(home, '.dsh-wsl', 'bridge')
  if (!existsSync(join(bridge, 'STAMP'))) throw new Error(`no bridge in ${bridge}: start the test Desktop once first (dev/start-test-desktop.sh)`)
  let running
  try { running = JSON.parse(readFileSync(join(home, '.dsh-wsl', 'run', profile, 'daemon.json'), 'utf8')) } catch {}
  const dsh = running?.dsh ?? process.env.DSH_WSL_DEV_DSH ?? (() => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) if (existsSync(join(dir, 'dsh'))) return realpathSync(join(dir, 'dsh'))
    throw new Error('dsh not found on PATH; set DSH_WSL_DEV_DSH to its lib/bin.js')
  })()
  const stamp = running?.stamp ?? readFileSync(join(bridge, 'STAMP'), 'utf8').trim()
  const extra = [['--dsh-home', running?.dshHome], ['--follow', running?.follow]].flatMap(([k, v]) => (v ? [k, v] : []))
  const { startBridge } = await import(join(bridge, 'transport', 'client.mjs'))
  const b = startBridge({ command: process.execPath, args: [join(bridge, 'transport', 'daemon.mjs'), '--bridge', '--profile', profile, '--dsh', dsh, '--stamp', stamp, ...extra] })
  await b.ready(timeoutMs)
  const login = await b.request(`/?token=${b.state.dsh.token}`)
  const cookie = [].concat(login.headers['set-cookie']).map((c) => c.split(';')[0]).join('; ')
  /** One page API call; resolves to the Host's `result` ({ ok, value } or { ok: false, error }). */
  const call = (endpoint, args) => new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'dev', method: endpoint, payload: { args } })
    b.request(`/api/${endpoint}`, { method: 'POST', headers: { cookie, origin: b.state.dsh.origin, 'content-type': 'application/json' }, body })
      .then((r) => {
        let t = ''
        r.on('data', (c) => (t += c))
        r.on('end', () => { try { resolve(JSON.parse(t).result ?? { ok: false, error: { code: `no result (HTTP ${r.statusCode})` } }) } catch { resolve({ ok: false, error: { code: `HTTP ${r.statusCode}`, message: t.slice(0, 200) } }) } })
      }, (error) => resolve({ ok: false, error: { code: 'bridge', message: error.message } }))
  })
  return { call, close: () => b.close(), bridge: b }
}
