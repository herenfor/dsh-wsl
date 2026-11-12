// Which WSL Host routes the Desktop Host forwards. Kept free of DSH imports so it can be unit-tested.

// Paths DSH itself owns on every Host; never forwarded even when only the WSL Host has them.
const RESERVED = [/^\/$/, /^\/api(\/|$)/, /^\/plugins(\/|$)/, /^\/connect$/, /^\/wsl-bridge(\/|$)/, /^\/assets(\/|$)/]
export const isReserved = (path) => RESERVED.some((re) => re.test(path))

/**
 * Routes the WSL Host serves and the local Host does not: with the same DSH version and the same official bundles
 * on both sides, these are the routes of plugins installed only in WSL.
 * @param remote - { exact: string[], prefix: string[] } from the WSL agent.
 * @param local - { exact: Set|string[], prefix: Set|string[] } of this Host, without the routes the mirror added.
 * @returns [{ kind, path }] in a stable order.
 */
export function routesToForward(remote, local) {
  const out = []
  for (const kind of ['exact', 'prefix']) {
    const mine = new Set(local?.[kind] ?? [])
    for (const path of [...(remote?.[kind] ?? [])].sort()) if (!mine.has(path) && !isReserved(path)) out.push({ kind, path })
  }
  return out
}

// Request headers passed to the WSL Host; cookie, host and origin are replaced with the WSL Host's own.
export const FORWARD_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'cache-control', 'if-none-match', 'if-modified-since', 'last-event-id', 'range']
// Response headers passed back; set-cookie is dropped so the WSL Host's cookie never reaches the page.
export const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'])

export const isJson = (type) => typeof type === 'string' && /^application\/(?:[\w.+-]*\+)?json\b/i.test(type.trim())

/**
 * A chunk rewriter for a Server-Sent Events body: each `data:` line holding JSON goes through `map`. Lines are cut at
 * line ends, so a partial line waits for the next chunk.
 */
export function eventStreamRewriter(map) {
  const decoder = new TextDecoder()
  let pending = ''
  return (chunk) => {
    pending += decoder.decode(chunk, { stream: true })
    const end = pending.lastIndexOf('\n')
    if (end < 0) return Buffer.alloc(0)
    const lines = pending.slice(0, end + 1)
    pending = pending.slice(end + 1)
    return Buffer.from(lines.replace(/^data:( ?)(.*)$/gm, (line, space, data) => {
      try { return `data:${space}${JSON.stringify(map(JSON.parse(data)))}` } catch { return line }
    }))
  }
}
