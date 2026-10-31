import type { EngineInterface, Register, Timer } from 'claude-code'

// The prompt cache lives an hour from the last request; hand off a minute before.
const IDLE_MS = 59 * 60_000

// A handoff skill may be installed bare (`handoff`) or namespaced (`anthropic-skills:handoff`).
const isHandoff = (name: string) => name === 'handoff' || name.endsWith(':handoff')

const runHandoff = async ($: EngineInterface) => {
  const command = (await $.command.list()).map(c => c.name).find(isHandoff)
  if (command) await $.command.run({ command })
  else $.ui.toast('handoff-before-cold: no handoff skill or command installed.')
}

export const register: Register = on => {
  let timer: Timer | undefined
  // Whether the last turn the person (or the model) started was a handoff.
  let lastWasHandoff = false

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
    timer = $.clock.after(IDLE_MS, () => {
      timer = undefined
      if (!lastWasHandoff) void runHandoff($)
    })
    return result
  })
}
