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

// One shell script answers everything setup needs to know about a distribution, as key=value lines.
const PROBE = String.raw`H="$HOME"; echo "home=$H"; echo "arch=$(uname -m)"
for c in "$H/.dsh-wsl/node/bin/node" "$H/.local/bin/node" "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node; do
  [ -n "$c" ] && [ -x "$c" ] && echo "node=$c $("$c" -v 2>/dev/null)"
done
P="$H/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/package.json"; [ -f "$P" ] && echo "dsh=$(tr -d '\n' < "$P")"
for c in "$(bash -lc 'command -v dsh' 2>/dev/null | tail -n1)" "$H/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
  [ -n "$c" ] && [ -e "$c" ] || continue
  r=$(readlink -f "$c"); d=$(dirname "$r")
  while [ -n "$d" ] && [ "$d" != / ]; do
    if [ -f "$d/package.json" ] && grep -q '"name": *"@deepseek-ai/dsh"' "$d/package.json"; then echo "own=$r|$d|$(tr -d '\n' < "$d/package.json")"; break; fi
    d=$(dirname "$d")
  done
done
true`

/** Parse the probe's output. */
export function parseProbe(text) {
  const out = { home: undefined, arch: undefined, nodes: [], dsh: null, own: null }
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('='); if (i < 0) continue
    const key = line.slice(0, i); const value = line.slice(i + 1)
    if (key === 'home') out.home = value
    else if (key === 'arch') out.arch = value
    else if (key === 'node') { const [path, version] = value.split(' '); if (version && !out.nodes.some((n) => n.path === path)) out.nodes.push({ path, version }) }
    else if (key === 'dsh') { try { const pkg = JSON.parse(value); out.dsh = { version: pkg.version, bin: typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh } } catch {} }
    else if (key === 'own' && !out.own) {
      const [entry, pkgDir, ...json] = value.split('|')
      // The plugin's private DSH is not the person's own.
      if (out.home && pkgDir.startsWith(`${out.home}/.dsh-wsl/`)) continue
      try { const pkg = JSON.parse(json.join('|')); out.own = { entry, pkgDir, version: pkg.version, prefix: npmPrefixOf(pkgDir) } } catch {}
    }
  }
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
export const nodeOk = (v) => { const p = parseVersion(v); if (p.length < 3) return false; for (let i = 0; i < 3; i++) if (p[i] !== MIN_NODE[i]) return p[i] > MIN_NODE[i]; return true }

/**
 * Where the WSL side stands. `listing` is {error?} or {distros}; `chosen` is {distro?, mode?}; `probe` is parseProbe's
 * result for the distribution (absent when there is none). States: no-wsl, no-distro, wsl1, choose (WSL has the
 * person's own DSH and no mode is chosen), needs-node, needs-dsh, version-mismatch (WSL's DSH too old),
 * desktop-outdated (WSL's DSH newer than Desktop's major.minor), ready (with `drift` when versions differ within it).
 */
export function evaluate({ desktopVersion, listing, chosen = {}, probe }) {
  if (listing.error) return { state: 'no-wsl', distros: [] }
  const distros = listing.distros
  if (distros.length === 0) return { state: 'no-distro', distros }
  const distro = distros.find((d) => d.name === chosen.distro) ?? distros.find((d) => d.isDefault) ?? distros[0]
  const base = { distro: distro.name, distros, home: probe?.home, arch: probe?.arch, own: probe?.own ?? null }
  if (distro.version === 1) return { ...base, state: 'wsl1' }
  if (!probe) return { ...base, state: 'error', error: 'cannot look into the distribution' }
  const node = probe.nodes.find((n) => nodeOk(n.version))
  let mode = chosen.mode === 'reuse' && !probe.own ? undefined : chosen.mode
  if (mode !== 'reuse' && mode !== 'private') {
    if (probe.own) return { ...base, state: 'choose', node }
    mode = 'private'
  }
  const dsh = mode === 'reuse'
    ? { version: probe.own.version, entry: probe.own.entry }
    : probe.dsh && { version: probe.dsh.version, entry: posix.join(probe.home, '.dsh-wsl', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', probe.dsh.bin ?? 'lib/bin.js') }
  const at = { ...base, mode, node, dshHome: mode === 'private' ? posix.join(probe.home, '.dsh-wsl', 'home') : null }
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
export function commandsFor(status, desktopVersion) {
  if (!canInstall(status)) return ''
  const lines = []
  const arch = status.arch === 'aarch64' ? 'arm64' : 'x64'
  const nodeDir = status.node ? posix.dirname(status.node.path) : '$HOME/.dsh-wsl/node/bin'
  if (status.state === 'needs-node') {
    const name = `node-v${NODE_VERSION}-linux-${arch}`
    lines.push('# 1. Node.js（只给这个插件用，装在 ~/.dsh-wsl/node）')
    lines.push(`mkdir -p ~/.dsh-wsl && cd ~/.dsh-wsl && curl -fL https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz | tar -xJ && rm -rf node && mv ${name} node`)
  }
  const step = status.state === 'needs-node' ? '2. ' : ''
  if (status.mode === 'reuse') {
    const prefix = status.own?.prefix
    lines.push(`# ${step}把你的 dsh 更新到 ${desktopVersion}（和 Desktop 同版本；你自己用的 dsh 也会一起更新）`)
    lines.push(`PATH="${nodeDir}:$PATH" npm install -g ${prefix ? `--prefix "${prefix}" ` : ''}@deepseek-ai/dsh@${desktopVersion}`)
  } else {
    lines.push(`# ${step}DSH ${desktopVersion}（和 Desktop 同版本，装在 ~/.dsh-wsl/dsh）`)
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
export function promptFor(status, desktopVersion) {
  const commands = commandsFor(status, desktopVersion)
  if (!commands) return ''
  const check = status.mode === 'reuse' ? 'dsh --version' : 'grep -m1 version ~/.dsh-wsl/dsh/node_modules/@deepseek-ai/dsh/package.json'
  return [
    `请帮我在 WSL（发行版 ${status.distro}）里装好 DSH WSL 运行模式需要的组件。不要改动 WSL 里已有的其他东西，也不要用 sudo。`,
    '',
    `在 PowerShell 里用 \`wsl.exe -d ${status.distro} -- bash -lc '<命令>'\` 依次执行下面的命令（# 开头的是说明，不用执行）：`,
    '',
    '```bash', commands, '```',
    '',
    `完成后执行 \`wsl.exe -d ${status.distro} -- bash -lc '${check}'\`，确认版本是 ${desktopVersion}。`,
    '如果 npm 提示找不到这个版本，说明它还没有发布到 npm，停下来告诉我，不要改装别的版本。',
    '网络失败时可以重试一次；仍然失败就把错误原文告诉我。',
  ].join('\n')
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
    const r = await run(wsl, ['-d', pick.name, '--exec', 'sh', '-c', PROBE], { timeout: 90_000 })
    if (r.code === 0) probe = parseProbe(decodeWslText(r.stdout))
    else listing.probeError = (decodeWslText(r.stdout) + r.stderr).trim().slice(0, 500)
  }
  const status = evaluate({ desktopVersion, listing, chosen, probe })
  if (listing.probeError) status.probeError = listing.probeError
  status.commands = commandsFor(status, desktopVersion)
  status.prompt = promptFor(status, desktopVersion)
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
