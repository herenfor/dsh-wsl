// A stand-in DeepSeek endpoint (Anthropic messages format) for README screenshots in the test environment.
// node mock-llm.mjs <port> <log-file>. Replies are scripted; the system-check answer quotes a real command run.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
const [port = '47900', logFile = '/dev/null'] = process.argv.slice(2)
const log = (o) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')

const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '').join('\n')
let forced = null  // set with GET /__lang/zh or /__lang/en
const cjk = (s) => /[一-鿿]/.test(s)
const CHECK = /(这台机器|this machine)/i
const COMMAND = 'uname -sr; . /etc/os-release && echo "$PRETTY_NAME"; node -v; dsh --version'

function decide(body) {
  const msgs = body.messages ?? []
  const last = msgs.at(-1)
  const lastText = textOf(last?.content)
  const firstUser = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).find((t) => t.trim()) ?? ''
  const userTexts = msgs.filter((m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))).map((m) => textOf(m.content))
  const question = userTexts.at(-1) ?? ''
  const zh = forced ? forced === 'zh' : cjk(question) || cjk(firstUser) || cjk(textOf(body.system))
  const tools = body.tools ?? []
  const shell = tools.find((t) => /^bash$/i.test(t.name)) ?? tools.find((t) => /bash|shell|exec/i.test(t.name))
  const toolResult = Array.isArray(last?.content) && last.content.find((b) => b.type === 'tool_result')
  // A short title request (session titles) gets a short title.
  if (/title/i.test(textOf(body.system)) && !tools.length) return { text: zh ? '查看 WSL 环境' : 'Check the WSL environment' }
  if (toolResult) {
    const lines = textOf(toolResult.content).split('\n').map((s) => s.trim()).filter(Boolean)
    const [kernel = '?', os = '?', node = '?', dsh = '?'] = lines
    return { text: zh
      ? `查好了，我是在 WSL 里运行的：\n\n| 项目 | 结果 |\n|---|---|\n| 系统 | ${os} |\n| 内核 | ${kernel} |\n| Node.js | ${node} |\n| DSH | ${dsh} |\n\n你在 Desktop 窗口里和我聊，命令和文件其实都在 Linux 这边执行，用的是 WSL 里的工具链。\n\n要我接着去 inventory-api 看看那几个失败的集成测试吗？`
      : `Done. I'm running inside WSL:\n\n| Item | Result |\n|---|---|\n| System | ${os} |\n| Kernel | ${kernel} |\n| Node.js | ${node} |\n| DSH | ${dsh} |\n\nYou talk to me in the Desktop window, but commands and files run on the Linux side, with the toolchain installed in WSL.\n\nWant me to look into the failing integration tests in inventory-api next?` }
  }
  if (shell && CHECK.test(question)) {
    const props = Object.keys(shell.input_schema?.properties ?? {})
    const key = props.includes('command') ? 'command' : props.find((p) => /^(cmd|script)$/i.test(p)) ?? 'command'
    return { tool: { name: shell.name, input: { [key]: COMMAND, ...(props.includes('description') ? { description: zh ? '查看系统和版本' : 'Check the system and versions' } : {}) } }, pre: zh ? '我在 WSL 里跑一下看看。' : 'Let me check from inside WSL.' }
  }
  return { text: zh
    ? '你好，我是 Chief，帮你管理 Bot 团队。需要拍板的事都可以来找我。\n\n想让团队先帮你做什么？'
    : "Hi, I'm Chief. I run your Bot team, so come to me with anything that needs a decision.\n\nWhat should the team help with first?" }
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function stream(res, body, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const id = `msg_demo_${Date.now()}`
  sse(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0 } } })
  let index = 0
  const text = async (t) => {
    sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
    for (const piece of t.match(/[\s\S]{1,12}/g) ?? []) { sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: piece } }); await sleep(8) }
    sse(res, 'content_block_stop', { index }); index++
  }
  if (plan.pre) await text(plan.pre)
  if (plan.text) await text(plan.text)
  if (plan.tool) {
    sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_demo_${Date.now()}`, name: plan.tool.name, input: {} } })
    sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.tool.input) } })
    sse(res, 'content_block_stop', { index }); index++
  }
  sse(res, 'message_delta', { delta: { stop_reason: plan.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 180 } })
  sse(res, 'message_stop', {})
  res.end()
}

createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c)).on('end', async () => {
    const url = req.url ?? ''
    const set = url.match(/^\/__lang\/(zh|en)$/)
    if (set) { forced = set[1]; res.writeHead(200); return res.end(forced) }
    if (req.method === 'GET' && /\/models$/.test(url)) {
      log({ url })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'deepseek' }, { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }] }))
    }
    if (req.method === 'POST' && /\/messages(\?|$)/.test(url)) {
      let body = {}; try { body = JSON.parse(raw) } catch {}
      const plan = decide(body)
      log({ url, question: (body.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content)).at(-1)?.slice(0, 300), bash: (body.tools ?? []).find((t) => t.name === 'bash')?.input_schema, model: body.model, stream: body.stream, tools: (body.tools ?? []).map((t) => t.name), last: textOf(body.messages?.at(-1)?.content).slice(0, 200), plan })
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'msg_demo', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: plan.text ?? plan.pre ?? '' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }))
      }
      return stream(res, body, plan)
    }
    log({ url, method: req.method, unknown: true })
    res.writeHead(404).end()
  })
}).listen(Number(port), '127.0.0.1', () => log({ listening: port }))
