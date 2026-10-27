import { atom, read, update } from 'claude-code'
import type { Register, SessionMeasureInput } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, {})
const lastActivity = atom({ plugin: 'usage-line', key: 'lastActivity' } as const, null)
// Bumped every minute so the cache timer redraws.
const tick = atom({ plugin: 'usage-line', key: 'tick' } as const, 0)

// Warn once per level: context per session (what each message re-reads), 5-hour limit per window.
const CONTEXT_WARN = [40, 60, 80]
const FIVE_HOUR_WARN = [50, 75, 90]

// Band palette.
const BAND_BG = '#24221e'
const LABEL = '#ece8df'
const MUTED = '#8c877d'
const WEEK = '#e07b39'
const FIVE_HOUR = '#e6b84a'
const CONTEXT = '#7fb8d6'
const WARM = '#7cbf6a'
const COOLING = '#5fb8b0'
const COLD = '#5b9bf0'
const DOTS = 10

// Pro's prompt cache lives about an hour; warn a bit before.
const CACHE_COOLING_MIN = 45
const CACHE_COLD_MIN = 60
// Below this a cold re-read is cheap enough not to interrupt.
const COLD_PROMPT_MIN_TOKENS = 50_000

// `compactAt` is the window auto-compaction measures against (what the app's Context % uses), smaller than the model's.
const toUsage = (m: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>, compactAt?: number): Usage => {
  const five = m.rateLimits.find(r => r.kind === 'five_hour')
  const week = m.rateLimits.find(r => r.kind === 'seven_day')
  return {
    fiveHour: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
    week: week?.percentUsed,
    weekResetsAt: week?.resetsAt,
    contextPct: m.context.tokens !== undefined && compactAt ? Math.round((m.context.tokens / compactAt) * 100) : m.context.percent,
    contextTokens: m.context.tokens,
    usd: m.cost?.usd,
  }
}

