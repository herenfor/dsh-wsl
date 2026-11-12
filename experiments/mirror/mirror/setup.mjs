// First-run setup of the WSL side (docs/deployment.md). Runs in the Desktop Host. Finds the WSL distribution, its Node
// and DSH, and says what is missing. Downloads happen only when the person asks (the "install" button runs
// installScript in WSL); otherwise the commands are shown, or handed to a Windows DSH task as a prompt. What needs no
// network (the bridge files, the WSL profile and its plugin) is done here and by the daemon.
//
// Two ways to run DSH in WSL, chosen by the person when WSL already has a DSH of their own:
//   reuse    their DSH and its data (~/.dsh): Desktop's WSL tasks and their own DSH sessions see each other
//   private  a DSH of this plugin's own (~/.dsh-wsl/dsh) with its own data (~/.dsh-wsl/home); nothing is shared, so
//            two DSH versions never write the same data
// WSL side layout, in the distribution's home:
//   ~/.dsh-wsl/node/     Node, when the distribution has none new enough
//   ~/.dsh-wsl/dsh/      private: DSH, npm --prefix
//   ~/.dsh-wsl/home/     private: the DSH home (sessions, workspaces, profiles)
//   ~/.dsh-wsl/bridge/   transport/ and agent/, copied from this plugin (by setup)
//   ~/.dsh-wsl/run/      the daemon's socket, token, identity and log
// Versions: the two DSH must share major.minor (compatibleRelease); a WSL DSH older than that is updated, a newer one
// asks for a Desktop update. Within major.minor they connect, and the person may still align them.
import { inLanguage } from './language.mjs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

export const NODE_VERSION = '24.22.2'
export const MIN_NODE = [24, 9, 0]
export const PROFILE = 'desktop-wsl'

/** Run a command; resolves {code, stdout (Buffer), stderr}. Never rejects (a missing executable gives code null). */
export function run(command, args, { timeout = 60_000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'buffer', timeout, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, error: error?.code, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString('utf8') })
    })
    if (input !== undefined) child.stdin.end(input)
  })
}

/** wsl.exe writes its own messages in UTF-16LE (without BOM); programs it runs write UTF-8. */
export function decodeWslText(buffer) {
  const b = Buffer.from(buffer)
  const utf16 = b.length >= 2 && (b[1] === 0 || (b[0] === 0xff && b[1] === 0xfe))
  return (utf16 ? b.toString('utf16le') : b.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '')
}

/** `wsl.exe --list --verbose`: rows of `* Ubuntu  Running  2`; the starred one is the default. */
export function parseDistros(text) {
  const rows = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^\s*(\*)?\s*(\S.*?)\s{2,}(\S+)\s+(\d)\s*$/.exec(line)
    if (m) rows.push({ name: m[2], isDefault: m[1] === '*', state: m[3], version: Number(m[4]) })
  }
  return rows
}

