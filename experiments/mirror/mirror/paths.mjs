// Local-directory install specs between Windows and WSL. A spec may carry pnpm's `file:` or `link:` prefix.
// Kept free of DSH imports so it can be unit-tested.

const split = (spec) => { const m = /^(file:|link:)?(.*)$/s.exec(spec); return [m[1] ?? '', m[2]] }

/** A Windows path (C:\..., \\wsl.localhost\<distro>\..., \\wsl$\<distro>\...) as WSL sees it; other specs unchanged. */
export function toWslSpec(spec) {
  const [prefix, path] = split(spec.trim())
  const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(path)
  if (drive) return `${prefix}/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`.replace(/\/+$/, '')
  const unc = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]?(.*)$/is.exec(path)
  if (unc) return `${prefix}/${unc[1].replace(/\\/g, '/')}`.replace(/\/+$/, '') || `${prefix}/`
  return spec
}

/** A WSL path as Windows sees it (/mnt/c/... → C:\..., /home/... → \\wsl.localhost\<distro>\home\...); other specs unchanged. */
export function toWindowsSpec(spec, distro) {
  const [prefix, path] = split(spec.trim())
  if (!path.startsWith('/')) return spec
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/s.exec(path)
  if (mnt) return `${prefix}${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`
  if (!distro) return spec
  return `${prefix}\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
}

/**
 * Where the WSL side reads a file the page names by path (GET /api/file, the chat's pictures): a POSIX absolute path
 * as it is, and a \\wsl.localhost (or \\wsl$) path of `distro` as WSL sees it. Undefined for anything else: Windows
 * paths, other machines' UNC paths and other distributions' paths stay with the Desktop Host, which can read them.
 */
export function wslFilePath(path, distro) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return undefined
  if (path.startsWith('/') && !path.startsWith('//')) return path
  const unc = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/is.exec(path)
  if (!unc || typeof distro !== 'string' || unc[1].toLowerCase() !== distro.toLowerCase()) return undefined
  return `/${(unc[2] ?? '').replace(/\\/g, '/')}`.replace(/(.)\/+$/, '$1')
}
