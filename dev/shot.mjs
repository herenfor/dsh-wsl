// Screenshots for the README: node shot.mjs <url> <out-dir> <steps.json>
// steps.json: [{ "name": "file-stem" | null, "js": "<async page script>", "wait": ms }]. Env: DARK=1, LOCALE=zh|en, W, H.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
const [url, outDir, stepsFile] = process.argv.slice(2)
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))
mkdirSync(outDir, { recursive: true })
const base = `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1228`
const bin = `${base}/${readdirSync(base).find((d) => d.startsWith('chrome-'))}/chrome-headless-shell`
const port = 9300 + Math.floor(Math.random() * 500)
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900)
const proc = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${outDir}/.profile-${process.env.LOCALE ?? 'x'}`, '--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break } catch {} await sleep(200) }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0; const pending = new Map(); const log = []
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method === 'Runtime.exceptionThrown') log.push(m.params.exceptionDetails.exception?.description?.slice(0, 200)) })
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
if (process.env.DARK) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
if (process.env.PRELOAD) await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(process.env.PRELOAD, 'utf8') })
await send('Page.navigate', { url })
await sleep(Number(process.env.FIRST_WAIT ?? 9000))
const out = []
for (const step of steps) {
  const r = await send('Runtime.evaluate', { expression: step.js ?? 'null', awaitPromise: true, returnByValue: true })
  const value = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description
  await sleep(step.wait ?? 1500)
  if (step.name) {
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82 })
    const file = `${outDir}/${step.name}.webp`
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    out.push({ name: step.name, bytes: Buffer.from(shot.result.data, 'base64').length, value })
  } else out.push({ step: (step.js ?? '').slice(0, 40), value })
}
console.log(JSON.stringify({ out, log }, null, 1))
ws.close(); proc.kill(); process.exit(0)