// One shell script answers everything setup needs to know about a distribution, as key=value lines. It runs under
// `sh -c` with the distribution's plain PATH; the login shell is asked once for its PATH's node and dsh, and the usual
// version managers' folders are looked at directly (their Node often loads only in an interactive shell).
//   node=<path> <version>      a Node found (every candidate, in order of preference)
//   dsh=<package.json>         the plugin's private DSH
//   own=<candidate>|<pkgDir>|<package.json>   a DSH of the person's own, found from a dsh command
//   entry=found|<pkgDir>|<package.json> or entry=missing|<what>   the DSH the person named (config dshEntry)
//   seen-dsh=<candidate>|found|<pkgDir>, |missing or |not-dsh     every place looked at, for the setup window
// A candidate is a dsh command, a file in the package or the package's folder. Symlinks are followed; a script shim
// (pnpm's, node_modules/.bin/dsh) is read for the package path it runs. Project folders are not searched.
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export function probeScript({ dshEntry } = {}) {
  return String.raw`H="$HOME"; echo "home=$H"; echo "arch=$(uname -m)"
L=$(bash -lc 'echo "@node=$(command -v node)"; echo "@dsh=$(command -v dsh)"' </dev/null 2>/dev/null)
LN=$(printf '%s\n' "$L" | sed -n 's/^@node=//p' | tail -n1); LD=$(printf '%s\n' "$L" | sed -n 's/^@dsh=//p' | tail -n1)
for c in "$H/.dsh-wsl/node/bin/node" "$H/.local/bin/node" "$LN" "$(command -v node 2>/dev/null)" \
  "$H"/.nvm/versions/node/*/bin/node "$H"/.local/share/fnm/node-versions/*/installation/bin/node "$H"/.fnm/node-versions/*/installation/bin/node \
  "$H"/.asdf/installs/nodejs/*/bin/node "$H"/.local/share/mise/installs/node/*/bin/node "$H/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do
  [ -n "$c" ] && [ -f "$c" ] && [ -x "$c" ] && echo "node=$c $("$c" -v 2>/dev/null)"
done
P="$H/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/package.json"; [ -f "$P" ] && echo "dsh=$(tr -d '\n' < "$P")"
pkgof() {
  d="$1"; [ -d "$d" ] || d=$(dirname "$d")
  while [ -n "$d" ] && [ "$d" != / ] && [ "$d" != . ]; do
    if [ -f "$d/package.json" ] && grep -q '"name": *"@deepseek-ai/dsh"' "$d/package.json"; then echo "$d"; return 0; fi
    d=$(dirname "$d")
  done
  return 1
}
find_dsh() {
  r=$(readlink -f "$1" 2>/dev/null) && [ -e "$r" ] || return 1
  pkgof "$r" && return 0
  [ -f "$r" ] && [ "$(head -c 2 "$r")" = '#!' ] || return 1
  b=$(dirname "$r")
  for p in $(grep -o '[^"'"'"' :=]*@deepseek-ai/dsh/[^"'"'"' :]*' "$r" 2>/dev/null | head -n 5); do
    p=$(printf '%s' "$p" | sed -e 's|[$][{]basedir[}]|'"$b"'|g' -e 's|[$]basedir|'"$b"'|g')
    q=$(readlink -f "$p" 2>/dev/null) && [ -e "$q" ] && pkgof "$q" && return 0
  done
  return 1
}
look() {
  [ -n "$1" ] || return 0
  if [ ! -e "$1" ]; then echo "seen-dsh=$1|missing"
  elif d=$(find_dsh "$1"); then echo "seen-dsh=$1|found|$d"; echo "own=$1|$d|$(tr -d '\n' < "$d/package.json")"
  else echo "seen-dsh=$1|not-dsh"; fi
}
E=${quote(dshEntry ?? '')}
if [ -n "$E" ]; then
  F="$E"
  case "$E" in "~") F="$H" ;; "~/"*) F="$H/$(printf '%s' "$E" | cut -c3-)" ;; */*) ;; *) F=$(bash -lc 'command -v "$1"' _ "$E" </dev/null 2>/dev/null | tail -n1) ;; esac
  if [ -n "$F" ] && [ -e "$F" ] && d=$(find_dsh "$F"); then echo "entry=found|$d|$(tr -d '\n' < "$d/package.json")"; else echo "entry=missing|$E"; fi
fi
for c in "$LD" "$(command -v dsh 2>/dev/null)" "$H/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do look "$c"; done
for c in "$H"/.nvm/versions/node/*/bin/dsh "$H/.local/share/pnpm/dsh" "$H/.bun/bin/dsh" "$H/.npm-global/bin/dsh" "$H"/.local/share/fnm/node-versions/*/installation/bin/dsh; do
  [ -e "$c" ] && look "$c"
done
true`
}

/** One DSH package as the probe found it: where it is, how to run it, and how it was installed. */
function dshPackage(pkgDir, json, via) {
  const pkg = JSON.parse(json)
  const bin = (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh) ?? 'lib/bin.js'
  const prefix = npmPrefixOf(pkgDir)
  return { entry: posix.join(pkgDir, bin), pkgDir, version: pkg.version, engines: pkg.engines?.node ?? null, prefix, kind: prefix ? 'global' : 'local', ...(via ? { via } : {}) }
}

