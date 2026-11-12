import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeSource, followState, insertedIds, mergePatches, noteFollowed, packageOf, planManifest, syncFollow } from '../agent/follow.mjs'

const manifest = (deps, bundles) => ({ name: 'p', dependencies: deps, dsh: { profile: { bundles } } })
const BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

test('the WSL profile follows the source for plugins and their on/off; its own extras stay', () => {
  const source = manifest({ tuning: 'link:/home/s/tuning', sentinel: 'link:/home/s/sentinel', off: '1.0.0' }, [...BASE, 'tuning', 'sentinel', '@deepseek-ai/dsh-experimental-x'])
  const target = manifest({ 'dsh-wsl-agent': 'link:/a', 'ds-bot': '0.3.5', tuning: 'link:/home/s/tuning' }, [...BASE, 'dsh-wsl-agent', 'ds-bot', 'tuning'])
  const first = planManifest(source, target, {})
  assert.deepEqual(first.add, [['sentinel', 'link:/home/s/sentinel'], ['off', '1.0.0']])
  assert.deepEqual(first.remove, [])
  assert.deepEqual(first.bundles, [...BASE, 'dsh-wsl-agent', 'ds-bot', 'tuning', 'sentinel', '@deepseek-ai/dsh-experimental-x'])
  // Later the source drops sentinel and turns tuning off: both follow; ds-bot (Desktop's own) stays.
  const later = manifest({ tuning: 'link:/home/s/tuning', off: '1.0.0' }, [...BASE])
  const after = { ...target, dependencies: { ...target.dependencies, sentinel: 'link:/home/s/sentinel', off: '1.0.0' }, dsh: { profile: { bundles: first.bundles } } }
  const second = planManifest(later, after, first.state)
  assert.deepEqual(second.add, [])
  assert.deepEqual(second.remove, ['sentinel'])
  assert.deepEqual(second.bundles, [...BASE, 'dsh-wsl-agent', 'ds-bot'])
  // The agent is never followed, removed or switched off.
  assert.ok(!planManifest(manifest({ 'dsh-wsl-agent': 'x' }, ['dsh-wsl-agent']), target, { deps: ['dsh-wsl-agent'] }).remove.includes('dsh-wsl-agent'))
})

test('config of followed plugins merges three ways; official settings are not followed', () => {
  const owned = (i) => (typeof i.name === 'string' ? packageOf(i.name) === 'tuning' : i.id === 'preset')
  const model = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { model: 'a' } }
  const base = { preset: { id: 'preset', disabled: false } }
  // Changed in Desktop only: written to the source.
  let m = mergePatches([{ id: 'preset', disabled: false }], [model, { id: 'preset', disabled: true }], base, owned)
  assert.deepEqual(m.source, [{ id: 'preset', disabled: true }])
  assert.deepEqual(m.changed, { source: true, target: false })
  // Changed in the source only: copied to Desktop's; the official model item stays as Desktop has it.
  m = mergePatches([{ id: 'preset', disabled: true }, { id: 'w', name: 'tuning/wait', config: { s: 5 } }], [model, { id: 'preset', disabled: false }], base, owned)
  assert.deepEqual(m.target, [model, { id: 'preset', disabled: true }, { id: 'w', name: 'tuning/wait', config: { s: 5 } }])
  assert.equal(m.changed.source, false)
  // Both changed: the source wins. Removed in the source: removed in Desktop's.
  m = mergePatches([{ id: 'preset', disabled: true }], [{ id: 'preset', disabled: 'x' }], { preset: { id: 'preset', disabled: false } }, owned)
  assert.deepEqual(m.target, [{ id: 'preset', disabled: true }])
  m = mergePatches([], [{ id: 'preset', disabled: false }], base, owned)
  assert.deepEqual(m.target, [])
  // An official item in the source is never copied.
  m = mergePatches([{ ...model, config: { model: 'b' } }], [model], {}, owned)
  assert.deepEqual([m.target, m.changed], [[model], { source: false, target: false }])
  assert.deepEqual([...insertedIds([{ insert: [{ id: 'a', insert: [{ id: 'b' }] }] }, { id: 'c', disabled: true }])], ['a', 'b'])
  assert.equal(packageOf('@x/y/z'), '@x/y'); assert.equal(packageOf('tuning/wait'), 'tuning')
})

