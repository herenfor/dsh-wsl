// Step 2 of the cross-host scan (docs/cross-host-scan.md): ask each read-only method three times and compare.
//   windows  the test Desktop's own Host, past our router (the x-dsh-wsl-mirror-inner header the plugin uses itself)
//   wsl      the fake WSL side's Host, through the bridge daemon (like dev/bridge-call.mjs)
//   page     the test Desktop as the page sees it, through our router
// A method that names a Session is asked once with a Windows Session and once with a WSL one.
//   HOME=$FAKE_HOME node dev/scan/probe.mjs <inventory.json> <out.json>
// Needs the test Desktop running in reuse mode (dev/README.md); reads its token from $DESK_HOME/token. Reads only.
import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { connectWslHost } from '../wsl-host.mjs'

const [invPath, outPath] = process.argv.slice(2)
if (!invPath || !outPath) { console.error('usage: probe.mjs <inventory.json> <out.json>'); process.exit(2) }
const inv = JSON.parse(readFileSync(invPath, 'utf8'))
const deskHome = process.env.DESK_HOME ?? join(userInfo().homedir, 'dshwsl-desk')
const port = process.env.DESK_PORT ?? '47102'
const token = readFileSync(join(deskHome, 'token'), 'utf8').trim()
const origin = `http://127.0.0.1:${port}`

// ---- the test Desktop (page and windows)
const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
const deskCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
async function desk(endpoint, args, inner) {
  const r = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie: deskCookie, origin, 'content-type': 'application/json', ...(inner ? { 'x-dsh-wsl-mirror-inner': '1' } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'scan', method: endpoint, payload: { args } }),
  })
  const t = await r.text()
  try { return JSON.parse(t).result ?? { ok: false, error: { code: `no result (HTTP ${r.status})` } } } catch { return { ok: false, error: { code: `HTTP ${r.status}`, message: t.slice(0, 200) } } }
}

// ---- the fake WSL side
const host = await connectWslHost()
const wsl = host.call

// ---- samples: one live Session on each side
const firstSession = (r) => r?.ok ? (r.value.items ?? []).find((s) => !s.archived && !s.archivedAt) ?? r.value.items?.[0] : undefined
const winSession = firstSession(await desk('session/list', { _request: {} }, true))
const wslSession = firstSession(await wsl('session/list', { _request: {} }))
if (!winSession || !wslSession) { console.error('need at least one task on each side (dev/demo-data.mjs makes a Windows one)'); host.close(); process.exit(2) }
console.error(`samples: windows ${winSession.sessionId} (${winSession.cwd ?? ''}), wsl ${wslSession.sessionId} (${wslSession.cwd ?? ''})`)

// Calls that leave the machine or change state even though their names read like reads.
const SKIP = /^(?:account\/|pluginRegistryProbe\/|liveshareShares\/identity|cotTranslation\/limits)/
const IDENTITY = /^(?:workspaceIds?|beforeWorkspaceId|(?:[a-zA-Z]*Session|session)Ids?|parentSession|agentId|workspaceFileScopeId|eventId)$/

/** Arguments with every required field filled: identities with `id`, the rest with empty values. */
function argsFor(params, id) {
  const fill = (list) => Object.fromEntries(list.filter((p) => !p.optional || IDENTITY.test(p.name)).flatMap((p) => {
    if (IDENTITY.test(p.name)) return [[p.name, id]]
    if (p.name === 'kind' && /'session'/.test(p.type)) return [[p.name, 'session']]
    if (p.fields) return [[p.name, fill(p.fields)]]
    if (/\[\]$|^readonly .*\[\]$/.test(p.type)) return [[p.name, []]]
    if (/^string\b|Id$/.test(p.type)) return [[p.name, p.name === 'path' ? '' : '']]
    if (/^number\b/.test(p.type)) return [[p.name, 0]]
    if (/^boolean\b/.test(p.type)) return [[p.name, false]]
    return []
  }))
  return fill(params)
}
// Non-empty values where an empty one is refused.
const OVERRIDE = {
  'session/search': { request: { query: 'a' } },
  'workspaceFiles/list': { path: '.' },
  'workspaceFiles/stat': { path: '.' },
  'workspaceFiles/read': { path: '.', range: {} },
  'workspaceFiles/readBytes': { path: '.', options: {} },
  'agentPresets/read': { agentPreset: 'standard' },
  'fileReferences/list': { query: 'a' },
  'workspaceFiles/search': { request: { query: 'a', excludedPaths: [], includeHidden: false, respectGitignore: true } },
  'sessionReferenceResolver/candidates': { query: 'a' },
}
const unprefix = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/"wsl:/g, '"'))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const methods = inv.methods.filter((m) => m.readOnly && !SKIP.test(m.endpoint))
const results = []
for (const m of methods) {
  const cases = m.identities.length
    ? [{ side: 'windows-task', id: winSession.sessionId }, { side: 'wsl-task', id: wslSession.sessionId }]
    : [{ side: 'host', id: undefined }]
  for (const c of cases) {
    // The page names a WSL Session with the prefix (experiments/mirror/mirror/ids.mjs); the WSL Host without it.
    const args = { ...argsFor(m.params, c.side === 'wsl-task' ? `wsl:${c.id}` : c.id), ...OVERRIDE[m.endpoint] }
    const wslArgs = unprefix(args)
    const [windows, wslSide, page] = await Promise.all([
      c.side === 'wsl-task' ? undefined : desk(m.endpoint, args, true),
      c.side === 'windows-task' ? undefined : wsl(m.endpoint, wslArgs),
      desk(m.endpoint, args, false),
    ])
    const pageView = unprefix(page)
    let verdict
    if (c.side === 'windows-task') verdict = same(page, windows) ? 'page = windows' : 'page ≠ windows'
    else if (c.side === 'wsl-task') verdict = same(pageView, wslSide) ? 'page = wsl' : 'page ≠ wsl'
    else if (same(windows, wslSide)) verdict = same(page, windows) ? 'same on both, page agrees' : 'same on both, page differs'
    else if (same(page, windows)) verdict = 'differ; page shows windows only'
    else if (same(pageView, wslSide)) verdict = 'differ; page shows wsl only'
    else verdict = 'differ; page shows a mix'
    results.push({ endpoint: m.endpoint, route: m.route, case: c.side, args, verdict, windows, wsl: wslSide, page })
    console.error(`${verdict.padEnd(34)} ${m.endpoint} [${c.side}]`)
  }
}
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), samples: { windows: winSession, wsl: wslSession }, results }, null, 2))
host.close(); process.exit(0)
