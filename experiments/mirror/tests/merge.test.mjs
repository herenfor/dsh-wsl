import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeGraphs, requestedPackages } from '../mirror/merge.mjs'
import { disabledByPatches } from '../agent/index.mjs'

const release = { version: '0.2.2-rc.1', commit: 'c59d10a' }
const row = (id, rev) => ({ id, url: `plugins/??${id}/client.js&rev=${rev}`, rev })
const local = {
  rev: 'L', release,
  entries: [row('@deepseek-ai/dsh-client-modules', 'm'), row('@deepseek-ai/dsh-client-ui-chat', 'a1'), row('@deepseek-ai/dsh-client-ui-tool', 'a2')],
  batches: [
    { phase: 'bootstrap', url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=m', rev: 'm', entries: ['@deepseek-ai/dsh-client-modules'] },
    { phase: 'application', url: 'plugins/??x&rev=b', rev: 'b', entries: ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-tool'] },
  ],
}
const remote = {
  graph: { rev: 'R', release, entries: [row('@deepseek-ai/dsh-client-modules', 'm2'), row('@deepseek-ai/dsh-client-ui-chat', 'b1'), row('dsh-sentinel', 's')], batches: [] },
  origin: { '@deepseek-ai/dsh-client-modules': 'builtin', '@deepseek-ai/dsh-client-ui-chat': 'user', 'dsh-sentinel': 'user' },
}
const order = (rows) => rows

test('remote user rows are added or replace the local row; builtin rows stay local', () => {
  const { graph, mirrored } = mergeGraphs(local, remote, order)
  assert.deepEqual([...mirrored.keys()], ['@deepseek-ai/dsh-client-ui-chat', 'dsh-sentinel'])
  assert.deepEqual(graph.entries.map((r) => `${r.id}@${r.rev}`), ['@deepseek-ai/dsh-client-modules@m', '@deepseek-ai/dsh-client-ui-tool@a2', '@deepseek-ai/dsh-client-ui-chat@b1', 'dsh-sentinel@s'])
  assert.equal(graph.release, release)
})

test('every row is in exactly one batch, and no batch still carries a replaced row', () => {
  const { graph } = mergeGraphs(local, remote, order)
  const seen = graph.batches.flatMap((b) => b.entries)
  assert.deepEqual([...seen].sort(), graph.entries.map((r) => r.id).sort())
  assert.ok(!graph.batches.some((b) => b.url === 'plugins/??x&rev=b'))
  assert.deepEqual(graph.batches.find((b) => b.entries[0] === '@deepseek-ai/dsh-client-ui-tool'), { phase: 'application', url: local.entries[2].url, rev: 'a2', entries: ['@deepseek-ai/dsh-client-ui-tool'] })
})

test('official rows a WSL plugin\'s patch switches off leave the page; their batch is split', () => {
  const disabled = disabledByPatches(
    [{ bundle: 'ds-bot', items: [{ insert: [{ id: 'bot', name: 'ds-bot' }] }, { id: 'web', config: {} }, { id: 'ui-tool', disabled: true }, { id: 'nameless', disabled: true }] }],
    new Map([['ui-tool', '@deepseek-ai/dsh-client-ui-tool'], ['web', '@deepseek-ai/dsh-web']]),
  )
  assert.deepEqual(disabled, [{ id: 'ui-tool', name: '@deepseek-ai/dsh-client-ui-tool', by: 'ds-bot' }])
  const { graph, dropped } = mergeGraphs(local, { ...remote, disabled }, order)
  assert.deepEqual([...dropped], ['@deepseek-ai/dsh-client-ui-tool'])
  assert.ok(!graph.entries.some((r) => r.id === '@deepseek-ai/dsh-client-ui-tool'))
  assert.ok(!graph.batches.some((b) => b.entries.includes('@deepseek-ai/dsh-client-ui-tool')))
  // a disabled row alone still changes the page, even with no WSL user rows
  const onlyDisabled = mergeGraphs(local, { graph: { ...remote.graph, entries: [] }, origin: {}, disabled }, order)
  assert.deepEqual(onlyDisabled.graph.entries.map((r) => r.id), ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-chat'])
})

test('a remote of another release is not mirrored', () => {
  const r = mergeGraphs(local, { ...remote, graph: { ...remote.graph, release: { version: '0.3.0' } } }, order)
  assert.equal(r.graph, local)
  assert.equal(r.mirrored.size, 0)
  assert.match(r.reason, /release differs/)
})

test('requested packages of combos, chunks and assets', () => {
  assert.deepEqual(requestedPackages('/plugins/??dsh-sentinel/client.js&rev=1'), ['dsh-sentinel'])
  assert.deepEqual(requestedPackages('/plugins/??a/client.js.map,@s/b/client.js.map&rev=1'), ['a', '@s/b'])
  assert.deepEqual(requestedPackages('/plugins/@deepseek-ai/dsh-client-ui-chat/client.x.js?rev=1'), ['@deepseek-ai/dsh-client-ui-chat'])
  assert.deepEqual(requestedPackages('/plugins/dsh-sentinel/assets/whale-1.png'), ['dsh-sentinel'])
})

import { isReserved, routesToForward } from '../mirror/routes.mjs'

test('only routes the WSL Host has and this Host lacks are forwarded, never DSH-owned paths', () => {
  const remote = { exact: ['/dsh-task-notify/events', '/dsh-wsl-probe/whoami', '/plugins/events', '/connect', '/shared'], prefix: ['/api', '/dsh-sentinel', '/plugins'] }
  const local = { exact: new Set(['/plugins/events', '/connect', '/shared']), prefix: ['/api', '/plugins'] }
  assert.deepEqual(routesToForward(remote, local), [
    { kind: 'exact', path: '/dsh-task-notify/events' },
    { kind: 'exact', path: '/dsh-wsl-probe/whoami' },
    { kind: 'prefix', path: '/dsh-sentinel' },
  ])
  assert.deepEqual(routesToForward({ exact: ['/api/x', '/wsl-bridge/events', '/'] }, {}), [])
  assert.equal(isReserved('/apix'), false)
  assert.deepEqual(routesToForward(undefined, local), [])
})

import { mergeDescribe, settingsMethod } from '../mirror/settings.mjs'

test('settings: WSL-only namespaces are added after this Host\'s own; shared ones keep this Host\'s view', () => {
  const local = { writable: true, hasDocument: true, namespaces: [{ ns: 'ui-chat', revision: 1 }, { ns: 'locale', revision: 2 }] }
  const remote = { writable: true, hasDocument: false, namespaces: [{ ns: 'locale', revision: 9 }, { ns: 'runtime-tuning-ui-chat', revision: 3 }] }
  const { value, remoteNamespaces } = mergeDescribe(local, remote)
  assert.deepEqual(value.namespaces.map((v) => `${v.ns}@${v.revision}`), ['ui-chat@1', 'locale@2', 'runtime-tuning-ui-chat@3'])
  assert.equal(value.hasDocument, true)
  assert.deepEqual([...remoteNamespaces], ['runtime-tuning-ui-chat'])
  assert.equal(settingsMethod('/api/settings/mutate'), 'mutate')
  assert.equal(settingsMethod('/api/settings/mutate/x'), undefined)
  assert.equal(settingsMethod('/api/session/list'), undefined)
})

import { wslBundles } from '../mirror/plugins.mjs'
import { toWindowsSpec, toWslSpec } from '../mirror/paths.mjs'

test('local-directory specs are converted between Windows and WSL', () => {
  assert.equal(toWslSpec('C:\\Users\\S\\dsh-wsl-test\\mirror'), '/mnt/c/Users/S/dsh-wsl-test/mirror')
  assert.equal(toWslSpec('link:D:/plugins/pet\\'), 'link:/mnt/d/plugins/pet')
  assert.equal(toWslSpec('\\\\wsl.localhost\\Ubuntu\\home\\s\\dsh-sentinel'), '/home/s/dsh-sentinel')
  assert.equal(toWslSpec('\\\\wsl$\\Ubuntu-24.04\\home\\s\\x'), '/home/s/x')
  assert.equal(toWslSpec('dsh-plugin-whale-pet'), 'dsh-plugin-whale-pet')
  assert.equal(toWslSpec('github:herenfor/dsh-sentinel'), 'github:herenfor/dsh-sentinel')
  assert.equal(toWindowsSpec('/mnt/c/Users/S/x', 'Ubuntu'), 'C:\\Users\\S\\x')
  assert.equal(toWindowsSpec('file:/home/s/dsh-sentinel', 'Ubuntu'), 'file:\\\\wsl.localhost\\Ubuntu\\home\\s\\dsh-sentinel')
  assert.equal(toWindowsSpec('@scope/pkg', 'Ubuntu'), '@scope/pkg')
})

import { sharedNamespaces, syncOps } from '../mirror/settings.mjs'

test('settings sync: Desktop values are copied field by field; secrets and machine-specific namespaces are not', () => {
  const desktop = { user: { provider: 'deepseek-account', model: 'flash', apiKey: '***' }, secrets: [{ path: ['apiKey'], set: true }] }
  const wsl = { user: { model: 'pro', extra: 1, apiKey: '***' }, secrets: [{ path: ['apiKey'], set: false }] }
  assert.deepEqual(syncOps(desktop, wsl), [
    { op: 'set', path: ['provider'], value: 'deepseek-account' },
    { op: 'set', path: ['model'], value: 'flash' },
    { op: 'unset', path: ['extra'] },
  ])
  assert.deepEqual(syncOps({ user: { a: [1] } }, { user: { a: [1] } }), [])
  const shared = sharedNamespaces([{ ns: 'locale' }, { ns: 'bash-sandbox' }, { ns: 'ui-chat' }], [{ ns: 'locale' }, { ns: 'bash-sandbox' }, { ns: 'runtime-tuning-ui-chat' }])
  assert.deepEqual(shared.map((s) => s.ns), ['locale'])
})


test('WSL tab: official optional and installed bundles, mine first; base and internal bundles left out', () => {
  const rows = wslBundles([
    { name: '@deepseek-ai/dsh-base', official: false, installed: false, enabled: true },
    { name: 'dsh-wsl-agent', official: false, installed: true, enabled: true },
    { name: '@deepseek-ai/dsh-x', official: true, installed: false, enabled: false, meta: { title: { en: 'X', zh: '某功能' } } },
    { name: 'ds-bot', official: false, installed: true, enabled: true, version: '0.3.5', description: 'Bots' },
  ])
  const zh = (v) => typeof v === 'string' ? v : v.zh ?? v.en
  assert.deepEqual(rows.map((r) => `${r.name}|${zh(r.title)}|${r.enabled}`), ['ds-bot|ds-bot|true', '@deepseek-ai/dsh-x|某功能|false'])
  assert.equal(rows[0].description, 'Bots')
})

test('wslBundlePage joins a bundle\'s rows with the WSL Host\'s live entries', async () => {
  const { wslBundlePage } = await import('../mirror/plugins.mjs')
  const bundles = [
    { name: '@deepseek-ai/dsh-experimental-agent-team-profile', official: true, installed: false, enabled: true, availability: 'installation', removable: false, version: '0.2.2-rc.1',
      meta: { title: { zh: '智能体团队', en: 'Agent team' } },
      rows: [{ rowId: 'agent-team', moduleName: '@deepseek-ai/dsh-experimental-agent-team', entryId: 'e1', meta: { title: { zh: '团队协作' } } }, { rowId: 'gone', moduleName: 'x' }] },
    { name: 'dsh-wsl-agent', official: false, installed: true, enabled: true, rows: [] },
    { name: 'ds-bot', official: false, installed: true, enabled: false, removable: true, source: 'ds-bot@1.0.0', rows: [] },
  ]
  const plugins = [{ entryId: 'e1', enabled: true, fiberPhase: 'active', patchId: 'agent-team' }]
  const team = wslBundlePage(bundles, plugins, bundles[0].name)
  assert.equal(team.experimental, true)
  assert.equal(team.removable, false)
  assert.deepEqual(team.rows.map((r) => [r.rowId, r.enabled, r.phase, r.locked, r.title]), [['agent-team', true, 'active', false, { en: '团队协作', zh: '团队协作' }], ['gone', false, null, true, 'gone']])
  const bot = wslBundlePage(bundles, plugins, 'ds-bot')
  assert.equal(bot.removable, true)
  assert.equal(bot.source, 'ds-bot@1.0.0')
  assert.equal(wslBundlePage(bundles, plugins, 'dsh-wsl-agent'), undefined)
  assert.equal(wslBundlePage(bundles, plugins, 'nope'), undefined)
})
