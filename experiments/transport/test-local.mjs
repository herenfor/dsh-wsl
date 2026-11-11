// Local test of the transport inside WSL: the bridge command is `node daemon.mjs --bridge`, no wsl.exe.
import { fileURLToPath } from 'node:url'
import { startBridge } from './client.mjs'
const daemon = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
const b = startBridge({ command: process.execPath, args: [daemon, '--bridge', '--profile', process.argv[2] ?? 'desktop-wsl'], log: (m) => console.log('[log]', m) })
const t0 = Date.now()
const s = await b.ready(90_000)
console.log('ready in', Date.now() - t0, 'ms; hello', JSON.stringify(s.hello), 'origin', s.dsh.origin, 'token', s.dsh.token ? '(in memory)' : 'none')
const text = async (res) => { let out = ''; for await (const c of res) out += c; return out }
const r = await b.request('/dsh-wsl-probe/whoami'); console.log('whoami', r.statusCode, await text(r))
// login like the mirror does, then a concurrent burst and an SSE stream
const login = await b.request(`/?token=${s.dsh.token}`); const cookie = login.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; '); login.resume()
console.log('login', login.statusCode, cookie ? 'cookie ok' : 'no cookie')
const t1 = Date.now()
const all = await Promise.all(Array.from({ length: 20 }, () => b.request('/dsh-wsl-probe/whoami').then(text)))
console.log('20 parallel requests in', Date.now() - t1, 'ms, all ok:', all.every((x) => x.includes('"linux"')))
const ev = await b.request('/wsl-bridge/events', { headers: { cookie } })
let first = ''
for await (const c of ev) { first += c; if (first.includes('\n\n')) break }
const frame = JSON.parse(first.split('\n').find((l) => l.startsWith('data: ')).slice(6))
console.log('events: rows', frame.graph.entries.length, 'routes', frame.routes.exact.length, 'distro', frame.distro)
const big = await b.request('/plugins/' + encodeURI(`??${frame.graph.entries.find((e) => e.id === '@deepseek-ai/dsh-client-ui-chat').url.split('??')[1]}`))
let size = 0; const t2 = Date.now(); for await (const c of big) size += c.length
console.log('ui-chat bundle', big.statusCode, size, 'bytes in', Date.now() - t2, 'ms')
b.close(); process.exit(0)
