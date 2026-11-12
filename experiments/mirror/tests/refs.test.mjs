import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, createChoices, hasModel, intendedSection, keepMachineFields, overlayView, referencePart, resolveSection, rosterOf, wslSection } from '../mirror/refs.mjs'
import { mergeModelCatalog, mergePermissionCatalog, mergePresets, mergeWebProviders } from '../mirror/hostlists.mjs'
import { sharedNamespaces } from '../mirror/settings.mjs'

const windows = rosterOf({
  presets: { presets: [{ id: 'standard', isDefault: true }, { id: 'ptc' }] },
  permissionPresets: { options: [{ value: 'read-only' }, { value: 'workspace-write' }] },
  webProviders: { search: [{ id: 'deepseek-search-api' }], fetch: [{ id: 'http' }] },
  models: { groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }] },
})
const wsl = rosterOf({
  presets: { presets: [{ id: 'standard', isDefault: true }, { id: 'ptc' }, { id: 'tuned' }] },
  permissionPresets: { options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'locked' }] },
  webProviders: { search: [{ id: 'deepseek-search-api' }, { id: 'auto' }], fetch: [{ id: 'http' }] },
  models: { groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }, { id: 'local', models: [{ id: 'qwen' }] }] },
})

test('a choice one Host lacks is not kept there: that Host uses its own default', () => {
  assert.deepEqual(resolveSection('agent-preset-registry', { selectedDefault: 'tuned' }, windows), {})
  assert.deepEqual(resolveSection('agent-preset-registry', { selectedDefault: 'tuned' }, wsl), { selectedDefault: 'tuned' })
  assert.deepEqual(resolveSection('permission', { defaultPreset: 'locked' }, windows), {})
  assert.deepEqual(resolveSection('web', { searchProvider: 'auto', fetchProvider: 'http' }, windows), { fetchProvider: 'http' })
  assert.deepEqual(resolveSection('agent-default-model', { provider: 'local', model: 'qwen', reasoningEffort: 'high' }, windows), { reasoningEffort: 'high' })
  assert.deepEqual(resolveSection('agent-default-model', { provider: 'local', model: 'qwen' }, wsl), { provider: 'local', model: 'qwen' })
  const allowed = { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'local', model: 'qwen' }] }
  assert.deepEqual(resolveSection('subagent-model-selection-settings', allowed, windows).allowedModels, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
  // A list that could not be read keeps the value; other namespaces are untouched.
  assert.deepEqual(resolveSection('agent-preset-registry', { selectedDefault: 'tuned' }, rosterOf({})), { selectedDefault: 'tuned' })
  assert.deepEqual(resolveSection('ui-theme', { preference: 'dark' }, windows), { preference: 'dark' })
  assert.equal(hasModel(wsl, 'local', 'qwen'), true)
  assert.equal(hasModel(windows, 'local', 'qwen'), false)
})

test('what the person means after a page write', () => {
  const current = { selectedDefault: 'tuned' }
  assert.deepEqual(intendedSection('update', { patch: { selectedDefault: 'ptc' } }, current), { selectedDefault: 'ptc' })
  assert.deepEqual(intendedSection('replace', { section: { selectedDefault: 'standard' } }, current), { selectedDefault: 'standard' })
  assert.deepEqual(intendedSection('mutate', { ops: [{ op: 'unset', path: ['selectedDefault'] }] }, current), {})
  assert.deepEqual(applyOps({ a: { b: 1 } }, [{ op: 'set', path: ['a', 'c'], value: 2 }, { op: 'unset', path: ['a', 'b'] }]), { a: { c: 2 } })
  assert.deepEqual(referencePart('web', { searchProvider: 'auto', fetchProvider: 'http', other: 1 }), { searchProvider: 'auto', fetchProvider: 'http' })
  assert.deepEqual(overlayView({ ns: 'web', user: {}, value: { searchProvider: 'x', fetchProvider: 'http' } }, { searchProvider: 'auto' }),
    { ns: 'web', user: { searchProvider: 'auto' }, value: { searchProvider: 'auto', fetchProvider: 'http' } })
})

test('the choices: kept across writes, and a value set elsewhere becomes the choice', async () => {
  let saved
  const calls = []
  const choices = createChoices({
    save: (s) => { saved = s },
    call: { windows: async (e) => { calls.push(e); if (e === 'agentPresets/list') return { presets: [{ id: 'standard' }] }; throw new Error('no') }, wsl: async () => { throw new Error('down') } },
    now: () => 0,
  })
  // First look: this Host's value is the choice.
  assert.deepEqual(choices.reconcile('agent-preset-registry', { selectedDefault: 'ptc' }), { selectedDefault: 'ptc' })
  // The person picks a WSL-only preset: this Host is given nothing, the choice stays.
  choices.record('agent-preset-registry', { selectedDefault: 'tuned' }, {})
  assert.deepEqual(choices.reconcile('agent-preset-registry', {}), { selectedDefault: 'tuned' })
  assert.deepEqual(saved['agent-preset-registry'], { choice: { selectedDefault: 'tuned' }, windows: {} })
  // Someone sets it in the settings file: that is the new choice.
  assert.deepEqual(choices.reconcile('agent-preset-registry', { selectedDefault: 'ptc' }), { selectedDefault: 'ptc' })
  // Lists: none without a cookie for this Host; cached once read; a failed list is unknown.
  assert.equal((await choices.roster('windows')).presets, undefined)
  choices.noteCookie('c=1')
  assert.deepEqual([...(await choices.roster('windows')).presets], ['standard'])
  const before = calls.length
  await choices.roster('windows')
  assert.equal(calls.length, before)
  assert.equal((await choices.roster('wsl')).presets, undefined)
})

