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
async function rig(options = {}, model = { providerID: 'flash1047', id: 'deepseek-v4.1-flash-free' }, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'))
  const hooks = {}
  const calls = { prompt: [], compact: 0, switchModel: 0, context: 0 }
  // what the transcript holds: every admitted prompt, in order. Tests that simulate a revert pass
  // their own `context` and omit the message the user took back.
  const history = []
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
        return {
          messages: history.length
            ? history.slice()
            : [{ role: 'user', content: 'do the task' }, tmsg('last', 'y')],
        }
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
      ...over,
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
  const prompt = (text) => {
    const p = hooks.prompt[0]({ sessionID: 'ses_test', prompt: { text } })
    // admission persists after the hook runs; the next prompt must see this one in the transcript
    return p.then(() => {
      history.push({ role: 'user', content: [{ type: 'text', text }] })
    })
  }
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
// Long assistant/user prose: the normal prune never touches it, so it is what the emergency trim
// has to deal with when compaction is unavailable.
const manyChatter = (count = 100, size = 8000) => {
  const out = []
  for (let i = 0; i < count; i++) {
    const role = i % 10 === 0 ? 'user' : 'assistant'
    out.push({ role, content: [{ type: 'text', text: 'x'.repeat(size) }] })
  }
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

// ---------------------------------------------------------------- output reservation
{
  const r = await rig({ ceiling: 20000, margin: 2000 })
  const ev = {
    sessionID: 'ses_test',
    model: { providerID: 'flash1047', id: 'deepseek-v4.1-flash-free' },
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(50000) }] }],
    options: { maxTokens: 32000 },
  }
  await r.hooks.context[0](ev)
  check('reservation: reply budget shrinks as the prompt approaches the ceiling', ev.options.maxTokens === 2000, `maxTokens=${ev.options.maxTokens}`)
}

// ---------------------------------------------------------------- calibrate from real tokens
{
  let tk = { input: 400, output: 20, reasoning: 0, cache: { read: 11600, write: 0 } }
  const r = await rig({}, undefined, {
    context: async () => ({
      messages: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], tokens: tk },
      ],
    }),
  })
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(36000) }] }] // estimate 10 000
  await r.context(msgs)
  await r.emit('session.tool.success', { id: '1', name: 'shell' })
  let lines = r.log().filter((l) => l.at === 'calibrate')
  check('calibrate: learns from real prompt tokens (input + cache.read)', lines.at(-1)?.real === 12000 && Math.abs((lines.at(-1)?.cal ?? 0) - 1.2) < 0.01, JSON.stringify(lines.at(-1)))

  tk = { input: 402, output: 20, reasoning: 0, cache: { read: 9600, write: 0 } } // real 10 002 -> ratio 1.0
  await r.context(msgs)
  await r.emit('session.tool.success', { id: '2', name: 'shell' })
  lines = r.log().filter((l) => l.at === 'calibrate')
  check('calibrate: second sample is smoothed, not slotted in raw', Math.abs((lines.at(-1)?.cal ?? 0) - 1.1199) < 0.001, JSON.stringify(lines.at(-1)))

  tk = { input: 200, output: 20, reasoning: 0, cache: { read: 5800, write: 0 } } // ratio 0.6: sharp shift
  await r.context(msgs)
  const ctxLine = r.log().filter((l) => l.at === 'ctx').at(-1)
  check('calibrate: ratio decisions use the calibrated estimate', ctxLine?.cal === 1.1199 && ctxLine?.used === Math.round(ctxLine?.est * ctxLine?.cal), JSON.stringify(ctxLine))
  await r.emit('session.tool.success', { id: '3', name: 'shell' })
  lines = r.log().filter((l) => l.at === 'calibrate')
  check('calibrate: a sharp content shift moves the ratio faster', lines.at(-1)?.jump === true && Math.abs((lines.at(-1)?.cal ?? 0) - 0.7819) < 0.001, JSON.stringify(lines.at(-1)))
}

