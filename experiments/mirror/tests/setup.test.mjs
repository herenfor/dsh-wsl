import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsFor, compareVersions, compatibleRelease, decodeWslText, evaluate, hostPathOf, installBridgeFiles, installScript, minNodeOf, nodeOk, parseDistros, parseProbe, probeScript, promptFor } from '../mirror/setup.mjs'
import { execFileSync } from 'node:child_process'
import { chmodSync, symlinkSync } from 'node:fs'

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
    dsh: { version: '0.2.2-rc.1', bin: 'lib/bin.js', engines: null },
    // the private one is skipped
    own: { entry: `${own}/lib/bin.js`, pkgDir: own, version: '0.2.1', engines: null, prefix: '/home/s/.local', kind: 'global', via: `${own}/lib/bin.js` },
    seen: [],
  })
  assert.equal(nodeOk('v24.9.0'), true); assert.equal(nodeOk('v24.8.9'), false); assert.equal(nodeOk('v25.0.0'), true); assert.equal(nodeOk('v18.19.1'), false)
  assert.equal(nodeOk('v22.23.4', [22, 0, 0]), true)
  assert.deepEqual(minNodeOf('>=24.9.0'), [24, 9, 0]); assert.deepEqual(minNodeOf('^22.12 || >=24'), [22, 12, 0]); assert.deepEqual(minNodeOf('24.x'), [24, 0, 0]); assert.equal(minNodeOf('*'), null)
  // The location the person named wins over one found, and a local install is not an npm global one.
  const local = '/home/s/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh'
  const named = parseProbe(`home=/home/s\nentry=found|${local}|{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1","engines":{"node":">=24.9.0"},"bin":{"dsh":"lib/bin.js"}}\nseen-dsh=/usr/bin/dsh|missing\nseen-dsh=/usr/bin/dsh|missing\nown=${own}/lib/bin.js|${own}|{"name":"@deepseek-ai/dsh","version":"0.2.1"}\n`)
  assert.deepEqual(named.own, { entry: `${local}/lib/bin.js`, pkgDir: local, version: '0.2.2-rc.1', engines: '>=24.9.0', prefix: null, kind: 'local', configured: true })
  assert.deepEqual(named.seen, [{ path: '/usr/bin/dsh', result: 'missing' }])
  assert.equal(parseProbe('home=/home/s\nentry=missing|~/gone\n').entryMissing, '~/gone')
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
  // reuse chosen, but their DSH is gone: said so, never quietly the private one (other sessions)
  const gone = at(ubuntu, probe({ nodes: node24, seen: [{ path: '/usr/bin/dsh', result: 'missing' }] }), { mode: 'reuse' })
  assert.deepEqual([gone.state, gone.mode, gone.checked.dsh.length], ['reuse-missing', 'reuse', 1])
  const named = at(ubuntu, probe({ nodes: node24, own: own('0.2.2'), entryMissing: '~/gone' }), { mode: 'reuse', dshEntry: '~/gone' })
  assert.deepEqual([named.state, named.entryMissing], ['reuse-missing', '~/gone'])
  // nvm's Node 22 is too old for a DSH that wants 24.9; the threshold is the DSH's own engines
  const nvm22 = [{ path: '/home/s/.nvm/versions/node/v22.23.4/bin/node', version: 'v22.23.4' }]
  const wants = (engines) => probe({ nodes: nvm22, own: { ...own('0.2.2'), engines } })
  const old = at(ubuntu, wants('>=24.9.0'), { mode: 'reuse' })
  assert.deepEqual([old.state, old.checked.minNode, old.checked.nodes[0].ok], ['needs-node', '24.9.0', false])
  assert.equal(at(ubuntu, wants('>=22.12.0'), { mode: 'reuse' }).state, 'ready')
  assert.equal(at(ubuntu, wants(null), { mode: 'reuse' }).state, 'needs-node')   // none declared: MIN_NODE
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
  // their DSH is not an npm global install: no `npm install -g` that would put a second copy beside it
  const local = { ...own('0.1.0'), prefix: null, kind: 'local', pkgDir: '/home/s/x/node_modules/@deepseek-ai/dsh' }
  assert.equal(commandsFor({ state: 'version-mismatch', mode: 'reuse', node: { path: '/p/bin/node' }, own: local }, '0.2.2'), '')
  assert.doesNotMatch(commandsFor({ state: 'needs-node', mode: 'reuse', own: local }, '0.2.2'), /npm install/)
  // only Node is missing: their DSH is already at Desktop's version, so no DSH step
  const nodeOnly = commandsFor({ state: 'needs-node', mode: 'reuse', installed: '0.2.2', own: own('0.2.2') }, '0.2.2')
  assert.match(nodeOnly, /nodejs\.org/); assert.doesNotMatch(nodeOnly, /npm install/)
  assert.match(promptFor({ state: 'needs-node', mode: 'reuse', distro: 'Ubuntu', own: local }, '0.2.2'), /grep -m1 '"version"' '\/home\/s\/x\/node_modules\/@deepseek-ai\/dsh\/package\.json'/)
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

