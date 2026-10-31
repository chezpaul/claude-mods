import { expect, mock, test } from 'claude-code/testing'

const COMMANDS = [
  { name: 'clear', description: '', source: 'builtin' },
  { name: 'anthropic-skills:handoff', description: '', source: 'plugin' },
]

const turnEnd = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })

test('59 idle minutes after a turn, it runs the handoff once', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_, e) => (sent.push(e.command), { text: '' }))

  await $.prompt.submit({ text: 'fix the bug' })
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(58 * 60_000)
  expect(sent).toEqual([])
  await clock.advance(60_000)
  expect(sent).toEqual(['anthropic-skills:handoff'])
  await clock.advance(120 * 60_000)
  expect(sent.length).toBe(1)
})

test('a new turn restarts the countdown', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_, e) => (sent.push(e.command), { text: '' }))

  await $.prompt.submit({ text: 'one' })
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(40 * 60_000)
  await $.prompt.submit({ text: 'two' })
  await $.turn.complete(turnEnd('t2'))
  await clock.advance(40 * 60_000)
  expect(sent).toEqual([])
  await clock.advance(19 * 60_000)
  expect(sent.length).toBe(1)
})

test('no handoff when the last turn was a typed /handoff', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_, e) => (sent.push(e.command), { text: '' }))

  await $.prompt.submit({ text: '/handoff', command: { name: 'handoff', args: '' } })
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(sent).toEqual([])
})

test('no handoff when the model ran the handoff skill', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: {} }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_, e) => (sent.push(e.command), { text: '' }))

  await $.prompt.submit({ text: 'write a handoff' })
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:handoff' })
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(sent).toEqual([])
})