// ---------------------------------------------------------------- compaction threshold 85%
{
  const big = 'x'.repeat(250000) // estimate 69 444 -> calibrated 81 944 of 100 000 = 81.9%
  const r = await rig({ contextLimit: 100000 })
  await r.context([{ role: 'user', content: [{ type: 'text', text: big }] }])
  await sleep(30)
  check('threshold: 82% does not compact', r.calls.compact === 0)
  const warn = r.log().find((l) => l.at === 'warn' && l.key === 'compact')
  check('threshold: 82% is not even a compact warning', !warn, JSON.stringify(warn))

  const r2 = await rig({ contextLimit: 100000 })
  await r2.context([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(280000) }] }, // 91.8%
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'tool', content: [{ type: 'tool-result', name: 'shell', result: { type: 'text', value: 'ok' } }] },
    { role: 'user', content: [{ type: 'text', text: 'go on' }] },
  ])
  await sleep(40)
  check('threshold: 85% triggers compaction', r2.calls.compact === 1, `compact=${r2.calls.compact}`)
  const req = r2.log().find((l) => l.at === 'compact-request')
  check('threshold: compaction request is logged with calibrated usage', Boolean(req) && req.used > 90000, JSON.stringify(req))

  // a one-turn session has nothing to summarise; the runtime rejects that request and in 2.1.2
  // the rejection can kill the run, so the plugin must not even ask
  const r3 = await rig({ contextLimit: 100000 })
  let threw = null
  try {
    await r3.context([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(295000) }] }]) // 96.7%
  } catch (e) {
    threw = e
  }
  await sleep(30)
  check('threshold: no-history session skips compaction instead of failing the run', r3.calls.compact === 0 && !threw)
  check('threshold: the skip is visible in the log', Boolean(r3.log().find((l) => l.at === 'compact-skip')))

  // OpenCode keeps compaction.keep tokens (15 000 by default) verbatim; below that floor the
  // runtime answers "Nothing to compact yet". The plugin must not ask while used < 18k.
  const r4 = await rig({ contextLimit: 12000 })
  await r4.context([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40000) }] }, // 109% of 12k before the floor
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
  ])
  await sleep(30)
  const skip4 = r4.log().find((l) => l.at === 'compact-skip')
  check('threshold: below the runtime keep window compaction is skipped', r4.calls.compact === 0 && skip4?.why === 'below-keep-window', JSON.stringify(skip4))
}

// ---------------------------------------------------------------- wide-text estimator
{
  const r = await rig()
  // 36 000 Cyrillic chars: 18 000 tokens at ~2 chars/token, not 10 000 at chars/3.6
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'ж'.repeat(36000) }] }])
  const line = r.log().find((l) => l.at === 'ctx')
  check('estimate: wide text (Cyrillic) is not counted as ASCII', line && line.est > 17500 && line.est < 18500, `est=${line?.est}`)
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
  check('compaction: note forbids paraphrasing the request', /Do not paraphrase the user's requirements/i.test(msgs[count].content[0].text))

  // the transcript itself is the source of truth for files / tools / the last visible step
  const r2 = await rig()
  await r2.prompt('fix the crypto checker')
  const msgs2 = [
    { role: 'user', content: [{ type: 'text', text: 'fix the crypto checker' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'read', input: { filePath: 'C:/repo/src/crypto.ts' } },
        { type: 'tool-call', name: 'read', input: { filePath: 'C:/repo/src/verify.ts', offset: 10, limit: 20 } },
        { type: 'tool-call', name: 'shell', input: { command: 'npm test' } },
        { type: 'text', text: 'the handler drops the nonce, fixing it now' },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-result', name: 'read', result: { type: 'text', value: 'ok' } }] },
  ]
  await r2.compaction(msgs2)
  const note2 = msgs2.at(-1).content[0].text
  check('compaction: note carries files touched', note2.includes('src/crypto.ts'), note2.slice(0, 300))
  check('compaction: note carries the last visible step', note2.includes('drops the nonce'), note2.slice(0, 300))
  check('compaction: note carries the line range of a ranged read', note2.includes('src/verify.ts:10-29'), note2.slice(0, 300))
  check('compaction: note carries commands verbatim', note2.includes('npm test'), note2.slice(0, 300))
  check('compaction: note carries the user\'s own words as requirements', /user's own words/i.test(note2) && note2.includes('"fix the crypto checker"'), note2.slice(0, 300))
  check('compaction: note tells the summariser what must not be lost', /file path and line/i.test(note2) && /symbol\/function\/table name/i.test(note2))
}

{
  // one reworded requirement must not take three of the four slots in the note either
  const r = await rig()
  await r.prompt('audit the checker so that we never lose a token across the chains')
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'audit the checker so that we never lose a token across the chains' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: 'audit the checker so that we never lose a token across the chains, and print the diff for every chain' }],
    },
    { role: 'user', content: [{ type: 'text', text: 'and also compare the two runs against ankr' }] },
  ]
  await r.compaction(msgs)
  const note = msgs.at(-1).content[0].text
  const words = note.split("The user's own words")[1]?.split('.')[0] || ''
  check(
    'compaction: an extension does not duplicate a requirement in the note',
    (words.match(/audit the checker/g) || []).length === 1,
    words.slice(0, 200),
  )
  check('compaction: the note keeps the longest version of a reworded requirement', words.includes('print the diff'))
  check('compaction: a genuinely new requirement survives the dedupe', words.includes('compare the two runs against ankr'))
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
  check('anchor: repeats on the next request, then stops', system2.length === 1)
  const system3 = []
  await r.context([], system3)
  check('anchor: gone after the repeat', system3.length === 0)
}

