// The WSL tab of the Plugins page: which of the WSL Host's bundles it lists, and what it shows of each. The official
// Installed tab is left to this Host alone. Kept free of DSH imports so it can be unit-tested.

// Bundles the WSL side needs to be reached at all: listed nowhere, so they cannot be switched off from the page.
const INTERNAL = new Set(['dsh-wsl-agent'])

const text = (value, fallback) => {
  if (typeof value === 'string') return { zh: value, en: value }
  if (value && typeof value === 'object') return { zh: value.zh ?? value.en ?? fallback, en: value.en ?? value.zh ?? fallback }
  return { zh: fallback, en: fallback }
}

/**
 * The rows of the WSL tab, as the official Installed tab picks them: the official optional bundles and the installed
 * ones (the profile's own base bundles are neither), installed ones first.
 */
export function wslBundles(bundles) {
  return bundles
    .filter((b) => !INTERNAL.has(b.name) && (b.official || b.installed))
    .map((b) => ({
      name: b.name,
      title: text(b.meta?.title, b.name),
      description: text(b.meta?.description ?? b.description, ''),
      icon: typeof b.meta?.icon === 'string' ? b.meta.icon : undefined,
      version: b.version ?? null,
      official: !!b.official,
      installed: !!b.installed,
      enabled: !!b.enabled,
      availability: b.availability,
      ...(b.error ? { error: b.error.message ?? String(b.error.code ?? b.error) } : {}),
    }))
    .sort((a, b) => Number(a.official) - Number(b.official))
}
