import { expect, mock, test } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 } } as never

test('HANDOFF pressed again while its run is queued starts no second run', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  const runs: string[] = []
  let release = () => {}
  on('command.list', () => ({ value: [{ name: 'anthropic-skills:handoff' }] }) as never)
  on('command.run', async (_, e) => {
    runs.push(e.command)
    await new Promise<void>(r => (release = r))
    return {}
  })
  const ui = await $.ui.mount({ plugin: 'usage-line-v2', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'handoff' })
  await new Promise(r => setTimeout(r, 10))
  expect(await ui.find({ type: 'Text', text: 'HANDOFF…' })).toBeTruthy()
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff' })
  await new Promise(r => setTimeout(r, 10))
  expect(runs).toEqual(['anthropic-skills:handoff'])
  release()
  await new Promise(r => setTimeout(r, 10))
  expect(await ui.find({ type: 'Text', text: 'HANDOFF' })).toBeTruthy()
  await ui.unmount()
})
