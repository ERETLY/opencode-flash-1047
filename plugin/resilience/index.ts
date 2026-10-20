import fs from 'node:fs'
import path from 'node:path'

const CHARS_PER_TOKEN = 3.6
const PLUGIN_ID = 'omni-resilience'

const DEFAULTS = {
  contextLimit: 310000,
  warn: 0.7,
  compact: 0.85,
  hard: 0.93,
  every: 20,
  cooldownMs: 180000,
  stallMs: 900000,
  maxResumes: 4,
  resumeCooldownMs: 120000,
  keepRecent: 12,
  pruneSoft: 0.55,
  protocol: true,
}

// Injected once per session (only for the guarded model). Mirrors instructions/long-session.md.
const PROTOCOL = `[omni-resilience] Long-session protocol for this model.
State on disk: keep .omo/state.md as working memory (goal, confirmed findings, decisions, TODOs, next step). Update it after every meaningful finding/decision, rewrite when >80 lines. After a compaction or resumed turn, read .omo/state.md and the newest .omo/checkpoints/ file first. Never restart a task from scratch. Put extracted facts in .omo/notes/<topic>.md instead of only in chat.
Large files/logs: anything over ~50 KB or ~1000 lines is never read whole more than once - locate with grep/ripgrep, then read targeted ranges (offset/limit). Raw bulk output (dumps, scans, JSON, HTML, long logs) goes to disk and is processed by script; only the summary or matching lines enter context. Do not paste big tool output back into the conversation - cite path + line range. Re-read only changed ranges. Batch independent shell commands into one call; never repeat a tool call that already succeeded.
Context pressure: above ~70% stop exploratory reads and summarise into .omo/state.md; above ~85% finish the current step, write state, let compaction run, do not start a new sub-task. Prefer subagents for wide fan-out (many hosts/files) with narrow self-contained instructions.
Quality: verify against files or fresh tool output, never invent paths/results/output. On tool failure read the error, adjust, retry once; after two failures change method and record why.`

// setup() runs once per location; several instances may load for the same root,
// so state, the event subscription and the stall timer are shared per root.
const GLOBAL: any = globalThis as any
GLOBAL.__omniResilience ||= { byRoot: new Map<string, any>() }

const estimate = (v: any): number => {
  let chars = 0
  const walk = (x: any) => {
    if (!x) return
    if (typeof x === 'string') {
      chars += x.length
      return
    }
    if (Array.isArray(x)) {
      for (const i of x) walk(i)
      return
    }
    if (typeof x === 'object') {
      for (const k of Object.keys(x)) {
        if (k === 'metadata') continue
        walk(x[k])
      }
    }
  }
  walk(v)
  return Math.round(chars / CHARS_PER_TOKEN)
}

