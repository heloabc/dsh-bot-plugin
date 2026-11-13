import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'

// A real mounted React tree, not SSR: keep the same buttons across streaming,
// durable replacement, new activity and completion, in both transcript modes.
const compiled = await build({
  stdin: {
    contents: `
      import React, { act } from 'react'
      import { createRoot } from 'react-dom/client'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { Transcript } from './ui/src/transcript.tsx'
      import { ActivityGroup } from './ui/src/ProcessRow.tsx'
      import { MarkdownView } from './ui/src/MarkdownView.tsx'
      export { act }
      export function mount(node) {
        const root = createRoot(node)
        return {
          render: props => act(() => root.render(<Transcript {...props} />)),
          group: props => act(() => root.render(<ActivityGroup {...props} />)),
          close: () => act(() => root.unmount())
        }
      }
      export const markdown = text => renderToStaticMarkup(<MarkdownView text={text} />)
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'tsx',
  },
  // Keep React's Node act scheduler intact instead of bundling its dynamic
  // require into a browser MessageChannel fallback that leaves ports alive.
  plugins: [
    {
      name: 'node-react',
      setup(builder) {
        const uiRequire = createRequire(new URL('../ui/package.json', import.meta.url))
        builder.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/ }, args => ({
          path: uiRequire.resolve(args.path),
          external: true,
        }))
      },
    },
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
})

function harness() {
  const { window, document } = parseHTML('<html><body><main></main></body></html>')
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }
  Object.assign(window, { matchMedia: () => ({ matches: true }) })
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const mod = { exports: {} as any }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  )
  const container = document.querySelector('main')!
  const mounted = mod.exports.mount(container)
  return {
    ...mounted,
    markdown: mod.exports.markdown,
    container,
    act: mod.exports.act,
    async close() {
      await mounted.close()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

const tool = (id: string, status = 'running') => ({
  kind: 'tool',
  id: `tool:${id}`,
  callId: id,
  name: 'bash',
  args: '{}',
  result: '',
  running: status === 'running',
  status,
  error: false,
  seq: 2,
  turn: 1,
})
const base = {
  sessionId: 'session-state',
  completed: {},
  failures: {},
  retries: {},
  turnEnds: {},
  tickets: [],
  now: 0,
  canRetry: false,
  onRetry() {},
  onSupply() {},
  onOpenSession() {},
  onOpenFile() {},
  onOpenInbox() {},
  botLabel: (id: string) => id,
  drafting: true,
  currentTurn: 1,
}

for (const chat of [true, false]) {
  test(`mounted actions preserve user state through streaming and completion (Bot=${chat})`, async () => {
    const h = harness()
    const groups = () => [...h.container.querySelectorAll('.activity-group')]
    const button = () => groups()[0]!.querySelector('button')!
    const expanded = () => button().getAttribute('aria-expanded')
    const click = () => h.act(() => button().click())
    const think = { kind: 'think', id: 'live:think:0', text: 'working', running: true, seq: 1, turn: 1, step: 1 }
    try {
      await h.render({ ...base, chat, segments: [think, tool('one')] })
      assert.equal(expanded(), 'true')
      const original = groups()[0]
      await click()
      assert.equal(expanded(), 'false')
      await h.render({ ...base, chat, segments: [{ ...think, text: 'working more' }, tool('one'), tool('two')] })
      assert.equal(expanded(), 'false', 'streaming and new actions must not reopen')
      await h.render({
        ...base,
        chat,
        drafting: false,
        turnEnds: { 1: 'completed' },
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
        ],
      })
      assert.equal(groups()[0], original, 'durable ids must not remount the action group or turn')
      assert.equal(expanded(), 'false')
      await click()
      assert.equal(expanded(), 'true')
      await h.render({
        ...base,
        chat,
        drafting: false,
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
          { kind: 'assistant', id: 'answer', text: 'between actions', seq: 4, turn: 1 },
          { ...tool('three'), seq: 5 },
        ],
      })
      assert.equal(expanded(), 'true', 'new separate activity must not close the selected group')
      assert.equal(groups().length, 2, 'text must remain between the two activity runs')
      assert.ok(h.container.textContent!.includes('between actions'))
      await h.render({
        ...base,
        chat,
        drafting: false,
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
        ],
      })
      assert.equal(expanded(), 'true', 'completion must not close a manually opened group')
    } finally {
      await h.close()
    }
  })
}

test('pending, connection and running status never auto-toggle an actions group', async () => {
  const h = harness()
  const expanded = () => h.container.querySelector('button')!.getAttribute('aria-expanded')
  try {
    await h.group({ segments: [tool('one', 'succeeded')], pending: false })
    assert.equal(expanded(), 'false')
    await h.group({ segments: [tool('one')], pending: true, connectionPhase: 'syncing' })
    assert.equal(expanded(), 'false')
    await h.act(() => h.container.querySelector('button')!.click())
    await h.group({ segments: [tool('one', 'succeeded')], pending: false, connectionPhase: 'live' })
    assert.equal(expanded(), 'true')
  } finally {
    await h.close()
  }
})

test('Markdown images keep absolute URLs and resolve relative images under the authenticated workbench', async () => {
  const h = harness()
  try {
    const html = h.markdown(
      '![Desktop](https://tobs.thready.org/dsh-bot/coffee-page/preview/desktop.jpg)\n\n![Mobile](coffee-page/preview/mobile.png)',
    )
    assert.match(html, /src="https:\/\/tobs\.thready\.org\/dsh-bot\/coffee-page\/preview\/desktop.jpg"/)
    assert.match(html, /src="\/dsh-bot\/coffee-page\/preview\/mobile.png"/)
    assert.doesNotMatch(h.markdown('![unsafe](javascript:alert)'), /src="javascript:/)
  } finally {
    await h.close()
  }
})
