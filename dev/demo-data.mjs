// Demo data on the test Desktop's Windows side, for screenshots: the folder $DESK_HOME/projects/website with the task
// "Polish the pricing page". Runs against the page API of a running test Desktop.
//   node dev/demo-data.mjs <token> [--delete-workspace <id> ...]
// --delete-workspace drops leftover workspaces (their ids are in the sidebar rows' data-row-key "workspace:<id>").
// The WSL side's demo data lives in the fake home and is made with dev/bridge-call.mjs; see dev/README.md.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [token, ...rest] = process.argv.slice(2)
if (!token) { console.error('usage: node dev/demo-data.mjs <token> [--delete-workspace <id> ...]'); process.exit(2) }
const O = `http://127.0.0.1:${process.env.DSH_WSL_DEV_PORT ?? 47102}`
const desk = process.env.DSH_WSL_DEV_DESK_HOME ?? join(process.env.REAL_HOME ?? homedir(), 'dshwsl-desk')
const website = join(desk, 'projects', 'website')
const TITLE = 'Polish the pricing page'

const login = await fetch(`${O}/?token=${token}`, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const call = async (endpoint, args) => {
  const r = await fetch(`${O}/api/${endpoint}`, { method: 'POST', headers: { cookie, origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'dev', method: endpoint, payload: { args } }) })
  const { result } = await r.json()
  if (!result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(result?.error ?? result)}`)
  return result.value
}

if (!existsSync(join(website, 'index.html'))) {
  mkdirSync(website, { recursive: true })
  writeFileSync(join(website, 'index.html'), '<!doctype html><title>Pricing</title>\n')
}
const sessions = (await call('session/list', { _request: {} })).items
if (sessions.some((s) => s.cwd === website && s.projections?.values?.title === TITLE)) console.log(`already there: ${TITLE}`)
else {
  const { workspace } = await call('workspace/create', { request: { path: website } })
  const { sessionId } = await call('session/create', { request: { workspaceId: workspace.workspaceId } })
  await call('session/rename', { request: { sessionId, title: TITLE } })
  // A prompt makes the task non-blank, so the sidebar lists it; without a real key its turn just fails.
  await call('session/prompt', { request: { requestId: 'demo-1', sessionId, mode: 'queue', content: [{ type: 'text', text: 'Tighten the spacing on the pricing cards and make the yearly toggle clearer.' }] } })
  console.log(`created ${TITLE} in ${website} (workspace ${workspace.workspaceId})`)
}
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== '--delete-workspace' || !rest[i + 1]) continue
  const id = rest[++i]
  console.log('delete workspace', id, JSON.stringify(await call('workspace/delete', { request: { workspaceId: id } })))
}
