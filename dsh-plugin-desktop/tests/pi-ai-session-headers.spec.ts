import { afterEach, describe, expect, it, vi } from 'vitest'

const adapterModuleId: string = '@deepseek-ai/dsh-llm-pi-ai'
const llmModuleId: string = '@deepseek-ai/dsh-llm'
const providerModuleId: string = '@earendil-works/pi-ai/providers/opencode-go'
const { PiAiAdapter } = await import(adapterModuleId) as {
  PiAiAdapter: new (options: Record<string, unknown>) => {
    prepareCall(provider: string, model: string): Promise<{ stream(options: Record<string, unknown>): AsyncIterable<unknown> }>
    stream(options: Record<string, unknown>): AsyncIterable<unknown>
  }
}
const { resolveRetryPolicy } = await import(llmModuleId) as {
  resolveRetryPolicy(value: Record<string, unknown>, source: string): unknown
}
const { opencodeGoProvider } = await import(providerModuleId) as {
  opencodeGoProvider(): unknown
}

const sessionHeader = 'x-deepseek-harness-session-id'

afterEach(() => vi.unstubAllGlobals())

function fixture(headers: Record<string, string> = {}) {
  const requests: Array<{ url: string; headers: Headers; body: string }> = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: String(init?.body)
    })
    return new Response(JSON.stringify({ error: { message: 'End request capture' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  })
  const profiles = new Map([
    ['opencode-go', {
      provider: 'opencode-go',
      displayName: 'OpenCode Go',
      headers,
      piProvider: opencodeGoProvider(),
      streamIdleTimeoutMs: 5000,
      configuredMaxTokens: new Map(),
      maxRequestImageBytes: 1024,
      requestImagePixelBudget: 1024,
      requestImageMaxBytes: 1024,
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test')
    }]
  ])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => 'test-key',
    auth: {}
  })

  async function send(sessionId?: string | number, model = 'deepseek-v4-flash', prepared = false) {
    const options = {
      provider: 'opencode-go',
      model,
      ...(sessionId === undefined ? {} : { sessionId }),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(sessionId ?? 'no-session') }] }],
      maxTokens: 8
    }
    const call = prepared ? await adapter.prepareCall('opencode-go', model) : adapter
    for await (const _chunk of call.stream(options)) { /* Consume through HTTP dispatch. */ }
  }

  return { requests, send }
}

describe('pi-ai Harness session request identity', () => {
  it.each([
    ['ordinary session', 'session-parent', 'deepseek-v4-flash', '/chat/completions'],
    ['child session', 'session-child', 'minimax-m3', '/messages'],
    ['image-reading session', 'session-image-reader', 'gpt-5.6-luna', '/responses']
  ])('sends the real ID for an %s', async (_kind, sessionId, model, endpoint) => {
    const { send, requests } = fixture()
    await send(sessionId, model)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain(endpoint)
    expect(requests[0]!.headers.get(sessionHeader)).toBe(sessionId)
    expect(requests[0]!.headers.get('user-agent')).toContain('deepseek-harness/')
  })

  it('keeps prepared and concurrent session identities isolated', async () => {
    const { send, requests } = fixture()
    await send('session-parent')
    await send('session-parent', 'deepseek-v4-flash', true)
    await Promise.all([send('session-child'), send('session-image-reader')])

    expect(requests.map(request => request.headers.get(sessionHeader)).sort()).toEqual([
      'session-child',
      'session-image-reader',
      'session-parent',
      'session-parent'
    ])
    for (const request of requests) {
      expect(JSON.parse(request.body).messages[0].content).toBe(request.headers.get(sessionHeader))
    }
  })

  it('overrides a configured session header case-insensitively and keeps custom headers', async () => {
    const { send, requests } = fixture({
      'X-DeepSeek-Harness-Session-ID': 'stale-session',
      'x-custom-header': 'retained'
    })
    await send(42)

    expect(requests[0]!.headers.get(sessionHeader)).toBe('42')
    expect(requests[0]!.headers.get('x-custom-header')).toBe('retained')
  })

  it('does not invent an ID when a call has no session', async () => {
    const { send, requests } = fixture({
      'X-DeepSeek-Harness-Session-ID': 'stale-session',
      'x-custom-header': 'retained'
    })
    await send()

    expect(requests[0]!.headers.has(sessionHeader)).toBe(false)
    expect(requests[0]!.headers.get('x-custom-header')).toBe('retained')
  })
})
