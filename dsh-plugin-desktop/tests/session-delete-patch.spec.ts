import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import WorkspaceRegistry, { WorkspaceId, workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'

const workspaceRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(workspaceRoot, '..')
const dependencyRoot = path.join(workspaceRoot, 'node_modules', '@deepseek-ai')

async function importDependencyModule<T>(name: string, file: string): Promise<T> {
  return import(pathToFileURL(path.join(dependencyRoot, name, 'lib', 'types', file)).href) as Promise<T>
}

async function createDeletionCommandFixture(
  failure: 'persistence' | 'workspace-detach' | 'workspace-archive' | 'none',
  activity: 'idle' | 'running' | 'queued' = 'idle',
  hooks?: {
    admitPromptContent?(content: readonly unknown[]): Promise<readonly unknown[]>
    afterWorkspaceBegin?(): Promise<void>
  },
) {
  const targetId = SessionId(`desktop-delete-${failure}`)
  const keptId = SessionId(`desktop-keep-${failure}`)
  const targetSession = {
    id: targetId,
    header: { version: SESSION_FORMAT_VERSION, id: targetId, createdAt: 1, isSeeded: false, cwd: '/tmp' },
    snapshotEvents: () => [],
  }
  const keptSession = {
    id: keptId,
    header: { version: SESSION_FORMAT_VERSION, id: keptId, createdAt: 2, isSeeded: false, cwd: '/tmp' },
    snapshotEvents: () => [],
  }
  const sessions = new Map([[targetId, targetSession], [keptId, keptSession]])
  const targetAgent = {
    id: targetId,
    session: targetSession,
    status: activity === 'running' ? 'running' : 'idle',
    inbox: {
      nextTurn: activity === 'queued' ? [{ id: 'queued-work' }] : [],
      nextStep: [],
    },
  }
  const agents = new Map([[targetId, targetAgent]])
  const stored = new Map([[targetId, targetSession.header], [keptId, keptSession.header]])
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const removalEvents: string[] = []
  const client = { ids: [targetId, keptId], selected: targetId as string | undefined }
  let persistenceFailures = failure === 'persistence' ? 1 : 0
  let workspaceFailures = failure.startsWith('workspace-') ? 1 : 0
  let persistenceDeleteCalls = 0
  let workspaceBeginCalls = 0
  let workspaceForgetCalls = 0
  let disposeCalls = 0
  let admittedMessages = 0

  const persistence = {
    async delete(id: typeof targetId) {
      persistenceDeleteCalls += 1
      if (persistenceFailures-- > 0) throw new Error('injected persistence deletion failure')
      return stored.delete(id)
    },
  }
  const workspaceId = WorkspaceId(`workspace-${failure}`)
  const workspaceRecords = new Map([[workspaceId, {
    path: '/tmp',
    title: 'Deletion fixture',
    sessionIds: [targetId, keptId],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }]])
  let workspaceState = {
    initialized: true,
    workspaceIds: [workspaceId],
    archivedSessionIds: [targetId, keptId],
    pendingSessionDeletionIds: [] as Array<typeof targetId>,
  }
  const workspaceTable = {
    get size() { return workspaceRecords.size },
    entries: () => workspaceRecords.entries(),
    keys: () => workspaceRecords.keys(),
    get: (id: typeof workspaceId) => workspaceRecords.get(id),
    async put(id: typeof workspaceId, value: (typeof workspaceRecords extends Map<unknown, infer V> ? V : never)) {
      workspaceRecords.set(id, value)
    },
    async update(id: typeof workspaceId, update: (current: NonNullable<ReturnType<typeof workspaceRecords.get>>) => NonNullable<ReturnType<typeof workspaceRecords.get>>) {
      if (failure === 'workspace-detach' && workspaceFailures-- > 0) {
        throw new Error('injected workspace detach failure')
      }
      const current = workspaceRecords.get(id)
      if (!current) throw new Error(`unknown workspace ${id}`)
      const next = update(current)
      workspaceRecords.set(id, next)
      return next
    },
    async delete(id: typeof workspaceId) {
      return workspaceRecords.delete(id)
    },
  }
  const workspaceGlobal = {
    async set(next: typeof workspaceState) {
      if (failure === 'workspace-archive'
        && !next.pendingSessionDeletionIds.includes(targetId)
        && workspaceFailures-- > 0) {
        throw new Error('injected workspace archive write failure')
      }
      workspaceState = next
    },
  }
  const actualWorkspaceRegistry = new WorkspaceRegistry(new Context())
  Object.assign(actualWorkspaceRegistry, {
    table: workspaceTable,
    global: workspaceGlobal,
    state: workspaceState,
    sessionPaths: new Map([[targetId, '/tmp'], [keptId, '/tmp']]),
  })
  ;(actualWorkspaceRegistry as unknown as { rebuildEntities(): void }).rebuildEntities()
  let activeWorkspaceRegistry = actualWorkspaceRegistry
  const workspaceRegistry = {
    async beginSessionDeletion(id: typeof targetId) {
      workspaceBeginCalls += 1
      await activeWorkspaceRegistry.beginSessionDeletion(id)
      await hooks?.afterWorkspaceBegin?.()
    },
    isSessionDeletionPending: (id: typeof targetId) => activeWorkspaceRegistry.isSessionDeletionPending(id),
    async forgetSession(id: typeof targetId) {
      workspaceForgetCalls += 1
      await activeWorkspaceRegistry.forgetSession(id)
    },
  }
  const ctx = {
    typert: {
      lookups: { configure() {} },
      contexts: { configureHost() {} },
    },
    sessions: { get: (id: typeof targetId) => sessions.get(id) },
    agents: {
      get: (id: typeof targetId) => agents.get(id),
      isOwnedBy: () => false,
    },
    workspaceRegistry,
    llm: {
      listProviders: () => [{ id: 'fixture-provider' }],
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
    attachments: {
      admitPromptContent: hooks?.admitPromptContent ?? (async (content: readonly unknown[]) => content),
    },
    fileUploads: {
      resolve: () => undefined,
      bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
    },
    get(name: string) {
      return name === 'sessionPersistence' ? persistence : undefined
    },
    sessionQuery: {
      async observeSession(id: typeof targetId) {
        const header = stored.get(id)
        if (!header) throw new SessionQueryError(`session "${id}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
        return { header, inheritedEventCount: 0, events: [], [Symbol.dispose]() {} }
      },
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
    },
    emit(name: string, ...args: unknown[]) {
      if (name === 'api-session/removed') removalEvents.push(String(args[0]))
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
  const { ApiSessionAgentController } = await importDependencyModule<{
    ApiSessionAgentController: new (ctx: unknown) => {
      retainHandle(handle: unknown): unknown
      isRemovalDeferred?(id: string): boolean
      resolveAgent(id: typeof targetId): Promise<{ agent: unknown } | { error: { code: string } }>
      ensureSession(id: typeof targetId, cwd: string, checkPersistedIdentity: boolean): Promise<unknown>
      selectionFor(agent: unknown): { current: { provider: string, model: string } }
    }
  }>('dsh-api-session-controller', 'agent.js')
  const { SessionCommandController } = await importDependencyModule<{
    SessionCommandController: new (ctx: unknown, agents: unknown, defaultCwd: string) => {
      delete(request: { sessionId: typeof targetId }): Promise<{ deleted: true }>
      prompt(request: {
        requestId: string
        sessionId: typeof targetId
        mode: 'queue' | 'steer'
        content: readonly unknown[]
      }): Promise<{ accepted: true }>
    }
  }>('dsh-api-session-controller', 'commands.js')
  const agentController = new ApiSessionAgentController(ctx)
  agentController.selectionFor = () => ({ current: { provider: 'fixture-provider', model: 'fixture-model' } })
  agentController.retainHandle({
    agent: Object.assign(agents.get(targetId)!, {
      followup() { admittedMessages += 1 },
      steer() { admittedMessages += 1 },
    }),
    async dispose() {
      disposeCalls += 1
      agents.delete(targetId)
      const removed = sessions.get(targetId)
      sessions.delete(targetId)
      if (removed) ctx.emit('session/disposed', removed)
    },
  })
  ctx.on('api-session/removed', (sessionId: unknown) => {
    const id = String(sessionId)
    client.ids = client.ids.filter(candidate => candidate !== id)
    if (client.selected === id) client.selected = undefined
  })
  ctx.on('session/disposed', (session: unknown) => {
    const id = (session as { id: string }).id
    if (agentController.isRemovalDeferred?.(id) === true) return
    ctx.emit('api-session/removed', id)
  })
  const command = new SessionCommandController(ctx, agentController, '/tmp')
  const restart = () => {
    const reloadedRegistry = new WorkspaceRegistry(new Context())
    Object.assign(reloadedRegistry, {
      table: workspaceTable,
      global: workspaceGlobal,
      state: workspaceDomainState.parse(workspaceState),
      sessionPaths: new Map([[targetId, '/tmp'], [keptId, '/tmp']]),
    })
    ;(reloadedRegistry as unknown as { rebuildEntities(): void }).rebuildEntities()
    activeWorkspaceRegistry = reloadedRegistry
    const reloadedAgentController = new ApiSessionAgentController(ctx)
    reloadedAgentController.selectionFor = () => ({ current: { provider: 'fixture-provider', model: 'fixture-model' } })
    return new SessionCommandController(ctx, reloadedAgentController, '/tmp')
  }

  return {
    command,
    agentController,
    targetId,
    keptId,
    client,
    stored,
    restart,
    get workspaceRegistry() { return activeWorkspaceRegistry },
    get workspaceSessionIds() { return [...(activeWorkspaceRegistry.list()[0]?.sessionIds ?? [])] },
    get archivedSessionIds() { return [...activeWorkspaceRegistry.archivedSessionIds] },
    get pendingSessionDeletionIds() { return [...workspaceState.pendingSessionDeletionIds] },
    removalEvents,
    get admittedMessages() { return admittedMessages },
    calls: () => ({ persistenceDeleteCalls, workspaceBeginCalls, workspaceForgetCalls, disposeCalls }),
  }
}

const patchedPackages = [
  {
    name: 'dsh-session-persistence',
    file: 'lib/index.js',
    markers: ['delete(_id)', 'this session persistence backend does not support deletion'],
  },
  {
    name: 'dsh-session-persistence-jsonl',
    file: 'lib/index.js',
    markers: ['async delete(id)', 'this.tracker.assertDeletable(id)', 'for (const generation of generations)'],
  },
  {
    name: 'dsh-workspace',
    file: 'lib/index.js',
    markers: ['beginSessionDeletion(sessionId)', 'pendingSessionDeletionIds', 'forgetSession(sessionId)'],
  },
  {
    name: 'dsh-api-session-controller',
    file: 'lib/index.js',
    markers: [
      'beginDeletion(sessionId)',
      'isActivationPending(sessionId)',
      'has active or queued work',
      'await persistence.delete(request.sessionId)',
      'workspaceRegistry.forgetSession(request.sessionId)',
    ],
  },
  {
    name: 'dsh-api-session-controller',
    file: 'lib/client.js',
    markers: ['SessionDeleteError', 'this.remote.session.delete({ sessionId })', 'if (this.watched === sessionId) this.watched = void 0'],
  },
  {
    name: 'dsh-api-session-controller',
    file: 'lib/typert.host.js',
    markers: ["id: '@deepseek-ai/dsh-api-session-controller#session/delete'", "method: 'delete'"],
  },
  {
    name: 'dsh-api-remotes',
    file: 'lib/client.js',
    markers: [
      'const _deepseek_ai_dsh_api_session_controller_session_delete_parameter_0$schema',
      'id: "@deepseek-ai/dsh-api-session-controller#session/delete"',
      'method: "delete"',
    ],
  },
  {
    name: 'dsh-client-ui-workspace',
    file: 'lib/client.js',
    markers: ['delete.session', 'danger: true', 'Workspace files are kept', 'await sessions.delete(sessionId)'],
  },
] as const

describe('permanent session deletion dependency patches', () => {
  it.each(patchedPackages)('$name patch is reproducible and installed', async ({ name, file, markers }) => {
    const [patch, installed] = await Promise.all([
      readFile(path.join(repositoryRoot, 'patches', `${name}@0.1.5-rc.1.patch`), 'utf8'),
      readFile(path.join(workspaceRoot, 'node_modules', '@deepseek-ai', name, file), 'utf8'),
    ])

    for (const marker of markers) {
      expect(patch).toContain(marker)
      expect(installed).toContain(marker)
    }
  })

  it('states the deletion boundary in both locales', async () => {
    const ui = await readFile(
      path.join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
      'utf8',
    )

    expect(ui).toContain('工作区文件会保留。此操作无法撤销。')
    expect(ui).toContain('Workspace files are kept. This can’t be undone.')
  })

  it('mounts session/delete exactly once from the aggregate Client Remote', async () => {
    const source = await readFile(
      path.join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js'),
      'utf8',
    )
    let registration: {
      factory(require: (id: string) => never): {
        apply(ctx: {
          remote: {
            $mount(contribution: { descriptors: Array<{ id: string }> }): Promise<() => void>
          }
        }): Promise<() => Promise<void>>
      }
    } | undefined

    runInNewContext(source, {
      window: {
        __ModuleLoader__: {
          load(value: typeof registration) {
            registration = value
          },
        },
      },
    })

    expect(registration).toBeDefined()
    if (!registration) throw new Error('aggregate Client Remote did not register with ModuleLoader')

    const contributions: Array<{ descriptors: Array<{ id: string }> }> = []
    const clientRemote = registration.factory((id) => {
      throw new Error(`unexpected aggregate Client Remote dependency: ${id}`)
    })
    const dispose = await clientRemote.apply({
      remote: {
        async $mount(contribution) {
          contributions.push(contribution)
          return () => undefined
        },
      },
    })
    const deleteDescriptors = contributions
      .flatMap(contribution => contribution.descriptors)
      .filter(({ id }) => id === '@deepseek-ai/dsh-api-session-controller#session/delete')

    expect(deleteDescriptors).toHaveLength(1)
    await dispose()
  })

  it('removes one materialized JSONL log without touching another session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-session-delete-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & {
      delete(id: ReturnType<typeof SessionId>): Promise<boolean>
    }
    const removed = SessionId('desktop-delete-removed')
    const kept = SessionId('desktop-delete-kept')

    try {
      const removedHandle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: removed,
        createdAt: 1,
        isSeeded: false,
      })
      await removedHandle.flush()
      await expect(persistence.delete(removed)).rejects.toThrow(/persistence handle is open/)
      await removedHandle.close()

      const keptHandle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: kept,
        createdAt: 2,
        isSeeded: false,
      })
      await keptHandle.flush()
      await keptHandle.close()

      expect(await persistence.delete(removed)).toBe(true)
      expect((await persistence.list()).map(snapshot => snapshot.header.id)).toEqual([kept])
      await expect(persistence.open(removed, 'read')).rejects.toThrow(/not found/i)
      const keptRead = await persistence.open(kept, 'read')
      expect(keptRead.header.id).toBe(kept)
      await keptRead.close()
      expect(await persistence.delete(SessionId('desktop-delete-missing'))).toBe(false)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the latest JSONL generation available when an older-generation deletion fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-session-delete-generations-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & {
      delete(id: ReturnType<typeof SessionId>): Promise<boolean>
      removeGeneration(path: string): Promise<void>
    }
    const targetId = SessionId('desktop-delete-generations')

    try {
      const handle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: targetId,
        createdAt: 1,
        isSeeded: false,
      })
      await handle.flush()
      await handle.close()

      const currentName = `session.v${SESSION_FORMAT_VERSION}.jsonl`
      const currentRelative = (await readdir(root, { recursive: true })).find(entry => entry.endsWith(currentName))
      if (currentRelative === undefined) throw new Error(`materialized generation ${currentName} was not found`)
      const currentPath = path.join(root, currentRelative)
      const directory = path.dirname(currentPath)
      await copyFile(currentPath, path.join(directory, 'session.v1.jsonl'))
      await copyFile(currentPath, path.join(directory, 'session.v2.jsonl'))

      const removeGeneration = persistence.removeGeneration.bind(persistence)
      persistence.removeGeneration = async generationPath => {
        if (path.basename(generationPath) === 'session.v2.jsonl') {
          throw new Error('injected intermediate generation deletion failure')
        }
        await removeGeneration(generationPath)
      }
      await expect(persistence.delete(targetId)).rejects.toThrow(/intermediate generation deletion failure/)
      expect((await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort()).toEqual([
        'session.v2.jsonl',
        currentName,
      ].sort())
      const latest = await persistence.open(targetId, 'read')
      expect(latest.header.id).toBe(targetId)
      await latest.close()

      persistence.removeGeneration = removeGeneration
      await expect(persistence.delete(targetId)).resolves.toBe(true)
      await expect(persistence.open(targetId, 'read')).rejects.toThrow(/not found/i)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the Client list and selection readable when durable log deletion fails', async () => {
    const fixture = await createDeletionCommandFixture('persistence')

    await expect(fixture.command.delete({ sessionId: fixture.targetId })).rejects.toThrow(
      /injected persistence deletion failure/,
    )

    expect(fixture.client).toEqual({ ids: [fixture.targetId, fixture.keptId], selected: fixture.targetId })
    expect([...fixture.stored.keys()]).toEqual([fixture.targetId, fixture.keptId])
    expect(fixture.workspaceSessionIds).toEqual([fixture.targetId, fixture.keptId])
    expect(fixture.archivedSessionIds).toEqual([fixture.targetId, fixture.keptId])
    expect([...fixture.pendingSessionDeletionIds]).toEqual([fixture.targetId])
    expect(fixture.removalEvents).toEqual([])
  })

  it.each(['workspace-detach', 'workspace-archive'] as const)(
    'retries cleanup after an injected %s failure without changing another Session',
    async failure => {
      const fixture = await createDeletionCommandFixture(failure)

      await expect(fixture.command.delete({ sessionId: fixture.targetId })).rejects.toThrow(/injected workspace/)
      expect([...fixture.stored.keys()]).toEqual([fixture.keptId])
      expect(fixture.client).toEqual({ ids: [fixture.targetId, fixture.keptId], selected: fixture.targetId })
      expect([...fixture.pendingSessionDeletionIds]).toEqual([fixture.targetId])

      const retryCommand = fixture.restart()
      await expect(retryCommand.delete({ sessionId: fixture.targetId })).resolves.toEqual({ deleted: true })
      expect([...fixture.stored.keys()]).toEqual([fixture.keptId])
      expect(fixture.workspaceSessionIds).toEqual([fixture.keptId])
      expect(fixture.archivedSessionIds).toEqual([fixture.keptId])
      expect(fixture.client).toEqual({ ids: [fixture.keptId], selected: undefined })
      expect(fixture.removalEvents).toEqual([fixture.targetId])
      expect([...fixture.pendingSessionDeletionIds]).toEqual([])
      expect(fixture.calls()).toEqual({
        persistenceDeleteCalls: 2,
        workspaceBeginCalls: 2,
        workspaceForgetCalls: 2,
        disposeCalls: 1,
      })
    },
  )

  it('preserves a pending deletion across unrelated Workspace create/delete operations', async () => {
    const fixture = await createDeletionCommandFixture('workspace-detach')
    const unrelatedDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-unrelated-workspace-'))

    try {
      await expect(fixture.command.delete({ sessionId: fixture.targetId })).rejects.toThrow(
        /injected workspace detach failure/,
      )
      expect(fixture.pendingSessionDeletionIds).toEqual([fixture.targetId])

      const unrelated = await fixture.workspaceRegistry.create(unrelatedDirectory, 'Unrelated workspace')
      expect(fixture.pendingSessionDeletionIds).toEqual([fixture.targetId])
      await expect(fixture.workspaceRegistry.delete(unrelated.id)).resolves.toBe(true)
      expect(fixture.pendingSessionDeletionIds).toEqual([fixture.targetId])

      const durableState = (fixture.workspaceRegistry as unknown as { state: unknown }).state
      const reloadedState = workspaceDomainState.parse(durableState)
      const reloadedRegistry = new WorkspaceRegistry(new Context())
      Object.assign(reloadedRegistry, { state: reloadedState })
      expect(reloadedRegistry.isSessionDeletionPending(fixture.targetId)).toBe(true)

      await expect(fixture.command.delete({ sessionId: fixture.targetId })).resolves.toEqual({ deleted: true })
      expect(fixture.pendingSessionDeletionIds).toEqual([])
      expect(fixture.workspaceSessionIds).toEqual([fixture.keptId])
    } finally {
      await rm(unrelatedDirectory, { recursive: true, force: true })
    }
  })

  it.each(['running', 'queued'] as const)(
    'rejects an Agent with %s work before writing the durable deletion marker',
    async activity => {
      const fixture = await createDeletionCommandFixture('none', activity)

      await expect(fixture.command.delete({ sessionId: fixture.targetId })).rejects.toThrow(/active or queued work/)

      expect(fixture.pendingSessionDeletionIds).toEqual([])
      expect(fixture.calls()).toEqual({
        persistenceDeleteCalls: 0,
        workspaceBeginCalls: 0,
        workspaceForgetCalls: 0,
        disposeCalls: 0,
      })
      expect([...fixture.stored.keys()]).toEqual([fixture.targetId, fixture.keptId])
      expect(fixture.client).toEqual({ ids: [fixture.targetId, fixture.keptId], selected: fixture.targetId })
    },
  )

  it('blocks create and resume while permanent deletion owns the Session identity', async () => {
    const fixture = await createDeletionCommandFixture('none')

    const deletion = fixture.command.delete({ sessionId: fixture.targetId })
    const resolving = fixture.agentController.resolveAgent(fixture.targetId)
    const creating = fixture.agentController.ensureSession(fixture.targetId, '/tmp', true)

    const resolved = await resolving
    expect(resolved).toHaveProperty('error.code', 'session/agent-busy')
    await expect(creating).rejects.toMatchObject({ code: 'session/agent-busy' })
    await expect(deletion).resolves.toEqual({ deleted: true })
    expect(fixture.calls()).toEqual({
      persistenceDeleteCalls: 1,
      workspaceBeginCalls: 1,
      workspaceForgetCalls: 1,
      disposeCalls: 1,
    })
  })

  it('rejects a gated image prompt before admission can race with deletion', async () => {
    let markAdmissionStarted!: () => void
    let releaseAdmission!: () => void
    let markDeletionStarted!: () => void
    let releaseDeletion!: () => void
    const admissionStarted = new Promise<void>(resolve => { markAdmissionStarted = resolve })
    const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve })
    const deletionStarted = new Promise<void>(resolve => { markDeletionStarted = resolve })
    const deletionGate = new Promise<void>(resolve => { releaseDeletion = resolve })
    const fixture = await createDeletionCommandFixture('none', 'idle', {
      async admitPromptContent() {
        markAdmissionStarted()
        await admissionGate
        return [{
          type: 'image',
          attachment: {
            attachmentId: 'fixture-image',
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        }]
      },
      async afterWorkspaceBegin() {
        markDeletionStarted()
        await deletionGate
      },
    })

    const prompt = fixture.command.prompt({
      requestId: 'delete-admission-race',
      sessionId: fixture.targetId,
      mode: 'queue',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
    })
    await admissionStarted
    const deletion = fixture.command.delete({ sessionId: fixture.targetId })
    await deletionStarted
    releaseAdmission()

    await expect(prompt).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.admittedMessages).toBe(0)
    releaseDeletion()
    await expect(deletion).resolves.toEqual({ deleted: true })
  })

  it('does not release a replacement handle when an older handle finishes disposal', async () => {
    const targetId = SessionId('desktop-delete-handle-race')
    const firstSession = { id: targetId }
    const secondSession = { id: targetId }
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const ctx = {
      typert: {
        lookups: { configure() {} },
        contexts: { configureHost() {} },
      },
      on(name: string, listener: (...args: unknown[]) => void) {
        const entries = listeners.get(name) ?? []
        entries.push(listener)
        listeners.set(name, entries)
      },
      emit(name: string, ...args: unknown[]) {
        for (const listener of listeners.get(name) ?? []) listener(...args)
      },
    }
    const { ApiSessionAgentController } = await importDependencyModule<{
      ApiSessionAgentController: new (ctx: unknown) => {
        retainHandle(handle: unknown): unknown
        disposeOwned(id: typeof targetId): Promise<boolean>
      }
    }>('dsh-api-session-controller', 'agent.js')
    const controller = new ApiSessionAgentController(ctx)
    let firstDisposeStarted!: () => void
    let releaseFirstDispose!: () => void
    let secondDisposeCalls = 0
    const firstStarted = new Promise<void>(resolve => { firstDisposeStarted = resolve })
    const firstGate = new Promise<void>(resolve => { releaseFirstDispose = resolve })

    controller.retainHandle({
      agent: { id: targetId, session: firstSession },
      async dispose() {
        firstDisposeStarted()
        await firstGate
        ctx.emit('session/disposed', firstSession)
      },
    })
    const disposingFirst = controller.disposeOwned(targetId)
    await firstStarted
    controller.retainHandle({
      agent: { id: targetId, session: secondSession },
      async dispose() {
        secondDisposeCalls += 1
        ctx.emit('session/disposed', secondSession)
      },
    })
    releaseFirstDispose()

    await expect(disposingFirst).resolves.toBe(true)
    await expect(controller.disposeOwned(targetId)).resolves.toBe(true)
    expect(secondDisposeCalls).toBe(1)
  })

  it('rejects a subagent identity before disposal or durable mutation', async () => {
    const fixture = await createDeletionCommandFixture('none')
    const session = (fixture as unknown as { targetId: string }).targetId
    // Replace the live header at the command seam with the ownership marker used by Session routing.
    const commandContext = fixture.command as unknown as { ctx: { sessions: { get(id: string): { header: object } | undefined } } }
    const originalGet = commandContext.ctx.sessions.get
    commandContext.ctx.sessions.get = id => {
      const found = originalGet(id)
      return found && id === session ? { ...found, header: { ...found.header, origin: 'subagent' } } : found
    }

    await expect(fixture.command.delete({ sessionId: fixture.targetId })).rejects.toThrow(/subagent routing/)
    expect(fixture.calls()).toEqual({
      persistenceDeleteCalls: 0,
      workspaceBeginCalls: 0,
      workspaceForgetCalls: 0,
      disposeCalls: 0,
    })
    expect([...fixture.stored.keys()]).toEqual([fixture.targetId, fixture.keptId])
  })
})