// ---------------------------------------------------------------- goal survives a nudge
{
  const r = await rig()
  await r.prompt('build the geophoto report for wallet 7xKq and verify every claim before writing')
  await r.prompt('продолжай')
  await r.emit('session.compaction.ended')
  const sys = []
  await r.context([], sys)
  const t = sys[0]?.text || ''
  check('anchor: quotes the original task after a "продолжай"', t.includes('build the geophoto report'))
  check('anchor: calls the nudge a nudge, not the task', /last instruction was only "продолжай"/.test(t))
}
{
  const r = await rig()
  await r.prompt('first task: collect every address from the log file')
  await r.prompt('second task: now write the report in russian with sources')
  await r.emit('session.compaction.ended')
  const sys = []
  await r.context([], sys)
  check('anchor: a genuinely new task replaces the old goal', (sys[0]?.text || '').includes('second task'))
}

// ---------------------------------------------------------------- goal file + auto-continue
{
  const r = await rig()
  await r.prompt('write the long report about solana wallets and verify each claim')
  const p = path.join(r.root, '.omo', 'goal.md')
  const g = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  check('goal file: the task is written to .omo/goal.md', g.includes('write the long report about solana'))
  await r.prompt('продолжай')
  const g2 = fs.readFileSync(p, 'utf8')
  check('goal file: a nudge does not replace the goal', g2.includes('write the long report about solana') && /продолжай/.test(g2))
  await r.prompt('only check wallets above 1000 usd and cite the source for every claim')
  const g3 = fs.readFileSync(p, 'utf8')
  check(
    'goal file: requirements keep every ask verbatim',
    g3.includes('write the long report about solana') && g3.includes('only check wallets above 1000'),
    g3.split('\n').slice(0, 8).join(' / '),
  )
}

// ------------------------------------------------------- one goal, additions marked as additions
{
  const r = await rig()
  await r.prompt('audit the checker so that we never lose a token across the chains')
  const p = path.join(r.root, '.omo', 'goal.md')
  await r.prompt(
    'и да, у меня поиск запущен просто чтобы ты знал, что ошибки по прокси могут быть, проверь что всё гуд',
  )
  const g = fs.readFileSync(p, 'utf8')
  check(
    'additions: an informational message does not replace the goal',
    /# Goal\n\naudit the checker so that we never lose a token/.test(g),
    g.split('\n').slice(0, 3).join(' / '),
  )
  check(
    'additions: the message lands in its own section, not in requirements',
    /## Additions \(context to take into account, NOT tasks\)\n\n1\. и да, у меня поиск запущен/.test(g) &&
      !/## Requirements[\s\S]*?и да, у меня поиск запущен[\s\S]*?## Additions/.test(g),
  )
  await r.emit('session.compaction.ended', {}, 1700)
  const sys = []
  await r.context([], sys)
  const a = sys[0]?.text || ''
  check('additions: the anchor still quotes the real task', a.includes('audit the checker so that we never lose a token'), a.slice(0, 120))
  check('additions: the anchor carries the addition as context, not as the task', /NOT tasks[\s\S]*поиск запущен/.test(a))
}

{
  // the classifier must not swallow real work: "у меня запущен X, почини" is a task, not a status
  const r = await rig()
  await r.prompt('build the report generator for the token checker')
  await r.prompt('у меня запущен старый чекер и он падает на BNB - почини эту ошибку в chck3.py')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  check(
    'additions: a state report that also asks for work stays the goal',
    /# Goal\n\nу меня запущен старый чекер/.test(g) && !/## Additions[\s\S]*почини эту ошибку/.test(g),
    g.split('\n').slice(0, 3).join(' / '),
  )
}

{
  // and an addition must not come back as a "requirement" in the compaction note
  const r = await rig()
  const TASK = 'audit the checker so that we never lose a token across the chains'
  const ADD = 'и да, у меня поиск запущен просто чтобы ты знал, что ошибки по прокси могут быть'
  await r.prompt(TASK)
  await r.prompt(ADD)
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: TASK }] },
    { role: 'user', content: [{ type: 'text', text: ADD }] },
  ]
  await r.compaction(msgs)
  const note = msgs.at(-1).content[0].text
  const asks = note.split("The user's own words")[1]?.split('Work done so far')[0] || ''
  check('additions: the note does not restate the addition as a requirement', !asks.includes('поиск запущен') && asks.includes('never lose a token'), asks.trim().slice(0, 200))
  check('additions: the note still carries the addition as context', /NOT tasks[\s\S]*поиск запущен/.test(note), note.slice(0, 200))
}

