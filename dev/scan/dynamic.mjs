// Step 4 of the cross-host scan (docs/cross-host-scan.md): write a setting that names something only one side has (or
// nothing), create a task on each side through the page, and record what each Host made of it. Every case puts the
// setting back (the user layer as it was, through the page so the copy to WSL follows) and archives the tasks it made.
//   HOME=$FAKE_HOME node dev/scan/dynamic.mjs <out.json>
// Needs the test Desktop running in reuse mode, with the tuning plugin's `tuned` preset enabled in the fake WSL
// profile (dev/README.md). Writes settings: never run it against a real Desktop.
import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { connectWslHost } from '../wsl-host.mjs'

const outPath = process.argv[2]
if (!outPath) { console.error('usage: dynamic.mjs <out.json>'); process.exit(2) }
const deskHome = process.env.DESK_HOME ?? join(userInfo().homedir, 'dshwsl-desk')
const fakeHome = process.env.HOME
const origin = `http://127.0.0.1:${process.env.DESK_PORT ?? '47102'}`
const token = readFileSync(join(deskHome, 'token'), 'utf8').trim()
const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
async function page(endpoint, args, inner = false) {
  const r = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', ...(inner ? { 'x-dsh-wsl-mirror-inner': '1' } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'scan', method: endpoint, payload: { args } }),
  })
  const t = await r.text()
  try { return JSON.parse(t).result } catch { return { ok: false, error: { code: `HTTP ${r.status}`, message: t.slice(0, 200) } } }
}
const host = await connectWslHost()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const view = (describe, ns) => describe?.ok ? describe.value.namespaces.find((v) => v.ns === ns) : undefined

// The two folders: the demo Windows project and the fake WSL project (dev/README.md), as the page names them.
const distro = process.env.DSH_WSL_DEV_DISTRO ?? 'Ubuntu'
const FOLDERS = {
  windows: join(deskHome, 'projects', 'website'),
  wsl: `\\\\wsl.localhost\\${distro}${join(fakeHome, 'projects', 'inventory-api').replaceAll('/', '\\')}`,
}

const CASES = [
  { name: 'default preset: WSL-only', ns: 'agent-preset-registry', patch: { selectedDefault: 'tuned' } },
  { name: 'default preset: on neither side', ns: 'agent-preset-registry', patch: { selectedDefault: 'scan-nowhere' } },
  { name: 'default permission preset: on neither side', ns: 'permission', patch: { defaultPreset: 'scan-nowhere' } },
  { name: 'default model: on neither side', ns: 'agent-default-model', patch: { provider: 'deepseek-official', model: 'scan-nowhere' } },
  { name: 'default model provider: on neither side', ns: 'agent-default-model', patch: { provider: 'scan-nowhere', model: 'deepseek-flash' } },
  { name: 'search provider: WSL-only', ns: 'web', patch: { searchProvider: 'auto' } },
]

/** What a new task on one side looks like: the create result and the task's own record of preset, model, permissions. */
async function newTask(where) {
  const created = await page('session/create', { request: { cwd: FOLDERS[where] } })
  if (!created?.ok) return { created: created?.error ?? created }
  const sessionId = created.value.sessionId
  await sleep(500)
  const list = await page('session/list', { _request: {} })
  const row = list?.ok ? list.value.items.find((s) => s.sessionId === sessionId) : undefined
  const v = row?.projections?.values ?? {}
  return { created: { ok: true, sessionId, agentPreset: created.value.agentPreset }, agentPreset: v.agentPreset, model: v.modelSelection, permission: v.permissions?.currentValue, cwd: row?.cwd }
}

