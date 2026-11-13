import { expect, mock, test } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 } } as never
const USAGE = { startedAt: 0, context: { tokens: 120_000, window: 1_000_000, percent: 12, breakdown: { rawMaxTokens: 400_000 } }, rateLimits: [] } as never

test('a reopened thread draws every cell from stored limits and activity', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { limits: { fiveHour: 7, week: 44 }, lastActivity: { s1: 0 } })
  await clock.advance(10 * 60_000)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: USAGE }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-line-v2', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  for (const text of ['30%', '5H', '7%', '7D', '44%', 'Warm', '50m', 'CLEAR', 'HANDOFF']) expect(await ui.find({ type: 'Text', text })).toBeTruthy()
  await ui.unmount()
})