test('a load while Desktop runs, or of another version, asks for a restart; a reload at the boot version does not', async () => {
  const { loadKind } = await import('../mirror/index.mjs')
  const boot = loadKind(undefined, '0.1.1', 5, 60)
  assert.deepEqual(boot, { mode: 'boot', version: '0.1.1' })
  assert.equal(loadKind(boot, '0.1.1', 900, 60).mode, 'boot')                 // a service it uses restarted
  assert.equal(loadKind(boot, '0.1.2', 900, 60).mode, 'restart-required')     // updated from the Plugins page
  const hot = loadKind(undefined, '0.1.1', 900, 60)                            // installed mid-session
  assert.equal(hot.mode, 'restart-required')
  assert.equal(loadKind(hot, '0.1.1', 950, 60).mode, 'restart-required')      // stays so until Desktop restarts
})

test('text the Host writes follows the page language: by id, then base language, then English', async () => {
  const { inLanguage, noteLanguage, pick, language } = await import('../mirror/language.mjs')
  const texts = { zh: '中', en: 'en' }
  assert.equal(inLanguage('zh', texts), '中')
  assert.equal(inLanguage('zh-CN', texts), '中')
  assert.equal(inLanguage('ja', texts), 'en')
  noteLanguage({ headers: { 'x-dsh-wsl-language': 'zh-CN' } })
  assert.equal(pick(texts), '中')
  noteLanguage({ headers: { 'x-dsh-wsl-language': 'bad value; drop' } })
  assert.equal(language(), 'zh-CN')
  noteLanguage({ headers: { 'x-dsh-wsl-language': 'en' } })
  assert.equal(pick(texts), 'en')
  const status = { state: 'needs-dsh', mode: 'private', distro: 'Debian', node: { path: '/n/node' } }
  assert.match(commandsFor(status, '0.2.2', 'en'), /# DSH 0\.2\.2 \(the Desktop's version/)
  assert.match(promptFor(status, '0.2.2', 'en'), /do not use sudo/)
  assert.match(promptFor(status, '0.2.2', 'ja'), /do not use sudo/)
  assert.match(promptFor(status, '0.2.2', 'zh'), /不要用 sudo/)
})

test('the probe script finds a project-local DSH it is told about, a pnpm shim and nvm\'s Node', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-probe-'))
  const pkg = (dir, version) => {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' }, engines: { node: '>=24.9.0' } }, null, 2))
    writeFileSync(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n'); chmodSync(join(dir, 'lib', 'bin.js'), 0o755)
  }
  const local = join(home, '.local/share/dsh-cli/node_modules/@deepseek-ai/dsh')
  pkg(local, '0.2.2-rc.1')
  // pnpm's global bin: a shell script naming the package relative to its own folder
  const pnpm = join(home, '.local/share/pnpm')
  pkg(join(pnpm, 'global/5/node_modules/@deepseek-ai/dsh'), '0.2.1')
  writeFileSync(join(pnpm, 'dsh'), '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/global/5/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n'); chmodSync(join(pnpm, 'dsh'), 0o755)
  // a node_modules/.bin shim (pnpm writes scripts, not links)
  mkdirSync(join(home, 'proj/node_modules/.bin'), { recursive: true })
  pkg(join(home, 'proj/node_modules/@deepseek-ai/dsh'), '0.2.0')
  writeFileSync(join(home, 'proj/node_modules/.bin/dsh'), '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec node "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"\n')
  // nvm's Node, which only an interactive shell puts on PATH
  const nvm = join(home, '.nvm/versions/node/v24.11.0/bin')
  mkdirSync(nvm, { recursive: true }); writeFileSync(join(nvm, 'node'), '#!/bin/sh\necho v24.11.0\n'); chmodSync(join(nvm, 'node'), 0o755)
  const probeWith = (dshEntry) => parseProbe(execFileSync('sh', ['-c', probeScript({ dshEntry })], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }))

  const found = probeWith()
  assert.ok(found.nodes.some((n) => n.path === join(nvm, 'node') && n.version === 'v24.11.0'))
  assert.equal(found.own.pkgDir, join(pnpm, 'global/5/node_modules/@deepseek-ai/dsh'))
  assert.equal(found.own.kind, 'local')
  assert.ok(found.seen.some((x) => x.path === join(home, '.local/bin/dsh') && x.result === 'missing'))
  assert.ok(found.seen.some((x) => x.path === join(pnpm, 'dsh') && x.result === 'found'))

  for (const entry of ['~/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh', `${local}/lib/bin.js`, `${local}/`]) {
    const named = probeWith(entry)
    assert.deepEqual([named.own.pkgDir, named.own.entry, named.own.version, named.own.configured, named.own.engines], [local, `${local}/lib/bin.js`, '0.2.2-rc.1', true, '>=24.9.0'], entry)
  }
  assert.equal(probeWith('~/proj/node_modules/.bin/dsh').own.pkgDir, join(home, 'proj/node_modules/@deepseek-ai/dsh'))
  assert.equal(probeWith("~/it's not here").entryMissing, "~/it's not here")
  const status = evaluate({ desktopVersion: '0.2.2-rc.1', listing: { distros: [{ name: 'U', isDefault: true, version: 2 }] }, chosen: { mode: 'reuse', dshEntry: '~/x' }, probe: probeWith(`${local}/lib/bin.js`) })
  assert.deepEqual([status.state, status.dshEntry, status.node.path], ['ready', `${local}/lib/bin.js`, join(nvm, 'node')])
})
