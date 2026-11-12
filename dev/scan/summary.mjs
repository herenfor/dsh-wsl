// Step 5 helper of the cross-host scan (docs/cross-host-scan.md): read probe.json (and dynamic.json when there) and print
// what differs, in the terms the report uses.
//   node dev/scan/summary.mjs <scan dir>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) { console.error('usage: summary.mjs <scan dir>'); process.exit(2) }
const probe = JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8'))
const brief = (r) => r === undefined ? '-' : r.ok ? `ok ${(JSON.stringify(r.value) ?? '').length}b` : `ERR ${r.error?.code}`

console.log('## Calls whose answers differ (the rest agree on every side)\n')
for (const r of probe.results) {
  if (/same on both, page agrees|^page = /.test(r.verdict)) continue
  console.log(`- ${r.endpoint} [${r.case}] ${r.verdict}: windows ${brief(r.windows)}, wsl ${brief(r.wsl)}, page ${brief(r.page)}`)
}
const notRouted = probe.results.filter((r) => r.case === 'wsl-task' && r.verdict !== 'page = wsl')
console.log(`\nCalls naming a WSL task that the page did not get from the WSL Host: ${notRouted.length ? notRouted.map((r) => r.endpoint).join(', ') : 'none'}`)
const allMissing = probe.results.filter((r) => r.case === 'host' && !r.windows?.ok && !r.wsl?.ok && /404/.test(r.windows?.error?.code ?? ''))
console.log(`Not served by either Host in this profile (HTTP 404): ${allMissing.map((r) => r.endpoint).join(', ') || 'none'}`)

// Lists the page shows: entries one Host has and the other lacks, keyed by id/name/ns.
const KEY = (x) => x?.id ?? x?.ns ?? x?.name ?? x?.entryId ?? x?.sessionId
const arrays = (value, at = '') => {
  if (Array.isArray(value)) return value.length && typeof value[0] === 'object' && KEY(value[0]) !== undefined ? [[at || '.', value]] : []
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => arrays(v, at ? `${at}.${k}` : k))
  return []
}
console.log('\n## Entries only one Host has\n')
for (const r of probe.results.filter((r) => r.case === 'host' && r.windows?.ok && r.wsl?.ok)) {
  const w = new Map(arrays(r.windows.value)), l = new Map(arrays(r.wsl.value)), p = new Map(arrays(r.page.value))
  for (const [path, items] of l) {
    const mine = new Set((w.get(path) ?? []).map(KEY)), shown = new Set((p.get(path) ?? []).map((x) => String(KEY(x)).replace(/^wsl:/, '')))
    const wslOnly = items.map(KEY).filter((k) => !mine.has(k))
    const winOnly = [...mine].filter((k) => !items.some((x) => KEY(x) === k))
    if (!wslOnly.length && !winOnly.length) continue
    const hidden = wslOnly.filter((k) => !shown.has(String(k)))
    console.log(`- ${r.endpoint} ${path}: WSL only ${wslOnly.length}${hidden.length ? ` (not on the page: ${hidden.slice(0, 8).join(', ')}${hidden.length > 8 ? ', …' : ''})` : ' (all on the page)'}; Windows only ${winOnly.length}${winOnly.length ? ` (${winOnly.slice(0, 5).join(', ')}${winOnly.length > 5 ? ', …' : ''})` : ''}`)
  }
}

// Settings: schema ids (uid/refs) are numbered per process, so schemas are compared after renumbering.
const settings = probe.results.find((r) => r.endpoint === 'settings/describe')
if (settings?.windows?.ok && settings?.wsl?.ok) {
  const norm = (s) => {
    if (!s?.refs) return s
    const map = new Map(); let n = 0
    const walk = (id) => { if (map.has(id)) return map.get(id); const k = `#${n++}`; map.set(id, k); const node = s.refs[id]; const out = { ...node }
      if (node?.dict) out.dict = Object.fromEntries(Object.entries(node.dict).map(([key, v]) => [key, walk(v)]))
      if (node?.list) out.list = node.list.map(walk)
      if (node?.inner !== undefined) out.inner = walk(node.inner)
      if (node?.sKey !== undefined) out.sKey = walk(node.sKey)
      return out }
    return walk(s.uid)
  }
  const views = (v) => new Map(v.namespaces.map((x) => [x.ns, x]))
  const w = views(settings.windows.value), l = views(settings.wsl.value), p = views(settings.page.value)
  console.log('\n## Settings namespaces\n')
  console.log(`- Windows only: ${[...w.keys()].filter((k) => !l.has(k)).join(', ') || 'none'}`)
  const wslOnly = [...l.keys()].filter((k) => !w.has(k))
  console.log(`- WSL only: ${wslOnly.join(', ') || 'none'}${wslOnly.length ? ` (on the page: ${wslOnly.every((k) => p.has(k)) ? 'yes' : 'no'})` : ''}`)
  for (const [ns, a] of w) {
    const b = l.get(ns); if (!b) continue
    const diffs = []
    if (JSON.stringify(norm(a.schema)) !== JSON.stringify(norm(b.schema))) diffs.push('schema')
    for (const layer of ['base', 'user', 'value']) {
      const A = a[layer] ?? {}, B = b[layer] ?? {}
      for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) diffs.push(`${layer}.${k}: windows ${JSON.stringify(A[k])}, wsl ${JSON.stringify(B[k])}`)
    }
    if (diffs.length) console.log(`- ${ns}: ${diffs.join('; ')}`)
  }
}

const dynPath = join(dir, 'dynamic.json')
if (existsSync(dynPath)) {
  console.log('\n## Writes (dynamic.json)\n')
  const t = (x) => x?.created?.ok ? `created (preset ${x.agentPreset}, permission ${x.permission})` : `refused: ${x?.created?.code} ${x?.created?.message ?? ''}`.trim()
  for (const r of JSON.parse(readFileSync(dynPath, 'utf8')).results) {
    if (r.tasks) console.log(`- ${r.name} (${r.ns} ${JSON.stringify(r.patch)}): Windows task ${t(r.tasks.windows)}; WSL task ${t(r.tasks.wsl)}; restored ${JSON.stringify(r.restored)}`)
    else console.log(`- ${r.name}: ${JSON.stringify({ ...r, name: undefined })}`)
  }
}
