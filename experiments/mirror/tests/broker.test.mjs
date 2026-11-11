import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { brokerCredentials } from '../agent/broker.mjs'

// A local provider and a Desktop behind a fake broker client.
function setup({ local = {}, localRecords = {}, desktop = {}, desktopRecords = {} } = {}) {
  const creds = {
    async resolve(ref) { return local[ref] ? { value: local[ref], source: 'file' } : undefined },
    async describe(ref) { return { configured: ref in local, writable: true, ...(ref in local ? { source: 'file' } : {}) } },
    async readRecord(key) { return localRecords[key] },
    async describeRecord(key) { return { configured: key in localRecords, writable: true } },
    async listRecords() { return Object.entries(localRecords).map(([key, r]) => ({ key, kind: r.kind })) },
    async modifyRecord(key, mutate) { const next = await mutate(localRecords[key]); if (next !== undefined) localRecords[key] = next; return localRecords[key] },
  }
  const asked = []
  const client = {
    swapHook: undefined,
    async ask(op, args) {
      asked.push(op)
      if (op === 'resolve') return desktop[args.ref] ? { value: desktop[args.ref], source: 'desktop-file' } : null
      if (op === 'describe') return { configured: args.ref in desktop, writable: true }
      if (op === 'readRecord') return desktopRecords[args.key] ?? null
      if (op === 'listRecords') return Object.entries(desktopRecords).map(([key, r]) => ({ key, kind: r.kind }))
      if (op === 'swapRecord') {
        client.swapHook?.()
        if (!isDeepStrictEqual(desktopRecords[args.key] ?? null, args.expected)) return { swapped: false, record: desktopRecords[args.key] ?? null }
        desktopRecords[args.key] = args.next
        return { swapped: true, record: args.next }
      }
      throw new Error(op)
    },
    close() {},
  }
  const restore = brokerCredentials(creds, client)
  return { creds, asked, client, localRecords, desktopRecords, restore }
}

test('WSL\'s own credential wins; Desktop fills the gaps', async () => {
  const { creds, asked } = setup({ local: { A: 'wsl-a' }, desktop: { A: 'desk-a', B: 'desk-b' } })
  assert.deepEqual(await creds.resolve('A'), { value: 'wsl-a', source: 'file' })
  assert.equal(asked.length, 0)
  assert.deepEqual(await creds.resolve('B'), { value: 'desk-b', source: 'desktop-file' })
  assert.equal(await creds.resolve('C'), undefined)
  assert.deepEqual(await creds.describe('B'), { configured: true, source: 'desktop', writable: true })
})

test('Desktop down: WSL behaves as it would alone', async () => {
  const { creds, client } = setup({ local: { A: 'wsl-a' } })
  client.ask = async () => { throw new Error('Desktop is not connected') }
  assert.equal(await creds.resolve('B'), undefined)
  assert.equal((await creds.describe('B')).configured, false)
  assert.deepEqual(await creds.listRecords(), [])
})

test('a token refresh of a Desktop record is written back to Desktop, not kept in WSL', async () => {
  const { creds, localRecords, desktopRecords } = setup({ desktopRecords: { 'account:me': { kind: 'grant', payload: { token: 1 } } } })
  const after = await creds.modifyRecord('account:me', async (cur) => ({ kind: 'grant', payload: { token: cur.payload.token + 1 } }))
  assert.deepEqual(after, { kind: 'grant', payload: { token: 2 } })
  assert.deepEqual(desktopRecords['account:me'], { kind: 'grant', payload: { token: 2 } })
  assert.equal(localRecords['account:me'], undefined)
})

test('a refresh racing Desktop\'s own is redone on Desktop\'s new value', async () => {
  const s = setup({ desktopRecords: { k: { kind: 'grant', payload: { token: 1 } } } })
  let raced = false
  s.client.swapHook = () => { if (!raced) { raced = true; s.desktopRecords.k = { kind: 'grant', payload: { token: 10 } } } }
  const seen = []
  const after = await s.creds.modifyRecord('k', async (cur) => { seen.push(cur.payload.token); return { kind: 'grant', payload: { token: cur.payload.token + 1 } } })
  assert.deepEqual(seen, [1, 10])
  assert.deepEqual(after.payload, { token: 11 })
})

test('records: both listed, WSL\'s own wins; restore puts the service back', async () => {
  const s = setup({ localRecords: { a: { kind: 'api-key', key: 'x' } }, desktopRecords: { a: { kind: 'api-key', key: 'y' }, b: { kind: 'grant', payload: 1 } } })
  assert.deepEqual(await s.creds.listRecords(), [{ key: 'a', kind: 'api-key' }, { key: 'b', kind: 'grant' }])
  assert.deepEqual(await s.creds.readRecord('a'), { kind: 'api-key', key: 'x' })
  s.restore()
  assert.equal(Object.hasOwn(s.creds, 'resolve'), true)  // the fake defines its methods as own properties
  assert.equal(await s.creds.resolve('zzz'), undefined)
})