test('copied to WSL: choices resolved there, machine fields kept, machine namespaces not at all', () => {
  assert.deepEqual(wslSection('agent-preset-registry', {}, {}, { selectedDefault: 'tuned' }, wsl), { selectedDefault: 'tuned' })
  assert.deepEqual(wslSection('agent-preset-registry', { selectedDefault: 'standard' }, {}, { selectedDefault: 'standard' }, wsl), { selectedDefault: 'standard' })
  assert.deepEqual(wslSection('web', { fetchProvider: 'http' }, { searchProvider: 'auto' }, { searchProvider: 'exa' }, wsl), { fetchProvider: 'http' })
  const desktop = { providers: { mine: { apiKeyEnv: 'WIN_KEY', baseURL: 'https://x' }, fresh: { apiKeyEnv: 'NEW_KEY' } } }
  const theirs = { providers: { mine: { apiKeyEnv: 'LINUX_KEY', baseURL: 'old' } } }
  assert.deepEqual(keepMachineFields(desktop, theirs), { providers: { mine: { apiKeyEnv: 'LINUX_KEY', baseURL: 'https://x' }, fresh: { apiKeyEnv: 'NEW_KEY' } } })
  assert.deepEqual(wslSection('web-deepseek-api', { count: 5, searchApiKeyEnv: 'A' }, { searchApiKeyEnv: 'B' }), { count: 5, searchApiKeyEnv: 'B' })
  const views = (names) => names.map((ns) => ({ ns, user: {} }))
  assert.deepEqual(sharedNamespaces(views(['web', 'mcp-manager', 'bash-sandbox']), views(['web', 'mcp-manager', 'bash-sandbox'])).map((x) => x.ns), ['web'])
})

test('preset list: the chosen default is marked wherever it lives, with what the other side uses', () => {
  const text = { label: (n) => `${n} · WSL`, name: (r) => r.name ?? r.id, windowsUses: (n) => `Windows: ${n}`, wslUses: (n) => `WSL: ${n}` }
  const mine = [{ id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false }]
  const theirs = [{ id: 'standard', isDefault: false }, { id: 'tuned', name: 'Tuned', description: 'd', isDefault: true }]
  const rows = mergePresets(mine, theirs, { choice: 'tuned', text })
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.isDefault]), [['standard', undefined, false], ['ptc', undefined, false], ['tuned', 'Tuned · WSL', true]])
  assert.equal(rows[2].description, 'd\nWindows: standard')
  // No choice: this Host's default; a choice only Windows has says what WSL tasks use.
  assert.deepEqual(mergePresets(mine, theirs, { text }).filter((r) => r.isDefault).map((r) => r.id), ['standard'])
  const winOnly = mergePresets(mine, [{ id: 'standard', isDefault: true }], { choice: 'ptc', text })
  assert.equal(winOnly.find((r) => r.id === 'ptc').description, 'WSL: standard')
  // Without WSL: unchanged rows.
  assert.deepEqual(mergePresets(mine, [], {}).map((r) => [r.id, r.isDefault]), [['standard', true], ['ptc', false]])
})

test('permission presets, search providers and models list both sides', () => {
  const perm = mergePermissionCatalog({ options: [{ value: 'read-only', name: 'read-only' }], defaultPreset: 'read-only' }, { options: [{ value: 'read-only', name: 'read-only' }, { value: 'locked', name: 'locked' }] }, { choice: 'locked' })
  assert.deepEqual(perm, { options: [{ value: 'read-only', name: 'read-only' }, { value: 'locked', name: 'locked · WSL' }], defaultPreset: 'locked' })
  assert.deepEqual(mergePermissionCatalog({ options: [], defaultPreset: 'x' }, undefined, { choice: 'y' }), { options: [], defaultPreset: 'x' })
  const web = mergeWebProviders({ search: [{ id: 'a' }], fetch: [{ id: 'http' }] }, { search: [{ id: 'a' }, { id: 'auto' }], fetch: [{ id: 'http' }] }, { describe: (kind) => ({ en: kind }) })
  assert.deepEqual(web, { search: [{ id: 'a' }, { id: 'auto', description: { en: 'search' } }], fetch: [{ id: 'http' }] })
  const models = mergeModelCatalog(
    { default: { provider: 'p', model: 'a' }, routableProviders: ['p'], groups: [{ id: 'p', name: 'P', models: [{ id: 'a', name: 'A' }] }] },
    { default: { provider: 'p', model: 'a' }, routableProviders: ['p', 'q'], groups: [{ id: 'p', name: 'P', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, { id: 'q', name: 'Q', models: [{ id: 'c' }] }] },
    { choice: { provider: 'q', model: 'c' } })
  assert.deepEqual(models.groups.map((g) => [g.name, g.models.map((m) => m.name ?? m.id)]), [['P', ['A', 'B · WSL']], ['Q · WSL', ['c']]])
  assert.deepEqual(models.default, { provider: 'q', model: 'c' })
  assert.deepEqual(models.routableProviders, ['p', 'q'])
})

test('a value the WSL Host already uses as its default is not written again on every pass', async () => {
  const { syncOps } = await import('../mirror/settings.mjs')
  assert.deepEqual(syncOps({ user: { searchProvider: 'auto' } }, { user: {}, value: { searchProvider: 'auto' } }), [])
  assert.deepEqual(syncOps({ user: { searchProvider: 'exa' } }, { user: {}, value: { searchProvider: 'auto' } }), [{ op: 'set', path: ['searchProvider'], value: 'exa' }])
  assert.deepEqual(syncOps({ user: {} }, { user: { searchProvider: 'auto' }, value: { searchProvider: 'auto' } }), [{ op: 'unset', path: ['searchProvider'] }])
})