function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${mins % 60}m`
}

function toLine(u: Usage): string | undefined {
  const parts = [
    u.fiveHour !== undefined && `5h ${Math.round(u.fiveHour)}%`,
    u.week !== undefined && `week ${Math.round(u.week)}%`,
    u.contextPct !== undefined && `ctx ${Math.round(u.contextPct)}%`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

export const register: Register = on => {
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const full = await $.session.usage({ breakdown: 'summary' })
    const u = toUsage(full, full.context.breakdown?.rawMaxTokens)
    await update($, usage, () => u)
    $.clock.every(60_000, async () => {
      await update($, tick, n => n + 1)
      const last = await read($, lastActivity)
      const tokens = (await read($, usage)).contextTokens ?? 0
      const mins = last === null ? 0 : Math.floor(((await $.clock.now()) - last) / 60_000)
      if (mins === CACHE_COOLING_MIN && tokens >= COLD_PROMPT_MIN_TOKENS) {
        const message = `Cache cools in ${CACHE_COLD_MIN - mins} min. Stepping away? Run /handoff now while it's cheap.`
        $.ui.toast(message)
        // Reaches the phone when Remote Control is on; skipped while the person is at the screen.
        await $.tool.call({ tool: 'PushNotification', message, status: 'proactive' }).catch(() => undefined)
      }
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const last = await read($, lastActivity)
    await update($, lastActivity, () => now)

    // Cold cache + big context: the next message re-reads it all at full price.
    const isColdReturn = !e.isMeta && !e.command && last !== null && now - last >= CACHE_COLD_MIN * 60_000
    if (isColdReturn) {
      const tokens = (await $.session.usage()).context.tokens ?? 0
      if (tokens >= COLD_PROMPT_MIN_TOKENS) {
        const mins = Math.floor((now - last) / 60_000)
        const away = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
        const choice = await $.ui
          .ask(`Cache is cold (${away} since the last message). Sending re-reads ~${Math.round(tokens / 1000)}k tokens at full price. Send anyway?`, {
            header: 'Cold cache',
            options: ['Send anyway', 'Start fresh instead'],
          })
          .catch(() => 'Send anyway')
        // /handoff here would itself re-read the cold chat, so the cheap way out is a fresh start.
        if (choice === 'Start fresh instead') {
          $.ui.toast('Not sent. Run /clear, then send your message with a few lines of context.')
          return { drop: 'Cold cache: start fresh instead' }
        }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastActivity, () => now)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // `summary` estimates locally: no API call.
    const compactAt = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.rawMaxTokens
    const u = toUsage(e, compactAt)
    await update($, usage, () => u)
    for (const level of CONTEXT_WARN) {
      if ((u.contextPct ?? 0) >= level && !warned.has(`c${level}`)) {
        warned.add(`c${level}`)
        $.ui.toast(`Session context at ${Math.round(u.contextPct!)}%: every message re-reads it. Consider /handoff then /clear, or /compact.`)
      }
    }
    for (const level of FIVE_HOUR_WARN) {
      // Keyed by the window's reset time so a fresh 5-hour window warns again.
      const key = `f${level}-${u.fiveHourResetsAt}`
      if ((u.fiveHour ?? 0) >= level && !warned.has(key)) {
        warned.add(key)
        const reset = untilReset(u.fiveHourResetsAt, Date.now())
        $.ui.toast(`5-hour limit ${Math.round(u.fiveHour!)}% used${reset ? `, resets in ${reset}` : ''}.`)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = toLine(await read($, usage))
    if (!line) return next(e)

    // The terminal draws `tail` after its own hint; other surfaces need our own tree.
    if (e.surface === 'terminal') return next({ ...e, props: { ...e.props, tail: `  ${line}` } })
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint ? `${e.props.hint}  ·  ${line}` : line}</Text>
  })

  // The desktop Code tab doesn't raise PromptHint; the band above the prompt is where it shows there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    if (u.week === undefined && u.fiveHour === undefined) return next(e)
    const now = await $.clock.now()
    await read($, tick)
    const last = await read($, lastActivity)
    const { Box, Button, Text } = $.ui.resolve(e)

    const meter = (key: string, label: string, used: number | undefined, resetsAt: string | undefined, color: string) => {
      if (used === undefined) return null
      const pct = Math.min(100, Math.max(0, Math.round(used)))
      const filled = Math.round((pct / 100) * DOTS)
      const reset = untilReset(resetsAt, now)
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap="sm">
          <Text mono weight="semibold" color={MUTED}>{label}</Text>
          <Text mono>
            <Text color={color}>{'●'.repeat(filled)}</Text>
            <Text color={MUTED}>{'·'.repeat(DOTS - filled)}</Text>
          </Text>
          <Text mono weight="bold" color={color}>{pct}%</Text>
          {reset ? <Text mono color={MUTED}>· {reset}</Text> : null}
        </Box>
      )
    }

    let cache = null
    if (last !== null) {
      const mins = Math.floor((now - last) / 60000)
      const state = mins >= CACHE_COLD_MIN ? 'Cold' : mins >= CACHE_COOLING_MIN ? 'Cooling' : 'Warm'
      const color = state === 'Cold' ? COLD : state === 'Cooling' ? COOLING : WARM
      const age = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
      cache = (
        <Box key="cache" flexDirection="row" alignItems="center" gap="sm">
          <Text mono weight="semibold" color={MUTED}>CACHE</Text>
          <Text mono weight="bold" color={color}>{state}</Text>
          <Text mono color={MUTED} wrap="truncate">{`·\u00a0${age}`}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="row" alignItems="center" gap="lg" paddingX="md" paddingY={0} backgroundColor={BAND_BG}>
        <Box flexDirection="row" alignItems="center" gap="lg" flexGrow={1}>
          <Text mono weight="bold" color={LABEL}>USAGE</Text>
          {meter('five', '5H', u.fiveHour, undefined, FIVE_HOUR)}
          {meter('week', '7D', u.week, undefined, WEEK)}
          {cache}
          {meter('ctx', 'CTX', u.contextPct, undefined, CONTEXT)}
        </Box>
        {/* Runs /handoff, as typing it + Return would. */}
        {/* The desktop draws a Button's frame its own way; the label's style is ours. */}
        <Button key="handoff" label="HANDOFF" onPress={() => void $.command.run({ command: 'handoff' })}>
          <Text mono weight="bold" color={CONTEXT}>HANDOFF</Text>
        </Button>
      </Box>
    )
  })
}
