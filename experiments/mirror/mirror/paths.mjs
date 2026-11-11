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
