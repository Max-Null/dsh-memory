/**
 * @max-null/dsh-memory browser half (0.3.3): the memory panel, moved home
 * from dsh-ssid-panels (2026-08-19 用户: 记忆面板应跟随 dsh-memory)。
 * Data goes straight through the Typert `remote.memory` surface
 * (list/search/confirm/forget/setInjected/reload) — no /ssid/api bridge,
 * so any profile with dsh-memory gets the panel. Hosted on better-sidebar
 * as an optional peer (same pattern dsh-ssid-panels used); without it the
 * client half registers nothing.
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'

export const inject = ['slots', 'locale', 'remote', 'remote.memory']

// ---- i18n (DSH zh/en, plugin-center pattern) ----
type LocaleId = 'zh' | 'en'
const STRINGS = {
  zh: {
    tabMemory: '记忆',
    memorySearch: '搜索记忆…',
    empty: '黑暗中未见灵光',
    confirm: '确认',
    forget: '删除',
    groupPending: '待审核',
    groupOnDemand: '已审核 · 按需',
    groupInjected: '常驻注入',
    injectSwitch: '常驻注入',
    approveFirst: '审核通过后可常驻注入',
    allNamespaces: '全部',
    nsGlobal: '全局',
    nsProject: '项目',
    organizeMemory: '整理记忆',
    confirmAll: '全部确认',
    suggested: '待审核',
    approved: '已审核',
    refresh: '刷新',
  },
  en: {
    tabMemory: 'Memory',
    memorySearch: 'Search memory…',
    empty: 'No spark in the dark',
    confirm: 'Confirm',
    forget: 'Forget',
    groupPending: 'Pending review',
    groupOnDemand: 'Approved · on demand',
    groupInjected: 'Always injected',
    injectSwitch: 'Inject every turn',
    approveFirst: 'Approve to enable injection',
    allNamespaces: 'All',
    nsGlobal: 'Global',
    nsProject: 'Project',
    organizeMemory: 'Organize memory',
    confirmAll: 'Approve all',
    suggested: 'Suggested',
    approved: 'Approved',
    refresh: 'Refresh',
  },
} as const
type StringKey = keyof typeof STRINGS.zh
let localeId: LocaleId = 'zh'
const localeListeners = new Set<() => void>()
function adoptLocale(id: string | undefined): void {
  const next: LocaleId = id === 'en' ? 'en' : 'zh'
  if (next === localeId) return
  localeId = next
  localeListeners.forEach(l => l())
}
function fmt(tpl: string, vars: Record<string, unknown> = {}): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
}
function useT(): (key: StringKey, vars?: Record<string, unknown>) => string {
  const [id, setId] = useState(localeId)
  useEffect(() => {
    const l = (): void => { setId(localeId) }
    localeListeners.add(l)
    return () => { localeListeners.delete(l) }
  }, [])
  return (key, vars) => fmt(STRINGS[id][key] ?? STRINGS.zh[key], vars)
}

// ---- inline-styled primitives (no CSS build step) ----
const ssid = {
  accent: '#4FC3F7',
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
  card: {
    background: 'var(--dsw-alias-bg-layer-1, #131a26)',
    border: '1px solid var(--dsw-alias-border-l2, #1e2836)',
    borderRadius: 10,
    padding: '10px 12px',
  },
  title: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #67748a)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  text: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary, #d8e0ea)', lineHeight: 1.55 },
  muted: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #67748a)' },
  empty: { padding: '28px 12px', textAlign: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary, #67748a)' },
  btn: {
    padding: '3px 12px', fontSize: 11.5, background: 'none',
    border: '1px solid var(--dsw-alias-border-l2, #1e2836)', borderRadius: 6,
    color: 'var(--dsw-alias-label-primary, #d8e0ea)', cursor: 'pointer',
  },
} as const

// ---- remote.memory surface (Typert gateway: list/search/confirm/forget/setInjected/reload) ----
interface RemoteMemory {
  list(filter?: { namespace?: string, status?: string, injected?: boolean }): Promise<Array<{
    id: string, content: string, status: 'suggested' | 'approved', injected: boolean, namespace: string, keywords: string[]
  }>>
  reload(): Promise<Array<Record<string, unknown>>>
  confirm(id: string): Promise<Record<string, unknown>>
  forget(id: string): Promise<boolean>
  setInjected(id: string, injected: boolean): Promise<Record<string, unknown>>
}

// 预填指令（0.3.1+）：过时内容用 memory_update 修正；工具面自查法。
const ORGANIZE_PROMPT = '请整理我的记忆库：用 memory_list 查看全部记忆，合并重复或可归并的条目，精简冗长内容，为每条补充或修正 keywords；对过时、错误或已变化的内容用 memory_update 修正（会重置为待审核），需要删除的用 memory_forget，需要新增的用 memory_save。判断内容是否过时的方法：把记忆里提到的工具名/数量与你当前实际可用的记忆工具对照——你当前可用：memory_save / memory_list / memory_search / memory_confirm / memory_forget / memory_update（共 6 个）；若记忆中的工具列表、数量、流程与此不符即为过时，用 memory_update 修正。改动全部落在 suggested 等待审核（不要调用 memory_confirm），完成后用一句话汇报整理结果。'

interface MemoryViewProps {
  visible: boolean
  remote: RemoteMemory
  ctx: {
    get?: (name: string) => unknown
  }
}

function MemoryView(props: MemoryViewProps): ReactNode {
  const t = useT()
  const [records, setRecords] = useState<Awaited<ReturnType<RemoteMemory['list']>>>([])
  const [query, setQuery] = useState('')
  const [namespace, setNamespace] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const reload = async (): Promise<void> => {
    try {
      setRecords(await props.remote.list())
    } catch {
      setRecords([])
    }
  }
  // 强制重读存储文件（JsonStorageBackend 无 watch——外部编辑后必须 reload）
  const refreshFromDisk = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const value = await props.remote.reload()
      setRecords(value as Awaited<ReturnType<RemoteMemory['list']>>)
    } catch {
      await reload()
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => { if (props.visible) void reload() }, [props.visible])

  const toggleInjected = async (record: Awaited<ReturnType<RemoteMemory['list']>>[number]): Promise<void> => {
    if (record.status !== 'approved') return
    try {
      await props.remote.setInjected(record.id, !record.injected)
    } catch {
      /* 失败保持原状态 */
    }
    await reload()
  }

  const confirmAll = async (): Promise<void> => {
    const pending = records.filter(record => record.status === 'suggested')
    if (pending.length === 0) return
    await Promise.all(pending.map(record => props.remote.confirm(record.id).catch(() => null)))
    await reload()
  }

  // 一点即发整理：sessions.create → open → input 就绪（轮询 ≤5s）→ setDraft → submit。
  // 机制实证自 dsh-better-sidebar conversation-draft.ts；sessions/conversation 软获取。
  const organize = async (): Promise<void> => {
    if (organizing) return
    setOrganizing(true)
    try {
      const sessions = props.ctx.get?.('sessions') as {
        create(opts?: { workspaceId?: string, cwd?: string }): Promise<string>
        open(id: string): void
        scope(id: string): unknown
      } | undefined
      const conversation = props.ctx.get?.('conversation') as {
        input?: { for?(actx: unknown): { setDraft(text: string): void, submit(): void } | undefined }
      } | undefined
      if (sessions === undefined || conversation?.input?.for === undefined) {
        throw new Error('sessions/conversation unavailable')
      }
      const sessionId = await sessions.create({})
      sessions.open(sessionId)
      let input: { setDraft(text: string): void, submit(): void } | undefined
      for (let i = 0; i < 50; i++) {
        try {
          const actx = sessions.scope(sessionId)
          if (actx !== undefined) {
            input = conversation.input.for(actx)
            if (input !== undefined) break
          }
        } catch {
          /* not ready yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (input === undefined) throw new Error('composer input not ready')
      input.setDraft(ORGANIZE_PROMPT)
      input.submit()
    } catch (error) {
      console.warn('[dsh-memory] organize memory failed:', error)
    } finally {
      setOrganizing(false)
    }
  }

  const q = query.trim().toLowerCase()
  const byNs = namespace === null ? records : records.filter(record => record.namespace === namespace)
  const filtered = byNs.filter(record => q === '' || record.content.toLowerCase().includes(q))
  const groups: Array<{ key: string, label: string, items: typeof filtered }> = [
    { key: 'pending', label: t('groupPending'), items: filtered.filter(record => record.status === 'suggested') },
    { key: 'ondemand', label: t('groupOnDemand'), items: filtered.filter(record => record.status === 'approved' && !record.injected) },
    { key: 'injected', label: t('groupInjected'), items: filtered.filter(record => record.status === 'approved' && record.injected) },
  ].filter(group => group.items.length > 0)

  return createElement('div', { style: ssid.wrap },
    createElement('div', { style: { display: 'flex', gap: 6 } },
      createElement('button', {
        type: 'button',
        title: t('organizeMemory'),
        onClick: () => { void organize() },
        disabled: organizing,
        style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent },
      }, organizing ? '…' : t('organizeMemory')),
      createElement('input', {
        value: query,
        onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
        placeholder: t('memorySearch'),
        style: {
          flex: 1, padding: '6px 10px', fontSize: 12.5, boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-layer-1, #0f141d)',
          border: '1px solid var(--dsw-alias-border-l2, #1e2836)', borderRadius: 8,
          color: 'var(--dsw-alias-label-primary, #d8e0ea)', outline: 'none',
        },
      }),
      createElement('button', {
        type: 'button',
        title: t('refresh'),
        onClick: () => { void refreshFromDisk() },
        disabled: refreshing,
        style: ssid.btn,
      }, refreshing ? '…' : '↻'),
    ),
    createElement('div', { style: { display: 'flex', gap: 4 } },
      ([null, 'global', 'project'] as Array<string | null>).map(ns => createElement('button', {
        key: ns ?? 'all',
        onClick: () => { setNamespace(ns) },
        style: { flex: 1, ...ssid.btn, ...(namespace === ns ? { color: ssid.accent, borderColor: ssid.accent } : {}) },
      }, ns === null ? t('allNamespaces') : ns === 'global' ? t('nsGlobal') : t('nsProject'))),
    ),
    groups.length === 0
      ? createElement('div', { style: ssid.empty }, t('empty'))
      : groups.map(group => createElement('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('div', { style: ssid.title },
          createElement('span', null, group.label),
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            group.key === 'pending' && group.items.length > 0
              ? createElement('button', {
                type: 'button',
                title: t('confirmAll'),
                onClick: () => { void confirmAll() },
                style: { ...ssid.btn, padding: '1px 8px', fontSize: 10.5 },
              }, t('confirmAll'))
              : null,
            createElement('span', null, `${group.items.length}`),
          ),
        ),
        group.items.map(record => createElement('div', { key: record.id, style: ssid.card },
          createElement('div', { style: ssid.text }, record.content),
          createElement('div', { style: { ...ssid.muted, marginTop: 6 } },
            `${record.namespace} · ${record.status === 'approved' ? t('approved') : t('suggested')}${record.injected ? ` · ${t('groupInjected')}` : ''}`),
          createElement('div', { style: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' } },
            createElement('button', {
              type: 'button',
              title: record.status === 'approved' ? t('injectSwitch') : t('approveFirst'),
              disabled: record.status !== 'approved',
              onClick: () => { void toggleInjected(record) },
              style: {
                ...ssid.btn,
                ...(record.injected ? { color: ssid.accent, borderColor: ssid.accent } : {}),
                opacity: record.status !== 'approved' ? 0.4 : 1,
                cursor: record.status !== 'approved' ? 'not-allowed' : 'pointer',
              },
            }, record.injected ? `✓ ${t('injectSwitch')}` : t('injectSwitch')),
            record.status === 'suggested'
              ? createElement('button', {
                style: ssid.btn,
                onClick: () => { void props.remote.confirm(record.id).then(() => reload()) },
              }, t('confirm'))
              : null,
            createElement('button', {
              style: ssid.btn,
              onClick: () => { void props.remote.forget(record.id).then(() => reload()) },
            }, t('forget')),
          ),
        )),
      )),
  )
}

/** Locale service's minimal surface (optional read + change event). */
interface LocaleFace {
  getLocale?: () => { active?: string }
}
interface LocaleAwareContext {
  get?: (name: string) => unknown
  on?: (event: string, handler: (payload: unknown) => void) => void
}

// ---- client plugin body ----
export function apply(ctx: unknown): void {
  const face = ctx as LocaleAwareContext
  const locale = face.get?.('locale') as LocaleFace | undefined
  const initial = locale?.getLocale?.()?.active
  if (typeof initial === 'string') adoptLocale(initial)
  face.on?.('locale/change', (snap) => { adoptLocale((snap as { active?: string } | undefined)?.active) })

  const slots = (ctx as {
    slots?: {
      inject?(name: string, cb: () => unknown): void
      register?(descriptor: unknown, component: unknown): unknown
    }
  }).slots
  const remoteMemory = (ctx as { remote?: { memory?: RemoteMemory } }).remote?.memory

  // 兜底入口：设置页「记忆」条目——任何环境（无 better-sidebar 也）可管理记忆。
  // 与侧栏 tab 双入口并存（2026-08-19 用户：没有侧栏就没有管理面板的问题）。
  if (slots?.inject !== undefined && remoteMemory !== undefined) {
    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'dsh-memory',
      order: 60,
      label: () => STRINGS[localeId].tabMemory,
      inject: () => ({}),
    }, () => createElement(MemoryView, {
      visible: true,
      remote: remoteMemory,
      ctx: ctx as MemoryViewProps['ctx'],
    })))
  }

  // better-sidebar 可选软依赖：有侧栏时挂 tab（无则设置页兜底）。
  const root = ctx as {
    inject?(names: string[], cb: (c: unknown) => void): void
  }
  if (root.inject === undefined) return
  root.inject(['betterSidebar'], (sidebarCtx: unknown) => {
    const service = (sidebarCtx as { betterSidebar?: { registerTab?(descriptor: unknown): unknown } }).betterSidebar
    if (service?.registerTab === undefined) return
    if (remoteMemory === undefined) return
    const tabCtx = ctx as LocaleAwareContext
    service.registerTab({
      id: '@max-null/dsh-memory:memory',
      title: () => STRINGS[localeId].tabMemory,
      order: 60,
      single: true,
      component: ({ visible }: { visible: boolean }) => createElement(MemoryView, {
        visible,
        remote: remoteMemory,
        ctx: tabCtx as MemoryViewProps['ctx'],
      }),
    })
  })
}