{
  // a rewritten requirement replaces the old one instead of eating another slot
  const r = await rig()
  await r.prompt('check the other addresses and the test seeds to be sure tokens are not lost')
  await r.prompt(
    'check the other addresses and the test seeds to be sure tokens are not lost, and also the exchange wallets',
  )
  await r.prompt(
    'check the other addresses and the test seeds to be sure tokens are not lost, and also the exchange wallets, print the full diff',
  )
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const asks = (g.split('## Requirements')[1] || '').split('## Additions')[0]
  check('dedupe: an extension does not consume another requirement slot', (asks.match(/^\d+\. /gm) || []).length === 1, asks.trim().slice(0, 200))
  check('dedupe: the longest version of the requirement wins', asks.includes('print the full diff'))
  await r.prompt('now also compare the two runs against ankr and report the lost contracts')
  const g2 = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const asks2 = (g2.split('## Requirements')[1] || '').split('## Additions')[0]
  check('dedupe: a genuinely new requirement is appended', (asks2.match(/^\d+\. /gm) || []).length === 2, asks2.trim().slice(0, 300))
  check('dedupe: the rewritten goal is the current one', /# Goal\n\nnow also compare the two runs/.test(g2))
}

{
  // a short ask quoted inside a much longer, different ask must not be merged away
  const r = await rig()
  await r.prompt('fix the parser bug in src/a.ts')
  await r.prompt(
    'now write a full report for the client about how we fixed the parser bug in src/a.ts, with a timeline of every step and the cost of each one',
  )
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const asks = (g.split('## Requirements')[1] || '').split('## Additions')[0]
  check('dedupe: a different ask that merely mentions the old one is not merged into it', (asks.match(/^\d+\. /gm) || []).length === 2, asks.trim().slice(0, 300))
}

{
  // an addition with no goal yet is still worth keeping: it is the only intent on record
  const r = await rig()
  await r.prompt('у меня поиск запущен просто чтобы ты знал, проверь пожалуйста что всё гуд по прокси')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  check('additions: with no task on record it still becomes the goal', /# Goal\n\nу меня поиск запущен/.test(g), g.split('\n').slice(0, 3).join(' / '))
}

{
  // context the user asked to keep in mind must not be dropped silently after a few messages
  const r = await rig()
  await r.prompt('audit the checker so that we never lose a token across the chains')
  for (let i = 1; i <= 6; i++) {
    await r.prompt(`добавка номер ${i}: для информации, просто чтобы ты знал про деталь ${i}`)
  }
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const sec = (g.split('## Additions')[1] || '').split('## Last instruction')[0]
  const kept = [...sec.matchAll(/добавка номер (\d+)/g)].map((m) => Number(m[1]))
  check(
    'additions: six additions are all kept, the oldest is not evicted',
    kept.length === 6 && kept.includes(1),
    JSON.stringify(kept),
  )
}

{
  // an addition that arrived before any task was filed as the goal - once real work exists it
  // belongs in the additions, not in the requirement list posing as the task
  const r = await rig()
  await r.prompt('у меня поиск запущен просто чтобы ты знал, что ошибки по прокси могут быть')
  await r.prompt('audit the checker so that we never lose a token across the chains')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const reqs = (g.split('## Requirements')[1] || '').split('## Additions')[0]
  check(
    'additions: a pre-task addition is promoted out of the goal',
    /# Goal\n\naudit the checker so that we never lose a token/.test(g) && /## Additions[\s\S]*поиск запущен/.test(g),
    g.split('\n').slice(0, 3).join(' / '),
  )
  check('additions: the promoted addition does not stay in requirements', !reqs.includes('поиск запущен'), reqs.trim().slice(0, 200))
  const promoted = r.log().filter((x) => x.at === 'goal-addition' && x.reason === 'promoted-from-goal')
  check('additions: the promotion is logged', promoted.length === 1, JSON.stringify(promoted))
}

{
  // the newest addition is also the message that set lastInstruction: writing it twice, once under
  // a heading called "Last instruction", makes context read like a command
  const r = await rig()
  const ADD = 'и да, у мя ща самого поиск запущен. просто чтобы ты знал, что мб ошибки будут хз по прокси'
  await r.prompt('audit the checker so that we never lose a token across the chains')
  await r.prompt(ADD)
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const last = (g.split('## Last instruction')[1] || '').split('---')[0]
  check('additions: the newest addition is not repeated as a last instruction', !last.includes('поиск запущен'), last.trim().slice(0, 200))
  check('additions: the file says plainly that it is context, not an instruction', /not an instruction/.test(last), last.trim().slice(0, 200))
  await r.emit('session.compaction.ended', {}, 1700)
  const sys = []
  await r.context([], sys)
  const a = sys[0]?.text || ''
  const hits = (a.match(/поиск запущен/g) || []).length
  check('additions: the anchor quotes it once, not twice', hits === 1, `hits=${hits}`)
}

{
  // a message the user reverted and rewrote before any answer is one intent, not two: the rewrite
  // replaces the entry the first version produced. The reverted message is gone from the transcript.
  const reverted = {
    context: async () => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }),
  }
  const r = await rig({}, undefined, reverted)
  await r.prompt('audit the checker so that we never lose a token across the chains')
  await r.prompt('к сведению: мой прогон идёт параллельно, так что прокси могут тупить')
  await r.prompt('к сведению: мой прогон идёт параллельно, поэтому часть прокси будет тупить и отваливаться')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const adds = (g.split('## Additions')[1] || '').split('## Last instruction')[0]
  check('revision: an edited addition replaces the old one', (adds.match(/^\d+\. /gm) || []).length === 1, adds.trim().slice(0, 300))
  check('revision: the newest wording wins', adds.includes('часть прокси будет тупить'), adds.trim().slice(0, 300))
  check('revision: the edit is logged', r.log().some((x) => x.at === 'goal-revision' && x.kind === 'addition'))
}

