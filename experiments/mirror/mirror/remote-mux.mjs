// Streams on the WSL DSH Host: one WebSocket to its /api/remote.mux (DSH's JSON text mux), opened over the bridge.
// A minimal WebSocket client (RFC 6455, text frames, no extensions) so nothing depends on where the Desktop install
// keeps the `ws` package.
import { randomBytes, randomUUID, createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Error of a remote stream, in the form DSH's gateway passes to the page unchanged. */
export const remoteError = (failure) => Object.assign(new Error(failure?.message || 'WSL stream failed'), {
  isDSHRemoteError: true, code: failure?.code || 'internal', details: failure?.details ?? {},
})
const carrierError = (message) => remoteError({ code: 'gateway/carrier', message })

function encode(opcode, payload) {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
  const mask = randomBytes(4)
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, body])
}

class Socket {
  constructor(socket, head, onText, onClose) {
    this.socket = socket
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    this.fragments = []
    this.open = true
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(onText) })
    const closed = () => { if (!this.open) return; this.open = false; onClose() }
    socket.once('close', closed)
    socket.once('error', closed)
    if (this.buffer.length) queueMicrotask(() => this.drain(onText))
  }
  drain(onText) {
    for (;;) {
      const b = this.buffer
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let offset = 2
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); offset = 4 } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); offset = 10 }
      const maskAt = offset
      if (masked) offset += 4
      if (b.length < offset + len) return
      let payload = b.subarray(offset, offset + len)
      if (masked) { const m = b.subarray(maskAt, maskAt + 4); payload = Buffer.from(payload.map((x, i) => x ^ m[i & 3])) }
      this.buffer = b.subarray(offset + len)
      if (opcode === 0x9) this.write(0xa, payload)
      else if (opcode === 0x8) { this.write(0x8, Buffer.alloc(0)); this.socket.end(); return }
      else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(Buffer.from(payload))
        if (fin) { const text = Buffer.concat(this.fragments).toString('utf8'); this.fragments = []; onText(text) }
      }
    }
  }
  write(opcode, payload) { if (this.open && !this.socket.destroyed) this.socket.write(encode(opcode, payload)) }
  send(text) { this.write(0x1, Buffer.from(text, 'utf8')) }
  close() { if (this.open) { this.write(0x8, Buffer.alloc(0)); this.socket.end() } this.socket.destroy() }
}

/**
 * @param upgrade - async () => ({ socket, head }): performs the HTTP upgrade to /api/remote.mux on the WSL Host.
 */
export class WslMux {
  constructor(upgrade) {
    this.upgrade = upgrade
    this.streams = new Map()
  }
  connect() {
    if (this.socket?.open) return Promise.resolve()
    return (this.connecting ??= (async () => {
      const { socket, head } = await this.upgrade()
      this.socket = new Socket(socket, head, (text) => this.receive(text), () => {
        this.socket = undefined
        for (const inbox of this.streams.values()) inbox.fail(carrierError('The connection to the WSL Host closed.'))
      })
    })().finally(() => { this.connecting = undefined }))
  }
  receive(text) {
    let frame
    try { frame = JSON.parse(text) } catch { return }
    this.streams.get(frame.streamId)?.push(frame)
  }
  /** Open one stream on the WSL Host; yields its items, throws its error. */
  async *open(endpoint, payload, signal, uplink) {
    await this.connect()
    signal?.throwIfAborted()
    const id = randomUUID()
    const inbox = new Inbox()
    this.streams.set(id, inbox)
    const socket = this.socket
    const send = (frame) => socket.send(JSON.stringify({ streamId: id, ...frame }))
    const abort = () => inbox.fail(signal.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    send({ type: 'open', endpoint, payload })
    let stopped = false
    let iterator
    if (uplink) {
      iterator = uplink[Symbol.asyncIterator]()
      void (async () => {
        while (!stopped) {
          const item = await iterator.next()
          if (stopped) break
          if (item.done) { send({ type: 'end' }); break }
          send({ type: 'item', value: item.value })
        }
      })().catch((error) => inbox.fail(error))
    }
    let finished = false
    try {
      for (;;) {
        const frame = await inbox.next()
        if (frame.type === 'item') yield frame.value
        else if (frame.type === 'error') { finished = true; throw remoteError(frame.error) }
        else { finished = true; return }
      }
    } finally {
      stopped = true
      signal?.removeEventListener('abort', abort)
      if (!finished && socket.open) send({ type: 'cancel' })
      this.streams.delete(id)
      void iterator?.return?.()
    }
  }
  close() { this.socket?.close() }
}

class Inbox {
  frames = [];
  push(frame) { this.frames.push(frame); this.wake?.() }
  fail(error) { this.error ??= error; this.wake?.() }
  async next() {
    while (!this.frames.length) {
      if (this.error) throw this.error
      await new Promise((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
    return this.frames.shift()
  }
}

/** The headers and accept check of a client WebSocket upgrade. */
export function upgradeHeaders() {
  const key = randomBytes(16).toString('base64')
  return {
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key },
    accept: createHash('sha1').update(key + GUID).digest('base64'),
  }
}
