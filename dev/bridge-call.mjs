// Call the fake WSL side's Host directly through the daemon, the way the Desktop plugin does (no page needed).
//   HOME=$FAKE_HOME node dev/bridge-call.mjs '[["session/list", {"_request": {}}], ["session/rename", {...}, 500]]'
// Each entry is [endpoint, args, waitMs?] (results are cut to 400 characters unless FULL=1); an argument string "$N.path" is replaced by that value from the result of
// call N. Refuses to run against your real home: it must not replace your real daemon. The --stamp it passes is read
// from the bridge's own STAMP file, so it joins the running daemon instead of restarting it.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

const home = process.env.HOME
if (!home || home === userInfo().homedir) { console.error('run with HOME set to the fake WSL home (dev/env.sh FAKE_HOME), not your real home'); process.exit(2) }
const bridge = join(home, '.dsh-wsl', 'bridge')
if (!existsSync(join(bridge, 'STAMP'))) { console.error(`no bridge in ${bridge}: start the test Desktop once first (dev/start-test-desktop.sh)`); process.exit(2) }
const dshEntry = process.env.DSH_WSL_DEV_DSH ?? (() => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (existsSync(join(dir, 'dsh'))) return realpathSync(join(dir, 'dsh'))
  console.error('dsh not found on PATH; set DSH_WSL_DEV_DSH to its lib/bin.js'); process.exit(2)
})()

const { startBridge } = await import(join(bridge, 'transport', 'client.mjs'))
const stamp = readFileSync(join(bridge, 'STAMP'), 'utf8').trim()
const b = startBridge({ command: process.execPath, args: [join(bridge, 'transport', 'daemon.mjs'), '--bridge', '--profile', 'desktop-wsl', '--dsh', dshEntry, '--stamp', stamp] })
await b.ready(60000)
const login = await b.request(`/?token=${b.state.dsh.token}`)
const cookie = [].concat(login.headers['set-cookie']).map((c) => c.split(';')[0]).join('; ')
const call = (endpoint, args) => new Promise((resolve) => {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'dev', method: endpoint, payload: { args } })
  b.request(`/api/${endpoint}`, { method: 'POST', headers: { cookie, origin: b.state.dsh.origin, 'content-type': 'application/json' }, body })
    .then((r) => { let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => { try { resolve(JSON.parse(t).result) } catch { resolve({ ok: false, error: `HTTP ${r.statusCode}: ${t.slice(0, 200)}` }) } }) })
})
const results = []
const fill = (v) => typeof v === 'string' && v.startsWith('$') ? v.slice(1).split('.').reduce((o, k) => o?.[k], results)
  : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v
for (const [endpoint, args = {}, wait] of JSON.parse(process.argv[2] ?? '[]')) {
  const r = await call(endpoint, fill(args))
  results.push(r.ok ? r.value : r)
  console.log(endpoint, r.ok ? JSON.stringify(r.value).slice(0, process.env.FULL ? undefined : 400) : `ERROR ${JSON.stringify(r.error).slice(0, 300)}`)
  if (wait) await new Promise((x) => setTimeout(x, wait))
}
b.close(); process.exit(0)