{
  // a second message is an addition, not an edit: the first one is still in the transcript
  const A1 = 'к сведению: мой прогон идёт параллельно, так что прокси могут тупить'
  const answered = {
    context: async () => ({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'audit the checker so that we never lose a token' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        { role: 'user', content: [{ type: 'text', text: A1 }] },
        { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      ],
    }),
  }
  const r = await rig({}, undefined, answered)
  await r.prompt('audit the checker so that we never lose a token across the chains')
  await r.prompt(A1)
  await r.prompt('к сведению: мой прогон идёт параллельно, поэтому часть прокси будет тупить и отваливаться')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const adds = (g.split('## Additions')[1] || '').split('## Last instruction')[0]
  check('revision: a message still in history is not treated as an edit', (adds.match(/^\d+\. /gm) || []).length === 2, adds.trim().slice(0, 300))
}

{
  // the same rule for the task itself
  const reverted = {
    context: async () => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }),
  }
  const r = await rig({}, undefined, reverted)
  await r.prompt('проверь на других адресах что мы НЕ ТЕРЯЕМ токены')
  await r.prompt('проверь на других адресах, биржевые кошельки и тестовые сидки, что мы НЕ ТЕРЯЕМ токены')
  const g = fs.readFileSync(path.join(r.root, '.omo', 'goal.md'), 'utf8')
  const reqs = (g.split('## Requirements')[1] || '').split('## Additions')[0]
  check('revision: an edited task replaces the old one', (reqs.match(/^\d+\. /gm) || []).length === 1, reqs.trim().slice(0, 300))
  check('revision: the goal is the newest wording', /# Goal\n\nпроверь на других адресах, биржевые кошельки/.test(g))
}

{
  const r = await rig()
  await r.prompt('build the geophoto report')
  await r.emit('session.compaction.ended', {}, 1700)
  check('auto-continue: one prompt after compaction', r.calls.prompt.length === 1, `prompts=${r.calls.prompt.length}`)
  check('auto-continue: the prompt points at goal.md', String(r.calls.prompt[0] || '').includes('.omo/goal.md'))
  await r.emit('session.compaction.ended', {}, 1700)
  check('auto-continue: respects the 60 s cooldown', r.calls.prompt.length === 1)
}

