import type { EngineInterface, Register, Timer } from 'claude-code'

// The prompt cache lives an hour from the last request. Warn a few minutes before.
const DEFAULT_MINUTES = 55

// Session facts are best effort: a missing one never stops the alert.
const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await f()
  } catch {
    return fallback
  }
}

const folderName = async ($: EngineInterface) =>
  (await safe(() => $.session.cwd(), '')).split('/').filter(Boolean).pop() ?? ''

// A handoff skill may be installed bare (`handoff`) or namespaced (`anthropic-skills:handoff`).
const isHandoff = (name: string) => name === 'handoff' || name.endsWith(':handoff')

// The newest `custom-title` row's title in a transcript's text (the title the
// desktop sidebar shows), if there is one.
export const lastTitle = (text: string): string | undefined => {
  const re = /"customTitle":"((?:[^"\\]|\\.)*)"/g
  let last: string | undefined
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1]
  return last === undefined ? undefined : (JSON.parse(`"${last}"`) as string)
}

// The thread's name: its transcript title, else the project folder's name.
const threadTitle = async ($: EngineInterface): Promise<string> => {
  try {
    const { transcriptPath } = await $.session.info()
    if (transcriptPath) {
      const title = lastTitle(await $.fs.read(transcriptPath))
      if (title) return title
    }
  } catch {
    // No transcript on this machine: fall back to the folder name.
  }
  return (await folderName($)) || 'Claude'
}

const minutes = async ($: EngineInterface) => {
  const n = Number(await $.env.get('COLD_THREAD_MINUTES'))
  return Number.isFinite(n) && n > 0 && n < 60 ? n : DEFAULT_MINUTES
}

const sendAlert = async ($: EngineInterface, idleMinutes: number) => {
  const url = await $.env.get('COLD_THREAD_WEBHOOK')
  if (!url) {
    $.ui.toast('cold-thread-alert: set COLD_THREAD_WEBHOOK in settings.json env.')
    return
  }
  const thread = await threadTitle($)
  const project = await folderName($)
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread, project, idle_minutes: idleMinutes, session_id: await safe(() => $.session.id(), '') }),
  })
  if (!res.ok) $.ui.toast(`cold-thread-alert: webhook answered ${res.status}.`)
}

export const register: Register = on => {
  let timer: Timer | undefined
  // Whether the last turn was a handoff: the thread is saved, so its going cold is fine.
  let lastWasHandoff = false

  const reset = () => {
    timer?.cancel()
    timer = undefined
    lastWasHandoff = false
  }

  on('session.end', async ($, e, next) => {
    reset()
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    reset()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    // Meta prompts (notices, wakeups) aren't the person's doing, so they leave the flag alone.
    if (!e.isMeta) lastWasHandoff = e.command !== undefined && isHandoff(e.command.name)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The model can run the handoff skill itself when asked in plain words.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (!e.agentId && isHandoff(e.skill)) lastWasHandoff = true
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every main-loop turn end is the last request so far: restart the countdown from it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    timer?.cancel()
    const idle = await minutes($)
    timer = $.clock.after(idle * 60_000, () => {
      timer = undefined
      if (!lastWasHandoff) void sendAlert($, idle).catch(() => $.ui.toast('cold-thread-alert: webhook failed.'))
    })
    return result
  })
}
