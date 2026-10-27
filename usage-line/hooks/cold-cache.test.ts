import { expect, mock, test } from 'claude-code/testing'

const USAGE = { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [] }

test('a prompt after an hour with a big context asks first, and can be dropped', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const asked: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  // $.ui.ask is an AskUserQuestion tool call; answer it as the person would.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0].question
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: 'Start fresh instead' } } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'first' })
  expect(asked.length).toBe(0)

  await clock.advance(30 * 60_000)
  await $.prompt.submit({ text: 'warm' })
  expect(asked.length).toBe(0)

  await clock.advance(61 * 60_000)
  const result = await $.prompt.submit({ text: 'cold' })
  expect(asked.length).toBe(1)
  expect(result).toEqual({ drop: 'Cold cache: start fresh instead' })
})

test('at 45 idle minutes in a big chat, a toast shows once and nothing is pushed', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  const pushes: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', { tool: 'PushNotification' }, (_, e) => (pushes.push(e.message), { result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi' })
  await clock.advance(54 * 60_000)
  expect(toasts.filter(t => t.includes('/handoff')).length).toBe(1)
  expect(pushes.length).toBe(0)
})

test('the Handoff button runs /handoff', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const sent: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }] } }))
  on('command.run', (_, e) => (sent.push(e.command), { text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 } },
  })
  await ui.press({ key: 'handoff' })
  expect(sent).toEqual(['handoff'])
  await ui.unmount()
})

test('CTX is measured against the compaction window, as the app shows it', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 248_808, window: 1_000_000, percent: 25, breakdown: { rawMaxTokens: 400_000 } },
      rateLimits: [{ kind: 'five_hour', percentUsed: 16 }],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 } },
  })
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeTruthy()
  await ui.unmount()
})

test('a fresh thread with no reply yet shows the last limits seen in any session', async ($, on) => {
  mock.clock(on)
  mock.store(on, { limits: { fiveHour: 59, week: 38 } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: USAGE }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 } },
  })
  expect(await ui.find({ type: 'Text', text: '59%' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '38%' })).toBeTruthy()
  await ui.unmount()
})

test('a reopened thread shows its cache age before any new message', async ($, on) => {
  const clock = mock.clock(on)
  // Last active at the clock's start, 70 minutes ago.
  mock.store(on, { limits: { fiveHour: 10 }, lastActivity: { s1: 0 } })
  await clock.advance(70 * 60_000)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: USAGE }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'usage-line',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 } },
  })
  expect(await ui.find({ type: 'Text', text: 'Cold' })).toBeTruthy()
  await ui.unmount()
})