// ---------------------------------------------------------------- compaction fails -> emergency
{
  const r = await rig()
  await r.prompt('fix the crypto checker and verify every claim')
  await r.emit('session.compaction.failed')
  await r.emit('session.compaction.failed')
  const backoff = r.log().filter((x) => x.at === 'compact-backoff').pop()
  check('compaction: a failure raises the backoff', backoff?.fails === 2 && backoff?.nextTryMs === 720000, JSON.stringify(backoff))
  check('compaction: emergency mode turns on after two failures', backoff?.emergency === true)

  const msgs = manyChatter()
  const system = []
  await r.context(msgs, system)
  await sleep(30)
  console.log('DBG len=' + msgs.length + ' m1=' + String(msgs[1]?.content?.[0]?.text || '').length + ' lastRole=' + msgs[msgs.length-1]?.role + ' lastTxt=' + String(msgs[msgs.length-1]?.content?.[0]?.text || '').slice(0,30))
  check('compaction: no new request while the backoff holds', r.calls.compact === 0, `compact=${r.calls.compact}`)
  const oldest = msgs.slice(0, 90).filter((m) => m.role === 'assistant')
  const longest = Math.max(...oldest.map((m) => String(m.content?.[0]?.text || '').length))
  check('emergency: old assistant text cut to a stub', longest < 1500, `longest=${longest} ` + JSON.stringify(r.log().filter((x) => x.at === 'emergency-trim').pop()))
  check('emergency: handoff note carries the task', String(msgs[msgs.length - 1]?.content?.[0]?.text || '').includes('fix the crypto checker'))
  check('emergency: logged', r.log().some((x) => x.at === 'emergency-trim'))

  await r.emit('session.compaction.ended')
  const msgs2 = manyChatter()
  await r.context(msgs2, [])
  const trims = r.log().filter((x) => x.at === 'emergency-trim').length
  check('emergency: off again after a successful compaction', trims === 1, `trims=${trims}`)
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
  // HTTP 200, no status, body just stops: this is the free gateway cutting a long reasoning stream
  const etrunc = await r.retry({ type: 'provider.invalid-output', message: 'OpenAI Chat stream ended without finish_reason' })
  check('retry truncated stream: retried as transport', etrunc.decision?.retry === true, `delay=${etrunc.decision?.delay}`)
  const eframe = await r.retry({ type: 'provider.invalid-output', message: 'Invalid flash1047/openai-compatible-chat stream event' })
  check('retry cut stream frame: retried as transport', eframe.decision?.retry === true)
  const rtr = await rig()
  await rtr.retry({ type: 'provider.invalid-output', message: 'OpenAI Chat stream ended without finish_reason' })
  await rtr.retry({ type: 'provider.invalid-output', message: 'OpenAI Chat stream ended without finish_reason' })
  const tf = rtr.log().filter((l) => l.at === 'transport-fail')
  check('retry truncated stream: the second failure arms the forced prune', tf.length === 2 && tf[1].count === 2, JSON.stringify(tf.map((l) => l.count)))
  check('failover: switchModel was never called', r.calls.switchModel === 0)

  const r2 = await rig()
  let last
  for (let i = 0; i < 6; i++) {
    last = await r2.retry({ status: 200, type: 'provider.transport', message: 'ECONNRESET' }, i + 1)
  }
  check('retry transport: the sixth failure still retries', last.decision?.retry === true, `delay=${last.decision?.delay}`)
  last = await r2.retry({ status: 200, type: 'provider.transport', message: 'ECONNRESET' }, 7)
  check('retry transport: gives up on the seventh instead of hanging', last.decision === undefined)
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

// ---------------------------------------------------------------- compaction safety
{
  // the floor must follow compaction.keep.tokens, not a hardcoded 18k
  const r = await rig({ contextLimit: 100000, keep: 95000 })
  await r.context([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(280000) }] }, // 91.8%
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'tool', content: [{ type: 'tool-result', name: 'shell', result: { type: 'text', value: 'ok' } }] },
  ])
  await sleep(30)
  const skipKeep = r.log().find((l) => l.at === 'compact-skip')
  check('threshold: keep option raises the compaction floor', r.calls.compact === 0 && skipKeep?.floor === 98000, JSON.stringify(skipKeep))
}

{
  // regression: 2.1.2 answers "Nothing to compact yet" when keep swallows the history. The old
  // code reset the cooldown, so the next request retried and the session compacted every turn.
  let attempts = 0
  const r = await rig({ contextLimit: 100000 }, undefined, {
    compact: async () => {
      attempts += 1
      throw new Error('Nothing to compact yet')
    },
  })
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(280000) }] }, // 91.8%
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'tool', content: [{ type: 'tool-result', name: 'shell', result: { type: 'text', value: 'ok' } }] },
  ]
  await r.context(msgs)
  await sleep(50)
  await r.context(msgs)
  await sleep(50)
  check('compaction: a "nothing to compact" rejection does not hot-loop', attempts === 1, `attempts=${attempts}`)
  const errs = r.log().filter((l) => l.at === 'compact-error')
  check('compaction: the rejection is logged with the keep value and a backoff', errs.length === 1 && errs[0]?.empty === 1 && errs[0]?.keep === 15000, JSON.stringify(errs))
}

{
  // if the runtime never emits compaction.ended the flag must time out instead of disabling compaction forever
  const r = await rig({ contextLimit: 100000, keep: 1000, compactingTtlMs: 25 })
  await r.emit('session.compaction.started')
  await sleep(45)
  await r.context([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(280000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'tool', content: [{ type: 'tool-result', name: 'shell', result: { type: 'text', value: 'ok' } }] },
  ])
  await sleep(30)
  check('compaction: a lost compaction event cannot wedge the flag', Boolean(r.log().find((l) => l.at === 'compacting-watchdog')))
}

