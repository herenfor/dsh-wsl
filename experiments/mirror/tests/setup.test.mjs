import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsFor, compareVersions, compatibleRelease, decodeWslText, evaluate, hostPathOf, installBridgeFiles, installScript, nodeOk, parseDistros, parseProbe, promptFor } from '../mirror/setup.mjs'

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
  const own = '/home/s/.local/lib/node_modules/@deepseek-ai/dsh'
  const p = parseProbe(`home=/home/s\narch=x86_64\nnode=/usr/bin/node v18.19.1\nnode=/home/s/.local/bin/node v24.22.2\ndsh={"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1","bin":{"dsh":"lib/bin.js"}}\nown=/home/s/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js|/home/s/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh|{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1"}\nown=${own}/lib/bin.js|${own}|{"name": "@deepseek-ai/dsh", "version": "0.2.1"}\n`)
  assert.deepEqual(p, {
    home: '/home/s', arch: 'x86_64', nodes: [{ path: '/usr/bin/node', version: 'v18.19.1' }, { path: '/home/s/.local/bin/node', version: 'v24.22.2' }],
    dsh: { version: '0.2.2-rc.1', bin: 'lib/bin.js' },
    own: { entry: `${own}/lib/bin.js`, pkgDir: own, version: '0.2.1', prefix: '/home/s/.local' },   // the private one is skipped
  })
  assert.equal(nodeOk('v24.9.0'), true); assert.equal(nodeOk('v24.8.9'), false); assert.equal(nodeOk('v25.0.0'), true); assert.equal(nodeOk('v18.19.1'), false)
})

const ubuntu = { distros: [{ name: 'Ubuntu', isDefault: true, version: 2 }] }
const probe = (patch = {}) => ({ home: '/home/s', arch: 'x86_64', nodes: [{ path: '/usr/bin/node', version: 'v18.19.1' }], dsh: null, own: null, ...patch })
const node24 = [{ path: '/n/node', version: 'v24.22.2' }]
const own = (version) => ({ entry: '/o/lib/bin.js', pkgDir: '/p/lib/node_modules/@deepseek-ai/dsh', version, prefix: '/p' })

test('versions: same major.minor connects; prereleases order before their release', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.2'), -1)
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.2'), 1)
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.9'), 1)
  assert.equal(compareVersions('0.2.2', '0.2.2'), 0)
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1)
  assert.equal(compatibleRelease('0.2.2-rc.1', '0.2.5'), true)
  assert.equal(compatibleRelease('0.2.2', '0.3.0'), false)
})

test('states', () => {
  const at = (listing, p, chosen) => evaluate({ desktopVersion: '0.2.2', listing, chosen, probe: p })
  assert.equal(at({ error: 'ENOENT' }).state, 'no-wsl')
  assert.equal(at({ distros: [] }).state, 'no-distro')
  assert.equal(at({ distros: [{ name: 'Old', isDefault: true, version: 1 }] }).state, 'wsl1')
  assert.equal(at(ubuntu, probe()).state, 'needs-node')
  assert.equal(at(ubuntu, probe({ nodes: node24 })).state, 'needs-dsh')
  const priv = (version, chosen) => at(ubuntu, probe({ nodes: node24, dsh: { version, bin: 'lib/bin.js' } }), chosen)
  assert.equal(priv('0.1.9').state, 'version-mismatch')
  assert.equal(priv('0.3.0').state, 'desktop-outdated')
  assert.deepEqual([priv('0.2.1').state, priv('0.2.1').drift], ['ready', 'wsl-older'])
  assert.deepEqual([priv('0.2.3').state, priv('0.2.3').drift], ['ready', 'wsl-newer'])
  const ready = priv('0.2.2')
  assert.deepEqual([ready.state, ready.drift, ready.mode], ['ready', null, 'private'])
  assert.equal(ready.dshEntry, '/home/s/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal(ready.dshHome, '/home/s/.dsh-wsl/home')
  // The person's own DSH: they choose first; reuse runs theirs with the default DSH home
  const withOwn = probe({ nodes: node24, own: own('0.2.2') })
  assert.equal(at(ubuntu, withOwn).state, 'choose')
  const reuse = at(ubuntu, withOwn, { mode: 'reuse' })
  assert.deepEqual([reuse.state, reuse.dshEntry, reuse.dshHome], ['ready', '/o/lib/bin.js', null])
  assert.equal(at(ubuntu, withOwn, { mode: 'private' }).state, 'needs-dsh')
  assert.equal(at(ubuntu, probe({ nodes: node24, own: own('0.1.0') }), { mode: 'reuse' }).state, 'version-mismatch')
  // reuse chosen, but their DSH is gone: no own DSH to choose, so the private one
  assert.equal(at(ubuntu, probe({ nodes: node24 }), { mode: 'reuse' }).mode, 'private')
  // the chosen distribution wins over the default
  const two = { distros: [{ name: 'Ubuntu', isDefault: true, version: 2 }, { name: 'Debian', isDefault: false, version: 2 }] }
  assert.equal(at(two, probe(), { distro: 'Debian' }).distro, 'Debian')
})

test('commands: Node only when none is new enough; DSH at Desktop\'s exact version; reuse updates their DSH', () => {
  const needsNode = commandsFor({ state: 'needs-node', mode: 'private', arch: 'x86_64' }, '0.2.2-rc.1')
  assert.match(needsNode, /node-v24\.22\.2-linux-x64\.tar\.xz/)
  assert.match(needsNode, /PATH="\$HOME\/\.dsh-wsl\/node\/bin:\$PATH" npm install --prefix ~\/\.dsh-wsl\/dsh @deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  const needsDsh = commandsFor({ state: 'needs-dsh', mode: 'private', arch: 'aarch64', node: { path: '/home/s/.local/bin/node' } }, '0.2.2')
  assert.doesNotMatch(needsDsh, /nodejs\.org/)
  assert.match(needsDsh, /PATH="\/home\/s\/\.local\/bin:\$PATH" npm install --prefix ~\/\.dsh-wsl\/dsh @deepseek-ai\/dsh@0\.2\.2/)
  const reuse = commandsFor({ state: 'version-mismatch', mode: 'reuse', node: { path: '/p/bin/node' }, own: own('0.1.0') }, '0.2.2')
  assert.match(reuse, /npm install -g --prefix "\/p" @deepseek-ai\/dsh@0\.2\.2/)
  assert.match(reuse, /你自己用的 dsh 也会一起更新/)
  assert.match(commandsFor({ state: 'ready', drift: 'wsl-older', mode: 'private', node: { path: '/n/node' } }, '0.2.2'), /npm install/)
  assert.equal(commandsFor({ state: 'ready', drift: 'wsl-newer' }, '0.2.2'), '')
  assert.equal(commandsFor({ state: 'desktop-outdated' }, '0.2.2'), '')
  const script = installScript({ state: 'needs-dsh', mode: 'private', node: { path: '/n/node' } }, '0.2.2')
  assert.match(script, /^set -eo pipefail/)
  assert.match(script, /daemon\.json/)
  assert.match(script, /\nPATH="\/n:\$PATH" npm install --prefix ~\/\.dsh-wsl\/dsh @deepseek-ai\/dsh@0\.2\.2\n/)
  const prompt = promptFor({ state: 'needs-dsh', mode: 'private', distro: 'Ubuntu', node: { path: '/usr/local/bin/node' } }, '0.2.2')
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