const headTail = (s: string, head: number, tail: number) => {
  if (s.length <= head + tail + 400) return s
  const cut = s.length - head - tail
  return (
    s.slice(0, head) +
    `\n\n[omni-resilience] ${cut} chars elided from the middle of this tool output to protect the context window. ` +
    `The full output is on disk. Re-run the tool with grep/offset/limit if you need the missing part.\n\n` +
    s.slice(-tail)
  )
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    const root = ctx.location?.directory || process.cwd()
    const opts = ctx.options ?? {}
    const CFG = {
      limit: Number(opts.contextLimit ?? DEFAULTS.contextLimit),
      warn: Number(opts.warn ?? DEFAULTS.warn),
      compact: Number(opts.compact ?? DEFAULTS.compact),
      hard: Number(opts.hard ?? DEFAULTS.hard),
      every: Number(opts.every ?? DEFAULTS.every),
      cooldownMs: Number(opts.cooldownMs ?? DEFAULTS.cooldownMs),
      stallMs: Number(opts.stallMs ?? DEFAULTS.stallMs),
      maxResumes: Number(opts.maxResumes ?? DEFAULTS.maxResumes),
      resumeCooldownMs: Number(opts.resumeCooldownMs ?? DEFAULTS.resumeCooldownMs),
      keepRecent: Number(opts.keepRecent ?? DEFAULTS.keepRecent),
      pruneSoft: Number(opts.pruneSoft ?? DEFAULTS.pruneSoft),
      protocol: opts.protocol === undefined ? DEFAULTS.protocol : Boolean(opts.protocol),
    }

    // empty = plugin active for every model; set them to guard a single model/provider
    const ONLY = String(opts.onlyModelID ?? '').trim()
    const ONLY_P = String(opts.onlyProviderID ?? '').trim()
    const ours = (s: any) => (!ONLY || s?.modelID === ONLY) && (!ONLY_P || s?.providerID === ONLY_P)

    const reg: Map<string, any> = GLOBAL.__omniResilience.byRoot
    const regKey = `${root}::${PLUGIN_ID}`
    if (!reg.has(regKey)) reg.set(regKey, { states: new Map<string, any>(), timerStarted: false, subscribed: false })
    const shared = reg.get(regKey)
    const state: Map<string, any> = shared.states

    const logs = path.join(root, '.omo', 'logs')
    const ckptDir = path.join(root, '.omo', 'checkpoints')
    const log = (o: any) => {
      try {
        fs.mkdirSync(logs, { recursive: true })
        fs.appendFileSync(path.join(logs, 'resilience.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')
      } catch {}
    }

    const get = (id: string) => {
      if (!state.has(id)) {
        state.set(id, {
          marks: {},
          toolCount: 0,
          lastTool: 'none',
          lastPrompt: '',
          lastCompactAt: 0,
          compacting: false,
          estimatedTokens: 0,
          contextLimit: CFG.limit,
          pending: new Set<string>(),
          lastEventAt: Date.now(),
          lastErrorAt: 0,
          lastError: '',
          resumes: 0,
          lastResumeAt: 0,
          busy: false,
          stalled: false,
          inflight: false,
          transportFails: 0,
          forcePrune: false,
          prunedChars: 0,
          modelLookup: 0,
        })
      }
      return state.get(id)
    }

    // resolve the session model when an event arrives before the first context hook
    const ensureModel = async (sessionID: string, s: any) => {
      if (!ONLY && !ONLY_P) return
      if (s.modelID && (!ONLY_P || s.providerID)) return
      if (s.modelLookup >= 3) return
      s.modelLookup += 1
      try {
        const info: any = await ctx.session.get({ sessionID })
        const m = info?.model ?? info?.data?.model
        if (m?.id) {
          s.modelID = m.id
          s.providerID = m.providerID
        }
      } catch {}
    }

    const writeCheckpoint = async (sessionID: string, reason: string) => {
      const s = get(sessionID)
      if (!ours(s)) return
      try {
        {
          try {
            const res: any = await ctx.session.context({ sessionID })
            const msgs = res?.messages ?? res?.data ?? res
            if (Array.isArray(msgs)) {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const parts = msgs[i]?.content || msgs[i]?.parts || []
                let found = ''
                for (let k = parts.length - 1; k >= 0; k--) {
                  const p = parts[k]
                  if (p?.type === 'tool' && (p.name || p.toolName)) {
                    found = p.name || p.toolName
                    break
                  }
                  if (p?.type === 'tool-call' && (p.toolName || p.name)) {
                    found = p.toolName || p.name
                    break
                  }
                }
                if (found) {
                  s.lastTool = found
                  break
                }
              }
            }
          } catch {}
        }
        fs.mkdirSync(ckptDir, { recursive: true })
        const payload = {
          sessionID,
          modelID: s.modelID || 'unknown',
          providerID: s.providerID || 'unknown',
          toolCallCount: s.toolCount,
          lastToolName: s.lastTool,
          lastUserPrompt: String(s.lastPrompt || '').slice(0, 4000),
          estimatedTokens: s.estimatedTokens,
          contextLimit: s.contextLimit,
          prunedChars: s.prunedChars,
          resumes: s.resumes,
          reason,
          timestamp: new Date().toISOString(),
        }
        fs.writeFileSync(path.join(ckptDir, `${sessionID}.json`), JSON.stringify(payload, null, 2))
        log({ at: 'checkpoint', sessionID, reason, toolCount: s.toolCount, tokens: s.estimatedTokens })
      } catch (e: any) {
        log({ at: 'checkpoint-error', sessionID, error: String(e?.message || e) })
      }
    }

    // actual runtime state according to the server, not our event bookkeeping
    const sessionState = async (sessionID: string) => {
      try {
        const info: any = await ctx.session.get({ sessionID })
        const raw = info?.status?.type ?? info?.status ?? info?.data?.status?.type ?? info?.data?.status
        const status = typeof raw === 'string' ? raw : ''
        const outcome = String(info?.outcome ?? info?.data?.outcome ?? '')
        const running = status ? /running|busy|retry|streaming/i.test(status) : !/succeeded|failed|interrupted/i.test(outcome)
        return { running, status, outcome }
      } catch {
        return { running: false, status: '', outcome: '' }
      }
    }

    // true only when the last user turn never reached an idle/completed state
    const needsContinuation = async (sessionID: string) => {
      try {
        const res: any = await ctx.session.context({ sessionID })
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs) || !msgs.length) return false
        const last = msgs[msgs.length - 1]
        const t = String(last?.type || last?.role || '')
        // 'idle' means the platform closed the turn (succeeded, failed or interrupted on purpose)
        if (t === 'idle') return false
        if (t === 'user' || t === 'tool') return true
        if (t === 'assistant') {
          const parts = Array.isArray(last.content) ? last.content : []
          const hasTool = parts.some((p: any) => p && (p.type === 'tool-call' || p.type === 'tool' || p.type === 'tool-invocation'))
          const hasText = parts.some((p: any) => p && p.type === 'text' && String(p.text || '').trim().length > 0)
          // unfinished tool call, or an assistant message that produced nothing at all
          return hasTool || !hasText
        }
        return false
      } catch {
        return false
      }
    }

    // did the model already produce visible prose after the last user message?
    const answerSinceUser = async (sessionID: string) => {
      try {
        const res: any = await ctx.session.context({ sessionID })
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs)) return false
        let at = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (String(msgs[i]?.type || msgs[i]?.role || '') === 'user') {
            at = i
            break
          }
        }
        if (at < 0) return false
        for (let i = at + 1; i < msgs.length; i++) {
          const m = msgs[i]
          if (String(m?.type || m?.role || '') !== 'assistant') continue
          const parts = Array.isArray(m.content) ? m.content : []
          if (parts.some((p: any) => p && p.type === 'text' && String(p.text || '').trim().length > 0)) return true
        }
        return false
      } catch {
        return false
      }
    }

    const resume = async (sessionID: string, reason: string, force = false) => {
      const s = get(sessionID)
      if (!ours(s)) return
      if (s.resumes >= CFG.maxResumes) {
        log({ at: 'resume-capped', sessionID, resumes: s.resumes })
        return
      }
      if (Date.now() - s.lastResumeAt < CFG.resumeCooldownMs) return
      const state = await sessionState(sessionID)
      if (state.running && !force) {
        log({ at: 'resume-skip', sessionID, why: 'still-running', reason })
        return
      }
      if (force) {
        // our own stall interrupt produces an 'interrupted' idle message: that is not an answer
        if (await answerSinceUser(sessionID)) {
          log({ at: 'resume-skip', sessionID, why: 'answer-present', reason, outcome: state.outcome })
          s.inflight = false
          s.stalled = false
          return
        }
      } else if (!(await needsContinuation(sessionID))) {
        log({ at: 'resume-skip', sessionID, why: 'no-open-turn', reason, outcome: state.outcome })
        s.inflight = false
        s.stalled = false
        return
      }
      s.resumes += 1
      s.lastResumeAt = Date.now()
      s.stalled = false
      log({ at: 'resume', sessionID, reason, attempt: s.resumes })
      await new Promise((r) => setTimeout(r, 2000))
      try {
        await ctx.session.prompt({
          sessionID,
          text:
            `The previous turn stopped unexpectedly (${reason}). Continue EXACTLY where you left off. ` +
            `Do not restart the task and do not repeat finished work. Read .omo/state.md and the latest checkpoint if they exist, ` +
            `then perform the next unfinished step. If a tool call failed, retry it or pick an alternative.`,
        })
        log({ at: 'resume-sent', sessionID, attempt: s.resumes })
      } catch (e: any) {
        log({ at: 'resume-error', sessionID, error: String(e?.message || e) })
      }
    }

    await ctx.session.hook('prompt', (event: any) => {
      const s = get(event.sessionID)
      if (!ours(s)) return
      const text = event.prompt?.text || ''
      // ignore our own resume messages; a real user message opens a new turn budget
      if (!text.startsWith('The previous turn stopped unexpectedly')) {
        s.lastPrompt = text
        s.resumes = 0
        s.lastResumeAt = 0
        s.transportFails = 0
        s.forcePrune = false
      }
      log({ at: 'prompt', sessionID: event.sessionID, chars: text.length })
    })

    await ctx.session.hook('context', (event: any) => {
      const s = get(event.sessionID)
      s.modelID = event.model?.id
      s.providerID = event.model?.providerID

      // ---- scope guard: every resilience behaviour below is for the guarded model only ----
      if (!ours(s)) return

      s.contextLimit = CFG.limit

      if (CFG.protocol && !s.marks.protocol) {
        s.marks.protocol = true
        event.system.push({ type: 'text', text: PROTOCOL })
        log({ at: 'protocol', sessionID: event.sessionID, modelID: s.modelID })
      }

      if (event.options && typeof event.options.maxTokens === 'number' && event.options.maxTokens > 32000) {
        event.options.maxTokens = 32000
      }

      let used = estimate(event.messages) + estimate(event.system)
      let ratio = used / CFG.limit

      if ((s.ctxCalls = (s.ctxCalls || 0) + 1) <= 12) {
        let toolChars = 0
        let toolMsgs = 0
        for (const m of event.messages || []) {
          if (m?.role !== 'tool' || !Array.isArray(m.content)) continue
          toolMsgs += 1
          for (const p of m.content) if (p?.type === 'tool-result' && typeof p?.result?.value === 'string') toolChars += p.result.value.length
        }
        log({ at: 'ctx', sessionID: event.sessionID, used, ratio: Number(ratio.toFixed(3)), msgs: event.messages?.length, toolMsgs, toolChars })
      }

      // ---- adaptive pruning of stale tool output (outgoing request only) ----
      const forced = Boolean(s.forcePrune)
      if ((forced || ratio >= CFG.pruneSoft) && Array.isArray(event.messages)) {
        try {
          const firstTool = event.messages.find((m: any) => m?.role === 'tool')
          log({
            at: 'prune-check',
            ratio: Number(ratio.toFixed(3)),
            soft: CFG.pruneSoft,
            msgs: event.messages.length,
            frozenArr: Object.isFrozen(event.messages),
            frozenMsg: firstTool ? Object.isFrozen(firstTool) : null,
            frozenPart: firstTool ? Object.isFrozen(firstTool.content?.[0]) : null,
          })
        } catch {}
        try {
        const tight = forced || ratio >= CFG.compact
        const keep = tight ? 6 : CFG.keepRecent
        const head = tight ? 2000 : ratio >= CFG.warn ? 3000 : 4000
        const tail = tight ? 600 : 1200
        const stop = Math.max(0, event.messages.length - keep)
        let saved = 0
        let touched = 0
        for (let i = 0; i < stop; i++) {
          const m = event.messages[i]
          if (!m || m.role !== 'tool' || !Array.isArray(m.content)) continue
          for (const p of m.content) {
            if (p?.type !== 'tool-result') continue
            const value = p?.result?.value
            if (p?.result?.type !== 'text' || typeof value !== 'string') continue
            if (value.includes('[omni-resilience]')) continue
            const before = value.length
            const next = headTail(value, head, tail)
            if (next.length !== before) {
              p.result.value = next
              saved += before - next.length
              touched += 1
            }
          }
        }
        if (saved > 0) {
          s.prunedChars += saved
          log({ at: 'prune', sessionID: event.sessionID, ratio: Number(ratio.toFixed(3)), messages: touched, saved, forced })
          used = estimate(event.messages) + estimate(event.system)
          ratio = used / CFG.limit
        }
        if (forced) {
          s.forcePrune = false
          log({ at: 'force-prune-done', sessionID: event.sessionID, saved })
        }
        } catch (e: any) {
          log({ at: 'prune-error', sessionID: event.sessionID, error: String(e?.message || e) })
        }
      }

      s.estimatedTokens = used

      const warn = (key: string, text: string) => {
        if (s.marks[key]) return
        s.marks[key] = true
        event.system.push({ type: 'text', text })
        log({ at: 'warn', sessionID: event.sessionID, key, used, ratio: Number(ratio.toFixed(3)) })
      }

      if (ratio >= CFG.hard) {
        warn(
          'hard',
          `[omni-resilience] Context ${(ratio * 100).toFixed(0)}% full. Before replying: append the current goal, findings, and next steps to .omo/state.md, then compact. Do not start new work in this turn.`,
        )
      } else if (ratio >= CFG.compact) {
        warn(
          'compact',
          `[omni-resilience] Context ${(ratio * 100).toFixed(0)}% full. Finish the current step, persist operational state to .omo/state.md, and expect compaction. Do not re-read large files.`,
        )
      } else if (ratio >= CFG.warn) {
        warn(
          'warn',
          `[omni-resilience] Context ${(ratio * 100).toFixed(0)}% full. Keep replies short, avoid re-reading large files, and record findings in .omo/state.md.`,
        )
      }

      if (ratio >= CFG.compact && !s.compacting && Date.now() - s.lastCompactAt > CFG.cooldownMs) {
        s.compacting = true
        s.lastCompactAt = Date.now()
        log({ at: 'compact-request', sessionID: event.sessionID, used })
        void Promise.resolve(ctx.session.compact({ sessionID: event.sessionID }))
          .then(() => log({ at: 'compact-admitted', sessionID: event.sessionID }))
          .catch((e: any) => {
            s.compacting = false
            log({ at: 'compact-error', sessionID: event.sessionID, error: String(e?.message || e) })
          })
      }
    })

    await ctx.session.hook('compaction', (event: any) => {
      const s = get(event.sessionID)
      if (!ours(s)) return
      let stateText = ''
      try {
        stateText = fs.readFileSync(path.join(root, '.omo', 'state.md'), 'utf8').slice(0, 2500)
      } catch {}
      const note =
        `[omni-resilience] Operational state that MUST survive compaction for session ${event.sessionID}. ` +
        `Tool calls so far: ${s.toolCount}. Last tool: ${s.lastTool}. Last user request: ${String(s.lastPrompt).slice(0, 1500)}. ` +
        `Checkpoint: .omo/checkpoints/${event.sessionID}.json. Preserve these facts verbatim in the summary.` +
        (stateText ? `\n\nCurrent .omo/state.md:\n${stateText}` : '')
      try {
        const msgs = event.messages
        if (Array.isArray(msgs) && msgs.length) {
          const last = msgs[msgs.length - 1]
          if (Array.isArray(last.content)) {
            const textPart = last.content.find((c: any) => c && c.type === 'text')
            if (textPart && typeof textPart.text === 'string') textPart.text += '\n\n' + note
            else last.content.push({ type: 'text', text: note })
          } else if (typeof last.content === 'string') {
            last.content += '\n\n' + note
          }
        }
        log({ at: 'compaction-note', sessionID: event.sessionID, injected: true, state: stateText.length })
      } catch (e: any) {
        log({ at: 'compaction-note-error', error: String(e?.message || e) })
      }
    })

    await ctx.session.hook('retry', (event: any) => {
      const s = get(event.sessionID)
      if (event.model?.id) s.modelID = event.model.id
      if (!ours(s)) return
      log({ at: 'retry-hook', sessionID: event.sessionID, status: event.error?.status, type: event.error?.type, attempt: event.attempt })
      const status = event.error?.status
      const type = String(event.error?.type || '')
      const msg = String(event.error?.message || '')
      // our own stall interrupt is not a network failure - never retry it
      if (/step interrupted|request aborted by user|interrupted by user/i.test(msg)) return
      const transport = /transport|econnreset|connection lost|socket|premature|network error|fetch failed/i.test(type + ' ' + msg)
      const transient =
        transport ||
        status === 429 ||
        status === 408 ||
        status === 409 ||
        status === 425 ||
        (typeof status === 'number' && status >= 500) ||
        /timeout|rate|overload|unavailable|network|fetch|econn|socket/i.test(type + ' ' + msg)
      if (!transient) return
      if (transport) {
        s.transportFails = (s.transportFails || 0) + 1
        if (s.transportFails === 2) s.forcePrune = true
        log({ at: 'transport-fail', sessionID: event.sessionID, count: s.transportFails, status, message: msg.slice(0, 160) })
        // a stream that keeps dying mid-flight will not heal by retrying forever:
        // give up fast and let the failure path (resume/compaction) take over
        if (s.transportFails > 5) {
          log({ at: 'retry-giveup', sessionID: event.sessionID, count: s.transportFails })
          return
        }
      }
      const attempt = Number(event.attempt || 1)
      const isRate = status === 429 || /rate.?limit|too many requests|quota/i.test(type + ' ' + msg)
      // 5xx / "endpoint unavailable" is usually a short upstream hiccup: retry fast (1s, 2s, 4s)
      // instead of making the user stare at a 30 s backoff.
      const delay = transport
        ? Math.min(8000, 1500 * attempt)
        : isRate
          ? Math.min(60000, 5000 * Math.pow(2, Math.max(0, attempt - 1)))
          : Math.min(5000, 1000 * Math.pow(2, Math.max(0, attempt - 2)))
      event.decision = { retry: true, delay }
      log({ at: 'retry', sessionID: event.sessionID, status, type, attempt, delay, transport, isRate })
    })

    try {
      if (!shared.subscribed) {
        shared.subscribed = true
        void (async () => {
        for await (const ev of ctx.event.subscribe()) {
          try {
            const type = ev.type
            const d: any = (ev as any).data || {}
            const id = d.sessionID || (ev as any).sessionID
            if (!id) continue
            const s = get(id)

            // ---- scope guard: resolve the model for events that arrive before a context hook ----
            if (!ours(s)) await ensureModel(id, s)
            if (!ours(s)) continue

            s.lastEventAt = Date.now()
            s.seen = s.seen || {}
            if (!s.seen[type]) {
              s.seen[type] = true
              log({ at: 'event-type', type, sessionID: id })
            }

            if (type === 'session.tool.called') {
              if (d.id) s.pending.add(d.id)
            } else if (type === 'session.tool.success' || type === 'session.tool.failed') {
              if (d.id) s.pending.delete(d.id)
              s.toolCount += 1
              s.lastTool = d.name || d.tool || s.lastTool
              if (type === 'session.tool.success' && s.toolCount % CFG.every === 0) await writeCheckpoint(id, `every-${CFG.every}`)
            } else if (type === 'session.execution.started') {
              s.busy = true
              s.inflight = true
              s.stalled = false
            } else if (type === 'session.execution.succeeded') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
              s.transportFails = 0
              s.forcePrune = false
              await writeCheckpoint(id, 'execution-succeeded')
            } else if (type === 'session.execution.failed') {
              s.busy = false
              s.inflight = false
              const retries = s.retryCount || 0
              s.retryCount = 0
              const fatal = /auth|permission|forbidden|unauthori[sz]ed|401|403|no-route|model.unavailable|model_not_found/i
              if (retries > 0 && !fatal.test(s.lastError)) void resume(id, 'failed after ' + retries + ' retries')
              await writeCheckpoint(id, 'execution-failed')
            } else if (type === 'session.execution.interrupted') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
            } else if (type === 'session.step.ended' || type === 'session.text.ended') {
              // a step finished: the stream is no longer in flight, re-arm on the next started event
              s.inflight = false
            } else if (type === 'session.step.failed') {
              if (d.error) {
                const et = String(d.error?.type || '')
                const em = String(d.error?.message || '')
                s.lastError = et || em || s.lastError
                // counting/retry decisions live in the retry hook, which sees every attempt exactly once
              }
            } else if (type === 'session.status') {
              const st = String(d.status?.type || d.status || '')
              s.busy = /busy|running|retry/i.test(st)
              if (!s.busy) s.inflight = false
              else s.stalled = false
            } else if (type === 'session.error') {
              s.lastErrorAt = Date.now()
              s.lastError = String(d.error?.type || d.error?.message || 'error')
              log({ at: 'error', sessionID: id, type: s.lastError })
            } else if (type === 'session.retry.scheduled') {
              s.retryCount = (s.retryCount || 0) + 1
              log({ at: 'retry-scheduled', sessionID: id, attempt: d.attempt, count: s.retryCount })
            } else if (type === 'session.compaction.started') {
              s.compacting = true
              await writeCheckpoint(id, 'pre-compaction')
            } else if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
              s.compacting = false
              s.marks = {}
              await writeCheckpoint(id, type.endsWith('failed') ? 'compaction-failed' : 'post-compaction')
            } else if (type === 'session.idle') {
              s.busy = false
              s.inflight = false
              const fatal = /auth|permission|forbidden|unauthori[sz]ed|401|403|no-route|model.unavailable|model_not_found/i
              let outcome = ''
              try {
                const info: any = await ctx.session.get({ sessionID: id })
                outcome = String(info?.outcome ?? info?.data?.outcome ?? '')
              } catch {}
              const retries = s.retryCount || 0
              s.retryCount = 0
              if (outcome === 'failed' && retries > 0 && !fatal.test(s.lastError)) {
                void resume(id, 'failed after ' + retries + ' retries')
              }
              await writeCheckpoint(id, 'idle')
            }
          } catch (e: any) {
            log({ at: 'event-error', error: String(e?.message || e) })
          }
        }
        })()
      }
    } catch (e: any) {
      log({ at: 'subscribe-error', error: String(e?.message || e) })
    }

    if (!shared.timerStarted && CFG.stallMs > 0) {
      shared.timerStarted = true
      let ticking = false
      const timer = setInterval(() => {
        if (ticking) return
        ticking = true
        void (async () => {
          try {
            const now = Date.now()
            for (const [id, s] of state) {
              if (!ours(s)) continue
              if (!s.inflight || s.stalled || s.pending.size > 0) continue
              if (now - (s.lastEventAt || now) < CFG.stallMs) continue
              const st = await sessionState(id)
              if (!st.running) {
                s.inflight = false
                log({ at: 'stall-skip', sessionID: id, why: 'not-running', status: st.status, outcome: st.outcome })
                continue
              }
              if (!(await needsContinuation(id))) {
                s.inflight = false
                log({ at: 'stall-skip', sessionID: id, why: 'answer-present' })
                continue
              }
              s.stalled = true
              log({ at: 'stall', sessionID: id, idleMs: now - s.lastEventAt, status: st.status })
              try {
                await ctx.session.interrupt({ sessionID: id })
              } catch (e: any) {
                log({ at: 'stall-error', sessionID: id, error: String(e?.message || e) })
              }
              await new Promise((r) => setTimeout(r, 4000))
              const after = await sessionState(id)
              if (after.running) {
                log({ at: 'stall-resolved', sessionID: id, why: 'still-streaming' })
                s.stalled = false
                continue
              }
              // the interrupt itself closes the turn as 'interrupted', so resume() checks
              // for real assistant prose instead of the idle marker
              void resume(id, 'stream stall', true)
            }
          } catch (e: any) {
            log({ at: 'timer-error', error: String(e?.message || e) })
          } finally {
            ticking = false
          }
        })()
      }, 30000)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()
    }

    log({
      at: 'setup',
      root,
      limit: CFG.limit,
      warn: CFG.warn,
      compact: CFG.compact,
      stallMs: CFG.stallMs,
      maxResumes: CFG.maxResumes,
      onlyProviderID: ONLY_P || 'all',
      onlyModelID: ONLY || 'all',
    })
  },
}
