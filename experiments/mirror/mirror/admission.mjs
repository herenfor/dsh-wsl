export const WINDOWS_BUNDLE = '@herenfor/dsh-wsl'

export const wrongHostMessage = (zh = false) => zh
  ? '安装位置不正确：此插件应安装在 Windows Desktop。当前未启动，可以安全地从 WSL 卸载。WSL 配套组件由 Desktop 自动部署。'
  : 'Wrong installation location: install this plugin in Windows Desktop. It has not started and can be safely removed from WSL. Desktop deploys the WSL companion automatically.'

/** Production always requires Windows. The Linux simulator uses a private copy and an explicit fake transport. */
export function admitsHost(platform, manifest, fakeTransport) {
  return platform === 'win32' || (manifest.private === true && typeof fakeTransport === 'string' && fakeTransport.length > 0)
}

/** Native package validation still owns all specs except these recognizable installation mistakes. */
export function wslRequestProblem(body) {
  if (!['inspect', 'install', 'enable'].includes(body.action)) return undefined
  const spec = String(body.spec ?? '').trim()
  if (body.name === WINDOWS_BUNDLE || /^@herenfor\/dsh-wsl(?:@|$)/.test(spec)) return 'wrong-host'
  if (body.action !== 'enable' && /^[v=~^]?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec)) return 'version-only'
}
