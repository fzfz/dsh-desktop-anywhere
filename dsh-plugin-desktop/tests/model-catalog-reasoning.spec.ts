import { readFile } from 'node:fs/promises'
import { act, createElement, useState, type ComponentType } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as react from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface CatalogModel {
  id: string
  [key: string]: unknown
}

const catalogModuleId: string = '@earendil-works/pi-ai/providers/all'
const jsdomModuleId: string = 'jsdom'
const { getBuiltinModels } = await import(catalogModuleId) as {
  getBuiltinModels(provider: string): CatalogModel[]
}
const { JSDOM } = await import(jsdomModuleId) as {
  JSDOM: new (html: string) => { window: any }
}

interface ModelRow {
  reasoningEfforts?: false | Record<string, string | null>
  reasoning?: { efforts?: Array<{ id?: string }> }
}

type ReasoningHelpers = {
  parseEffortList: (text: string) => string[]
  configuredReasoningEfforts: (model: ModelRow) => Record<string, string | null>
  reasoningEffortIds: (model: ModelRow) => string[]
  nextReasoningEfforts: (
    model: ModelRow,
    ids: string[]
  ) => Record<string, string | null> | undefined
}

const clientUrl = new URL(
  '../node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js',
  import.meta.url
)

type ReasoningFieldProps = {
  model: ModelRow & { id?: string }
  index: number
  t: (key: string) => string
  disabled: boolean
  onChange: (next: Record<string, string | null> | undefined) => void
}

async function loadReasoningField(): Promise<ComponentType<ReasoningFieldProps>> {
  const client = await readFile(clientUrl, 'utf8')
  const instrumented = client.replace(
    '\t\texports.apply = apply;',
    '\t\texports.__test = { ModelReasoningEffortsField };\n\t\texports.apply = apply;'
  )
  let field: ComponentType<ReasoningFieldProps> | undefined
  const moduleWindow = {
    __ModuleLoader__: {
      load(definition: {
        factory: (require: (id: string) => unknown) => {
          __test: { ModelReasoningEffortsField: ComponentType<ReasoningFieldProps> }
        }
      }) {
        const exported = definition.factory((id) => {
          if (id === 'react') return react
          if (id === 'react/jsx-runtime') return jsxRuntime
          if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (id === '@deepseek-ai/dsh-client-store') return {}
          throw new Error(`Unexpected bundled dependency: ${id}`)
        })
        field = exported.__test.ModelReasoningEffortsField
      }
    }
  }
  new Function('window', instrumented)(moduleWindow)
  expect(field).toBeDefined()
  return field!
}

afterEach(() => vi.unstubAllGlobals())

