import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsFor, decodeWslText, evaluate, hostPathOf, installBridgeFiles, nodeOk, parseDistros, parseProbe, promptFor } from '../mirror/setup.mjs'

const utf16 = (text) => Buffer.from(text, 'utf16le')

test('wsl.exe --list --verbose, as UTF-16 with the default starred', () => {
  const text = decodeWslText(utf16('  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n  Debian          Stopped         2\r\n  Legacy Name     Stopped         1\r\n'))
  assert.deepEqual(parseDistros(text), [
    { name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 },
    { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 },
    { name: 'Legacy Name', isDefault: false, state: 'Stopped', version: 1 },
  ])
  assert.equal(decodeWslText(Buffer.from('home=/home/s\n')), 'home=/home/s\n')
})

test('probe output', () => {
  const p = parseProbe('home=/home/s\narch=x86_64\nnode=/usr/bin/node v18.19.1\nnode=/home/s/.local/bin/node v24.22.2\ndsh={"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1","bin":{"dsh":"lib/bin.js"}}\nprofile=yes\n')
  assert.deepEqual(p, { home: '/home/s', arch: 'x86_64', nodes: [{ path: '/usr/bin/node', version: 'v18.19.1' }, { path: '/home/s/.local/bin/node', version: 'v24.22.2' }], dsh: { version: '0.2.2-rc.1', bin: 'lib/bin.js' }, profile: true })
  assert.equal(nodeOk('v24.9.0'), true); assert.equal(nodeOk('v24.8.9'), false); assert.equal(nodeOk('v25.0.0'), true); assert.equal(nodeOk('v18.19.1'), false)
})

const ubuntu = { distros: [{ name: 'Ubuntu', isDefault: true, version: 2 }] }
const probe = (patch = {}) => ({ home: '/home/s', arch: 'x86_64', nodes: [{ path: '/usr/bin/node', version: 'v18.19.1' }], dsh: null, profile: false, ...patch })

test('states', () => {
  const at = (listing, p, chosen) => evaluate({ desktopVersion: '0.2.2', listing, chosen, probe: p }).state
  assert.equal(at({ error: 'ENOENT' }), 'no-wsl')
  assert.equal(at({ distros: [] }), 'no-distro')
  assert.equal(at({ distros: [{ name: 'Old', isDefault: true, version: 1 }] }), 'wsl1')
  assert.equal(at(ubuntu, probe()), 'needs-node')
  assert.equal(at(ubuntu, probe({ nodes: [{ path: '/n', version: 'v24.22.2' }] })), 'needs-dsh')
  assert.equal(at(ubuntu, probe({ nodes: [{ path: '/n', version: 'v24.22.2' }], dsh: { version: '0.2.1', bin: 'lib/bin.js' } })), 'version-mismatch')
  const ready = evaluate({ desktopVersion: '0.2.2', listing: ubuntu, probe: probe({ nodes: [{ path: '/n', version: 'v24.22.2' }], dsh: { version: '0.2.2', bin: 'lib/bin.js' } }) })
  assert.equal(ready.state, 'ready')
  assert.equal(ready.dshEntry, '/home/s/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  // the chosen distribution wins over the default
  const two = { distros: [{ name: 'Ubuntu', isDefault: true, version: 2 }, { name: 'Debian', isDefault: false, version: 2 }] }
  assert.equal(evaluate({ desktopVersion: '0.2.2', listing: two, chosen: 'Debian', probe: probe() }).distro, 'Debian')
})

test('commands: Node only when none is new enough; DSH at Desktop\'s exact version; nothing for ready', () => {
  const needsNode = commandsFor({ state: 'needs-node', arch: 'x86_64' }, '0.2.2-rc.1')
  assert.match(needsNode, /node-v24\.22\.2-linux-x64\.tar\.xz/)
  assert.match(needsNode, /~\/\.dsh-wsl\/node\/bin\/npm install --prefix ~\/\.dsh-wsl\/dsh @deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  const needsDsh = commandsFor({ state: 'needs-dsh', arch: 'aarch64', node: { path: '/home/s/.local/bin/node' } }, '0.2.2')
  assert.doesNotMatch(needsDsh, /nodejs\.org/)
  assert.match(needsDsh, /PATH="\/home\/s\/\.local\/bin:\$PATH" npm install --prefix ~\/\.dsh-wsl\/dsh @deepseek-ai\/dsh@0\.2\.2/)
  assert.equal(commandsFor({ state: 'ready' }, '0.2.2'), '')
  const prompt = promptFor({ state: 'needs-dsh', distro: 'Ubuntu', node: { path: '/usr/local/bin/node' } }, '0.2.2')
  assert.match(prompt, /wsl\.exe -d Ubuntu -- bash -lc/)
  assert.match(prompt, /不要用 sudo/)
  assert.equal(promptFor({ state: 'ready' }, '0.2.2'), '')
})

test('bridge files are copied once per content stamp', () => {
  const plugin = mkdtempSync(join(tmpdir(), 'dsh-wsl-plugin-'))
  mkdirSync(join(plugin, 'transport')); mkdirSync(join(plugin, 'agent'))
  writeFileSync(join(plugin, 'transport', 'daemon.mjs'), 'one'); writeFileSync(join(plugin, 'agent', 'package.json'), '{}')
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-home-'))
  const first = installBridgeFiles(plugin, home)
  assert.equal(first.copied, true)
  assert.equal(readFileSync(join(home, '.dsh-wsl', 'bridge', 'transport', 'daemon.mjs'), 'utf8'), 'one')
  assert.equal(installBridgeFiles(plugin, home).copied, false)
  writeFileSync(join(plugin, 'transport', 'daemon.mjs'), 'two')
  const second = installBridgeFiles(plugin, home)
  assert.equal(second.copied, true); assert.notEqual(second.stamp, first.stamp)
  assert.ok(existsSync(join(home, '.dsh-wsl', 'bridge', 'STAMP')))
  assert.equal(hostPathOf('win32', 'Ubuntu', '/home/s'), '\\\\wsl.localhost\\Ubuntu\\home\\s')
  assert.equal(hostPathOf('linux', 'Ubuntu', '/home/s'), '/home/s')
})
