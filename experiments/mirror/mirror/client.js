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

    // On an official bundle's detail page: the WSL side's state and switch (the page's own switch is this Host's).
    function WslSwitch({ subject }) {
      const name = subject?.kind === 'bundle' && subject.pkg?.official && !subject.pkg.name.startsWith('wsl:') ? subject.pkg.name : undefined
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const call = (body) => window.fetch(new URL(`wsl-bridge/bundle?name=${encodeURIComponent(name)}`, window.document.baseURI), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }).then((r) => r.json()).then(setState, (e) => setState({ connected: true, error: String(e) }))
      React.useEffect(() => { if (name) void call() }, [name])
      if (!name || state === null) return null
      let text, action
      if (!state.connected) text = 'WSL：未连接'
      else if (state.error) text = `WSL：读取失败（${state.error}）`
      else if (!state.bundle) text = 'WSL：没有这个插件'
      else {
        const on = state.bundle.enabled
        text = `WSL：${on ? '已启用' : '未启用'}${state.result?.application === 'restart-required' ? '（WSL 端需要重启才生效）' : ''}`
        action = h('button', {
          type: 'button', disabled: busy,
          onClick: async () => { setBusy(true); try { await call({ name, enabled: !on }) } finally { setBusy(false) } },
          style: { marginLeft: 8, padding: '4px 10px', borderRadius: 6, border: `1px solid ${COLORS.wsl}`, background: on ? 'transparent' : COLORS.wsl, color: on ? COLORS.wsl : '#fff', cursor: busy ? 'default' : 'pointer', font: 'inherit', fontSize: 12 },
        }, busy ? '处理中…' : on ? '在 WSL 停用' : '在 WSL 启用')
      }
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', fontSize: 12, paddingLeft: 8, borderLeft: `3px solid ${COLORS.wsl}` } }, h('span', null, text), action)
    }

    return {
      name: 'dsh-wsl-mirror-browser',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.add.actions', () => ctx.slots.register({ name: 'plugins.add.actions', id: 'wsl-install-target' }, InstallTarget)), 'wsl-mirror: install target item')
        ctx.effect(() => ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'wsl-bundle-switch' }, WslSwitch)), 'wsl-mirror: WSL switch on detail pages')
      },
    }
  },
})