// ---------------------------------------------------------------- calibration after pruning
{
  // mirrors the plugin's estimator: ASCII at 3.6 chars/token, wide text at 2.0, `metadata` skipped
  const est = (v) => {
    let t = 0
    const walk = (x) => {
      if (!x) return
      if (typeof x === 'string') {
        for (let i = 0; i < x.length; i++) t += x.charCodeAt(i) < 128 ? 1 / 3.6 : 1 / 2.0
        return
      }
      if (Array.isArray(x)) return x.forEach(walk)
      if (typeof x === 'object') for (const k of Object.keys(x)) if (k !== 'metadata') walk(x[k])
    }
    walk(v)
    return Math.round(t)
  }
  let tk = null
  const r = await rig({ contextLimit: 100000 }, undefined, {
    context: async () => ({
      messages: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], tokens: tk },
      ],
    }),
  })
  const msgs = manyTools(30, 12000) // ~100k raw estimate: far above pruneSoft
  const sys = []
  await r.context(msgs, sys)
  const pruneLine = r.log().find((l) => l.at === 'prune')
  check('calibrate+prune: the scenario really pruned the request', Boolean(pruneLine), JSON.stringify(pruneLine))
  const sent = est(msgs) + est(sys) // what actually left the plugin, after pruning
  tk = { input: 500, output: 20, reasoning: 0, cache: { read: Math.round(sent * 1.2) - 500, write: 0 } }
  await r.emit('session.tool.success', { id: '1', name: 'shell' })
  const cal = r.log().filter((l) => l.at === 'calibrate').at(-1)
  // regression: prevEst used to be taken BEFORE pruning, so real/prevEst came out ~0.4 here
  check('calibrate+prune: ratio is learned against the pruned request, not the pre-prune estimate', Boolean(cal) && Math.abs(cal.cal - 1.2) < 0.02, JSON.stringify(cal))
}

{
  // parallel tool calls all read the same last assistant message: one real sample, one update
  const tk = { input: 400, output: 20, reasoning: 0, cache: { read: 11600, write: 0 } }
  const r = await rig({}, undefined, {
    context: async () => ({
      messages: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], tokens: tk },
      ],
    }),
  })
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(36000) }] }])
  await r.emit('session.tool.success', { id: '1', name: 'shell' })
  await r.emit('session.tool.success', { id: '2', name: 'shell' })
  await r.emit('session.tool.success', { id: '3', name: 'shell' })
  const n = r.log().filter((l) => l.at === 'calibrate').length
  check('calibrate: the same real sample is counted once, not once per tool event', n === 1, `updates=${n}`)
}

// ---------------------------------------------------------------- context-pressure note
{
  // 229 000 chars -> ~63.6k estimate * 1.18 = ~75% of 100k: between warn (70%) and compact (85%)
  const mk = () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(229000) }] }]
  const r = await rig({ contextLimit: 100000 })
  const a = mk()
  const sysA = []
  await r.context(a, sysA)
  const b = mk()
  const sysB = []
  await r.context(b, sysB)
  check('warn: note is appended as a fresh user message after the history', a.length === 2 && a[1].role === 'user' && /\[omni-resilience\]/.test(a[1].content?.[0]?.text || ''))
  check('warn: the system prompt is left alone (prefix cache survives)', sysA.length === 0 && sysB.length === 0)
  check('warn: the note is on every request while the level holds, not just the first', b.length === 2 && /\[omni-resilience\]/.test(b[1].content?.[0]?.text || ''))
  check('warn: existing messages stay byte-identical', JSON.stringify(a[0]) === JSON.stringify(mk()[0]))
  check('warn: the note says it is automatic and not from the user', /not from the user/i.test(a[1].content?.[0]?.text || ''))
  check('warn: the level is logged once, not per request', r.log().filter((l) => l.at === 'warn').length === 1)

  const rs = await rig({ contextLimit: 100000, warnMode: 'system' })
  const c = mk()
  const sysC = []
  await rs.context(c, sysC)
  check('warn: warnMode=system keeps the old placement in the system prompt', sysC.length === 1 && c.length === 1)
}

{
  // the tail note must not make a one-turn session look like it has history to compact
  const r = await rig({ contextLimit: 100000 })
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(295000) }] }]) // ~96%: hard level
  await sleep(30)
  const skip = r.log().find((l) => l.at === 'compact-skip')
  check('warn: the tail note does not count as conversation history for compaction', r.calls.compact === 0 && skip?.why === 'no-history' && skip?.msgs === 1, JSON.stringify(skip))
}

// ---------------------------------------------------------------- wrong model id
{
  const r = await rig()
  await r.prompt('TASK: x')
  const e = await r.retry({ status: 400, type: 'provider.invalid-request', message: 'Model is unavailable' })
  check('retry: 400 "Model is unavailable" (wrong model id) is not retried', e.decision === undefined)
  check('retry: the config error is logged as fatal', Boolean(r.log().find((l) => l.at === 'retry-fatal')))
  await r.emit('session.idle', {}, 2400)
  check('resume: not fired after a wrong-model-id failure', r.calls.prompt.length === 0)
  const e503 = await r.retry({ status: 503, type: 'provider.internal', message: 'Model is unavailable, upstream overloaded' })
  check('retry: a 5xx that mentions the model is still treated as an outage', e503.decision?.retry === true)
}

// ---------------------------------------------------------------- log shape
{
  const r = await rig()
  const lines = r.log()
  const setup = lines.find((l) => l.at === 'setup')
  check('log: setup records the guarded entry', setup?.guarded === 'flash1047/deepseek-v4.1-flash-free')
  check('log: setup records that model switching is disabled', setup?.modelSwitching === 'disabled')
  check('log: setup stamps the plugin version', /^\d+\.\d+\.\d+$/.test(setup?.plugin || ''), `plugin=${setup?.plugin}`)
}

