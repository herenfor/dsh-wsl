import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeGraphs, requestedPackages } from '../mirror/merge.mjs'

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

test('a remote of another release is not mirrored', () => {
  const r = mergeGraphs(local, { ...remote, graph: { ...remote.graph, release: { version: '0.2.3' } } }, order)
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
