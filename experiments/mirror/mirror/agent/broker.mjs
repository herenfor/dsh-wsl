// Credential broker, WSL half (docs/credentials.md, option 3). The WSL DSH Host keeps its own credential service
// (credentials-local); this wraps its read methods so that a credential the person did not set in WSL is asked of
// Desktop, through the bridge daemon (transport/daemon.mjs, "broker" connections). Nothing from Desktop is stored here.
//
// - resolve / describe / readRecord / describeRecord: WSL's own first, then Desktop's.
// - listRecords: both, WSL's own winning on the same key.
// - modifyRecord on a record only Desktop has (an account token refresh): read Desktop's, run the update here, write
//   it back to Desktop as a compare-and-swap, retrying if Desktop's changed meanwhile. Desktop keeps the only copy.
// - set / unset / deleteRecord: WSL's own store only.
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class BrokerClient {
  constructor(runDir) {
    this.socketPath = join(runDir, 'rpc.sock')
    this.tokenPath = join(runDir, 'daemon.token')
    this.pending = new Map()
    this.next = 1
  }
  connection() {
    if (this.socket && !this.socket.destroyed) return this.socket
    const socket = connect(this.socketPath)
    socket.write(`${readFileSync(this.tokenPath, 'utf8').trim()} broker\n`)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        let answer
        try { answer = JSON.parse(line) } catch { continue }
        const waiter = this.pending.get(answer.id)
        if (!waiter) continue
        this.pending.delete(answer.id)
        if (answer.error) waiter.reject(new Error(answer.error)); else waiter.resolve(answer.value)
      }
    })
    const fail = (error) => { for (const w of this.pending.values()) w.reject(error ?? new Error('broker connection closed')); this.pending.clear() }
    socket.on('error', fail)
    socket.on('close', () => fail())
    socket.unref()
    return (this.socket = socket)
  }
  /** One request to Desktop; rejects when Desktop is not connected or does not answer. */
  ask(op, args = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const id = this.next++
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Desktop did not answer')) }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      try { this.connection().write(`${JSON.stringify({ id, op, ...args })}\n`) } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }
  close() { this.socket?.destroy() }
}

/** Wrap the credential service instance; returns the restore function. */
export function brokerCredentials(credentials, client, logger) {
  const own = {}
  const orig = {}
  for (const name of ['resolve', 'describe', 'readRecord', 'describeRecord', 'listRecords', 'modifyRecord']) {
    own[name] = Object.hasOwn(credentials, name)
    orig[name] = credentials[name].bind(credentials)
  }
  const desktop = async (op, args, fallback) => {
    try { return await client.ask(op, args) } catch (error) { logger?.debug?.('wsl-agent: Desktop credentials %s: %s', op, error.message); return fallback }
  }
  credentials.resolve = async (ref) => (await orig.resolve(ref)) ?? (await desktop('resolve', { ref }, null)) ?? undefined
  credentials.describe = async (ref) => {
    const local = await orig.describe(ref)
    if (local.configured) return local
    const theirs = await desktop('describe', { ref })
    return theirs?.configured ? { configured: true, source: `desktop${theirs.source ? `-${theirs.source}` : ''}`, writable: local.writable } : local
  }
  credentials.readRecord = async (key) => (await orig.readRecord(key)) ?? (await desktop('readRecord', { key }, null)) ?? undefined
  credentials.describeRecord = async (key) => {
    const local = await orig.describeRecord(key)
    if (local.configured) return local
    const theirs = await desktop('describeRecord', { key })
    return theirs?.configured ? { ...theirs, writable: local.writable } : local
  }
  credentials.listRecords = async () => {
    const local = await orig.listRecords()
    const theirs = (await desktop('listRecords', {}, [])) ?? []
    const keys = new Set(local.map((e) => e.key))
    return [...local, ...theirs.filter((e) => !keys.has(e.key))]
  }
  credentials.modifyRecord = async (key, mutate) => {
    if ((await orig.readRecord(key)) !== undefined) return orig.modifyRecord(key, mutate)
    let current = await desktop('readRecord', { key }, null)
    if (current === null) return orig.modifyRecord(key, mutate)
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await mutate(current)
      if (next === undefined) return current
      const result = await client.ask('swapRecord', { key, expected: current, next })
      if (result.swapped) return result.record ?? undefined
      current = result.record
      if (current === null) return orig.modifyRecord(key, mutate)
    }
    throw new Error('wsl-agent: Desktop credential record kept changing; giving up')
  }
  return () => {
    for (const name of Object.keys(orig)) { if (own[name]) credentials[name] = orig[name]; else delete credentials[name] }
    client.close()
  }
}