/** Parse the probe's output. */
export function parseProbe(text) {
  const out = { home: undefined, arch: undefined, nodes: [], dsh: null, own: null, seen: [] }
  let found = null
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('='); if (i < 0) continue
    const key = line.slice(0, i); const value = line.slice(i + 1)
    if (key === 'home') out.home = value
    else if (key === 'arch') out.arch = value
    else if (key === 'node') { const [path, version] = value.split(' '); if (version && !out.nodes.some((n) => n.path === path)) out.nodes.push({ path, version }) }
    else if (key === 'dsh') { try { const pkg = JSON.parse(value); out.dsh = { version: pkg.version, bin: typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh, engines: pkg.engines?.node ?? null } } catch {} }
    else if (key === 'seen-dsh') {
      const [path, result, dir] = value.split('|')
      if (!out.seen.some((s) => s.path === path)) out.seen.push({ path, result, ...(dir ? { dir } : {}) })
    } else if (key === 'entry') {
      const [result, where, ...json] = value.split('|')
      if (result === 'found') { try { out.entry = { ...dshPackage(where, json.join('|')), configured: true } } catch { out.entryMissing = where } }
      else out.entryMissing = where
    } else if (key === 'own' && !found) {
      const [via, pkgDir, ...json] = value.split('|')
      // The plugin's private DSH is not the person's own.
      if (out.home && pkgDir.startsWith(`${out.home}/.dsh-wsl/`)) continue
      try { found = dshPackage(pkgDir, json.join('|'), via) } catch {}
    }
  }
  // The DSH the person named comes first.
  out.own = out.entry ?? found
  delete out.entry
  return out
}

/** The npm prefix a global install lives under (<prefix>/lib/node_modules/@deepseek-ai/dsh), else null. */
export const npmPrefixOf = (pkgDir) => /^(.*)\/lib\/node_modules\/@deepseek-ai\/dsh$/.exec(pkgDir ?? '')?.[1] ?? null

const parseVersion = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '') ?? []).slice(1).map(Number)
/** Semver order of two versions (prereleases before their release; numeric identifiers compared as numbers). */
export function compareVersions(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  const ra = /-([^+]+)/.exec(a ?? '')?.[1]; const rb = /-([^+]+)/.exec(b ?? '')?.[1]
  if (ra === rb) return 0
  if (ra === undefined) return 1
  if (rb === undefined) return -1
  const xa = ra.split('.'); const xb = rb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i]); const nb = /^\d+$/.test(xb[i])
    if (xa[i] === xb[i]) continue
    if (na && nb) return Number(xa[i]) < Number(xb[i]) ? -1 : 1
    if (na !== nb) return na ? -1 : 1
    return xa[i] < xb[i] ? -1 : 1
  }
  return 0
}
/** The two DSH can work together: same major.minor. */
export function compatibleRelease(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b)
  return pa.length === 3 && pb.length === 3 && pa[0] === pb[0] && pa[1] === pb[1]
}
/** Node `v` is at least `min` ([major, minor, patch]). */
export function nodeOk(v, min = MIN_NODE) {
  const p = parseVersion(v)
  if (p.length < 3) return false
  for (let i = 0; i < 3; i++) if (p[i] !== min[i]) return p[i] > min[i]
  return true
}
/** The lowest Node a package's `engines.node` allows (>=24.9.0, ^24.9, 24.x …; the first range of an `||`), or null. */
export function minNodeOf(range) {
  const m = /^\s*(?:>=|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(range ?? '').split('||')[0])
  if (!m) return null
  return [Number(m[1]), Number(m[2]) || 0, Number(m[3]) || 0]
}
const showVersion = (v) => v.join('.')

/**
 * Where the WSL side stands. `listing` is {error?} or {distros}; `chosen` is {distro?, mode?, dshEntry?}; `probe` is
 * parseProbe's result for the distribution (absent when there is none). States: no-wsl, no-distro, wsl1, choose (WSL
 * has the person's own DSH and no mode is chosen), reuse-missing (reuse was chosen but that DSH is not found: never
 * switched to the private one quietly, whose sessions are others), needs-node, needs-dsh, version-mismatch (WSL's DSH
 * too old), desktop-outdated (WSL's DSH newer than Desktop's major.minor), ready (with `drift` when versions differ
 * within it). `checked` lists where the probe looked, for the setup window. The Node needed is what the DSH to run
 * declares in its engines (MIN_NODE when it declares none).
 */
