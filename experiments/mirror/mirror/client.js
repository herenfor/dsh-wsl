// Browser half of the mirror: an item in the Plugins page's Add plugin menu that shows where
// "Install a third-party plugin" installs (WSL or Windows) and switches it.
window.__ModuleLoader__.load({
  id: 'dsh-wsl-mirror',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const url = () => new URL('wsl-bridge/install-target', window.document.baseURI)
    const COLORS = { wsl: '#e95420', local: '#0078d4' }

    function InstallTarget() {
      const [state, setState] = React.useState(null)
      const load = (body) => window.fetch(url(), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }).then((r) => r.json()).then(setState, () => setState({ error: true }))
      React.useEffect(() => { void load() }, [])
      if (state === null || state.error) return null
      const wsl = state.target === 'wsl'
      const where = wsl ? `WSL${state.distro ? `（${state.distro}）` : ''}` : 'Windows（本机）'
      const hint = wsl && !state.wslAvailable
        ? 'WSL 端未连接或版本不同：这时安装会直接报错，不会改装到 Windows'
        : `"安装第三方插件"会装到这里。点击切换到 ${wsl ? 'Windows' : 'WSL'}`
      return h('button', {
        type: 'button', role: 'menuitem',
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); void load({ target: wsl ? 'local' : 'wsl' }) },
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%', boxSizing: 'border-box',
          padding: '8px 12px', margin: '4px 0 0', border: 'none', borderLeft: `3px solid ${COLORS[state.target]}`,
          borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        },
      },
      h('span', { style: { fontSize: 13, fontWeight: 600 } }, `安装位置：${where}`),
      h('span', { style: { fontSize: 12, opacity: 0.7, maxWidth: 280 } }, hint))
    }

    return {
      name: 'dsh-wsl-mirror-browser',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.add.actions', () => ctx.slots.register({ name: 'plugins.add.actions', id: 'wsl-install-target' }, InstallTarget)), 'wsl-mirror: install target item')
      },
    }
  },
})