async function loadReasoningHelpers(): Promise<ReasoningHelpers> {
  const client = await readFile(clientUrl, 'utf8')
  const names = [
    'configuredReasoningEfforts',
    'parseEffortList',
    'reasoningEffortIds',
    'nextReasoningEfforts'
  ]
  const sources = names.map(name => {
    const source = client.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\t\\t\\}`))?.[0]
    expect(source, `${name} source`).toBeDefined()
    return source
  })
  return new Function(`${sources.join(';')};return { ${names.join(', ')} }`)() as ReasoningHelpers
}

describe('OpenCode Go Stable model catalog', () => {
  it('ships the four requested 0.84.4 models with their runtime capabilities', () => {
    const catalog = new Map(getBuiltinModels('opencode-go').map(model => [model.id, model]))

    expect(catalog.get('qwen3.8-flash')).toMatchObject({
      name: 'Qwen3.8 Flash',
      api: 'anthropic-messages',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 131_072
    })
    expect(catalog.get('glm-5.3-flash')).toMatchObject({
      api: 'openai-completions',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { low: 'low', high: 'high', max: 'max' }
    })
    expect(catalog.get('hy4-preview')).toMatchObject({
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      thinkingLevelMap: { off: 'none', high: 'high' }
    })
    expect(catalog.get('grok-4.6')).toMatchObject({
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh'
      }
    })
  })

  it('uses pi-ai 0.84.4 rather than a hand-maintained catalog patch', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../node_modules/@earendil-works/pi-ai/package.json', import.meta.url),
      'utf8'
    )) as { version: string }

    expect(manifest.version).toBe('0.84.4')
  })
})

describe('custom provider model reasoning settings', () => {
  it('preserves provider wire aliases and saves identity mappings for new levels', async () => {
    const { parseEffortList, nextReasoningEfforts } = await loadReasoningHelpers()
    const current: ModelRow = {
      reasoningEfforts: { off: null, high: 'default', max: 'ultra' }
    }

    expect(nextReasoningEfforts(
      current,
      parseEffortList('off, low, high, max, xhigh')
    )).toEqual({
      off: null,
      low: 'low',
      high: 'default',
      max: 'ultra',
      xhigh: 'xhigh'
    })
  })

  it('migrates legacy values on edit and clears an empty declaration', async () => {
    const { reasoningEffortIds, nextReasoningEfforts } = await loadReasoningHelpers()
    const legacy: ModelRow = {
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }
    }

    expect(reasoningEffortIds(legacy)).toEqual(['low', 'high'])
    expect(nextReasoningEfforts(legacy, ['low', 'high'])).toEqual({
      low: 'low',
      high: 'high'
    })
    expect(nextReasoningEfforts(legacy, [])).toBeUndefined()
  })

  it('preserves original aliases while the real input is cleared and retyped character by character', async () => {
    const dom = new JSDOM('<div id="root"></div>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement)
    vi.stubGlobal('Event', dom.window.Event)
    vi.stubGlobal('navigator', dom.window.navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

    const reactDomClientModuleId: string = 'react-dom/client'
    const { createRoot } = await import(reactDomClientModuleId) as {
      createRoot(container: Element): {
        render(node: ReturnType<typeof createElement>): void
        unmount(): void
      }
    }
    const Field = await loadReasoningField()
    const initial = {
      id: 'provider-model',
      name: 'Provider model',
      contextWindow: 128_000,
      reasoningEfforts: { off: null, high: 'default' }
    }
    type SavedModel = Omit<typeof initial, 'reasoningEfforts'> & {
      reasoningEfforts?: Record<string, string | null>
    }
    let saved: SavedModel = initial

    function Owner() {
      const [model, setModel] = useState<SavedModel>(initial)
      return createElement(Field, {
        model,
        index: 0,
        t: key => key,
        disabled: false,
        onChange: next => {
          const { reasoningEfforts: _removed, ...unchanged } = model
          saved = {
            ...unchanged,
            ...(next === undefined ? {} : { reasoningEfforts: next })
          }
          setModel(saved)
        }
      })
    }

    const container = dom.window.document.querySelector('#root')!
    const root = createRoot(container)
    await act(async () => root.render(createElement(Owner)))
    const input = container.querySelector('input')!
    expect(input.value).toBe('off, high')

    const write = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!
          .set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }
    await write('')
    expect(saved).toEqual({
      id: 'provider-model',
      name: 'Provider model',
      contextWindow: 128_000
    })
    await write('o')
    expect(saved.reasoningEfforts).toEqual({ o: 'o' })
    await write('of')
    await write('off')
    expect(saved.reasoningEfforts).toEqual({ off: null })
    for (const value of ['off,', 'off, ', 'off, h', 'off, hi', 'off, hig']) {
      await write(value)
    }
    expect(saved.reasoningEfforts).toEqual({ off: null, hig: 'hig' })
    await write('off, high')

    expect(saved).toEqual({
      id: 'provider-model',
      name: 'Provider model',
      contextWindow: 128_000,
      reasoningEfforts: { off: null, high: 'default' }
    })
    expect(input.value).toBe('off, high')
    await act(async () => root.unmount())
  })

  it('wires the editor to the canonical field without dropping the model row', async () => {
    const client = await readFile(clientUrl, 'utf8')
    const patch = await readFile(
      new URL('../../patches/dsh-client-ui-settings-models@0.1.2-rc.1.patch', import.meta.url),
      'utf8'
    )

    expect(client).toContain('patch(index, { reasoningEfforts: next, reasoning: void 0 });')
    expect(client).toContain('reasoningEfforts: original.current.reasoningEfforts')
    expect(client).toContain('modelReasoningLevels: "Reasoning effort levels"')
    expect(client).toContain('modelAdvanced: "模型设置"')
    expect(client).toContain('Saved IDs become selectable for this model in chat.')
    expect(client).toContain('保存后，会话可为此模型选择这些等级。')
    expect(client).toContain('className: "dshProviderEditorStickyFooter"')
    expect(patch).toContain('function nextReasoningEfforts(model, ids)')
    expect(patch).toContain('reasoningEfforts: next')
  })
})