export function evaluate({ desktopVersion, listing, chosen = {}, probe }) {
  if (listing.error) return { state: 'no-wsl', distros: [] }
  const distros = listing.distros
  if (distros.length === 0) return { state: 'no-distro', distros }
  const distro = distros.find((d) => d.name === chosen.distro) ?? distros.find((d) => d.isDefault) ?? distros[0]
  const base = { distro: distro.name, distros, home: probe?.home, arch: probe?.arch, own: probe?.own ?? null }
  if (distro.version === 1) return { ...base, state: 'wsl1' }
  if (!probe) return { ...base, state: 'error', error: 'cannot look into the distribution' }
  const nodeFor = (engines) => {
    const min = minNodeOf(engines) ?? MIN_NODE
    return { min, node: probe.nodes.find((n) => nodeOk(n.version, min)) }
  }
  const checked = (min) => ({ dsh: probe.seen ?? [], nodes: probe.nodes.map((n) => ({ ...n, ok: nodeOk(n.version, min) })), minNode: showVersion(min) })
  const named = chosen.dshEntry ? { dshEntry: chosen.dshEntry, entryMissing: probe.entryMissing ?? null } : {}
  let mode = chosen.mode
  if (mode === 'reuse' && (!probe.own || probe.entryMissing)) {
    const { min, node } = nodeFor(probe.own?.engines)
    return { ...base, ...named, state: 'reuse-missing', mode, node, checked: checked(min) }
  }
  if (mode !== 'reuse' && mode !== 'private') {
    if (probe.own) { const { min, node } = nodeFor(probe.own.engines); return { ...base, ...named, state: 'choose', node, checked: checked(min) } }
    mode = 'private'
  }
  const dsh = mode === 'reuse'
    ? { version: probe.own.version, entry: probe.own.entry, engines: probe.own.engines }
    : probe.dsh && { version: probe.dsh.version, engines: probe.dsh.engines, entry: posix.join(probe.home, '.dsh-wsl', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', probe.dsh.bin ?? 'lib/bin.js') }
  const { min, node } = nodeFor(dsh?.engines)
  const at = { ...base, ...named, mode, chosenMode: chosen.mode ?? null, node, checked: checked(min), dshHome: mode === 'private' ? posix.join(probe.home, '.dsh-wsl', 'home') : null }
  if (!dsh) return { ...at, state: node ? 'needs-dsh' : 'needs-node' }
  at.installed = dsh.version
  if (!node) return { ...at, state: 'needs-node' }
  at.dshEntry = dsh.entry
  const order = compareVersions(dsh.version, desktopVersion)
  if (!compatibleRelease(dsh.version, desktopVersion)) return { ...at, state: order < 0 ? 'version-mismatch' : 'desktop-outdated' }
  return { ...at, state: 'ready', drift: order === 0 ? null : order < 0 ? 'wsl-older' : 'wsl-newer' }
}

const INSTALLS = new Set(['needs-node', 'needs-dsh', 'version-mismatch'])
/** Whether the DSH install/update commands apply (also offered when versions merely drift with WSL behind). */
export const canInstall = (status) => INSTALLS.has(status.state) || (status.state === 'ready' && status.drift === 'wsl-older')

/** The commands the person runs in the WSL terminal for this state (empty when none apply). */
export function commandsFor(status, desktopVersion, lang = 'zh') {
  const say = (texts) => inLanguage(lang, texts)
  if (!canInstall(status)) return ''
  const lines = []
  const arch = status.arch === 'aarch64' ? 'arm64' : 'x64'
  const nodeDir = status.node ? posix.dirname(status.node.path) : '$HOME/.dsh-wsl/node/bin'
  if (status.state === 'needs-node') {
    const name = `node-v${NODE_VERSION}-linux-${arch}`
    lines.push(say({ zh: '# 1. Node.js（只给这个插件用，装在 ~/.dsh-wsl/node）', en: '# 1. Node.js (for this plugin only, in ~/.dsh-wsl/node)' }))
    lines.push(`mkdir -p ~/.dsh-wsl && cd ~/.dsh-wsl && curl -fL https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz | tar -xJ && rm -rf node && mv ${name} node`)
  }
  const step = status.state === 'needs-node' ? '2. ' : ''
  if (status.installed === desktopVersion) {
    // Only Node was missing: the DSH is already at Desktop's version.
  } else if (status.mode === 'reuse' && status.own?.kind === 'local') {
    // Not an npm global install (a project folder, pnpm, a wrapper): `npm install -g` would put a second copy beside
    // it, so the person updates it their own way.
  } else if (status.mode === 'reuse') {
    const prefix = status.own?.prefix
    lines.push(say({ zh: `# ${step}把你的 dsh 更新到 ${desktopVersion}（和 Desktop 同版本；你自己用的 dsh 也会一起更新）`, en: `# ${step}Update your dsh to ${desktopVersion} (the Desktop's version; the dsh you use yourself is updated too)` }))
    lines.push(`PATH="${nodeDir}:$PATH" npm install -g ${prefix ? `--prefix "${prefix}" ` : ''}@deepseek-ai/dsh@${desktopVersion}`)
  } else {
    lines.push(say({ zh: `# ${step}DSH ${desktopVersion}（和 Desktop 同版本，装在 ~/.dsh-wsl/dsh）`, en: `# ${step}DSH ${desktopVersion} (the Desktop's version, in ~/.dsh-wsl/dsh)` }))
    lines.push(`PATH="${nodeDir}:$PATH" npm install --prefix ~/.dsh-wsl/dsh @deepseek-ai/dsh@${desktopVersion}`)
  }
  return lines.join('\n')
}

/** What the install button runs in WSL (bash): stop the daemon first, so no DSH runs from files being replaced. */
export function installScript(status, desktopVersion) {
  const commands = commandsFor(status, desktopVersion).split('\n').filter((l) => l && !l.startsWith('#'))
  if (!commands.length) return ''
  return [
    'set -eo pipefail',
    `D="$HOME/.dsh-wsl/run/${PROFILE}/daemon.json"`,
    'P=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$D" 2>/dev/null || true)',
    'if [ -n "$P" ] && kill "$P" 2>/dev/null; then for i in $(seq 1 50); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done; echo "stopped the WSL side ($P)"; fi',
    ...commands.map((c) => `echo "\$ ${c.replace(/["\\$`]/g, '\\$&')}"\n${c}`),
    'echo "done"',
  ].join('\n')
}

