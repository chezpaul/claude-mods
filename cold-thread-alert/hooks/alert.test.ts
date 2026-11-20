import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { lastTitle } from './register'

const URL = 'https://ha.example/api/webhook/abc'
const prompt = (text: string, command?: { name: string; args: string }) =>
  ({ text, command, wait: true, origin: { kind: 'composer' as const } })
const turnEnd = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })

const setup = (on: On, posts: string[], stored?: Record<string, unknown>) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  mock.store(on, stored)
  mock.env(on, { COLD_THREAD_WEBHOOK: URL })
  on('ui.toast', (_, e) => (posts.push(`toast ${e.text}`), { value: undefined }))
  on('http.fetch', (_, e) => (
    posts.push(`${e.url} ${e.init?.body}`),
    { value: { status: 200, ok: true, headers: {}, text: '' } }
  ))
}

test('the newest transcript title wins, escapes undone', async () => {
  const text = '{"type":"custom-title","customTitle":"Old"}\n{"type":"custom-title","customTitle":"Winter \\"heat\\""}\n'
  expect(lastTitle(text)).toBe('Winter "heat"')
  expect(lastTitle('{"type":"user"}')).toBe(undefined)
})

test('55 idle minutes after a turn, it posts once', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)

  await $.prompt.submit(prompt('fix it'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(54 * 60_000)
  expect(posts).toEqual([])
  await clock.advance(60_000)
  expect(posts.length).toBe(1)
  const sent = posts[0] ?? ''
  expect(sent.startsWith(`${URL} `)).toBe(true)
  expect(JSON.parse(sent.slice(URL.length + 1)).idle_minutes).toBe(55)
  await clock.advance(120 * 60_000)
  expect(posts.length).toBe(1)
})

test('a new prompt restarts the countdown', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  await $.prompt.submit(prompt('one'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(50 * 60_000)
  await $.prompt.submit(prompt('two'))
  await $.turn.complete(turnEnd('t2'))
  await clock.advance(50 * 60_000)
  expect(posts).toEqual([])
  await clock.advance(5 * 60_000)
  expect(posts.length).toBe(1)
})

test('no alert after a handoff turn', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  await $.prompt.submit(prompt('/handoff', { name: 'anthropic-skills:handoff', args: '' }))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(posts).toEqual([])
})

test('no webhook set: a toast, no request', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  mock.env(on, {})
  on('ui.toast', (_, e) => (posts.push(`toast ${e.text}`), { value: undefined }))
  await $.prompt.submit(prompt('x'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(55 * 60_000)
  expect(posts).toEqual(['toast cold-thread-alert: set COLD_THREAD_WEBHOOK in settings.json env.'])
})

const HOUR = 60 * 60_000
const window = (kind: string, percentUsed: number, resetsAt: number) =>
  ({ kind, percentUsed, resetsAt: new Date(resetsAt).toISOString() })
const measure = (rateLimits: ReturnType<typeof window>[]) =>
  ({ context: { window: 200_000 } as never, rateLimits, changed: ['rateLimits' as const] })
const usage = (on: On, rateLimits: ReturnType<typeof window>[]) =>
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits } as never }))

test('no alert while the 5-hour window reads 100 %', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  const now = clock.now()
  await $.prompt.submit(prompt('x'))
  await $.session.measure(measure([window('five_hour', 100, now + 2 * HOUR)]))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(posts).toEqual([])
})

test('a turn that died on rate_limit silences alerts until the fullest window resets', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  const now = clock.now()
  usage(on, [window('five_hour', 97, now + 3 * HOUR), window('seven_day', 40, now + 90 * HOUR)])
  await $.prompt.submit(prompt('x'))
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...turnEnd('t1'), reason: 'error' as const })
  await clock.advance(70 * 60_000)
  expect(posts).toEqual([])
})

test('once the window has reset, alerts come back', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  const now = clock.now()
  await $.prompt.submit(prompt('x'))
  await $.session.measure(measure([window('five_hour', 100, now + 30 * 60_000)]))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(55 * 60_000)
  expect(posts.length).toBe(1)
})

test('a high but not used-up window still alerts', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  const now = clock.now()
  usage(on, [window('five_hour', 92, now + 2 * HOUR)])
  await $.prompt.submit(prompt('x'))
  await $.session.measure(measure([window('five_hour', 92, now + 2 * HOUR)]))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(55 * 60_000)
  expect(posts.length).toBe(1)
})

test("one thread's limit hit silences another thread's alert", async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  // Another thread stored the hit; this one never saw a 100 % reading.
  setup(on, posts, { limitedUntil: clock.now() + 2 * HOUR })
  await $.prompt.submit(prompt('x'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(posts).toEqual([])
})