test('a sync on disk: plugins added with dsh plugin, bundles and config written, state kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-follow-'))
  const stateDir = join(home, 'state')
  const write = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
  write(join(home, 'profiles/web/package.json'), manifest({ tuning: 'link:/t' }, [...BASE, 'tuning']))
  write(join(home, 'profiles/web/cordis.patch.yml'), '# header\n[{"id":"preset","disabled":true},{"id":"m","name":"@deepseek-ai/dsh-agent-default-model","config":{}}]')
  write(join(home, 'profiles/desktop-wsl/package.json'), manifest({ 'dsh-wsl-agent': 'link:/a' }, [...BASE, 'dsh-wsl-agent']))
  write(join(home, 'profiles/desktop-wsl/cordis.patch.yml'), '[]')
  const calls = []
  // `dsh plugin --profile desktop-wsl add ...`, as pnpm would leave it.
  const run = (argv) => {
    calls.push(argv.join(' '))
    const file = join(home, 'profiles', argv[2], 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (argv[3] === 'add') { pkg.dependencies.tuning = 'link:/t'; write(join(home, 'profiles', argv[2], 'node_modules/tuning/package.json'), { name: 'tuning' }); write(join(home, 'profiles', argv[2], 'node_modules/tuning/cordis.patch.yml'), '[{"insert":[{"id":"preset"}]}]') }
    writeFileSync(file, JSON.stringify(pkg))
    return { status: 0, stderr: '' }
  }
  const yaml = { load: (t) => JSON.parse(t.split('\n').filter((l) => !l.startsWith('#')).join('\n') || '[]'), dump: (v) => JSON.stringify(v) }
  const logs = []
  const r = syncFollow({ home, from: 'web', to: 'desktop-wsl', run, log: (m) => logs.push(m), stateDir, yaml })
  assert.equal(r.followed, true)
  assert.deepEqual(calls, ['plugin --profile desktop-wsl add --prefer-offline link:/t'])
  const target = JSON.parse(readFileSync(join(home, 'profiles/desktop-wsl/package.json'), 'utf8'))
  assert.deepEqual(target.dsh.profile.bundles, [...BASE, 'dsh-wsl-agent', 'tuning'])
  assert.deepEqual(yaml.load(readFileSync(join(home, 'profiles/desktop-wsl/cordis.patch.yml'), 'utf8')), [{ id: 'preset', disabled: true }])
  assert.deepEqual(followState('desktop-wsl', stateDir), { from: 'web', names: ['tuning'] })
  // Changed in Desktop: written back to the source, which keeps its own header comments.
  writeFileSync(join(home, 'profiles/desktop-wsl/cordis.patch.yml'), '[{"id":"preset","disabled":false}]')
  syncFollow({ home, from: 'web', to: 'desktop-wsl', run, log: () => {}, stateDir, yaml })
  const back = readFileSync(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')
  assert.ok(back.startsWith('# header\n'))
  assert.deepEqual(yaml.load(back), [{ id: 'preset', disabled: false }, { id: 'm', name: '@deepseek-ai/dsh-agent-default-model', config: {} }])
  // Nothing changed: a second sync runs no dsh command.
  calls.length = 0
  syncFollow({ home, from: 'web', to: 'desktop-wsl', run, log: () => {}, stateDir, yaml })
  assert.deepEqual(calls, [])
  // No source profile: nothing happens.
  assert.equal(syncFollow({ home, from: 'nope', to: 'desktop-wsl', run, log: () => {}, stateDir, yaml }).followed, false)
  rmSync(home, { recursive: true, force: true })
})

test('the WSL tab\'s changes reach the source profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-source-'))
  const file = join(home, 'profiles/web/package.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(manifest({ tuning: 'link:/t' }, [...BASE, 'tuning'])))
  const calls = []
  const run = (argv) => {
    calls.push(argv.join(' '))
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (argv[3] === 'add') pkg.dependencies['ds-bot'] = '0.3.5'
    if (argv[3] === 'remove') delete pkg.dependencies[argv[4]]
    writeFileSync(file, JSON.stringify(pkg))
    return { status: 0, stderr: '' }
  }
  const bundles = () => JSON.parse(readFileSync(file, 'utf8')).dsh.profile.bundles
  assert.deepEqual(changeSource({ home, from: 'web', action: 'install', name: 'ds-bot', spec: '0.3.5', run }), { ok: true })
  assert.deepEqual(bundles(), [...BASE, 'tuning', 'ds-bot'])
  assert.deepEqual(changeSource({ home, from: 'web', action: 'disable', name: 'tuning', run }), { ok: true })
  assert.deepEqual(bundles(), [...BASE, 'ds-bot'])
  assert.deepEqual(changeSource({ home, from: 'web', action: 'enable', name: 'other', run }), { skipped: 'not in the source' })
  assert.deepEqual(changeSource({ home, from: 'web', action: 'remove', name: 'ds-bot', run }), { ok: true })
  assert.deepEqual(bundles(), [...BASE])
  assert.deepEqual(calls, ['plugin --profile web add 0.3.5', 'plugin --profile web remove ds-bot'])
  const stateDir = join(home, 'state'); mkdirSync(stateDir)
  writeFileSync(join(stateDir, 'desktop-wsl.json'), JSON.stringify({ from: 'web', deps: ['tuning'], bundles: ['tuning'] }))
  noteFollowed('desktop-wsl', { action: 'install', name: 'ds-bot' }, stateDir)
  assert.deepEqual(followState('desktop-wsl', stateDir).names, ['tuning', 'ds-bot'])
  assert.ok(existsSync(join(stateDir, 'desktop-wsl.json')))
})
