// Browser half of the probe: a badge in the bottom-right corner of the window. Its second line asks the host half
// (GET dsh-wsl-probe/whoami on the page's own Host) where it runs; a 404 there means the route is not forwarded.
window.__ModuleLoader__.load({
  id: 'dsh-wsl-probe',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    function Badge() {
      const [host, setHost] = React.useState('询问中…')
      const [hidden, setHidden] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        window.fetch(new URL('dsh-wsl-probe/whoami', window.document.baseURI), { credentials: 'same-origin', cache: 'no-store' })
          .then(async (r) => r.ok ? (await r.json()) : Promise.reject(new Error(`HTTP ${r.status}`)))
          .then((w) => `宿主：${w.platform} · ${w.hostname} · ${w.release}`, (e) => `宿主不可达（${e.message}）`)
          .then((text) => { if (alive) setHost(text) })
        return () => { alive = false }
      }, [])
      if (hidden) return null
      return h('div', {
        onClick: () => setHidden(true),
        title: '点击隐藏',
        style: {
          position: 'fixed', right: 16, bottom: 16, zIndex: 2147483000, cursor: 'pointer',
          padding: '10px 14px', borderRadius: 12, color: '#fff', font: '600 13px/1.5 system-ui, sans-serif',
          background: 'linear-gradient(135deg, #e95420, #772953)', boxShadow: '0 6px 24px rgba(0,0,0,.3)',
        },
      }, h('div', null, '🐧 WSL 插件界面（dsh-wsl-probe）'), h('div', { style: { fontWeight: 400, opacity: 0.9 } }, host))
    }
    return {
      name: 'dsh-wsl-probe-browser',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-wsl-probe' }, Badge)), 'wsl-probe: badge')
      },
    }
  },
})
