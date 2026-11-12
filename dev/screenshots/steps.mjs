// Page scripts for dev/shot.mjs that take the README screenshots: node steps.mjs <lang> <set> > steps.json
//   main   home-<lang> (new WSL task), picker-<lang> (run-location menu), plugins-<lang> (WSL tab), detail-<lang> (dsh-pet)
//   first  setup-<lang>: the first-run dialog (the test Desktop must have no config.json, see make.sh)
//   bot    bot-<lang>: DS Bot's own surface; a fresh Main Bot gets a model, greets, and is asked to check the machine
// Selectors go by visible text in zh or en, so they follow the page language set by the first step.
const [lang, set] = process.argv.slice(2)
const w = (ms) => `await new Promise(r => setTimeout(r, ${ms}));`
const click = (expr) => `(${expr})?.click();`
const byText = (sel, test) => `[...document.querySelectorAll('${sel}')].find(e => ${test})`
const pet = (show) => `document.querySelectorAll('.dsh-pet-root,#dsh-pet-baifan-root').forEach(e => e.style.visibility = '${show ? '' : 'hidden'}');`
// ds-bot remembers whether the window shows its own surface ('bot') or DSH's ('agent').
const surface = (s) => ({ js: `(() => { if (localStorage.getItem('ds-bot:surface') === '${s}') return 0; localStorage.setItem('ds-bot:surface', '${s}'); location.reload(); return 1 })()`, wait: 16000 })
const shot = (name) => ({ name: `${name}-${lang}`, js: 'null', wait: 300 })
const language = `window.__wslctx?.locale?.setLocale('${lang}'); ${w(1500)}`
const expand = `document.querySelectorAll('[data-row-key^="workspace:"]').forEach(e => { if (e.getAttribute('aria-expanded') === 'false') e.click() }); ${w(1200)}`
const QUESTION = { zh: '这台机器是什么环境？帮我看一下系统和 Node 版本。', en: 'What is this machine running? Check the system and Node version for me.' }

const sets = {
  main: [
    surface('agent'),
    { js: `(async () => { ${language} ${expand} ${click(byText('button', `/inventory-api.*(新建会话|new session)|(新建会话|new session).*inventory-api/i.test(e.getAttribute('aria-label') || '')`))} ${w(2500)} document.activeElement?.blur?.(); return 1 })()`, wait: 1500 },
    shot('home'),
    { js: `(async () => { ${click(byText('button', `/^\\s*Ubuntu\\s*$/.test(e.innerText)`))} return 1 })()`, wait: 1200 },
    shot('picker'),
    { js: `(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${w(600)} ${click(byText('a,button,[role=button]', `['插件', 'Plugins'].includes(e.innerText.trim())`))} ${w(2500)} ${click(byText('button,[role=tab]', `e.innerText.trim().startsWith('WSL')`))} ${w(3500)} ${pet(false)} return 1 })()`, wait: 800 },
    shot('plugins'),
    { js: `(async () => { ${click(byText('[role=button][title]', `/dsh-pet/.test(e.innerText)`))} ${w(3000)} ${pet(false)} return 1 })()`, wait: 800 },
    shot('detail'),
  ],
  first: [
    surface('agent'),
    { js: `(async () => { ${language} ${click(byText('a,button,[role=button]', `['新会话', 'New Session'].includes(e.innerText.trim())`))} ${w(2000)} ${click(byText('button', `/^\\s*Windows\\s*$/.test(e.innerText)`))} ${w(1000)} ${click(byText('button,[role=menuitem]', `/^Ubuntu/.test(e.innerText.trim())`))} ${w(3000)} return [...document.querySelectorAll('[role=dialog]')].length })()`, wait: 1000 },
    shot('setup'),
  ],
  bot: [
    surface('bot'),
    { js: `(async () => { ${language} ${w(1000)} ${click(byText('button.bt-model-chip', `/V4.1-Flash/.test(e.innerText)`))} ${w(12000)} const ed = document.querySelector('[contenteditable=true]'); ed.focus(); document.execCommand('insertText', false, ${JSON.stringify(QUESTION[lang])}); ${w(600)} ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); ${w(20000)} document.activeElement?.blur?.(); return document.querySelector('[data-chat-flow]')?.innerText?.slice(-300) })()`, wait: 1500 },
    shot('bot'),
  ],
}
if (!sets[set] || !QUESTION[lang]) { console.error('usage: node steps.mjs <zh|en> <main|first|bot>'); process.exit(2) }
console.log(JSON.stringify(sets[set]))
