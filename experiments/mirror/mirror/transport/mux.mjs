// A stream multiplexer over one byte stream (a wsl.exe stdio pipe, or a Unix socket behind it).
// Frame: u32 length of the rest | u8 type | u32 stream id | payload.
// Types: OPEN (payload: JSON target), DATA, END (the sender will write no more), RESET (payload: reason), CONTROL
// (stream 0, payload: JSON). The opening side uses odd ids, the accepting side even ids, so ids never collide.
// Backpressure is the underlying pipe's; there are no per-stream windows yet.
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'

export const OPEN = 1, DATA = 2, END = 3, RESET = 4, CONTROL = 5
const HEADER = 9

export function encode(type, id, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const frame = Buffer.allocUnsafe(4 + 5 + body.length)
  frame.writeUInt32BE(5 + body.length, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(id, 5)
  body.copy(frame, HEADER)
  return frame
}

/** Incremental frame decoder: feed chunks, get { type, id, payload } frames. */
export class Decoder {
  buffer = Buffer.alloc(0);
  *push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (this.buffer.length < 4 + length) return
      const type = this.buffer.readUInt8(4)
      const id = this.buffer.readUInt32BE(5)
      const payload = this.buffer.subarray(HEADER, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      yield { type, id, payload: Buffer.from(payload) }
    }
  }
}

/**
 * One end of the multiplexer.
 * Events: 'stream' (duplex, target) for streams the other end opened; 'control' (message); 'close' (error?).
 */
export class Mux extends EventEmitter {
  streams = new Map()
  closed = false
  constructor(readable, writable, { side }) {
    super()
    this.writable = writable
    this.nextId = side === 'opener' ? 1 : 2
    const decoder = new Decoder()
    readable.on('data', (chunk) => { for (const frame of decoder.push(chunk)) this.receive(frame) })
    const close = (error) => this.close(error)
    readable.once('end', () => close())
    readable.once('error', close)
    writable.once('error', close)
  }

  send(type, id, payload) {
    if (this.closed) return false
    return this.writable.write(encode(type, id, payload))
  }

  control(message) { this.send(CONTROL, 0, JSON.stringify(message)) }

  /** Open a stream to a named target on the other end. */
  open(target) {
    const id = this.nextId
    this.nextId += 2
    const stream = this.attach(id)
    this.send(OPEN, id, JSON.stringify(target))
    return stream
  }

  attach(id) {
    const mux = this
    let ended = false
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        if (mux.send(DATA, id, chunk)) callback()
        else mux.writable.once('drain', () => callback())
      },
      final(callback) { ended = true; mux.send(END, id); callback() },
      destroy(error, callback) {
        if (mux.streams.get(id) === stream) {
          mux.streams.delete(id)
          if (!ended || error) mux.send(RESET, id, error ? String(error.message ?? error) : '')
        }
        callback(error)
      },
    })
    this.streams.set(id, stream)
    return stream
  }

  receive({ type, id, payload }) {
    if (type === CONTROL) { try { this.emit('control', JSON.parse(payload.toString('utf8'))) } catch {} return }
    if (type === OPEN) {
      let target
      try { target = JSON.parse(payload.toString('utf8')) } catch { target = null }
      this.emit('stream', this.attach(id), target)
      return
    }
    const stream = this.streams.get(id)
    if (!stream) return
    if (type === DATA) stream.push(payload)
    else if (type === END) stream.push(null)
    else if (type === RESET) { this.streams.delete(id); stream.destroy(payload.length ? new Error(payload.toString('utf8')) : undefined) }
  }

  close(error) {
    if (this.closed) return
    this.closed = true
    for (const stream of this.streams.values()) stream.destroy(new Error('bridge closed'))
    this.streams.clear()
    this.emit('close', error)
  }
}