const results = []
for (const c of CASES) {
  console.error(`== ${c.name}`)
  const before = view(await page('settings/describe', {}, true), c.ns)
  const beforeWsl = view(await host.call('settings/describe', {}), c.ns)
  if (!before) { results.push({ ...c, skipped: `no ${c.ns} on this Host` }); continue }
  const write = await page('settings/update', { ns: c.ns, patch: c.patch })
  // The copy to WSL runs after the write; wait until the WSL Host's user layer has the new fields.
  let wslView
  for (let i = 0; i < 20; i++) {
    wslView = view(await host.call('settings/describe', {}), c.ns)
    if (Object.entries(c.patch).every(([k, v]) => JSON.stringify(wslView?.user?.[k]) === JSON.stringify(v))) break
    await sleep(500)
  }
  const tasks = { windows: await newTask('windows'), wsl: await newTask('wsl') }
  const presets = await page('agentPresets/list', {})
  const catalog = await page('session/modelCatalog', {})
  const after = { windows: view(await page('settings/describe', {}, true), c.ns), wsl: wslView, page: view(await page('settings/describe', {}), c.ns) }

  // Put things back: archive the tasks, then the user layer as it was (set what it had, unset what it did not).
  for (const t of Object.values(tasks)) if (t.created?.ok) await page('workspace/archiveSession', { request: { sessionId: t.created.sessionId, force: true } })
  const now = view(await page('settings/describe', {}, true), c.ns)
  const ops = [
    ...Object.entries(before.user ?? {}).map(([k, v]) => ({ op: 'set', path: [k], value: v })),
    ...Object.keys(now?.user ?? {}).filter((k) => !(k in (before.user ?? {}))).map((k) => ({ op: 'unset', path: [k] })),
  ]
  const restore = ops.length ? await page('settings/mutate', { ns: c.ns, ops, expectedRevision: now?.revision }) : { ok: true }
  let restoredWsl
  for (let i = 0; i < 20; i++) {
    restoredWsl = view(await host.call('settings/describe', {}), c.ns)
    if (JSON.stringify(restoredWsl?.user ?? {}) === JSON.stringify(beforeWsl?.user ?? {})) break
    await sleep(500)
  }
  const restored = JSON.stringify(view(await page('settings/describe', {}, true), c.ns)?.user ?? {}) === JSON.stringify(before.user ?? {})
    && JSON.stringify(restoredWsl?.user ?? {}) === JSON.stringify(beforeWsl?.user ?? {})
  results.push({
    ...c, write: write?.ok ? 'ok' : write?.error, tasks,
    presetsOnPage: presets?.ok ? presets.value.presets.map((p) => `${p.id}${p.isDefault ? ' (default)' : ''}`) : presets?.error,
    catalogDefault: catalog?.ok ? catalog.value.default : catalog?.error,
    settingAfter: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, { user: v?.user, value: v?.value }])),
    restored: restore?.ok ? restored : { error: restore?.error },
  })
  console.error(JSON.stringify(results.at(-1).tasks), 'restored:', JSON.stringify(results.at(-1).restored))
}
// Calls by id (category 4): a scheduled message for a WSL task, created through the page (the call names the task, so
// it goes to the WSL Host), then listed, read and removed through the page (those calls name only the schedule).
// Fires in a day at the earliest, and is removed on the WSL Host directly whatever the page did.
{
  console.error('== schedule for a WSL task')
  const list = await page('session/list', { _request: {} })
  const target = list?.ok ? list.value.items.find((s) => s.sessionId.startsWith('wsl:') && !s.archived && !s.blank) : undefined
  const created = target ? await page('schedule/create', { request: { title: 'scan probe', prompt: 'scan probe (never sent)', timing: { kind: 'after', after_seconds: 86400 }, target: { kind: 'session', sessionId: target.sessionId } } }) : { ok: false, error: 'no WSL task' }
  const id = created?.ok ? created.value.id : undefined
  const onPage = await page('schedule/list', { request: {} })
  const onWsl = await host.call('schedule/list', { request: {} })
  const viewed = id ? await page('schedule/view', { request: { id } }) : undefined
  const removed = id ? await page('schedule/edit', { request: { id, action: 'delete' } }) : undefined
  const cleanup = id ? await host.call('schedule/edit', { request: { id, action: 'delete' } }) : undefined
  const ids = (r) => r?.ok ? (r.value.items ?? r.value.entries ?? r.value).map?.((e) => e.id) : r?.error
  results.push({
    name: 'schedule for a WSL task', target: target?.sessionId,
    create: created?.ok ? { ok: true, id } : created?.error,
    listOnPage: ids(onPage), listOnWsl: ids(onWsl),
    viewOnPage: viewed?.ok ? 'ok' : viewed?.error, deleteOnPage: removed?.ok ? 'ok' : removed?.error,
    cleanupOnWsl: cleanup?.ok ? 'ok' : cleanup?.error,
  })
  console.error(JSON.stringify(results.at(-1)))
}
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), folders: FOLDERS, results }, null, 2))
host.close(); process.exit(0)