/** The same setup as a task for the Windows DSH: it runs the commands through wsl.exe and checks the result. */
export function promptFor(status, desktopVersion, lang = 'zh') {
  const commands = commandsFor(status, desktopVersion, lang)
  if (!commands) return ''
  const check = `grep -m1 '"version"' ${status.mode === 'reuse' && status.own?.pkgDir ? quote(`${status.own.pkgDir}/package.json`) : '~/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/package.json'}`
  const en = [
    `Please set up what the DSH WSL run mode needs in WSL (distribution ${status.distro}). Do not change anything else already in WSL, and do not use sudo.`,
    '',
    `In PowerShell, run the commands below one by one with \`wsl.exe -d ${status.distro} -- bash -lc '<command>'\` (lines starting with # are notes, not commands):`,
    '',
    '```bash', commands, '```',
    '',
    `When done, run \`wsl.exe -d ${status.distro} -- bash -lc '${check}'\` and confirm the version is ${desktopVersion}.`,
    'If npm cannot find this version, it has not been published to npm yet: stop and tell me; do not install a different version.',
    'On a network failure you may retry once; if it still fails, tell me the exact error.',
  ]
  const zh = [
    `请帮我在 WSL（发行版 ${status.distro}）里装好 DSH WSL 运行模式需要的组件。不要改动 WSL 里已有的其他东西，也不要用 sudo。`,
    '',
    `在 PowerShell 里用 \`wsl.exe -d ${status.distro} -- bash -lc '<命令>'\` 依次执行下面的命令（# 开头的是说明，不用执行）：`,
    '',
    '```bash', commands, '```',
    '',
    `完成后执行 \`wsl.exe -d ${status.distro} -- bash -lc '${check}'\`，确认版本是 ${desktopVersion}。`,
    '如果 npm 提示找不到这个版本，说明它还没有发布到 npm，停下来告诉我，不要改装别的版本。',
    '网络失败时可以重试一次；仍然失败就把错误原文告诉我。',
  ]
  return inLanguage(lang, { zh, en }).join('\n')
}

