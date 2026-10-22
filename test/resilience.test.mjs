// Regression tests for the resilience plugin. No dependencies.
//
//   node --experimental-strip-types test/resilience.test.mjs
//
// Node >= 22.6 strips the TypeScript types on import, so the plugin runs exactly as shipped.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../plugin/resilience/index.ts'

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fresh plugin instance with a controllable session + event stream. */
async function rig(options = {}, model = { providerID: 'flash1047', id: 'deepseek-v4.1-flash-free' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'))
  const hooks = {}
  const calls = { prompt: [], compact: 0, switchModel: 0, context: 0 }
  let queue = []
  let waiter = null
  const push = (ev) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(ev)
    } else queue.push(ev)
  }
  const ctx = {
    location: { directory: root },
    options: {
      onlyProviderID: 'flash1047',
      onlyModelID: 'deepseek-v4.1-flash-free',
      ...options,
    },
    session: {
      hook: (name, fn) => {
        (hooks[name] ||= []).push(fn)
      },
      get: async () => ({ status: { type: 'idle' }, outcome: 'failed', model }),
      context: async () => {
        calls.context += 1
        return { messages: [{ role: 'user', content: 'do the task' }, tmsg('last', 'y')] }
      },
      prompt: async (arg) => {
        calls.prompt.push(arg.text)
      },
      compact: async () => {
        calls.compact += 1
      },
      switchModel: async () => {
        calls.switchModel += 1
      },
    },
    event: {
      subscribe: async function* () {
        for (;;) {
          const ev = queue.length ? queue.shift() : await new Promise((r) => (waiter = r))
          yield ev
        }
      },
    },
  }
  await plugin.setup(ctx)
  await sleep(5)
  const emit = async (type, data = {}, wait = 30) => {
    push({ type, data: { sessionID: 'ses_test', ...data } })
    await sleep(wait)
  }
  const context = (msgList, system = [], extra = {}) =>
    hooks.context[0]({ sessionID: 'ses_test', model, system, messages: msgList, options: {}, ...extra })
  const prompt = (text) => hooks.prompt[0]({ sessionID: 'ses_test', prompt: { text } })
  const retry = (err, attempt = 1) => {
    const ev = { sessionID: 'ses_test', attempt, error: err }
    return hooks.retry[0](ev).then(() => ev)
  }
  const compaction = (msgList) => hooks.compaction[0]({ sessionID: 'ses_test', messages: msgList })
  const log = () =>
    fs
      .readFileSync(path.join(root, '.omo', 'logs', 'resilience.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  return { root, hooks, calls, emit, context, prompt, retry, compaction, log }
}

const tmsg = (id, v) => ({ role: 'tool', content: [{ type: 'tool-result', id, name: 'shell', result: { type: 'text', value: v } }] })
const big = (n = 12000) => 'x'.repeat(n)
const manyTools = (count = 120, size = 12000) => {
  const out = []
  for (let i = 0; i < count; i++) out.push(tmsg('t' + i, big(size)))
  out.push({ role: 'user', content: [{ type: 'text', text: 'go' }] })
  return out
}
const clone = (v) => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------- scope
{
  const r = await rig({}, { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' })
  const msgs = manyTools()
  const before = JSON.stringify(msgs)
  const system = []
  await r.context(msgs, system)
  check('scope: other provider is never touched', JSON.stringify(msgs) === before)
  check('scope: other provider gets no system part', system.length === 0)
  await r.prompt('hello')
  await r.emit('session.idle')
  await sleep(50)
  check('scope: no resume for another model', r.calls.prompt.length === 0)
  await r.emit('session.compaction.ended')
  const sys2 = []
  await r.context(msgs, sys2)
  check('scope: no post-compaction anchor for another model', sys2.length === 0)
}

// ---------------------------------------------------------------- prune
{
  const r = await rig()
  const msgs = manyTools()
  const firstBefore = msgs[0].content[0].result.value.length
  await r.context(msgs)
  const pruned = msgs[0].content[0].result.value
  check('prune: stale tool output is shortened', pruned.length < firstBefore, `${firstBefore} -> ${pruned.length}`)
  check('prune: marker says the text was removed client-side', pruned.includes('were removed from the middle'))
  check('prune: marker forbids guessing', /do not guess or reconstruct/i.test(pruned))
  const lastUntouched = msgs.slice(-6).every((m) => m.role !== 'tool' || m.content[0].result.value.length === 12000)
  check('prune: recent messages are left intact', lastUntouched)
  const once = JSON.stringify(msgs)
  await r.context(msgs)
  check('prune: second pass does not re-prune the same output', JSON.stringify(msgs) === once)
}

// ---------------------------------------------------------------- token clamp
{
  const r = await rig()
  const ev = { sessionID: 'ses_test', model: { providerID: 'flash1047', id: 'deepseek-v4.1-flash-free' }, system: [], messages: [], options: { maxTokens: 64000 } }
  await r.hooks.context[0](ev)
  check('context: maxTokens clamped to the model output limit', ev.options.maxTokens === 32000)
}

// ---------------------------------------------------------------- compaction note
{
  const r = await rig()
  await r.prompt('fix the crypto checker, do not restart it')
  await r.emit('session.tool.success', { id: '1', name: 'shell' })
  const msgs = manyTools(3, 200)
  const count = msgs.length
  const before = JSON.stringify(msgs)
  await r.compaction(msgs)
  check('compaction: exactly one message appended', msgs.length === count + 1)
  check('compaction: appended message is a fresh user message', msgs[count].role === 'user')
  check('compaction: existing messages are byte-identical (regression: tool-message mutation)', JSON.stringify(msgs.slice(0, count)) === before)
  check('compaction: note quotes the user task', msgs[count].content[0].text.includes('fix the crypto checker'))
  check('compaction: note carries the recent tool trace', msgs[count].content[0].text.includes('recent tools: shell'))
  check('compaction: note forbids summarising the request away', /never summarise the request away/i.test(msgs[count].content[0].text))
}

// ---------------------------------------------------------------- post-compaction anchor
{
  const r = await rig()
  await r.prompt('build the geophoto report')
  await r.emit('session.compaction.ended')
  const system = []
  await r.context([], system)
  check('anchor: one system part after compaction', system.length === 1)
  check('anchor: quotes the current task', system[0]?.text.includes('build the geophoto report'))
  check('anchor: forbids restarting and inventing work', /do not restart/i.test(system[0]?.text || '') && /do not invent new work/i.test(system[0]?.text || ''))
  const system2 = []
  await r.context([], system2)
  check('anchor: injected only once', system2.length === 0)
}

// ---------------------------------------------------------------- retry, no switching
{
  const r = await rig()
  const e500 = await r.retry({ status: 500, type: 'provider.internal', message: 'Upstream request failed: Endpoint is unavailable' })
  check('retry 5xx: retried', e500.decision?.retry === true, `delay=${e500.decision?.delay}`)
  const e429 = await r.retry({ status: 429, type: 'provider.rate-limit', message: 'rate limit exceeded' })
  check('retry 429: retried', e429.decision?.retry === true, `delay=${e429.decision?.delay}`)
  const etr = await r.retry({ status: 200, type: 'provider.transport', message: 'Connection lost while reading the response: ECONNRESET' })
  check('retry transport: retried', etr.decision?.retry === true, `delay=${etr.decision?.delay}`)
  const e400 = await r.retry({ status: 400, type: 'provider.invalid-request', message: 'OpenAI Chat tool messages only support tool-result content for now' })
  check('retry invalid-request: not retried (it is our own bug, not the network)', e400.decision === undefined)
  const eabort = await r.retry({ status: 0, type: 'provider.aborted', message: 'Step interrupted by user' })
  check('retry own interrupt: not retried', eabort.decision === undefined)
  check('failover: switchModel was never called', r.calls.switchModel === 0)

  const r2 = await rig()
  let last
  for (let i = 0; i < 6; i++) {
    last = await r2.retry({ status: 200, type: 'provider.transport', message: 'ECONNRESET' }, i + 1)
  }
  check('retry transport: gives up after 5 resets instead of hanging', last.decision === undefined)
}

// ---------------------------------------------------------------- resume
{
  const r = await rig()
  await r.prompt('TASK: finish the checker and report')
  await r.retry({ status: 503, type: 'provider.internal', message: 'Endpoint is unavailable' })
  await r.emit('session.idle', {}, 2400)
  const sent = r.calls.prompt.filter((t) => t.startsWith('The previous turn stopped unexpectedly'))
  check('resume: fired after a failed turn', sent.length === 1)
  check('resume: keeps the continue-where-you-left-off wording', /Continue EXACTLY where you left off/.test(sent[0] || ''))
  check('resume: re-states the user task so the model cannot drift', (sent[0] || '').includes('TASK: finish the checker and report'))
  await r.emit('session.idle', {}, 2400)
  const sent2 = r.calls.prompt.filter((t) => t.startsWith('The previous turn stopped unexpectedly'))
  check('resume: cooldown blocks a second prompt', sent2.length === 1)
}

// ---------------------------------------------------------------- resume cap
{
  const r = await rig({ maxResumes: 0 })
  await r.prompt('TASK: whatever')
  await r.retry({ status: 503, type: 'provider.internal', message: 'Endpoint is unavailable' })
  await r.emit('session.idle', {}, 2300)
  check('resume: maxResumes=0 disables the prompt', r.calls.prompt.length === 0)
}

// ---------------------------------------------------------------- log shape
{
  const r = await rig()
  const lines = r.log()
  const setup = lines.find((l) => l.at === 'setup')
  check('log: setup records the guarded entry', setup?.guarded === 'flash1047/deepseek-v4.1-flash-free')
  check('log: setup records that model switching is disabled', setup?.modelSwitching === 'disabled')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
