import fs from 'node:fs'
import path from 'node:path'

const CHARS_PER_TOKEN = 3.6
const PLUGIN_ID = 'omni-resilience'

const DEFAULTS = {
  // hard scope: the plugin only ever manages this one entry
  providerID: 'flash1047',
  modelID: 'deepseek-v4.1-flash-free',
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
}

// Long-session rules live in ~/.config/opencode/instructions/long-session.md, which OpenCode
// already loads into the system prompt for every session. The plugin used to inject a second
// copy per session; that duplicated the text and drifted from the file, so it is gone.

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
    `\n\n[omni-resilience] ${cut} chars were removed from the middle of this tool output by the client ` +
    `to protect the context window. You cannot see them - do not guess or reconstruct their contents. ` +
    `Re-run the tool with grep/offset/limit if you need that part again.\n\n` +
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
    }

    // Hard scope. The plugin exists for exactly one entry: flash 1047 / deepseek-v4.1-flash-free.
    // It never switches models and it never manages any other model's session - if the guarded
    // model is not the one in use, every behaviour below is a no-op.
    const ONLY = String(opts.onlyModelID ?? DEFAULTS.modelID).trim()
    const ONLY_P = String(opts.onlyProviderID ?? DEFAULTS.providerID).trim()
    const GUARDED = ONLY_P && ONLY ? `${ONLY_P}/${ONLY}` : 'unscoped'
    const modelKey = (s: any) => (s?.providerID && s?.modelID ? `${s.providerID}/${s.modelID}` : '')
    const ours = (s: any) => Boolean(s) && (!ONLY || s.modelID === ONLY) && (!ONLY_P || s.providerID === ONLY_P)

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

    // ---- no model failover ------------------------------------------------
    // This plugin never changes the session model. Switching silently traded the model the user
    // picked for whatever happened to answer, which cost quality and context shape far more often
    // than it saved a turn. A dead endpoint is now handled by retry/backoff and, if it stays dead,
    // by the normal failure path (resume prompt), so the user always knows what happened.

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
          recent: [],
          anchor: null,
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

    // Scope check for hooks that can fire before the first context request (prompt, retry).
    // Without this the plugin silently ignored the very first user prompt of a session, which is
    // exactly the text resume/compaction need in order to keep the task alive.
    const manage = async (sessionID: string, s: any) => {
      if (!s.modelID || !s.providerID) await ensureModel(sessionID, s)
      return ours(s)
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
      if (!(await manage(sessionID, s))) return
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
        const task = String(s.lastPrompt || '').trim().slice(0, 500)
        await ctx.session.prompt({
          sessionID,
          text:
            `The previous turn stopped unexpectedly (${reason}). Continue EXACTLY where you left off. ` +
            (task ? `Your task, verbatim from the user: "${task}". ` : '') +
            `Do not restart the task and do not repeat finished work. Read .omo/state.md and the latest checkpoint if they exist, ` +
            `then perform the next unfinished step. If a tool call failed, retry it or pick an alternative.`,
        })
        log({ at: 'resume-sent', sessionID, attempt: s.resumes })
      } catch (e: any) {
        log({ at: 'resume-error', sessionID, error: String(e?.message || e) })
      }
    }

    await ctx.session.hook('prompt', async (event: any) => {
      const s = get(event.sessionID)
      if (!(await manage(event.sessionID, s))) return
      const text = event.prompt?.text || ''
      // ignore our own resume messages; a real user message opens a new turn budget
      if (!text.startsWith('The previous turn stopped unexpectedly')) {
        s.lastPrompt = text
        s.resumes = 0
        s.lastResumeAt = 0
        s.transportFails = 0
        s.forcePrune = false
      }
      log({ at: 'prompt', sessionID: event.sessionID, chars: text.length, model: modelKey(s) })
    })

    await ctx.session.hook('context', (event: any) => {
      const s = get(event.sessionID)
      s.modelID = event.model?.id
      s.providerID = event.model?.providerID

      // ---- scope guard: every resilience behaviour below is for the guarded model only ----
      if (!ours(s)) return

      s.contextLimit = CFG.limit

      // ---- post-compaction re-anchor (the anti-drift part) -------------------
      // Compaction replaces the live conversation with a summary. Without a re-anchor the model
      // tends to drift into invented work right after it, so the first request after a
      // successful compaction gets the user's task quoted back, once.
      if (s.anchor) {
        const task = String(s.lastPrompt || '').trim().slice(0, 600)
        const text =
          `[omni-resilience] The conversation was just compacted; earlier turns now exist only as a summary. ` +
          (task
            ? `Your current task, verbatim from the user: "${task}". `
            : `Your current task is in the summary. `) +
          `Continue it from .omo/state.md and .omo/checkpoints/${event.sessionID}.json. ` +
          `Do not restart the task, do not ask the user to repeat anything, and do not invent new work.`
        event.system.push({ type: 'text', text })
        s.anchor = null
        log({ at: 'anchor', sessionID: event.sessionID, reason: 'post-compaction', task: task.length })
      }

      // No protocol injection here: OpenCode already puts instructions/long-session.md into the
      // system prompt for every session (verified via the instruction blobs), so a second copy
      // only burned tokens and drifted from the file.

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
      const task = String(s.lastPrompt || '').trim().slice(0, 1500)
      const recent = (s.recent || []).slice(-6).join(', ') || 'none'
      const note =
        `[omni-resilience] Facts that MUST survive this compaction (session ${event.sessionID}). ` +
        (task ? `The user's request, verbatim: "${task}". ` : '') +
        `Work done so far: ${s.toolCount} tool calls; recent tools: ${recent}; last tool: ${s.lastTool}. ` +
        `Checkpoint: .omo/checkpoints/${event.sessionID}.json. ` +
        `Preserve the request and these facts verbatim in the summary - never summarise the request away.` +
        (stateText ? `\n\nCurrent .omo/state.md:\n${stateText}` : '')
      try {
        const msgs = event.messages
        let target = 'none'
        if (Array.isArray(msgs)) {
          // Rule: hooks never rewrite an existing message. Adding a text part to a `tool`
          // message made the whole request invalid on strict protocols (OpenAI Chat:
          // "tool messages only support tool-result content for now"), and appending to an
          // assistant message put instructions inside the model's own past output. A fresh
          // user message at the end is legal on every protocol and is what the summarizer
          // reads last, so it is the only injection point used here.
          msgs.push({ role: 'user', content: [{ type: 'text', text: note }] })
          target = 'user:new'
        }
        log({
          at: 'compaction-note',
          sessionID: event.sessionID,
          injected: true,
          state: stateText.length,
          target,
        })
      } catch (e: any) {
        log({ at: 'compaction-note-error', error: String(e?.message || e) })
      }
    })

    await ctx.session.hook('retry', async (event: any) => {
      const s = get(event.sessionID)
      if (event.model?.id) s.modelID = event.model.id
      if (event.model?.providerID) s.providerID = event.model.providerID
      if (!(await manage(event.sessionID, s))) return
      const status = event.error?.status
      const type = String(event.error?.type || '')
      const msg = String(event.error?.message || '')
      const blob = `${type} ${msg}`
      log({ at: 'retry-hook', sessionID: event.sessionID, status, type, attempt: event.attempt, model: modelKey(s) })
      // our own stall interrupt is not a network failure - never retry it
      if (/step interrupted|request aborted by user|interrupted by user/i.test(msg)) return

      const transport =
        /transport|econnreset|connection lost|socket|premature|network error|fetch failed|closed unexpectedly/i.test(blob)
      const isRate = status === 429 || /rate.?limit|too many requests|quota/i.test(blob)
      const endpointDead =
        (typeof status === 'number' && status >= 500) ||
        /endpoint is unavailable|upstream request failed|unavailable|overload|no route|internal/i.test(blob)
      const transient =
        transport ||
        isRate ||
        endpointDead ||
        status === 408 ||
        status === 409 ||
        status === 425 ||
        /timeout|network|fetch|econn|socket/i.test(blob)
      if (!transient) return

      const now = Date.now()
      if (!s.retryStart || now - s.retryStart > 120000) {
        s.retryStart = now
        s.retryCount = 0
      }
      s.retryCount = (s.retryCount || 0) + 1

      // --- 1) transport blip: same model, dense retry, smaller request -------------
      if (transport) {
        s.transportFails = (s.transportFails || 0) + 1
        if (s.transportFails === 2) s.forcePrune = true
        log({ at: 'transport-fail', sessionID: event.sessionID, count: s.transportFails, status, message: msg.slice(0, 160) })
        // a stream that keeps dying mid-flight will not heal by retrying forever:
        // give up fast and let the failure path (resume/compaction) take over
        if (s.transportFails > 5) {
          log({ at: 'retry-giveup', sessionID: event.sessionID, count: s.transportFails })
          s.retryGiveup = now
          s.transportFails = 0
          return
        }
        const delay = Math.min(8000, 1200 * Number(event.attempt || 1))
        event.decision = { retry: true, delay }
        log({ at: 'retry', sessionID: event.sessionID, reason: 'transport', delay, count: s.retryCount })
        return
      }

      // --- 2) backoff on this model only. No switching: the session keeps the model the user
      // picked. A 429 waits longer, a 5xx/overload waits shorter, a dead endpoint eventually
      // gives up and lets the failure path (resume prompt) surface it instead of hiding it.
      const elapsed = now - s.retryStart
      const budget = isRate ? 60000 : 45000
      if (elapsed > budget) {
        log({ at: 'retry-giveup', sessionID: event.sessionID, elapsed, budget, count: s.retryCount, status, type })
        s.retryStart = 0
        s.retryCount = 0
        // do not let the resume path start a second 45 s round against a dead endpoint
        s.retryGiveup = now
        return
      }
      // smaller request = cheaper retry: the free pool answers big prompts last
      if (s.retryCount >= 2) s.forcePrune = true
      const delay = isRate
        ? Math.min(15000, 3000 * Math.pow(2, Math.max(0, s.retryCount - 1)) * 0.6)
        : Math.min(2500, 700 + 400 * s.retryCount)
      event.decision = { retry: true, delay }
      log({
        at: 'retry',
        sessionID: event.sessionID,
        status,
        type,
        delay,
        isRate,
        endpointDead,
        count: s.retryCount,
        elapsed,
      })
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
              if (s.lastTool && s.lastTool !== 'none') {
                s.recent = [...(s.recent || []), String(s.lastTool)].slice(-8)
              }
              if (type === 'session.tool.success' && s.toolCount % CFG.every === 0) await writeCheckpoint(id, `every-${CFG.every}`)
            } else if (type === 'session.execution.started') {
              s.busy = true
              s.inflight = true
              s.stalled = false
              s.retryGiveup = 0
            } else if (type === 'session.execution.succeeded') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
              s.retryStart = 0
              s.transportFails = 0
              s.forcePrune = false
              log({ at: 'succeeded', sessionID: id, model: modelKey(s) })
              await writeCheckpoint(id, 'execution-succeeded')
            } else if (type === 'session.execution.failed') {
              s.busy = false
              s.inflight = false
              const retries = s.retryCount || 0
              s.retryCount = 0
              s.retryStart = 0
              const fatal = /auth|permission|forbidden|unauthori[sz]ed|401|403|no-route|model.unavailable|model_not_found/i
              if (retries > 0 && !fatal.test(s.lastError)) void resume(id, 'failed after ' + retries + ' retries')
              await writeCheckpoint(id, 'execution-failed')
            } else if (type === 'session.execution.interrupted') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
              s.retryStart = 0
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
              // counting happens once, in the retry hook - this event is informational only
              log({ at: 'retry-scheduled', sessionID: id, attempt: d.attempt, count: s.retryCount })
            } else if (type === 'session.compaction.started') {
              s.compacting = true
              await writeCheckpoint(id, 'pre-compaction')
            } else if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
              s.compacting = false
              s.marks = {}
              // re-anchor the model on the next request: compaction moves the conversation into a
              // summary, which is exactly where agents drift into invented work
              if (type === 'session.compaction.ended') s.anchor = { at: Date.now(), reason: 'compaction' }
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
              const gaveUp = s.retryGiveup && Date.now() - s.retryGiveup < 180000
              if (outcome === 'failed' && retries > 0 && !fatal.test(s.lastError) && !gaveUp) {
                void resume(id, 'failed after ' + retries + ' retries')
              } else if (gaveUp) {
                log({ at: 'resume-skip', sessionID: id, why: 'retry-budget-exhausted' })
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
      guarded: GUARDED,
      limit: CFG.limit,
      warn: CFG.warn,
      compact: CFG.compact,
      stallMs: CFG.stallMs,
      maxResumes: CFG.maxResumes,
      modelSwitching: 'disabled',
    })
  },
}
