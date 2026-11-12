// Browser half of the mirror:
// - a WSL tab on the Plugins page for the WSL side's plugins (the official Installed tab stays Windows');
// - a penguin after the title of WSL folders and Sessions in the sidebar;
// - the run location of new tasks on the new-task page.
window.__ModuleLoader__.load({
  id: 'dsh-wsl-mirror',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

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
}
@keyframes dsh-wsl-spin { to { transform: rotate(360deg) } }`
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
      item('wsl', h(PenguinIcon), distro, state.wslAvailable ? '在 WSL 中运行' : `${SETUP_NOTE[state.setup] ?? 'WSL 端未连接'}${SETUP_OPENS.has(state.setup) ? '，点击查看' : ''}`, !state.wslAvailable && !wsl && !SETUP_OPENS.has(state.setup), !state.wslAvailable),
      h('div', { style: { height: 1, margin: '4px 6px', background: BORDER } }),
      h('button', {
        type: 'button', role: 'menuitem', onClick: () => { setOpen(false); setSetupOpen(true) }, ...hoverable(),
        style: { display: 'block', width: '100%', padding: '6px 10px 6px 36px', border: 0, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: MUTED, font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' },
      }, 'WSL 运行环境设置…')) : null
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
      choose: '还没有选择在 WSL 里怎么运行 DSH', 'needs-node': 'WSL 里还没有装 DSH', 'needs-dsh': 'WSL 里还没有装 DSH',
      'version-mismatch': 'WSL 里的 DSH 版本较旧，需要更新', 'desktop-outdated': 'Desktop 版本较旧，需要先升级 Desktop',
      installing: '正在安装 WSL 端的 DSH…', checking: '正在检查 WSL…', starting: '正在启动 WSL 端…', error: 'WSL 端启动失败', connected: '已连接',
    }
    const SETUP_OPENS = new Set(['no-wsl', 'no-distro', 'wsl1', 'choose', 'needs-node', 'needs-dsh', 'version-mismatch', 'desktop-outdated', 'installing', 'error'])
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
      const [choosing, setChoosing] = React.useState(false)   // "change" from a connected state
      const load = (body) => { if (body) setBusy(true); return api('wsl-bridge/setup', body).then(setS, (e) => setS({ state: 'error', error: String(e) })).finally(() => { if (body) setBusy(false) }) }
      React.useEffect(() => { void load() }, [])
      const waiting = s?.state === 'installing' || s?.state === 'starting' || s?.state === 'checking'
      React.useEffect(() => { if (!waiting) return undefined; const t = setInterval(() => void load(), 2000); return () => clearInterval(t) }, [waiting])
      const para = (...children) => h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary, inherit)' } }, ...children)
      const note = (...children) => h('div', { style: { fontSize: 12, lineHeight: 1.6, color: FAINT } }, ...children)
      const code = (t) => h('code', { style: { fontFamily: MONO, fontSize: 12 } }, t)
      const button = (label, onClick, primary, disabled) => h('button', {
        type: 'button', onClick, disabled, ...hoverable(primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : undefined),
        style: { padding: '6px 14px', borderRadius: 'var(--dsw-radius-md, 8px)', border: primary ? 0 : `1px solid ${BORDER}`, background: primary ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : 'transparent', color: primary ? '#fff' : 'inherit', font: 'inherit', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
      }, label)
      const row = (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, ...children)
      const handToDsh = () => {
        // A Windows folder, so the task runs here (the WSL side is what it is setting up).
        const folder = ui?.workspaces.list.getSnapshot().items.find((w) => !isWsl(w.workspaceId))
        onClose()
        ui?.startSession(folder?.workspaceId, { prompt: s.prompt, whenDraftExists: 'replace' })
      }
      const choose = (mode) => { setChoosing(false); void load({ mode }) }
      const card = (mode, title, lines, current) => h('button', {
        type: 'button', onClick: () => choose(mode), disabled: busy, ...hoverable(),
        style: { display: 'flex', flexDirection: 'column', gap: 4, width: '100%', padding: '12px 14px', border: `1px solid ${current ? 'var(--dsw-alias-button-info-fill, #3b6fe0)' : BORDER}`, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: busy ? 'default' : 'pointer' },
      }, h('span', { style: { fontSize: 14, fontWeight: 600 } }, title, current ? h('span', { style: { fontWeight: 400, fontSize: 12, color: FAINT, marginLeft: 8 } }, '当前') : null),
      ...lines.map((l, i) => h('span', { key: i, style: { fontSize: 12, lineHeight: 1.6, color: MUTED } }, l)))
      const modeCards = () => {
        const own = s.own
        const ownCompatible = own && s.desktopVersion && own.version.split('.').slice(0, 2).join('.') === s.desktopVersion.split('.').slice(0, 2).join('.')
        return [
          para(own ? `WSL 里已经装了 DSH ${own.version}。Desktop 在 WSL 里运行任务时，用哪一份？` : 'Desktop 在 WSL 里运行任务时，用哪一份 DSH？'),
          own ? card('reuse', `复用你装的 dsh（${own.version}）`, [
            '会话同步：Desktop 里在 WSL 运行的任务，和你在 WSL 里自己用 dsh 时是同一份数据，任务记录、文件夹列表、插件互相都看得到。',
            `版本：两边要保持一致，更新时会一起更新你自己用的 dsh。${ownCompatible ? '' : `现在的 ${own.version} 和 Desktop（${s.desktopVersion}）不兼容，选择后需要先更新。`}`,
            '不用再下载。',
          ], s.mode === 'reuse') : null,
          card('private', '插件专用一份', [
            '会话不同步：数据单独放在 ~/.dsh-wsl/home，和你自己用的 dsh 互相看不到。',
            '版本：由插件跟着 Desktop 管理，不影响你自己用的 dsh。',
            '要单独下载安装（约 250 MB，装好后约 900 MB）。',
          ], s.mode === 'private'),
          note('以后可以在这里更改。换一种方式后，之前那种方式下的任务不会出现在列表里，数据不会删除。'),
        ]
      }
      const installRow = (label) => [
        h(CodeBlock, { text: s.commands }),
        note('DSH 连同依赖要下载约 250 MB，装好后约 900 MB，通常需要几分钟。如果 npm 提示找不到这个版本，说明它还没有发布到 npm，要等发布后再装。'),
        row(s.canInstall ? button(label, () => void load({ action: 'install' }), true, busy) : null, ui && s.prompt ? button('交给 DSH 安装', handToDsh, false, busy) : null),
        note('「', label, '」直接在 WSL 里运行上面的命令；「交给 DSH 安装」新建一个在 Windows 运行的任务，命令写在输入框里，检查后发送。也可以自己在 WSL 终端里运行（开始菜单里的 Ubuntu，或 PowerShell 里的 ', code(`wsl -d ${s.distro ?? 'Ubuntu'}`), '）。'),
      ]
      let body = [para('正在检查…')]
      if (s) {
        const distro = s.distro ?? 'Ubuntu'
        const ownDsh = s.mode === 'reuse'
        if (choosing || s.state === 'choose') body = modeCards()
        else if (s.state === 'no-wsl') body = [
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
        else if (s.state === 'installing') body = [
          para(`正在 WSL（${distro}）里安装，可能需要几分钟。装好后会自动连接。`),
          s.job?.log ? h(CodeBlock, { text: s.job.log }) : null,
        ]
        else if (s.state === 'needs-node' || s.state === 'needs-dsh') body = [
          para(ownDsh ? 'WSL 里找不到可用的 Node.js。' : `WSL 端需要一份和 Desktop 同版本的 DSH（${s.desktopVersion}），这份只给这个插件用。`),
          ...installRow('自动安装'),
        ]
        else if (s.state === 'version-mismatch') body = [
          para(`Desktop 是 DSH ${s.desktopVersion}，WSL 里${ownDsh ? '你的 dsh' : '插件专用的那份'}是 ${s.installed}，两边差得太多，不能一起用。`),
          ownDsh ? note('更新会一起更新你自己用的 dsh。不想动它，可以改用插件专用的一份。') : null,
          ...(s.canInstall || s.commands ? installRow(`自动更新到 ${s.desktopVersion}`) : [note('请把 WSL 里的 dsh 更新到和 Desktop 相同的版本，再点「重新检查」。')]),
        ]
        else if (s.state === 'desktop-outdated') body = [
          para(`WSL 里${ownDsh ? '你的 dsh' : '的 DSH'}是 ${s.installed ?? s.wslVersion}，比 Desktop（${s.desktopVersion}）新，差得太多，不能一起用。`),
          para('请先升级 Desktop：在 Desktop 里检查更新，或者到官网下载最新版本。升级后会自动重新检查。'),
          ownDsh ? note('也可以改用插件专用的一份，它会跟着 Desktop 的版本。') : null,
        ]
        else if (s.state === 'error') body = [
          para('WSL 端没能启动。'),
          s.error ? h(CodeBlock, { text: s.error }) : null,
          s.probeError ? h(CodeBlock, { text: s.probeError }) : null,
          s.log ? note('详细日志在 WSL 里的 ', code(s.log), '。') : null,
        ]
        else if (s.state === 'starting' || s.state === 'checking') body = [para('正在启动 WSL 端…'), note('第一次启动需要建好 WSL 端的配置，可能要半分钟。')]
        else if (s.state === 'connected') {
          body = [para(`已连接：WSL（${distro}）中的 DSH ${s.wslVersion ?? ''}。现在可以在输入框下方把运行位置切换到 ${distro}。`)]
          if (s.drift === 'wsl-older') body.push(note(`两边版本略有不同（Desktop ${s.desktopVersion}，WSL ${s.wslVersion}），可以正常使用。`), ...(s.canInstall ? [row(button(`更新 WSL 到 ${s.desktopVersion}`, () => void load({ action: 'install' }), false, busy))] : []))
          if (s.drift === 'wsl-newer') body.push(note(`WSL 的 DSH（${s.wslVersion}）比 Desktop（${s.desktopVersion}）新一些，可以正常使用；建议升级 Desktop。`))
        }
        if (s.job && !s.job.running && s.job.code !== 0 && s.state !== 'installing') body.push(para('上次安装没有成功：', s.job.error ?? ''), s.job.log ? h(CodeBlock, { text: s.job.log }) : null)
        if (s.mode && !choosing && s.state !== 'choose' && !s.dev) body.push(row(note(`运行方式：${s.mode === 'reuse' ? '复用你装的 dsh（会话同步）' : '插件专用一份（会话不同步）'}`),
          h('button', { type: 'button', onClick: () => setChoosing(true), style: { border: 0, background: 'transparent', color: 'var(--dsw-alias-button-info-fill, #3b6fe0)', font: 'inherit', fontSize: 12, cursor: 'pointer', padding: 0 } }, '更改')))
        if (s.plugin) {
          const p = s.plugin
          const said = { waiting: '启动约一分钟后检查更新', off: '自动更新已关闭', checking: '正在检查更新…', 'not-updatable': '从本地文件夹或 Git 地址安装，不会自动更新',
            'up-to-date': '已是最新', updating: `正在更新到 ${p.latest}…`, updated: `已更新到 ${p.latest}`, 'restart-required': `已更新到 ${p.latest}，重启 Desktop 后生效`,
            failed: `检查更新失败：${p.error ?? ''}` }[p.status] ?? ''
          const link = (label, onClick) => h('button', { type: 'button', onClick, disabled: busy, style: { border: 0, background: 'transparent', color: 'var(--dsw-alias-button-info-fill, #3b6fe0)', font: 'inherit', fontSize: 12, cursor: 'pointer', padding: 0 } }, label)
          body.push(h('div', { style: { height: 1, background: BORDER } }),
            row(note(`插件 ${p.name} ${p.version} · ${said}`),
              p.auto && p.status !== 'not-updatable' ? link('检查更新', () => void load({ action: 'check-plugin' })) : null,
              link(p.auto ? '关闭自动更新' : '打开自动更新', () => void load({ autoUpdate: !p.auto }))))
        }
        if (s.distros?.length > 1) body.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } }, '发行版',
          h('select', { value: distro, disabled: busy || s.state === 'installing', onChange: (e) => void load({ distro: e.target.value }), style: { padding: '4px 8px', borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit' } },
            ...s.distros.map((d) => h('option', { key: d, value: d }, d)))))
      }
      return h(Modal, {
        title: '设置 WSL 运行环境', onClose, width: 580,
        footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          button(busy ? '检查中…' : '重新检查', () => void load({ action: 'recheck' }), false, busy || s?.state === 'installing'),
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

    // Foot of the sidebar while the WSL side comes up: Desktop starts it, so its folders and tasks arrive some seconds
    // after the page. Asks /wsl-bridge/setup once a second only while it is starting, then waits (no requests) for the
    // first WSL folder to reach the page; shows nothing once loaded or when WSL is not set up.
    const LOADING_STATES = new Set(['checking', 'starting', 'installing'])
    const Spinner = () => h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 12, height: 12, flex: 'none', boxSizing: 'border-box', border: '1.5px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%', animation: 'dsh-wsl-spin .9s linear infinite' } })
    function WslStatus({ wide, ui }) {
      const [setup, setSetup] = React.useState(null)
      const [settled, setSettled] = React.useState(false)
      const [dialog, setDialog] = React.useState(false)
      const workspaces = useStore(ui.workspaces.list)
      const listed = workspaces.items.some((w) => isWsl(w.workspaceId))
      React.useEffect(() => {
        let stopped = false
        let timer
        const poll = () => api('wsl-bridge/setup').then((next) => {
          if (stopped) return
          setSetup(next)
          if (LOADING_STATES.has(next.state)) timer = setTimeout(poll, 1000)
        }, () => { if (!stopped) timer = setTimeout(poll, 3000) })
        poll()
        return () => { stopped = true; clearTimeout(timer) }
      }, [])
      // Connected with no WSL folder yet: the folders follow within moments; one with none ends the wait after 8 s.
      const connected = setup?.state === 'connected'
      React.useEffect(() => {
        if (!connected || listed) return undefined
        const timer = setTimeout(() => setSettled(true), 8000)
        return () => clearTimeout(timer)
      }, [connected, listed])
      if (setup === null) return null
      const distro = setup.distro ? `（${setup.distro}）` : ''
      let text
      if (setup.state === 'installing') text = `正在 WSL${distro} 中安装 DSH…`
      else if (LOADING_STATES.has(setup.state)) text = `正在启动 WSL${distro}…`
      else if (connected && !listed && !settled) text = '正在加载 WSL 的任务…'
      else if (setup.state === 'error') text = `WSL${distro} 启动失败，点击查看`
      const modal = dialog ? h(SetupDialog, { key: 'setup', ui, onClose: () => setDialog(false) }) : null
      if (text === undefined) return modal
      const failed = setup.state === 'error'
      return h(React.Fragment, null, h('button', {
        type: 'button', title: text, onClick: () => setDialog(true), ...hoverable(),
        style: { display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: wide ? '8px 12px' : '8px 0', border: 0, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent', color: failed ? 'var(--dsw-alias-state-error-primary, #e5484d)' : MUTED, font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' },
      }, failed ? h(PenguinIcon) : h(Spinner), wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text) : null), modal)
    }

    // ---- the WSL tab of the Plugins page: the WSL side's plugins, apart from the official Installed tab (Windows').
    const ERROR = 'var(--dsw-alias-state-error-primary, #e5484d)'
    const OK = 'var(--dsw-alias-state-success-primary, #30a46c)'
    const pageText = (v) => (document.documentElement.lang?.startsWith('zh') === false ? v?.en : v?.zh) ?? v?.zh ?? ''
    const AFTER = { 'restart-required': '需要重启才生效：完全退出 Desktop，等 5 秒以上再打开', failed: '失败', overridden: '被配置覆盖，没有生效', cancelled: '已取消' }
    function Toggle({ on, busy, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': on, disabled: busy, onClick: () => onChange(!on),
        style: { position: 'relative', width: 36, height: 20, flex: 'none', border: 0, borderRadius: 10, padding: 0, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, background: on ? 'var(--dsw-alias-accent-primary, #4c7cf3)' : 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.35))', transition: 'background .15s' },
      }, h('span', { style: { position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .15s' } }))
    }
    // The official component kit, when the page shares it (the Discover tab draws its pages with the same pieces).
    const UI = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return undefined } })()
    const SwitchControl = ({ checked, label, disabled, onChange }) => UI?.Switch
      ? h(UI.Switch, { checked, label, disabled, onChange })
      : h(Toggle, { on: checked, busy: disabled, onChange })
    const TagLabel = ({ tone = 'neutral', children }) => UI?.Tag
      ? h(UI.Tag, { tone }, children)
      : h('span', { style: { fontSize: 12, padding: '1px 8px', borderRadius: 6, background: HOVER, color: MUTED } }, children)
    const Dot = ({ state }) => UI?.StateDot ? h(UI.StateDot, { state }) : h('span', { style: { width: 6, height: 6, borderRadius: 3, background: state === 'done' ? OK : state === 'error' ? ERROR : FAINT } })
    const Artwork = ({ src, size = 36 }) => {
      const [failed, setFailed] = React.useState(false)
      if (src && !failed) return h('img', { src, alt: '', width: size, height: size, style: { objectFit: 'contain' }, onError: () => setFailed(true) })
      return UI?.PluginArtworkDefault ? h(UI.PluginArtworkDefault, { size }) : h(PenguinIcon)
    }
    const iconFrame = (size, child) => h('span', { 'aria-hidden': true, style: { width: size, height: size, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3))', borderRadius: 'var(--dsw-radius-lg, 12px)', color: MUTED } }, child)
    const PHASE_TEXT = { pending: '等待启动', loading: '正在启动', active: '运行中', failed: '启动失败', unloading: '正在停止' }
    const PHASE_DOT = { pending: 'idle', loading: 'ongoing', active: 'done', failed: 'error', unloading: 'ongoing' }
    const rowState = (row) => !row.enabled ? ['idle', '已关闭'] : row.phase === null ? ['idle', '未运行'] : [PHASE_DOT[row.phase] ?? 'idle', PHASE_TEXT[row.phase] ?? row.phase]
    const partsSummary = (rows) => {
      const running = rows.filter((r) => r.enabled && r.phase === 'active').length
      const off = rows.filter((r) => !r.enabled).length
      const failed = rows.filter((r) => r.phase === 'failed').length
      return [`共 ${rows.length} 个`, ...(running ? [`${running} 运行中`] : []), ...(off ? [`${off} 已关闭`] : []), ...(failed ? [`${failed} 启动失败`] : [])].join(' · ')
    }
    const DETAIL_FAILURE = { unavailable: '说明文档读取失败', other: '说明文档读取失败' }
    // A bundle's long description, read by the WSL Host and drawn with the official document view.
    function WslDetailDocument({ name, version }) {
      const language = document.documentElement.lang || navigator.language || 'zh'
      const [state, setState] = React.useState({ status: 'loading' })
      const read = () => {
        setState({ status: 'loading' })
        api(`wsl-bridge/plugins?${new URLSearchParams({ name, language })}`).then((r) => setState(
          r.detail ? { status: 'ready', detail: r.detail } : { status: 'error', message: DETAIL_FAILURE[r.detailError] ?? r.error ?? '说明文档读取失败' },
        ), (e) => setState({ status: 'error', message: String(e) }))
      }
      React.useEffect(read, [name, version, language])
      const path = state.status === 'ready' && state.detail.status === 'found' ? state.detail.path : undefined
      const images = React.useMemo(() => path === undefined ? undefined : {
        resolve: (destination) => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(destination) ? undefined
          : new URL(`wsl-bridge/plugin-file?${new URLSearchParams({ bundle: name, document: path, path: destination })}`, document.baseURI).href,
      }, [name, path])
      if (!UI?.DetailDocument) {
        if (state.status !== 'ready' || state.detail.status !== 'found') return null
        return h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: MUTED, margin: 0 } }, state.detail.markdown)
      }
      const labels = UI.useDetailDocumentLabels({ title: '详细介绍', loading: '正在读取说明…', retry: '重试', copy: '复制', copied: '已复制', codeBlock: '代码', wrap: '自动换行', unwrap: '取消换行', footnotes: '脚注' })
      return h(UI.DetailDocument, {
        state: UI.detailDocumentState(state.status === 'ready' ? { status: 'ready', markdown: state.detail.status === 'found' ? state.detail.markdown : undefined } : state),
        labels, images, onRetry: read,
      })
    }
    // One WSL bundle's page inside the WSL tab, laid out as the Discover tab's pages are.
    function WslBundlePage({ name, distro, onBack }) {
      const [page, setPage] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const load = () => api(`wsl-bridge/plugins?${new URLSearchParams({ name })}`).then(setPage, (e) => setPage({ connected: false, error: String(e) }))
      React.useEffect(() => { void load() }, [name])
      const b = page?.bundle
      // Components move through loading and unloading on their own; look again until they settle.
      const settling = b?.rows?.some((r) => r.enabled ? r.phase === 'loading' || r.phase === 'pending' || r.phase === 'unloading' : r.phase !== null && r.phase !== 'failed')
      React.useEffect(() => { if (!settling) return; const t = setTimeout(() => void load(), 1200); return () => clearTimeout(t) }, [page])
      const act = async (body, key, what, after) => {
        setBusy(key); setNote(null)
        try {
          const r = await api('wsl-bridge/plugins', body)
          const app = r.result?.application
          if (r.error) setNote({ text: `${what}失败：${r.error}`, error: true })
          else if (r.result?.error) setNote({ text: `${what}失败：${r.result.error.message ?? r.result.error.code}`, error: true })
          else { setNote({ text: app && app !== 'applied' ? `${what}：${AFTER[app] ?? app}` : `${what}：已生效`, error: app === 'failed' }); after?.(r.result) }
        } catch (e) { setNote({ text: String(e), error: true }) } finally { setBusy(null); void load() }
      }
      const crumb = h('button', { type: 'button', onClick: onBack, style: { alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'transparent', color: FAINT, font: 'inherit', fontSize: 12.5, cursor: 'pointer' } },
        h('span', { 'aria-hidden': true, style: { display: 'inline-flex', transform: 'rotate(90deg)' } }, UI?.IconChevronDownOutlineRegular ? h(UI.IconChevronDownOutlineRegular, { size: 14 }) : '⌄'), h('span', null, `返回 ${distro} 插件`))
      const wrap = (...children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 4px', maxWidth: 960 } }, crumb, ...children)
      if (page === null) return wrap(h('div', { style: { color: FAINT, fontSize: 13 } }, '加载中…'))
      if (!page.connected) return wrap(h('div', { style: { color: FAINT, fontSize: 13 } }, `${distro} 端还没有连接。`))
      if (page.error && !b) return wrap(h('div', { style: { color: ERROR, fontSize: 13 } }, page.error))
      if (!b) return wrap(h('div', { style: { color: FAINT, fontSize: 13 } }, `${distro} 里没有找到 ${name}，可能已经卸载。`))
      const title = pageText(b.title)
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
        iconFrame(48, h(Artwork, { src: b.icon })),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h('h3', { style: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' } }, title),
            b.version ? h(TagLabel, null, b.version) : null,
            b.experimental ? h(TagLabel, { tone: 'info' }, '实验性') : null,
            h(TagLabel, null, distro)),
          title !== b.name ? h('span', { style: { fontSize: 12, color: FAINT, fontFamily: 'var(--ds-font-family-code, monospace)', overflowWrap: 'anywhere' } }, b.name) : null),
        h('div', { style: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 12 } },
          b.removable ? h('button', { type: 'button', disabled: busy !== null, onClick: () => { if (window.confirm(`从 ${distro} 卸载 ${title}？`)) void act({ action: 'remove', name: b.name }, 'bundle', `卸载 ${title}`, (r) => { if (r?.application !== 'failed') onBack() }) },
            style: { padding: '6px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'transparent', color: ERROR, font: 'inherit', fontSize: 13, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 } }, '卸载') : null,
          h(SwitchControl, { checked: b.enabled, label: `在 ${distro} 中启用 ${title}`, disabled: busy !== null || b.readOnly, onChange: (on) => void act({ action: on ? 'enable' : 'disable', name: b.name }, 'bundle', `${on ? '启用' : '停用'} ${title}`) })))
      const description = pageText(b.description)
      const rowView = (row) => {
        const [dot, stateText] = rowState(row)
        const rowTitle = pageText(row.title)
        return h('li', { key: row.rowId, style: { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 2px', borderBottom: '.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))' } },
          iconFrame(40, h(Artwork, { src: row.icon, size: 30 })),
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', { style: { fontSize: 14, fontWeight: 500 } }, rowTitle),
            pageText(row.description) ? h('span', { style: { fontSize: 13, color: MUTED } }, pageText(row.description)) : null,
            row.diagnostic ? h('span', { style: { fontSize: 12, color: ERROR, overflowWrap: 'anywhere' } }, row.diagnostic) : null,
            h('span', { style: { fontSize: 12, color: FAINT, fontFamily: 'var(--ds-font-family-code, monospace)', overflowWrap: 'anywhere' } }, row.rowId),
            h('span', { style: { fontSize: 12, color: FAINT, fontFamily: 'var(--ds-font-family-code, monospace)', overflowWrap: 'anywhere' } }, row.moduleName)),
          h('span', { style: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: MUTED } }, h(Dot, { state: dot }), stateText),
          h(SwitchControl, { checked: row.enabled, label: `开关组件 ${rowTitle}`, disabled: busy !== null || row.locked,
            onChange: (on) => void act({ action: 'row', entryId: row.entryId, enabled: on }, `row:${row.rowId}`, `${on ? '打开' : '关闭'} ${rowTitle}`) }))
      }
      return wrap(
        head,
        description ? h('p', { style: { margin: 0, fontSize: 14, lineHeight: '22px', color: MUTED, overflowWrap: 'anywhere' } }, description) : null,
        b.error ? h('p', { role: 'status', style: { margin: 0, fontSize: 13, color: ERROR } }, b.error) : null,
        note ? h('div', { role: 'status', style: { fontSize: 13, color: note.error ? ERROR : OK } }, note.text) : null,
        h('div', { style: { marginTop: 8 } }, h(WslDetailDocument, { name: b.name, version: b.version })),
        b.rows.length ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16 } },
          h('h4', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, '包含的组件 ', h('span', { style: { fontWeight: 400, color: MUTED, marginLeft: 8 } }, partsSummary(b.rows))),
          !b.enabled ? h('span', { style: { fontSize: 12, color: FAINT } }, '插件停用时，组件开关不可用。') : null,
          h('ul', { style: { margin: 0, padding: 0, listStyle: 'none' } }, b.rows.map(rowView))) : null,
        b.source ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 } },
          h('h4', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, '来源'),
          h('code', { style: { fontSize: 12, color: MUTED, overflowWrap: 'anywhere' } }, b.source)) : null)
    }
    function WslPluginsTab() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(null)       // name of the bundle being changed, or 'install'
      const [note, setNote] = React.useState(null)       // { text, error }
      const [spec, setSpec] = React.useState('')
      const [checked, setChecked] = React.useState(null) // inspect result for `spec`
      const [open, setOpen] = React.useState(null)       // name of the bundle whose page is open
      const load = () => api('wsl-bridge/plugins').then(setState, (e) => setState({ connected: false, error: String(e) }))
      React.useEffect(() => { void load() }, [])
      const act = async (body, key, done) => {
        setBusy(key); setNote(null)
        try {
          const r = await api('wsl-bridge/plugins', body)
          if (r.error) setNote({ text: r.error, error: true })
          else done?.(r.result)
        } catch (e) { setNote({ text: String(e), error: true }) } finally { setBusy(null); void load() }
      }
      const outcome = (what) => (result) => {
        const app = result?.application
        if (result?.error) setNote({ text: `${what}失败：${result.error.message ?? result.error.code}`, error: true })
        else setNote({ text: app && app !== 'applied' ? `${what}：${AFTER[app] ?? app}` : `${what}：已生效`, error: app === 'failed' })
      }
      const distro = state?.distro ? `WSL（${state.distro}）` : 'WSL'
      const intro = h('p', { style: { margin: '0 0 16px', fontSize: 13, color: MUTED, lineHeight: 1.6 } },
        `这里是装在 ${distro} 里的插件，只对在 WSL 中运行的任务生效。Windows 的插件在「已安装」页管理，两边互不影响。`)
      if (open !== null) return h(WslBundlePage, { name: open, distro, onBack: () => { setOpen(null); void load() } })
      if (state === null) return h('div', { style: { padding: 24, color: FAINT, fontSize: 13 } }, '加载中…')
      if (!state.connected) {
        return h('div', { style: { padding: '8px 4px' } }, intro, h('p', { style: { fontSize: 13, color: FAINT } },
          `${distro} 端${SETUP_NOTE[state.setup] ? `：${SETUP_NOTE[state.setup]}` : '还没有连接'}。连上后这里会列出它的插件。`),
        h('button', { type: 'button', onClick: () => void load(), style: { marginTop: 8, padding: '6px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer' } }, '重新检查'))
      }
      const button = (label, onClick, { primary = false, disabled = false, danger = false } = {}) => h('button', {
        type: 'button', onClick, disabled,
        style: { padding: '6px 12px', borderRadius: 8, border: primary ? 0 : `1px solid ${BORDER}`, background: primary ? 'var(--dsw-alias-accent-primary, #4c7cf3)' : 'transparent', color: primary ? '#fff' : danger ? ERROR : 'inherit', font: 'inherit', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap' },
      }, label)
      // The whole card opens the bundle's page; its own buttons stop the click.
      const row = (b) => h('div', { key: b.name, role: 'button', tabIndex: 0, title: '查看详情',
        onClick: () => setOpen(b.name), onKeyDown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen(b.name) },
        onMouseEnter: (e) => { e.currentTarget.style.background = HOVER }, onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
        style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${BORDER}`, borderRadius: 'var(--dsw-radius-lg, 12px)', cursor: 'pointer' } },
        b.icon ? h('img', { src: b.icon, alt: '', style: { width: 32, height: 32, flex: 'none', borderRadius: 8 } }) : h('span', { style: { width: 32, height: 32, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, h(PenguinIcon)),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
            h('span', { style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pageText(b.title)),
            b.version ? h('span', { style: { fontSize: 12, color: FAINT } }, b.version) : null),
          h('span', { style: { fontSize: 12, color: b.error ? ERROR : MUTED, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, b.error ?? (pageText(b.description) || b.name))),
        h('span', { style: { display: 'contents' }, onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() },
        !b.official && b.installed ? button('卸载', () => { if (window.confirm(`从 ${distro} 卸载 ${pageText(b.title)}？`)) void act({ action: 'remove', name: b.name }, b.name, outcome(`卸载 ${pageText(b.title)}`)) }, { danger: true, disabled: busy !== null }) : null,
        h(Toggle, { on: b.enabled, busy: busy !== null, onChange: (on) => void act({ action: on ? 'enable' : 'disable', name: b.name }, b.name, outcome(`${on ? '启用' : '停用'} ${pageText(b.title)}`)) })))
      const mine = state.bundles.filter((b) => !b.official)
      const official = state.bundles.filter((b) => b.official)
      const section = (title, items, empty) => h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 } },
        h('h3', { style: { margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: MUTED } }, title),
        items.length ? items.map(row) : h('div', { style: { fontSize: 13, color: FAINT } }, empty))
      const inspected = checked?.status === 'accepted' ? checked : null
      const install = h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 14, marginBottom: 20, border: `1px solid ${BORDER}`, borderRadius: 'var(--dsw-radius-lg, 12px)' } },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, `安装插件到 ${distro}`),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', { value: spec, placeholder: 'npm 包名、git 地址或本地文件夹路径', onChange: (e) => { setSpec(e.target.value); setChecked(null) },
            onKeyDown: (e) => { if (e.key === 'Enter' && spec.trim()) void act({ action: 'inspect', spec: spec.trim() }, 'install', setChecked) },
            style: { flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13 } }),
          inspected
            ? button(busy === 'install' ? '安装中…' : '安装', () => void act({ action: 'install', spec: spec.trim() }, 'install', (r) => { outcome(`安装 ${inspected.name ?? spec.trim()}`)(r); if (!r?.error && r?.application !== 'failed') { setSpec(''); setChecked(null) } }), { primary: true, disabled: busy !== null })
            : button(busy === 'install' ? '检查中…' : '检查', () => void act({ action: 'inspect', spec: spec.trim() }, 'install', setChecked), { disabled: busy !== null || !spec.trim() })),
        checked?.status === 'refused' ? h('div', { style: { fontSize: 12, color: ERROR } }, checked.reason) : null,
        inspected ? h('div', { style: { fontSize: 12, color: MUTED } }, `${inspected.name ?? spec.trim()}${inspected.version ? ` ${inspected.version}` : ''}${inspected.description ? ` — ${inspected.description}` : ''}${inspected.bundle === false ? '（这个包不是 DSH 插件）' : ''}`) : null,
        busy === 'install' && inspected ? h('div', { style: { fontSize: 12, color: FAINT } }, '正在 WSL 中下载和安装，可能需要一两分钟…') : null)
      return h('div', { style: { padding: '8px 4px', maxWidth: 820 } }, intro,
        note ? h('div', { role: 'status', style: { marginBottom: 12, fontSize: 13, color: note.error ? ERROR : OK } }, note.text) : null,
        install,
        section('我安装的', mine, '还没有安装第三方插件'),
        section('官方插件', official, '没有可选的官方插件'))
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
          const Status = ({ wide }) => h(WslStatus, { wide, ui: c.uiWorkspace })
          c.effect(() => c.slots.inject('sidebar.footer.action', () => c.slots.register({ name: 'sidebar.footer.action', id: 'wsl-status', order: -100 }, Status)), 'wsl-mirror: WSL loading in the sidebar foot')
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
        // The tab is named after the distribution the WSL side runs in, once known.
        let tabLabel = 'WSL'
        api('wsl-bridge/setup').then((s) => { if (s?.distro) tabLabel = `WSL（${s.distro}）` }, () => {})
        ctx.effect(() => ctx.slots.inject('plugins.tab', () => ctx.slots.register({ name: 'plugins.tab', id: 'wsl-plugins', label: () => tabLabel, order: 50 }, WslPluginsTab)), 'wsl-mirror: WSL tab on the Plugins page')
      },
    }
  },
})
