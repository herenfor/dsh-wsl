import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeOf, translate } from '../mirror/ids.mjs'
import { mapScheduleCwds, mergeDeleteInactive, mergeScheduleCatalog, mergeScheduleList, placeSchedule } from '../mirror/hostlists.mjs'

const S = 'session-11111111-2222-3333-4444-555555555555'
const task = (id, extra = {}) => ({ id, kind: 'after', title: 't', prompt: 'p', status: 'active', target: { kind: 'session', sessionId: S }, involvedSessionIds: [S], ...extra })

test('a WSL scheduled task gets the prefix, and calls naming it go back to WSL', () => {
  const page = translate([task('schedule-a', { lastDelivery: { targetSessionId: S, messageId: 'm1' } })], true)
  assert.equal(page[0].id, 'wsl:schedule-a')
  assert.equal(page[0].target.sessionId, `wsl:${S}`)
  assert.deepEqual(page[0].involvedSessionIds, [`wsl:${S}`])
  assert.equal(page[0].lastDelivery.targetSessionId, `wsl:${S}`)
  assert.equal(page[0].lastDelivery.messageId, 'm1')
  assert.equal(routeOf({ request: { id: 'wsl:schedule-a', action: 'delete' } }, 'schedule/edit'), 'wsl')
  assert.equal(routeOf({ request: { id: 'schedule-b' } }, 'schedule/view'), 'local')
  assert.deepEqual(translate({ request: { id: 'wsl:schedule-a', limit: 10 } }, false), { request: { id: 'schedule-a', limit: 10 } })
  // Other `id` fields are left alone.
  assert.deepEqual(translate({ id: 'deepseek-search-api' }, true), { id: 'deepseek-search-api' })
})

test('both Hosts\' scheduled tasks are listed', () => {
  assert.deepEqual(mergeScheduleCatalog([task('schedule-a')], [task('wsl:schedule-b')]).map((t) => t.id), ['schedule-a', 'wsl:schedule-b'])
  assert.deepEqual(mergeScheduleCatalog([task('schedule-a')], undefined).map((t) => t.id), ['schedule-a'])
  assert.deepEqual(mergeDeleteInactive({ deleted: 2 }, { deleted: 1 }), { deleted: 3 })
  assert.deepEqual(mergeDeleteInactive({ deleted: 2 }, undefined), { deleted: 2 })
})

test('a page of the merged list: active first, then the window the page asked for', () => {
  const { ask, combine } = mergeScheduleList({ limit: 2, offset: 1 })
  assert.deepEqual(ask, { limit: 3, offset: 0 })
  const mine = { items: [task('a1'), task('a2', { status: 'ended' })], total: 2 }
  const theirs = { items: [task('w1'), task('w2', { status: 'paused' })], total: 2 }
  const page = combine(mine, theirs)
  assert.deepEqual(page.items.map((t) => t.id), ['w1', 'a2'])  // a1, w1, a2, w2 → skip 1, take 2
  assert.deepEqual({ ...page, items: undefined }, { items: undefined, shown: 2, total: 4, limit: 2, offset: 1 })
  assert.deepEqual(mergeScheduleList({}).ask, { offset: 0, limit: 100 })
})

test('a task that creates its Session runs where that Session would', () => {
  const where = (cwd) => (cwd.startsWith('\\\\wsl.localhost\\') || cwd === 'D:\\wsl-run' ? 'wsl' : 'local')
  assert.equal(placeSchedule({ target: { kind: 'session', sessionId: `wsl:${S}` } }, where), 'by-id')
  assert.deepEqual(placeSchedule({ target: { kind: 'new', create: { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\p' } } }, where), { host: 'wsl' })
  assert.deepEqual(placeSchedule({ target: { kind: 'new_once', create: { cwd: 'D:\\wsl-run' } } }, where), { host: 'wsl' })
  assert.deepEqual(placeSchedule({ target: { kind: 'new', create: { cwd: 'D:\\here' } } }, where), { host: 'local' })
  assert.deepEqual(placeSchedule({ target: { kind: 'new' } }, where), { host: 'local' })
  assert.deepEqual(placeSchedule({}, where), { host: 'local' })
})

test('the folder of a task that creates its Session is shown in this Host\'s form', () => {
  const up = (p) => p.toUpperCase()
  const value = [{ id: 'x', target: { kind: 'new_once', create: { cwd: '/home/me/p', agentPreset: 'tuned' } } }, { id: 'y', target: { kind: 'session', sessionId: S } }, { id: 'z', target: { kind: 'new', create: {} } }]
  assert.deepEqual(mapScheduleCwds(value, up), [{ id: 'x', target: { kind: 'new_once', create: { cwd: '/HOME/ME/P', agentPreset: 'tuned' } } }, value[1], value[2]])
  assert.deepEqual(mapScheduleCwds({ request: { target: { kind: 'new', create: { cwd: 'a' } } } }, up), { request: { target: { kind: 'new', create: { cwd: 'A' } } } })
})
