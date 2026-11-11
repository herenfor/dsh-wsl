// Browser half of the mirror:
// - an item in the Plugins page's Add plugin menu that shows where "Install a third-party plugin" installs (WSL or
//   Windows) and switches it, and the WSL switch on official bundles' detail pages;
// - a penguin after the title of WSL folders and Sessions in the sidebar;
// - the run location of new tasks on the new-task page.
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

    // Tux, drawn small for row titles.
    const PENGUIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><ellipse cx="8" cy="8.8" rx="5" ry="6.2" fill="#1f1f1f" stroke="#8a8a8a" stroke-width=".5"/><ellipse cx="8" cy="10.4" rx="3.3" ry="4.1" fill="#fafafa"/><circle cx="6.6" cy="5.3" r="1.05" fill="#fafafa"/><circle cx="9.4" cy="5.3" r="1.05" fill="#fafafa"/><circle cx="6.8" cy="5.5" r=".5" fill="#1f1f1f"/><circle cx="9.2" cy="5.5" r=".5" fill="#1f1f1f"/><path d="M6.5 6.7h3L8 8.2z" fill="#f5a623"/><ellipse cx="5.5" cy="14.9" rx="2.1" ry=".95" fill="#f5a623"/><ellipse cx="10.5" cy="14.9" rx="2.1" ry=".95" fill="#f5a623"/></svg>'
    const penguinUrl = `url("data:image/svg+xml,${encodeURIComponent(PENGUIN)}")`
    const isWsl = (id) => typeof id === 'string' && id.startsWith('wsl:')
    // Sidebar rows carry data-row-key="workspace:<id>" / "session:<id>"; WSL ids start with "wsl:".
    const SIDEBAR_CSS = `
[data-row-key^="session:wsl:"] > span:nth-child(2)::after,
[data-row-key^="workspace:wsl:"] > span:nth-child(3) > span::after {
  content: ""; display: inline-block; width: 13px; height: 13px; margin-left: 5px; vertical-align: -2px;
  background: ${penguinUrl} center / contain no-repeat;
}`
    const PenguinIcon = () => h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 14, height: 14, flex: 'none', background: `${penguinUrl} center / contain no-repeat` } })

    function useStore(store) {
      return React.useSyncExternalStore((cb) => store.subscribe(cb), () => store.getSnapshot())
    }

    // New-task page: where this task runs. WSL folders always run in WSL; a Windows folder runs here unless WSL is
    // chosen, which applies to new tasks in that folder until switched back.
    function RunTarget({ ui }) {
      const sessions = useStore(ui.sessions.list)
      const workspaces = useStore(ui.workspaces.list)
      const sessionId = Object.values(sessions.byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id
      const workspace = sessionId === undefined ? undefined : workspaces.items.find((w) => w.sessionIds.includes(sessionId))
      const workspaceId = workspace?.workspaceId
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const call = (body) => window.fetch(new URL(`wsl-bridge/run-target?workspaceId=${encodeURIComponent(workspaceId)}`, window.document.baseURI), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }).then((r) => r.json())
      React.useEffect(() => { if (workspaceId) call().then(setState, () => setState(null)) }, [workspaceId])
      if (!workspaceId || state === null || state.workspaceId !== workspaceId) return null
      const wsl = state.target === 'wsl'
      const distro = state.distro ? `（${state.distro}）` : ''
      const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, border: `1px solid ${wsl ? COLORS.wsl : 'rgba(127,127,127,.35)'}`, background: 'transparent', color: 'inherit', font: 'inherit', lineHeight: '18px' }
      if (state.insideWsl) return h('span', { style: chip, title: state.wslPath ?? undefined }, h(PenguinIcon), `在 WSL${distro} 中运行`)
      const slowDisk = wsl && typeof state.wslPath === 'string' && state.wslPath.startsWith('/mnt/')
      const toggle = async () => {
        setBusy(true)
        try {
          setState(await call({ workspaceId, target: wsl ? 'local' : 'wsl' }))
          // A blank task on the other side replaces this one.
          await ui.openWorkspace(workspaceId)
        } finally { setBusy(false) }
      }
      return h('span', { style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
        h('button', {
          type: 'button', disabled: busy || (!wsl && !state.wslAvailable), onClick: toggle,
          title: !state.wslAvailable && !wsl ? 'WSL 端未连接或版本不同' : `点击改为在 ${wsl ? 'Windows' : 'WSL'} 中运行`,
          style: { ...chip, cursor: busy ? 'default' : 'pointer' },
        }, wsl ? h(PenguinIcon) : null, busy ? '切换中…' : `运行位置：${wsl ? `WSL${distro}` : 'Windows'}`),
        slowDisk ? h('span', { style: { fontSize: 12, color: COLORS.wsl, maxWidth: 420 } },
          `这个文件夹在 Windows 磁盘上，WSL 通过 ${state.wslPath.split('/').slice(0, 3).join('/')} 访问，读写会明显变慢。经常在 WSL 运行的项目，建议放到 WSL 内（例如 ~/code）。`) : null)
    }

    return {
      name: 'dsh-wsl-mirror-browser',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshWslMirror = 'sidebar'
          style.textContent = SIDEBAR_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'wsl-mirror: WSL marks in the sidebar')
        ctx.inject(['uiWorkspace', 'slots'], (c) => {
          const Hero = () => h(RunTarget, { ui: c.uiWorkspace })
          c.effect(() => c.slots.inject('conversation.hero.options', () => c.slots.register({ name: 'conversation.hero.options', id: 'wsl-run-target' }, Hero)), 'wsl-mirror: run location on the new-task page')
        })
        ctx.effect(() => ctx.slots.inject('plugins.add.actions', () => ctx.slots.register({ name: 'plugins.add.actions', id: 'wsl-install-target' }, InstallTarget)), 'wsl-mirror: install target item')
        ctx.effect(() => ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'wsl-bundle-switch' }, WslSwitch)), 'wsl-mirror: WSL switch on detail pages')
      },
    }
  },
})
