// Host half of the probe: GET /dsh-wsl-probe/whoami answers which machine this half runs on.
import { hostname, platform, release } from 'node:os'

export const name = 'wsl-probe'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-wsl-probe/whoami',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ platform: platform(), release: release(), hostname: hostname(), pid: process.pid }))
    },
  }), 'wsl-probe: whoami route')
}
