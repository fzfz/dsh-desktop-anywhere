import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
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

async function createDeletionCommandFixture(failure: 'persistence' | 'workspace-detach' | 'workspace-archive' | 'none') {
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
  const agents = new Map([[targetId, { id: targetId }]])
  const stored = new Map([[targetId, targetSession.header], [keptId, keptSession.header]])
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const removalEvents: string[] = []
  const client = { ids: [targetId, keptId], selected: targetId as string | undefined }
  let persistenceFailures = failure === 'persistence' ? 1 : 0
  let workspaceFailures = failure.startsWith('workspace-') ? 1 : 0
  let persistenceDeleteCalls = 0
  let workspaceForgetCalls = 0

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
  const workspaceRegistry = {
    beginSessionDeletion: (id: typeof targetId) => actualWorkspaceRegistry.beginSessionDeletion(id),
    isSessionDeletionPending: (id: typeof targetId) => actualWorkspaceRegistry.isSessionDeletionPending(id),
    async forgetSession(id: typeof targetId) {
      workspaceForgetCalls += 1
      await actualWorkspaceRegistry.forgetSession(id)
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
    }
  }>('dsh-api-session-controller', 'agent.js')
  const { SessionCommandController } = await importDependencyModule<{
    SessionCommandController: new (ctx: unknown, agents: unknown, defaultCwd: string) => {
      delete(request: { sessionId: typeof targetId }): Promise<{ deleted: true }>
    }
  }>('dsh-api-session-controller', 'commands.js')
  const agentController = new ApiSessionAgentController(ctx)
  agentController.retainHandle({
    agent: agents.get(targetId),
    async dispose() {
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

  return {
    command,
    targetId,
    keptId,
    client,
    stored,
    workspaceRegistry: actualWorkspaceRegistry,
    get workspaceSessionIds() { return [...(actualWorkspaceRegistry.list()[0]?.sessionIds ?? [])] },
    get archivedSessionIds() { return [...actualWorkspaceRegistry.archivedSessionIds] },
    get pendingSessionDeletionIds() { return [...workspaceState.pendingSessionDeletionIds] },
    removalEvents,
    calls: () => ({ persistenceDeleteCalls, workspaceForgetCalls }),
  }
}

const patchedPackages = [
  {
    name: 'dsh-session-persistence',
    file: 'lib/index.js',
    markers: ['assertDeletable(id)', 'async delete(id)', 'await this.backend.deleteStored(id)'],
  },
  {
    name: 'dsh-session-persistence-jsonl',
    file: 'lib/index.js',
    markers: ['delete(id) {', 'return this.coordinator.delete(id)', 'async deleteStored(id)'],
  },
  {
    name: 'dsh-workspace',
    file: 'lib/index.js',
    markers: ['beginSessionDeletion(sessionId)', 'pendingSessionDeletionIds', 'forgetSession(sessionId)'],
  },
  {
    name: 'dsh-api-session-controller',
    file: 'lib/index.js',
    markers: ['disposeOwned(sessionId)', 'await persistence.delete(request.sessionId)', 'workspaceRegistry.forgetSession(request.sessionId)'],
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
      readFile(path.join(repositoryRoot, 'patches', `${name}@0.1.2-rc.1.patch`), 'utf8'),
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
    const event = [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }] as const

    try {
      await persistence.create({ version: SESSION_FORMAT_VERSION, id: removed, createdAt: 1, isSeeded: false })
      await persistence.append(removed, event)
      await persistence.create({ version: SESSION_FORMAT_VERSION, id: kept, createdAt: 2, isSeeded: false })
      await persistence.append(kept, event)

      expect(await persistence.delete(removed)).toBe(true)
      expect((await persistence.list()).map(header => header.id)).toEqual([kept])
      await expect(persistence.load(removed)).rejects.toThrow(/not found/i)
      expect((await persistence.load(kept)).meta.id).toBe(kept)
      expect(await persistence.delete(SessionId('desktop-delete-missing'))).toBe(false)
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

      await expect(fixture.command.delete({ sessionId: fixture.targetId })).resolves.toEqual({ deleted: true })
      expect([...fixture.stored.keys()]).toEqual([fixture.keptId])
      expect(fixture.workspaceSessionIds).toEqual([fixture.keptId])
      expect(fixture.archivedSessionIds).toEqual([fixture.keptId])
      expect(fixture.client).toEqual({ ids: [fixture.keptId], selected: undefined })
      expect(fixture.removalEvents).toEqual([fixture.targetId])
      expect([...fixture.pendingSessionDeletionIds]).toEqual([])
      expect(fixture.calls()).toEqual({ persistenceDeleteCalls: 2, workspaceForgetCalls: 2 })
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
    expect(fixture.calls()).toEqual({ persistenceDeleteCalls: 0, workspaceForgetCalls: 0 })
    expect([...fixture.stored.keys()]).toEqual([fixture.targetId, fixture.keptId])
  })
})