// ---------------------------------------------------------------- note hygiene (v1.3.1)
{
  // the runtime may keep the outgoing array and hand it back: the note must not stack up
  const r = await rig({ contextLimit: 100000 })
  const history = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(229000) }] }]
  await r.context(history)
  const afterFirst = history.length
  await r.context(history)
  const notes = history.filter((m) => /Automatic note, not from the user/.test(m?.content?.[0]?.text || '')).length
  check('warn: a persisted note does not stack up', afterFirst === 2 && history.length === 2 && notes === 1, `len=${history.length} notes=${notes}`)
  check('warn: the strip is visible in the log', Boolean(r.log().find((l) => l.at === 'note-strip')))
}

{
  // a note left by an earlier run (or an earlier build) is cleared even when no new level is hit
  const r = await rig({ contextLimit: 100000 })
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: '[omni-resilience] Automatic note, not from the user. Context 80% full. stale' }] },
  ]
  await r.context(msgs)
  check('warn: a stale note from an earlier request is removed', msgs.length === 1, `len=${msgs.length}`)
}

{
  // system mode used to push a copy on every request
  const r = await rig({ contextLimit: 100000, warnMode: 'system' })
  const sys = []
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(229000) }] }]
  await r.context(msgs, sys)
  await r.context(msgs, sys)
  check('warn: system mode does not duplicate the note in the system prompt', sys.length === 1, `len=${sys.length}`)
}

{
  // the level log has to re-arm, or only the first climb is ever recorded
  const r = await rig({ contextLimit: 100000 })
  const full = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(229000) }] }]
  await r.context(full)
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'short' }] }])
  await r.context(full)
  const warns = r.log().filter((l) => l.at === 'warn' && l.key === 'warn').length
  check('warn: the level re-arms after the context drops', warns === 2, `warns=${warns}`)
}

{
  // identical numbers on a new assistant message are a real second sample, not a duplicate
  const tk = { input: 400, output: 20, reasoning: 0, cache: { read: 11600, write: 0 } }
  let msgs = [
    { role: 'user', content: 'do the task' },
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'done' }], tokens: tk },
  ]
  const r = await rig({}, undefined, { context: async () => ({ messages: msgs }) })
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(36000) }] }])
  await r.emit('session.tool.success', { id: '1', name: 'shell' })
  msgs = [
    ...msgs,
    { role: 'user', content: 'again' },
    { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'done' }], tokens: tk },
  ]
  await r.context([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(36000) }] }])
  await r.emit('session.tool.success', { id: '2', name: 'shell' })
  const n = r.log().filter((l) => l.at === 'calibrate').length
  check('calibrate: an identical sample on a new message is still counted', n === 2, `updates=${n}`)
}

// ---------------------------------------------------------------- double load (v1.3.3)
{
  // the runtime can load the same plugin twice in one process: plugins/ directory scan plus the
  // `plugins` config entry that carries the options. Hooks are not de-duplicated by the runtime.
  const r = await rig()
  const before = r.hooks.context.length
  const hooks2 = {}
  const ctx2 = {
    location: { directory: r.root },
    options: { onlyProviderID: 'flash1047', onlyModelID: 'deepseek-v4.1-flash-free' },
    session: {
      hook: (name, fn) => {
        (hooks2[name] ||= []).push(fn)
      },
      get: async () => ({ status: { type: 'idle' }, outcome: 'failed', model: { providerID: 'flash1047', id: 'deepseek-v4.1-flash-free' } }),
      context: async () => ({ messages: [] }),
      prompt: async () => {},
      compact: async () => {},
      switchModel: async () => {},
    },
    event: { subscribe: async function* () {} },
  }
  await plugin.setup(ctx2)
  await sleep(5)
  check(
    'setup: a second load for the same root does not register hooks twice',
    (hooks2.context || []).length === 0 && r.hooks.context.length === before,
    `first=${before} second=${(hooks2.context || []).length}`,
  )
  check('setup: the duplicate load is logged', Boolean(r.log().find((l) => l.at === 'setup-duplicate')))

  // A later load may belong to a different session and must still register its own hooks.
  const reg = globalThis.__omniResilience.byRoot.get(`${r.root}::omni-resilience`)
  reg.hooksAt = Date.now() - 60000
  const hooks3 = {}
  ctx2.session.hook = (name, fn) => {
    (hooks3[name] ||= []).push(fn)
  }
  await plugin.setup(ctx2)
  await sleep(5)
  check('setup: a later load for the same root still registers hooks', (hooks3.context || []).length === 1, `later=${(hooks3.context || []).length}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
