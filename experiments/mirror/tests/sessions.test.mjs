import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeOf, translate } from '../mirror/ids.mjs'
import { applyWorkspaceFrame, mergeWorkspaces, pathMapping, placeSession, prefixEvent, prefixProjections } from '../mirror/sessions.mjs'

test('identities get the prefix coming in and lose it going out', () => {
  const wire = { workspace: { workspaceId: 'w1', path: '/home/s/p', sessionIds: ['s1', 's2'] }, ref: { kind: 'session', id: 's3' }, title: 's1' }
  const page = translate(wire, true)
  assert.deepEqual(page.workspace.sessionIds, ['wsl:s1', 'wsl:s2'])
  assert.equal(page.workspace.workspaceId, 'wsl:w1')
  assert.equal(page.ref.id, 'wsl:s3')
  assert.equal(page.title, 's1')
  assert.equal(page.workspace.path, '/home/s/p')
  assert.deepEqual(translate(page, false), wire)
})

test('a call goes where its identities live', () => {
  assert.equal(routeOf({ request: { sessionId: 'wsl:a' } }), 'wsl')
  assert.equal(routeOf({ request: { sessionId: 'a' } }), 'local')
  assert.equal(routeOf({}), 'local')
  assert.equal(routeOf({ agentId: 'wsl:a', query: 'x' }), 'wsl')
  assert.throws(() => routeOf({ request: { workspaceId: 'w', sessionId: 'wsl:a' } }), /mixes/)
  assert.equal(routeOf({ request: { workspaceId: 'wsl:w', sessionId: 'blank' } }, 'session/create'), 'wsl')
})

const linux = pathMapping('linux')
const win = pathMapping('win32', 'Ubuntu')

test('Windows paths and WSL paths', () => {
  assert.equal(win.toWsl('D:\\code\\proj'), '/mnt/d/code/proj')
  assert.equal(win.toLocal('/mnt/d/code/proj'), 'D:\\code\\proj')
  assert.equal(win.toLocal('/home/s/proj'), '\\\\wsl.localhost\\Ubuntu\\home\\s\\proj')
  assert.equal(win.toWsl('\\\\wsl.localhost\\Ubuntu\\home\\s\\proj'), '/home/s/proj')
  assert.ok(win.insideWsl('\\\\wsl.localhost\\Ubuntu\\home\\s\\proj'))
  assert.ok(!win.insideWsl('D:\\code'))
})

test('a Windows folder with a WSL twin is one row holding both sides\' Sessions', () => {
  const local = { items: [{ workspaceId: 'a', path: 'D:\\code\\proj', sessionIds: ['s1'] }], archivedSessionIds: ['s9'], pinnedSessionIds: [] }
  const wsl = translate({ items: [
    { workspaceId: 'tw', path: '/mnt/d/code/proj', sessionIds: ['t1'] },
    { workspaceId: 'own', path: '/home/s/x', sessionIds: ['t2'] },
  ], archivedSessionIds: [], pinnedSessionIds: ['t1'] }, true)
  const { value, twins } = mergeWorkspaces(local, wsl, win)
  assert.deepEqual(value.items.map((w) => [w.workspaceId, w.path, w.sessionIds]), [
    ['a', 'D:\\code\\proj', ['s1', 'wsl:t1']],
    ['wsl:own', '\\\\wsl.localhost\\Ubuntu\\home\\s\\x', ['wsl:t2']],
  ])
  assert.equal(twins.get('a'), 'wsl:tw')
  assert.deepEqual(value.pinnedSessionIds, ['wsl:t1'])
  assert.deepEqual(value.archivedSessionIds, ['s9'])
})

test('workspace frames apply in order', () => {
  let s = applyWorkspaceFrame(undefined, { type: 'baseline', value: { items: [{ workspaceId: 'a' }, { workspaceId: 'b' }], archivedSessionIds: [], pinnedSessionIds: [] } })
  s = applyWorkspaceFrame(s, { type: 'upsert', workspace: { workspaceId: 'c' } })
  s = applyWorkspaceFrame(s, { type: 'order', workspaceIds: ['c', 'b', 'a'] })
  s = applyWorkspaceFrame(s, { type: 'remove', workspaceId: 'b' })
  assert.deepEqual(s.items.map((w) => w.workspaceId), ['c', 'a'])
})

test('where a new Session goes', () => {
  assert.deepEqual(placeSession({ workspaceId: 'a', sessionId: 'blank' }, { target: 'local' }), { host: 'local', request: { workspaceId: 'a', sessionId: 'blank' } })
  // The page offers a WSL blank for reuse but the folder runs here: the blank is not reused.
  assert.deepEqual(placeSession({ workspaceId: 'a', sessionId: 'wsl:b' }, { target: 'local' }), { host: 'local', request: { workspaceId: 'a' } })
  assert.deepEqual(placeSession({ workspaceId: 'a', sessionId: 'blank' }, { target: 'wsl', twin: 'wsl:tw' }), { host: 'wsl', request: { workspaceId: 'wsl:tw' } })
  assert.deepEqual(placeSession({ workspaceId: 'a', sessionId: 'wsl:b', agentPreset: 'x' }, { target: 'wsl', twin: 'wsl:tw' }), { host: 'wsl', request: { agentPreset: 'x', workspaceId: 'wsl:tw', sessionId: 'wsl:b' } })
  assert.deepEqual(placeSession({ workspaceId: 'a' }, { target: 'wsl' }), { host: 'wsl', needsTwin: true, request: {} })
  assert.deepEqual(placeSession({ workspaceId: 'wsl:own' }, { target: 'local' }), { host: 'wsl', request: { workspaceId: 'wsl:own' } })
  assert.equal(placeSession({ cwd: '/x' }, { target: 'wsl' }).host, 'local')
  assert.equal(linux.toWsl('/home/s/p'), '/home/s/p')
})

test('Session control baselines and session events from WSL are prefixed', () => {
  assert.deepEqual(prefixProjections({ projections: { s1: { a: 1 } } }), { projections: { 'wsl:s1': { a: 1 } } })
  assert.deepEqual(prefixEvent({ type: 'emit', event: 'api-session/changed', args: ['s1', 2] }).args, ['wsl:s1', 2])
  assert.deepEqual(prefixEvent({ type: 'emit', event: 'other', args: ['s1'] }).args, ['s1'])
})
