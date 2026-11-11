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

    const ReactDOM = (() => { try { return require('react-dom') } catch { return undefined } })()
    const api = (path, body) => window.fetch(new URL(path, window.document.baseURI), {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }).then((r) => r.json())
    const MUTED = 'var(--dsw-alias-label-secondary, #9a9a9a)'
    const FAINT = 'var(--dsw-alias-label-tertiary, #777)'
    const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.15))'
    const LAYER = 'var(--dsw-alias-bg-layer-2, #2a2a2a)'
    const BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,.25))'
    const SHADOW = 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35))'
    const MonitorIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true },
      h('rect', { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5 }), h('path', { d: 'M5.5 14h5M8 11.5V14' }))
    const Chevron = () => h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true }, h('path', { d: 'M2.5 4l2.5 2.5L7.5 4' }))
    const Check = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'M3 8.5l3.2 3L13 4.5' }))
    const hoverable = (base) => ({ onMouseEnter: (e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = HOVER }, onMouseLeave: (e) => { e.currentTarget.style.background = base ?? 'transparent' } })

    // A container right below the composer of the new-task page, for content rendered from the hero options slot.
    function useBelowComposer(anchor) {
      const [host, setHost] = React.useState(null)
      React.useLayoutEffect(() => {
        // The hero options sit in the row above the input; the first ancestor that also holds the input is the column.
        const seat = anchor.current?.closest('[data-composer-seat]')
        if (!seat) return undefined
        let column = anchor.current.parentElement
        while (column && column !== seat && !column.querySelector('textarea, [contenteditable="true"]')) column = column.parentElement
        if (!column) column = seat
        const div = document.createElement('div')
        div.dataset.dshWslMirror = 'environment'
        div.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 8px 0;font-size:13px;position:relative'
        column.appendChild(div)
        setHost(div)
        return () => { div.remove(); setHost(null) }
      }, [])
      return host
    }

    // New-task page: the environment the task runs in, picked under the composer as in Claude Code's new-session view.
    // WSL folders always run in WSL; a Windows folder runs here unless WSL is chosen, which the folder then keeps.
    // Once the task has started the page shows no more of it (the sidebar's penguin tells where a task runs).
    function Environment({ ui }) {
      const anchor = React.useRef(null)
      const host = useBelowComposer(anchor)
      const sessions = useStore(ui.sessions.list)
      const workspaces = useStore(ui.workspaces.list)
      const sessionId = Object.values(sessions.byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id
      const workspaceId = sessionId === undefined ? undefined : workspaces.items.find((w) => w.sessionIds.includes(sessionId))?.workspaceId
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [setupOpen, setSetupOpen] = React.useState(false)
      const refresh = () => { if (workspaceId) api(`wsl-bridge/run-target?workspaceId=${encodeURIComponent(workspaceId)}`).then(setState, () => setState(null)) }
      React.useEffect(refresh, [workspaceId])
      React.useEffect(() => {
        if (!open) return undefined
        const close = (e) => { if (!host?.contains(e.target)) setOpen(false) }
        const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', close, true); document.addEventListener('keydown', esc, true)
        return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', esc, true) }
      }, [open, host])
      const placeholder = h('span', { ref: anchor, style: { display: 'none' } })
      if (!ReactDOM?.createPortal || !host || !workspaceId || state === null || state.workspaceId !== workspaceId) return placeholder
      const wsl = state.target === 'wsl'
      const distro = state.distro ?? 'WSL'
      const choose = async (target) => {
        setOpen(false)
        if (target === state.target || state.insideWsl) return
        setBusy(true)
        // The blank task on the other side keeps this one's mode (Creator, a plugin's preset, ...) and typed text.
        const preset = sessions.byId[sessionId]?.projectionValues?.agentPreset
        const input = host.parentElement?.querySelector('textarea, [contenteditable="true"]')
        const draft = (input?.tagName === 'TEXTAREA' ? input.value : input?.innerText ?? '').replace(/\n$/, '')
        const fill = draft.trim() === '' ? undefined : (id) => {
          const binding = ui.sessions.binding?.(id)
          if (binding && ui.prepareDraft) try { ui.prepareDraft(binding, { prompt: draft, whenDraftExists: 'replace' }) } catch {}
        }
        try {
          const next = await api('wsl-bridge/run-target', { workspaceId, target, ...(typeof preset === 'string' ? { agentPreset: preset } : {}) })
          setState(next)
          // A blank task on the chosen side replaces this one; a mode that side lacks (a plugin's preset installed
          // only on the other side) falls back to the default mode.
          await ui.openWorkspace(workspaceId, fill, typeof preset === 'string' && next.presetAvailable ? { agentPreset: preset } : {})
        } finally { setBusy(false) }
      }
      // A WSL side that is not set up greys the WSL item; clicking it opens the setup dialog.
      const item = (target, icon, title, note, disabled, greyed) => h('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': state.target === target, disabled,
        onClick: () => { if (target === 'wsl' && !state.wslAvailable) { setOpen(false); setSetupOpen(true) } else void choose(target) }, ...hoverable(),
        style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', textAlign: 'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled || greyed ? 0.5 : 1 },
      }, h('span', { style: { display: 'inline-flex', width: 16, justifyContent: 'center' } }, icon),
      h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 2 } }, h('span', { style: { fontSize: 13 } }, title), h('span', { style: { fontSize: 12, color: FAINT } }, note)),
      h('span', { style: { width: 14, display: 'inline-flex' } }, state.target === target ? h(Check) : null))
      const menu = open ? h('div', {
        role: 'menu',
        style: { position: 'absolute', top: 'calc(100% + 6px)', left: 8, zIndex: 1100, minWidth: 260, padding: 4, borderRadius: 'var(--dsw-radius-lg, 12px)', background: LAYER, border: `1px solid ${BORDER}`, boxShadow: SHADOW },
      },
      item('local', h(MonitorIcon), 'Windows', state.insideWsl ? '这个文件夹在 WSL 中，只能在 WSL 运行' : '在本机运行', state.insideWsl),
      item('wsl', h(PenguinIcon), distro, state.wslAvailable ? '在 WSL 中运行' : `${SETUP_NOTE[state.setup] ?? 'WSL 端未连接'}${SETUP_OPENS.has(state.setup) ? '，点击查看' : ''}`, !state.wslAvailable && !wsl && !SETUP_OPENS.has(state.setup), !state.wslAvailable)) : null
      const slowDisk = wsl && typeof state.wslPath === 'string' && state.wslPath.startsWith('/mnt/')
      const row = [
        h('button', {
          key: 'env', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': open, disabled: busy, onClick: () => setOpen((o) => !o), ...hoverable(),
          title: wsl ? `在 WSL（${distro}）中运行` : '在 Windows 中运行',
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: 0, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: MUTED, font: 'inherit', fontSize: 13, cursor: busy ? 'default' : 'pointer' },
        }, wsl ? h(PenguinIcon) : h(MonitorIcon), busy ? '切换中…' : wsl ? distro : 'Windows', h(Chevron)),
        slowDisk ? h('span', { key: 'slow', style: { fontSize: 12, color: FAINT } }, `文件夹在 Windows 磁盘上（${state.wslPath.split('/').slice(0, 3).join('/')}），WSL 中读写较慢；常在 WSL 运行的项目建议放进 WSL`) : null,
        menu,
      ]
      const dialog = setupOpen ? h(SetupDialog, { key: 'setup', ui, onClose: () => { setSetupOpen(false); refresh() } }) : null
      return h(React.Fragment, null, placeholder, ReactDOM.createPortal(row, host), dialog)
    }

    // Adding a folder: Windows (the system's folder chooser) or WSL (browsed here, listed by the WSL Host). Takes the
    // directory-flow slots at a lower priority than the native chooser, which it calls for Windows folders.
    function FolderFlow({ open, busy, onPicked, onCancel, onError, nativePick, ui }) {
      const [phase, setPhase] = React.useState(null)   // null | 'choose' | 'native' | 'wsl'
      const [env, setEnv] = React.useState(null)
      const outcome = React.useRef({ onPicked, onCancel, onError })
      outcome.current = { onPicked, onCancel, onError }
      React.useEffect(() => {
        if (!open) { setPhase(null); return }
        if (phase !== null) return
        setPhase('choose')
        api('wsl-bridge/run-target').then((s) => { setEnv(s); if (!s.wslAvailable && !SETUP_OPENS.has(s.setup)) runNative() }, () => runNative())
      }, [open])
      const runNative = () => {
        setPhase('native')
        nativePick().then((path) => { if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path) },
          (reason) => outcome.current.onError(reason instanceof Error ? reason.message : String(reason)))
      }
      if (!open || phase === null || phase === 'native' || env === null) return null
      if (phase === 'setup') return h(SetupDialog, { ui, onClose: () => outcome.current.onCancel() })
      if (phase === 'wsl') return h(WslBrowser, { distro: env.distro ?? 'Ubuntu', busy, onPick: (path) => outcome.current.onPicked(path), onCancel: () => outcome.current.onCancel() })
      const option = (icon, title, note, onClick) => h('button', {
        type: 'button', onClick, ...hoverable(),
        style: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', border: `1px solid ${BORDER}`, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
      }, h('span', { style: { display: 'inline-flex', width: 18, justifyContent: 'center' } }, icon),
      h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, h('span', { style: { fontSize: 14 } }, title), h('span', { style: { fontSize: 12, color: FAINT } }, note)))
      return h(Modal, { title: '添加文件夹', onClose: () => outcome.current.onCancel(), width: 380 },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          option(h(MonitorIcon), 'Windows 文件夹', '用系统的文件夹选择框', runNative),
          env.wslAvailable
            ? option(h(PenguinIcon), `WSL 文件夹（${env.distro ?? 'Ubuntu'}）`, '浏览 Linux 文件系统；任务在 WSL 中运行，读写更快', () => setPhase('wsl'))
            : option(h(PenguinIcon), `WSL 文件夹${env.distro ? `（${env.distro}）` : ''}`, `${SETUP_NOTE[env.setup] ?? 'WSL 端未连接'}，点击查看`, () => setPhase('setup'))))
    }

    // ---- first-run setup of the WSL side (/wsl-bridge/setup). Nothing is downloaded by the plugin: the person runs the
    // commands shown, or hands them to a Windows DSH task, then re-checks.
    const SETUP_NOTE = {
      'no-wsl': '这台电脑没有安装 WSL', 'no-distro': 'WSL 里还没有 Linux 发行版', wsl1: '这个发行版是 WSL 1，需要 WSL 2',
      'needs-node': 'WSL 里还没有装 DSH', 'needs-dsh': 'WSL 里还没有装 DSH', 'version-mismatch': 'WSL 里的 DSH 版本和 Desktop 不同',
      checking: '正在检查 WSL…', starting: '正在启动 WSL 端…', error: 'WSL 端启动失败', connected: '已连接',
    }
    const SETUP_OPENS = new Set(['no-wsl', 'no-distro', 'wsl1', 'needs-node', 'needs-dsh', 'version-mismatch', 'error'])
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    function CodeBlock({ text }) {
      const [copied, setCopied] = React.useState(false)
      return h('div', { style: { position: 'relative' } },
        h('pre', { style: { margin: 0, padding: '10px 12px', paddingRight: 64, borderRadius: 'var(--dsw-radius-md, 8px)', border: `1px solid ${BORDER}`, background: 'rgba(127,127,127,.08)', fontFamily: MONO, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'text' } }, text),
        h('button', {
          type: 'button', ...hoverable(),
          onClick: () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) },
          style: { position: 'absolute', top: 6, right: 6, padding: '2px 8px', borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: MUTED, font: 'inherit', fontSize: 12, cursor: 'pointer' },
        }, copied ? '已复制' : '复制'))
    }
    function SetupDialog({ ui, onClose }) {
      const [s, setS] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const load = (body) => { setBusy(true); return api('wsl-bridge/setup', body).then(setS, (e) => setS({ state: 'error', error: String(e) })).finally(() => setBusy(false)) }
      React.useEffect(() => { void load() }, [])
      const para = (...children) => h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary, inherit)' } }, ...children)
      const note = (...children) => h('div', { style: { fontSize: 12, lineHeight: 1.6, color: FAINT } }, ...children)
      const code = (t) => h('code', { style: { fontFamily: MONO, fontSize: 12 } }, t)
      const button = (label, onClick, primary, disabled) => h('button', {
        type: 'button', onClick, disabled, ...hoverable(primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : undefined),
        style: { padding: '6px 14px', borderRadius: 'var(--dsw-radius-md, 8px)', border: primary ? 0 : `1px solid ${BORDER}`, background: primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : 'transparent', color: primary ? '#fff' : 'inherit', font: 'inherit', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
      }, label)
      const handToDsh = () => {
        // A Windows folder, so the task runs here (the WSL side is what it is setting up).
        const folder = ui?.workspaces.list.getSnapshot().items.find((w) => !isWsl(w.workspaceId))
        onClose()
        ui?.startSession(folder?.workspaceId, { prompt: s.prompt, whenDraftExists: 'replace' })
      }
      let body = [para('正在检查…')]
      if (s) {
        const distro = s.distro ?? 'Ubuntu'
        if (s.state === 'no-wsl') body = [
          para('这台电脑还没有安装 WSL。用管理员身份打开 PowerShell，运行：'), h(CodeBlock, { text: 'wsl --install' }),
          note('安装完成后需要重启电脑。重启后第一次打开 Ubuntu 时，按提示设置 Linux 用户名和密码，然后回到这里点「重新检查」。'),
        ]
        else if (s.state === 'no-distro') body = [
          para('WSL 已安装，但还没有 Linux 发行版。在 PowerShell 里运行：'), h(CodeBlock, { text: 'wsl --install -d Ubuntu' }),
          note('装好后打开一次 Ubuntu，设置 Linux 用户名和密码，然后回到这里点「重新检查」。'),
        ]
        else if (s.state === 'wsl1') body = [
          para(`发行版 ${distro} 运行在 WSL 1 上，需要 WSL 2。在 PowerShell 里运行：`), h(CodeBlock, { text: `wsl --set-version ${distro} 2` }),
        ]
        else if (['needs-node', 'needs-dsh', 'version-mismatch'].includes(s.state)) body = [
          s.state === 'version-mismatch'
            ? para(`Desktop 是 DSH ${s.desktopVersion}，WSL 里给这个插件用的是 ${s.installed}。两边版本必须相同，在 WSL 里更新：`)
            : para(`WSL 端需要一份和 Desktop 同版本的 DSH（${s.desktopVersion}）。在 WSL（${distro}）的终端里运行下面的命令：`),
          note('打开终端：开始菜单里的 Ubuntu，或者在 PowerShell 里运行 ', code(`wsl -d ${distro}`), '。这些文件都装在 ~/.dsh-wsl 下，不影响你在 WSL 里自己装的 dsh。'),
          h(CodeBlock, { text: s.commands }),
          note('DSH 连同依赖要下载约 250 MB，装好后约 900 MB，通常需要几分钟。如果 npm 提示找不到这个版本，说明它还没有发布到 npm，要等发布后再装。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            note('也可以把这件事交给 DSH：新建一个在 Windows 运行的任务，命令已经写在输入框里，检查后发送即可。'),
            ui && s.prompt ? button('交给 DSH 安装', handToDsh) : null),
        ]
        else if (s.state === 'error') body = [
          para('WSL 端没能启动。'),
          s.error ? h(CodeBlock, { text: s.error }) : null,
          s.probeError ? h(CodeBlock, { text: s.probeError }) : null,
          s.log ? note('详细日志在 WSL 里的 ', code(s.log), '。') : null,
        ]
        else if (s.state === 'starting' || s.state === 'checking') body = [para('正在启动 WSL 端…'), note('第一次启动需要建好 WSL 端的配置，可能要半分钟。')]
        else if (s.state === 'connected') body = [para(`已连接：WSL（${distro}）中的 DSH ${s.wslVersion ?? ''}。现在可以在输入框下方把运行位置切换到 ${distro}。`)]
        if (s.distros?.length > 1) body.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } }, '发行版',
          h('select', { value: distro, disabled: busy, onChange: (e) => void load({ distro: e.target.value }), style: { padding: '4px 8px', borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit' } },
            ...s.distros.map((d) => h('option', { key: d, value: d }, d)))))
      }
      return h(Modal, {
        title: '设置 WSL 运行环境', onClose, width: 560,
        footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          button(busy ? '检查中…' : '重新检查', () => void load({ action: 'recheck' }), false, busy),
          button(s?.state === 'connected' ? '完成' : '关闭', onClose, s?.state === 'connected')),
      }, ...body.filter(Boolean))
    }

    function Modal({ title, onClose, width, children, footer }) {
      React.useEffect(() => {
        const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
        document.addEventListener('keydown', esc, true)
        return () => document.removeEventListener('keydown', esc, true)
      }, [onClose])
      const box = h('div', { role: 'presentation', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() }, style: { position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45))' } },
        h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title, style: { width, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column', gap: 14, padding: 20, borderRadius: 'var(--dsw-radius-lg, 12px)', background: LAYER, border: `1px solid ${BORDER}`, boxShadow: SHADOW, color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 14 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, title), children, footer ?? null))
      return ReactDOM?.createPortal ? ReactDOM.createPortal(box, document.body) : box
    }

    // Folder browser over the WSL Host's file system (/wsl-bridge/dirs). The chosen folder is handed on as
    // \\wsl.localhost\<distro>\..., which the Host routes to WSL.
    function WslBrowser({ distro, busy, onPick, onCancel }) {
      const [listing, setListing] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [hidden, setHidden] = React.useState(false)
      const [naming, setNaming] = React.useState(null)
      const go = (path) => api(`wsl-bridge/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((r) => { if (r.ok) { setListing(r.value); setError(null) } else setError(r.error?.message ?? '无法读取') }, (e) => setError(String(e)))
      React.useEffect(() => { void go() }, [])
      const create = async () => {
        const name = naming?.trim()
        if (!name) { setNaming(null); return }
        const r = await api('wsl-bridge/dirs', { path: listing.path, name })
        if (!r.ok) { setError(r.error?.message ?? '新建失败'); return }
        setNaming(null); await go(r.value)
      }
      const unc = (path) => `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
      const button = (label, onClick, primary, disabled) => h('button', {
        type: 'button', onClick, disabled, ...hoverable(primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : undefined),
        style: { padding: '6px 14px', borderRadius: 'var(--dsw-radius-md, 8px)', border: primary ? 0 : `1px solid ${BORDER}`, background: primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : 'transparent', color: primary ? '#fff' : 'inherit', font: 'inherit', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
      }, label)
      const entries = (listing?.entries ?? []).filter((e) => hidden || !e.hidden)
      return h(Modal, {
        title: `选择 WSL 文件夹（${distro}）`, onClose: onCancel, width: 560,
        footer: h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: FAINT, marginRight: 'auto' } }, h('input', { type: 'checkbox', checked: hidden, onChange: (e) => setHidden(e.target.checked) }), '显示隐藏文件夹'),
          button('新建文件夹', () => setNaming(''), false, !listing),
          button('取消', onCancel),
          button(busy ? '添加中…' : '选择此文件夹', () => listing && onPick(unc(listing.path)), true, !listing || busy)),
      },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, fontSize: 13, color: MUTED } },
        ...(listing?.crumbs ?? []).flatMap((c, i) => [i > 1 ? h('span', { key: `s${i}`, style: { color: FAINT } }, '/') : null, h('button', { key: c.path, type: 'button', onClick: () => go(c.path), ...hoverable(), style: { border: 0, background: 'transparent', color: 'inherit', font: 'inherit', padding: '2px 4px', borderRadius: 6, cursor: 'pointer' } }, c.name)]),
        listing && listing.path !== listing.home ? h('button', { type: 'button', onClick: () => go(listing.home), ...hoverable(), style: { marginLeft: 'auto', border: 0, background: 'transparent', color: FAINT, font: 'inherit', fontSize: 12, padding: '2px 6px', borderRadius: 6, cursor: 'pointer' } }, '回到主目录') : null),
      naming !== null ? h('div', { style: { display: 'flex', gap: 8 } },
        h('input', { autoFocus: true, value: naming, placeholder: '文件夹名称', onChange: (e) => setNaming(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(null) } },
          style: { flex: 1, padding: '6px 10px', borderRadius: 'var(--dsw-radius-md, 8px)', border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit' } }),
        button('创建', create, true)) : null,
      error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e5484d)' } }, error) : null,
      h('div', { style: { height: 320, overflowY: 'auto', border: `1px solid ${BORDER}`, borderRadius: 'var(--dsw-radius-md, 8px)', padding: 4 } },
        listing === null ? h('div', { style: { padding: 12, color: FAINT, fontSize: 13 } }, '加载中…')
          : entries.length === 0 ? h('div', { style: { padding: 12, color: FAINT, fontSize: 13 } }, '没有子文件夹')
            : entries.map((e) => h('button', {
              key: e.path, type: 'button', onClick: () => go(e.path), ...hoverable(),
              style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', border: 0, borderRadius: 6, background: 'transparent', color: e.hidden ? FAINT : 'inherit', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' },
            }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true }, h('path', { d: 'M1.5 4.5v8h13v-7h-6.5l-1.5-1.5h-5z' })), e.name))))
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
          const Hero = () => h(Environment, { ui: c.uiWorkspace })
          c.effect(() => c.slots.inject('conversation.hero.options', () => c.slots.register({ name: 'conversation.hero.options', id: 'wsl-run-target' }, Hero)), 'wsl-mirror: environment under the composer')
          // Shadows the native chooser (lower priority renders) and calls it for Windows folders.
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__
          const nativePick = desktop === undefined ? () => c.uiWorkspace.pickDirectory() : () => desktop.pick()
          const injected = () => ({ nativePick, ui: c.uiWorkspace })
          c.effect(() => c.slots.inject('conversation.hero.workspace.directoryFlow', () => c.slots.inject('sidebar.workspaces.directoryFlow', function* () {
            yield c.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -1, inject: injected }, FolderFlow)
            yield c.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -1, inject: injected }, FolderFlow)
          })), 'wsl-mirror: Windows or WSL folder when adding one')
        })
        ctx.effect(() => ctx.slots.inject('plugins.add.actions', () => ctx.slots.register({ name: 'plugins.add.actions', id: 'wsl-install-target' }, InstallTarget)), 'wsl-mirror: install target item')
        ctx.effect(() => ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'wsl-bundle-switch' }, WslSwitch)), 'wsl-mirror: WSL switch on detail pages')
      },
    }
  },
})