/** Content stamp of the bridge files this plugin carries (transport/ and agent/). */
export function stampOf(dirs) {
  const hash = createHash('sha256')
  for (const dir of dirs) for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isFile()) hash.update(name).update(readFileSync(path))
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Copy transport/ and agent/ into the distribution's ~/.dsh-wsl/bridge when they differ from what is there.
 * `root` is how this Host reaches the distribution's home (\\wsl.localhost\<distro>\home\<user> on Windows).
 */
export function installBridgeFiles(pluginDir, root) {
  const sources = { transport: join(pluginDir, 'transport'), agent: join(pluginDir, 'agent') }
  const stamp = stampOf(Object.values(sources))
  const target = join(root, '.dsh-wsl', 'bridge')
  const stampFile = join(target, 'STAMP')
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp) return { stamp, copied: false }
  mkdirSync(target, { recursive: true })
  for (const [name, from] of Object.entries(sources)) {
    rmSync(join(target, name), { recursive: true, force: true })
    cpSync(from, join(target, name), { recursive: true, dereference: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) })
  }
  writeFileSync(stampFile, `${stamp}\n`)
  return { stamp, copied: true }
}

/** How this Host reaches a path in the distribution. */
export const hostPathOf = (platform, distro, path) => (platform === 'win32' ? win32.join(`\\\\wsl.localhost\\${distro}`, ...path.split('/').filter(Boolean)) : path)

/**
 * Check the WSL side. `wsl` is the wsl.exe command (a fake in tests). Returns evaluate()'s result plus the commands,
 * the prompt, and the bridge command when ready.
 */
export async function check({ wsl = 'wsl.exe', desktopVersion, chosen = {}, pluginDir, platform = process.platform }) {
  const list = await run(wsl, ['--list', '--verbose'], { timeout: 30_000 })
  const listing = list.code === null ? { error: list.error ?? 'wsl.exe not found' }
    : { distros: list.code === 0 ? parseDistros(decodeWslText(list.stdout)) : [] }
  let probe
  const pick = listing.distros?.find((d) => d.name === chosen.distro) ?? listing.distros?.find((d) => d.isDefault) ?? listing.distros?.[0]
  if (pick && pick.version !== 1) {
    const r = await run(wsl, ['-d', pick.name, '--exec', 'sh', '-c', probeScript({ dshEntry: chosen.dshEntry })], { timeout: 90_000 })
    const output = decodeWslText(r.stdout)
    // Kept for troubleshooting (the Host writes it to ~/.dsh-wsl/setup-probe.log): a broken .bashrc shows up here.
    listing.probeOutput = `# ${new Date().toISOString()} ${pick.name} exit ${r.code ?? r.error}\n${output}${r.stderr ? `\n# stderr\n${r.stderr}` : ''}`
    if (r.code === 0) probe = parseProbe(output)
    else listing.probeError = (output + r.stderr).trim().slice(0, 500)
  }
  const status = evaluate({ desktopVersion, listing, chosen, probe })
  if (listing.probeError) status.probeError = listing.probeError
  if (listing.probeOutput) status.probeOutput = listing.probeOutput
  status.script = installScript(status, desktopVersion)
  if (status.state === 'ready' && pluginDir) {
    const bridgeDir = posix.join(status.home, '.dsh-wsl', 'bridge')
    status.files = installBridgeFiles(pluginDir, hostPathOf(platform, status.distro, status.home))
    status.bridge = {
      command: wsl,
      args: ['-d', status.distro, '--exec', status.node.path, posix.join(bridgeDir, 'transport', 'daemon.mjs'), '--bridge', '--profile', PROFILE, '--dsh', status.dshEntry, '--stamp', status.files.stamp, ...(status.dshHome ? ['--dsh-home', status.dshHome] : [])],
    }
  }
  return status
}
