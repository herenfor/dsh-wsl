// Call the fake WSL side's Host directly through the daemon, the way the Desktop plugin does (no page needed).
//   HOME=$FAKE_HOME node dev/bridge-call.mjs '[["session/list", {"_request": {}}], ["session/rename", {...}, 500]]'
// Each entry is [endpoint, args, waitMs?] (results are cut to 400 characters unless FULL=1); an argument string "$N.path" is replaced by that value from the result of
// call N. Refuses to run against your real home, and joins the running daemon with its own identity instead of
// replacing it (dev/wsl-host.mjs).
import { connectWslHost } from './wsl-host.mjs'

let host
try { host = await connectWslHost() } catch (error) { console.error(error.message); process.exit(2) }
const results = []
const fill = (v) => typeof v === 'string' && v.startsWith('$') ? v.slice(1).split('.').reduce((o, k) => o?.[k], results)
  : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v
for (const [endpoint, args = {}, wait] of JSON.parse(process.argv[2] ?? '[]')) {
  const r = await host.call(endpoint, fill(args))
  results.push(r.ok ? r.value : r)
  console.log(endpoint, r.ok ? JSON.stringify(r.value).slice(0, process.env.FULL ? undefined : 400) : `ERROR ${JSON.stringify(r.error).slice(0, 300)}`)
  if (wait) await new Promise((x) => setTimeout(x, wait))
}
host.close(); process.exit(0)
