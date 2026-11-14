import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { admitsHost, wrongHostMessage, wslRequestProblem } from '../mirror/admission.mjs'
import { apply } from '../mirror/index.mjs'

test('the published bridge admits Windows only, even when a custom transport exists', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mirror/package.json', import.meta.url)))
  assert.deepEqual(manifest.dsh.bundle.platforms, ['win32'])
  assert.equal(admitsHost('win32', manifest), true)
  for (const platform of ['linux', 'darwin']) {
    assert.equal(admitsHost(platform, manifest), false)
    assert.equal(admitsHost(platform, manifest, 'custom-wsl.exe'), false)
  }
  assert.equal(admitsHost('linux', { private: true }, '/fake/wsl'), true)
  assert.equal(admitsHost('linux', { private: true }), false)
})

test('a wrong-side load fails visibly before touching any Host service or configuration', { skip: process.platform === 'win32' }, async () => {
  const ctx = new Proxy({}, { get() { assert.fail('wrong-side load accessed a Host service') } })
  await assert.rejects(apply(ctx, { command: 'node', args: ['fake-bridge'] }), (error) => {
    assert.match(error.message, /安装位置不正确/)
    assert.match(error.message, /当前未启动/)
    assert.match(error.message, /安全地从 WSL 卸载/)
    return true
  })
})

test('the WSL plugin page rejects wrong-side and version-only requests, while allowing removal', () => {
  for (const action of ['inspect', 'install', 'enable']) assert.equal(wslRequestProblem({ action, name: '@herenfor/dsh-wsl' }), 'wrong-host')
  assert.equal(wslRequestProblem({ action: 'install', spec: '@herenfor/dsh-wsl@0.1.12' }), 'wrong-host')
  for (const spec of ['0.2.17', '^0.2.17', '0.2.17-dev.1']) assert.equal(wslRequestProblem({ action: 'install', spec }), 'version-only')
  for (const spec of ['@herenfor/dsh-tune@0.2.17', 'file:/tmp/plugin.tgz', '/tmp/local', 'github:owner/repo']) assert.equal(wslRequestProblem({ action: 'install', spec }), undefined)
  for (const action of ['remove', 'disable']) assert.equal(wslRequestProblem({ action, name: '@herenfor/dsh-wsl' }), undefined)
  assert.match(wrongHostMessage(), /Windows Desktop/)
})
