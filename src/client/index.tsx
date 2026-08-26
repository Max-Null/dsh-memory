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

// 0.3.6：面板数据走 /memory/api（host 自建 HTTP 端点——client 侧
// remote.memory 依赖 Typert 构建产物，独立包生成不了）。
export const inject = ['slots', 'locale']

// ---- file reference rendering（0.3.9：记忆内容 @路径 可点击，rc.8 语法子集） ----
// Match @path and @"path with spaces" mentions; bare token until whitespace,
// quoted token until closing quote. Same subset dsh-skill-mcp-center uses.
const FILE_REF_RE = /@("([^"]+)"|([^\s"@]+))/g
interface FileRefToken { raw: string; path: string }
/**
 * Whether a bare @token looks like a file path worth linking. Package names
 * (@scope/name, @scope/name/subpath), bare words, domain-like tokens, and
 * extension-less directory chains must not render as clickable — they are not
 * reliably files. Quoted forms (@"...") always qualify (explicit user intent).
 */
function looksLikePath(path: string): boolean {
  if (path.includes('\\')) return true
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('/') || path.startsWith('~/')) return true
  if (path.includes('/')) {
    // Any dotted segment (README.md, dist/main.js) marks a file path; pure
    // package names and extension-less directory chains stay plain text.
    return path.includes('.')
  }
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(path)
  if (m === null) return false
  const ext = m[1]!.toLowerCase()
  const COMMON_EXTS = new Set(['md', 'txt', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'yml', 'yaml', 'toml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'css', 'scss', 'html', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'bat', 'exe', 'zip', 'tar', 'gz', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'log', 'env', 'lock', 'csv', 'xml', 'sql', 'db', 'wasm'])
  return COMMON_EXTS.has(ext)
}
function splitFileRefs(text: string): Array<{ kind: 'text'; text: string } | { kind: 'ref'; ref: FileRefToken }> {
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'ref'; ref: FileRefToken }> = []
  let last = 0
  let m: RegExpExecArray | null
  FILE_REF_RE.lastIndex = 0
  while ((m = FILE_REF_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) })
    const path = m[2] ?? m[3]!
    // Quoted forms always count; bare tokens must look like paths.
    if (m[2] !== undefined || looksLikePath(path)) {
      parts.push({ kind: 'ref', ref: { raw: m[0], path } })
    } else {
      parts.push({ kind: 'text', text: m[0] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}
/** better-sidebar openFile, wired when the peer is present (0.3.9). */
let openFileRef: ((path: string, title?: string) => void) | null = null
/** Memory content with @-mentions rendered as clickable references. */
function ContentWithRefs({ text, style }: { text: string; style?: Record<string, string> }): ReactNode {
  const parts = splitFileRefs(text)
  if (parts.every(p => p.kind === 'text')) return text
  return createElement('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
    parts.map((p, i) => p.kind === 'text'
      ? createElement('span', { key: i, style }, p.text)
      : createElement('span', {
        key: i,
        title: 'open file',
        onClick: () => { openFileRef?.(p.ref.path, p.ref.path) },
        style: {
          ...style,
          cursor: 'pointer',
          borderRadius: 4,
          padding: '0 3px',
          background: 'var(--dsw-alias-state-business-tertiary, rgba(79,195,247,.16))',
          color: 'var(--dsw-alias-state-business-primary, #4FC3F7)',
          textDecoration: 'underline dotted',
        },
      }, p.ref.raw)))
}

// ---- 大脑图标（Lucide brain，设置页 nav + 侧栏 tab 共用） ----
const BRAIN_PATHS = [
  'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z',
  'M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z',
]
/** 侧栏 tab 图标（ReactNode）。 */
function brainIcon(): ReactNode {
  return createElement('svg', {
    width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, BRAIN_PATHS.map((d, index) => createElement('path', { key: index, d })))
}

// ---- 设置页导航图标替换（照 dsh-plugin-center settings-nav-icon 模式） ----
// DSH 0.1.x settings.section 无 icon 契约（外部 section 一律默认齿轮）。
// MutationObserver 按当前本地化 label 标记本插件行，CSS mask 换成大脑。
const SETTINGS_NAV_MARKER = 'data-dsh-memory-settings-nav'
const BRAIN_MASK_SVG = `%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z'/%3E%3Cpath d='M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z'/%3E%3C/svg%3E`
const NAV_ICON_CSS = `
[data-dsh-memory-settings-nav] > svg:first-child { display: none; }
[data-dsh-memory-settings-nav]::before {
  content: '';
  flex: none;
  width: 16px;
  height: 16px;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,${BRAIN_MASK_SVG}") center / contain no-repeat;
  mask: url("data:image/svg+xml,${BRAIN_MASK_SVG}") center / contain no-repeat;
}
`
let navCssInjected = false
function injectNavCss(): void {
  if (navCssInjected || typeof document === 'undefined') return
  navCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-plugin', '@max-null/dsh-memory')
  style.textContent = NAV_ICON_CSS
  document.head.append(style)
}

/** 标记设置对话框里本插件的导航行（照 dsh-plugin-center 同款，HMR-safe）。 */
function registerSettingsNavIcon(label: () => string): () => void {
  let disposed = false
  const sync = (): void => {
    if (disposed) return
    const currentLabel = label().trim()
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      const matches = currentLabel.length > 0 && button.textContent?.trim() === currentLabel
      if (matches) button.setAttribute(SETTINGS_NAV_MARKER, '')
      else button.removeAttribute(SETTINGS_NAV_MARKER)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => {
    disposed = true
    observer.disconnect()
    document.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`)
      .forEach((element) => { element.removeAttribute(SETTINGS_NAV_MARKER) })
  }
}

// ---- i18n (DSH zh/en, plugin-center pattern) ----
type LocaleId = 'zh' | 'en'
const STRINGS = {
  zh: {
    tabMemory: '记忆',
    tabPrompt: '模板',
    promptEmpty: '暂无模板（点「新增模板」或往 ~/.dsh/prompt-library 放 md 文件）',
    promptRefresh: '刷新索引',
    promptAdd: '新增模板',
    promptInsert: '插入输入框',
    promptInserted: '已插入',
    promptInsertUnavailable: '无活动会话/输入框',
    promptDelete: '删除',
    promptDeleteConfirm: '删除模板（md 文件与索引一并删除）？',
    promptFormName: '名称',
    promptFormContent: '正文',
    promptFormDimension: '维度（前端/后端/…）',
    promptFormDifficulty: '难度（L1-L5/LX）',
    promptFormTags: '标签（逗号分隔）',
    promptFormFallback: '备用提示词',
    promptFormSubmit: '写入模板库',
    promptFormCancel: '取消',
    promptSearch: '搜索模板…',
    promptAgent: 'agent',
    promptFilterAll: '全部',
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
    nsWorkspace: '工作区',
    noWorkspace: '未选择工作区',
    organizeMemory: '整理记忆',
    confirmAll: '全部确认',
    injectPreview: '注入预览',
    contextUsage: '上下文占用',
    keywordsLabel: '关键词',
    suggested: '待审核',
    approved: '已审核',
    refresh: '刷新',
    coldHint: '冷数据 · 建议按需化',
  },
  en: {
    tabMemory: 'Memory',
    tabPrompt: 'Templates',
    promptEmpty: 'No templates yet (use "Add template" or drop md files into ~/.dsh/prompt-library)',
    promptRefresh: 'Refresh index',
    promptAdd: 'Add template',
    promptInsert: 'Insert into input',
    promptInserted: 'Inserted',
    promptInsertUnavailable: 'No active session/input',
    promptDelete: 'Delete',
    promptDeleteConfirm: 'Delete this template (md file + index)?',
    promptFormName: 'Name',
    promptFormContent: 'Body',
    promptFormDimension: 'Dimension (前端/后端/…)',
    promptFormDifficulty: 'Difficulty (L1-L5/LX)',
    promptFormTags: 'Tags (comma separated)',
    promptFormFallback: 'Fallback prompt',
    promptFormSubmit: 'Write to library',
    promptFormCancel: 'Cancel',
    promptSearch: 'Search templates…',
    promptAgent: 'agent',
    promptFilterAll: 'All',
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
    nsWorkspace: 'Workspace',
    noWorkspace: 'No workspace selected',
    organizeMemory: 'Organize memory',
    confirmAll: 'Approve all',
    injectPreview: 'Injection preview',
    contextUsage: 'Context usage',
    keywordsLabel: 'Keywords',
    suggested: 'Suggested',
    approved: 'Approved',
    refresh: 'Refresh',
    coldHint: 'Cold · consider on-demand',
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
  // Root column: toolbar + namespace tabs stay pinned at the top (flex:none);
  // only the content area below scrolls (2026-08-22 用户: tab 与功能不应随滚动)。
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', height: '100%', boxSizing: 'border-box' },
  header: { display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' },
  content: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginRight: -4, paddingRight: 4 },
  // 计数徽标（醒目：accent 底 + 白色数字）。
  count: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 18, height: 18, padding: '0 6px', borderRadius: 9,
    background: 'var(--dsw-alias-state-business-primary, #4FC3F7)',
    color: '#fff', fontSize: 11, fontWeight: 600, lineHeight: 1,
  },
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

// ---- /memory/api 数据通道（0.3.6，host 自建端点，panels 模式） ----
interface MemoryApiRecord {
  id: string, content: string, status: 'suggested' | 'approved', injected: boolean, namespace: string, keywords: string[], lastUsedAt?: number
}
/** 注入预览（0.5.2）：与 memory:recall 同源渲染——真实注入行 + 预算统计。 */
interface InjectionPreview {
  self: string, lines: string[], budget: number | null, omitted: number, chars: number
}

async function api(method: string, payload?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`/memory/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await res.json() as { ok?: boolean, value?: unknown, error?: { message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `${method} failed`)
  }
  return body.value
}

const memoryApi = {
  list(filter: { namespace?: string, status?: string, injected?: boolean } = {}, cwd?: string): Promise<MemoryApiRecord[]> {
    return api('list', { filter, ...cwd === undefined ? {} : { cwd } }) as Promise<MemoryApiRecord[]>
  },
  reload(cwd?: string): Promise<MemoryApiRecord[]> {
    return api('reload', { ...cwd === undefined ? {} : { cwd } }) as Promise<MemoryApiRecord[]>
  },
  confirm(id: string, cwd?: string): Promise<MemoryApiRecord> {
    return api('confirm', { id, ...cwd === undefined ? {} : { cwd } }) as Promise<MemoryApiRecord>
  },
  forget(id: string, cwd?: string): Promise<boolean> {
    return api('forget', { id, ...cwd === undefined ? {} : { cwd } }) as Promise<boolean>
  },
  setInjected(id: string, injected: boolean, cwd?: string): Promise<MemoryApiRecord> {
    return api('setInjected', { id, injected, ...cwd === undefined ? {} : { cwd } }) as Promise<MemoryApiRecord>
  },
  injectionPreview(cwd?: string): Promise<InjectionPreview> {
    return api('injectionPreview', { ...cwd === undefined ? {} : { cwd } }) as Promise<InjectionPreview>
  },
  // ── 提示词模板库（0.6.0）──
  promptList(cwd?: string): Promise<Array<Record<string, unknown>>> {
    return api('prompt.list', { ...cwd === undefined ? {} : { cwd } }) as Promise<Array<Record<string, unknown>>>
  },
  promptGet(nameOrId: string, cwd?: string): Promise<Record<string, unknown>> {
    return api('prompt.get', { name: nameOrId, ...cwd === undefined ? {} : { cwd } }) as Promise<Record<string, unknown>>
  },
  promptAdd(payload: Record<string, unknown>, cwd?: string): Promise<Record<string, unknown>> {
    return api('prompt.add', { ...payload, ...cwd === undefined ? {} : { cwd } }) as Promise<Record<string, unknown>>
  },
  promptRemove(nameOrId: string, cwd?: string): Promise<boolean> {
    return api('prompt.remove', { name: nameOrId, ...cwd === undefined ? {} : { cwd } }) as Promise<boolean>
  },
  promptRefresh(cwd?: string): Promise<Record<string, unknown>> {
    return api('prompt.refresh', { ...cwd === undefined ? {} : { cwd } }) as Promise<Record<string, unknown>>
  },
}

// 预填指令（0.3.6）：过时内容用 memory_update 修正（重置待审核）；
// 判断过时的方法 = 记忆里的工具名/数量与当前实际可用工具对照。
// 整理规则明确化（用户 2026-08-19）：同类习惯合并；与 memory:self 重复的
// 插件介绍删除——LLM 保守默认"不合并/不删"，必须显式规则。
const ORGANIZE_PROMPT = '请整理我的记忆库：用 memory_list 查看全部记忆。整理规则（必须执行）：①同类条目合并——工作习惯/约定类多条合并为一条（内容用 ①②③ 并列，避免碎片化）；②与「[记忆系统自述]」（你上下文中的记忆机制说明）内容重复的插件介绍条目（如 dsh-memory 插件发布信息）应删除——机制说明已由系统常驻提供，无需用户存储；③对过时、错误或已变化的内容用 memory_update 修正（会重置为待审核）；④精简冗长内容，为每条补充或修正 keywords；⑤需要删除的用 memory_forget，需要新增的用 memory_save。判断内容是否过时的方法：把记忆里提到的工具名/数量与你当前实际可用的记忆工具对照——你当前可用：memory_save / memory_list / memory_search / memory_confirm / memory_forget / memory_update（共 6 个）；若记忆中的工具列表、数量、流程与此不符即为过时，用 memory_update 修正。改动全部落在 suggested 等待审核（不要调用 memory_confirm），完成后用一句话汇报整理结果。'

interface MemoryViewProps {
  visible: boolean
  /** 当前会话工作区 cwd（侧栏 scope.cwd / 设置页 sessions 快照）；无则工作区记忆为空。 */
  cwd?: string
  ctx: {
    get?: (name: string) => unknown
  }
}

// ── 提示词模板库（0.6.0）：插入输入框走标准套件 conversation.input.for ────
// 与 organizeMemory 同款通道（sessions 快照 current → scope → input.for → setDraft）。
function insertIntoInput(ctx: MemoryViewProps['ctx'], text: string): { ok: boolean, reason?: string } {
  const sessions = ctx.get?.('sessions') as {
    list?: { getSnapshot?(): { current?: string } }
    scope(id: string): unknown
  } | undefined
  const conversation = ctx.get?.('conversation') as {
    input?: { for?(actx: unknown): { setDraft(text: string): void } | undefined }
  } | undefined
  if (sessions === undefined || conversation?.input?.for === undefined) return { ok: false, reason: 'unavailable' }
  const current = sessions.list?.getSnapshot?.()?.current
  if (current === undefined || current === '') return { ok: false, reason: 'no-active-session' }
  const actx = sessions.scope(current)
  if (actx === undefined) return { ok: false, reason: 'no-scope' }
  const input = conversation.input.for(actx)
  if (input === undefined) return { ok: false, reason: 'no-input' }
  try {
    input.setDraft(text)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'setDraft-failed' }
  }
}

/** 模板 tab：列表/预览/插入/新增/删除。 */
function PromptView(props: MemoryViewProps): ReactNode {
  const t = useT()
  const [items, setItems] = useState<Array<Record<string, unknown>>>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const reload = async (): Promise<void> => {
    try { setItems(await memoryApi.promptList(props.cwd) as Array<Record<string, unknown>>) } catch { /* 保留旧列表 */ }
  }
  useEffect(() => { if (props.visible) void reload() }, [props.visible])
  const flash = (text: string): void => {
    setNote(text)
    setTimeout(() => setNote(null), 2000)
  }
  const q = query.trim().toLowerCase()
  const filtered = items.filter(item => {
    if (q === '') return true
    const hay = [
      String(item.name ?? ''), String(item.dimension ?? ''), String(item.difficulty ?? ''),
      (item.tags ?? []).join(' '), String(item.summary ?? ''),
    ].join(' ').toLowerCase()
    return hay.includes(q)
  })
  const openPrompt = async (item: Record<string, unknown>): Promise<void> => {
    const key = String(item.id ?? item.name)
    if (expanded === key) { setExpanded(null); setDetail(null); return }
    setExpanded(key)
    try { setDetail(await memoryApi.promptGet(String(item.name ?? item.id), props.cwd)) } catch { setDetail(null) }
  }
  const insert = (item: Record<string, unknown>): void => {
    const text = String(detail?.body ?? item.summary ?? '')
    const result = insertIntoInput(props.ctx, text)
    flash(result.ok ? t('promptInserted') : `${t('promptInsertUnavailable')} (${result.reason ?? '?'})`)
  }
  const remove = async (item: Record<string, unknown>): Promise<void> => {
    if (!window.confirm(t('promptDeleteConfirm'))) return
    await memoryApi.promptRemove(String(item.name ?? item.id), props.cwd).catch(() => null)
    await reload()
  }
  const submitForm = async (): Promise<void> => {
    if ((form.name ?? '').trim() === '' || (form.content ?? '').trim() === '') return
    await memoryApi.promptAdd({
      name: form.name.trim(),
      content: form.content,
      ...(form.dimension ?? '').trim() === '' ? {} : { dimension: form.dimension.trim() },
      ...(form.difficulty ?? '').trim() === '' ? {} : { difficulty: form.difficulty.trim() },
      ...(form.tags ?? '').trim() === '' ? {} : { tags: form.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '') },
      ...(form.fallback ?? '').trim() === '' ? {} : { fallback: form.fallback },
    }, props.cwd)
    setForm({})
    setFormOpen(false)
    await reload()
  }
  const field = (key: string, hint: string, multiline = false): ReactNode =>
    createElement(multiline ? 'textarea' : 'input', {
      key,
      value: form[key] ?? '',
      placeholder: hint,
      rows: multiline ? 4 : undefined,
      onChange: (event: { target: { value: string } }) => { setForm(prev => ({ ...prev, [key]: event.target.value })) },
      style: {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
        background: 'var(--dsw-alias-bg-layer-1, #0f141d)',
        border: '1px solid var(--dsw-alias-border-l2, #1e2836)', borderRadius: 6,
        color: 'var(--dsw-alias-label-primary, #d8e0ea)', outline: 'none',
      },
    } as never)

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflowY: 'auto' } },
    createElement('div', { style: { display: 'flex', gap: 6 } },
      createElement('button', { type: 'button', style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent }, onClick: () => { setFormOpen(open => !open) } }, t('promptAdd')),
      createElement('button', { type: 'button', style: ssid.btn, onClick: () => { void reload() } }, t('promptRefresh')),
      createElement('input', {
        value: query,
        onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
        placeholder: t('promptSearch'),
        style: {
          flex: 1, padding: '6px 10px', fontSize: 12.5, boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-layer-1, #0f141d)',
          border: '1px solid var(--dsw-alias-border-l2, #1e2836)', borderRadius: 8,
          color: 'var(--dsw-alias-label-primary, #d8e0ea)', outline: 'none',
        },
      }),
      note === null ? null : createElement('span', { style: { ...ssid.muted, alignSelf: 'center' } }, note),
    ),
    formOpen
      ? createElement('div', { style: ssid.card },
        createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          field('name', t('promptFormName')),
          field('dimension', t('promptFormDimension')),
          field('difficulty', t('promptFormDifficulty')),
          field('tags', t('promptFormTags')),
          field('content', t('promptFormContent'), true),
          field('fallback', t('promptFormFallback'), true),
          createElement('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
            createElement('button', { type: 'button', style: ssid.btn, onClick: () => { setFormOpen(false); setForm({}) } }, t('promptFormCancel')),
            createElement('button', { type: 'button', style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent }, onClick: () => { void submitForm() } }, t('promptFormSubmit')),
          ),
        ),
      )
      : null,
    filtered.length === 0
      ? createElement('div', { style: ssid.empty }, t('promptEmpty'))
      : filtered.map(item => {
        const key = String(item.id ?? item.name)
        const open = expanded === key
        return createElement('div', { key, style: ssid.card },
          createElement('div', { style: { cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }, onClick: () => { void openPrompt(item) } },
            createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
              createElement('span', { style: { ...ssid.text, fontWeight: 600 } }, String(item.name ?? '')),
              item.source === 'agent' ? createElement('span', { style: { fontSize: 10, color: '#f7c94f', fontWeight: 600 } }, t('promptAgent')) : null,
              createElement('span', { style: { ...ssid.muted, fontSize: 10.5 } },
                [String(item.dimension ?? ''), String(item.difficulty ?? '')].filter(part => part !== '').join(' · ')),
            ),
            (item.tags ?? []).length > 0
              ? createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                (item.tags as string[]).slice(0, 6).map(tag => createElement('span', { key: tag, style: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2, #1e2836)', color: 'var(--dsw-alias-label-secondary, #67748a)' } }, tag)))
              : null,
            createElement('span', { style: ssid.muted }, String(item.summary ?? '').slice(0, 120)),
          ),
          open ? createElement('div', { style: { marginTop: 6 } },
            detail === null
              ? createElement('div', { style: ssid.muted }, '…')
              : createElement('pre', { style: { ...ssid.muted, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, maxHeight: 180, overflowY: 'auto' } }, String(detail.body ?? '')),
            createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' } },
              createElement('button', { type: 'button', style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent }, onClick: () => { insert(item) } }, t('promptInsert')),
              createElement('button', { type: 'button', style: { ...ssid.btn, color: '#f76f4f', borderColor: '#f76f4f' }, onClick: () => { void remove(item) } }, t('promptDelete')),
            ),
          ) : null,
        )
      }),
  )
}

// ---- 冷热显示（0.5.3：lastUsedAt 追踪；30 天未检索视为冷数据） ----
const DAY_MS = 86_400_000
const COLD_DAYS = 30
function fmtDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function isCold(usedAt: number | undefined, now: number = Date.now()): boolean {
  return usedAt === undefined || now - usedAt > COLD_DAYS * DAY_MS
}

function MemoryView(props: MemoryViewProps): ReactNode {
  const t = useT()
  const [mode, setMode] = useState<'mem' | 'prompt'>('mem')
  const [records, setRecords] = useState<MemoryApiRecord[]>([])
  const [query, setQuery] = useState('')
  const [namespace, setNamespace] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  // 注入预览（0.3.5）：开发者查看注入到 system prompt 的内容
  const [preview, setPreview] = useState<InjectionPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const togglePreview = async (): Promise<void> => {
    if (previewOpen) { setPreviewOpen(false); return }
    try {
      // 0.5.1：预览按当前会话工作区路由——与真实注入一致（global + 当前工作区）
      setPreview(await memoryApi.injectionPreview(props.cwd))
    } catch {
      setPreview(null)
    }
    setPreviewOpen(true)
  }
  const reload = async (): Promise<void> => {
    try {
      setRecords(await memoryApi.list({}, props.cwd))
    } catch {
      // 失败保留旧列表（2026-08-19 用户实测：失败清空无后续）
    }
  }
  // 强制重读存储文件（JsonStorageBackend 无 watch——外部编辑后必须 reload）
  const refreshFromDisk = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setRecords(await memoryApi.reload(props.cwd))
    } catch {
      await reload()
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => { if (props.visible) void reload() }, [props.visible])

  const toggleInjected = async (record: MemoryApiRecord): Promise<void> => {
    if (record.status !== 'approved') return
    try {
      await memoryApi.setInjected(record.id, !record.injected, props.cwd)
    } catch {
      /* 失败保持原状态 */
    }
    await reload()
  }

  const confirmAll = async (): Promise<void> => {
    const pending = records.filter(record => record.status === 'suggested')
    if (pending.length === 0) return
    await Promise.all(pending.map(record => memoryApi.confirm(record.id, props.cwd).catch(() => null)))
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
  const byNs = namespace === null ? records
    : namespace === 'workspace' ? records.filter(record => record.namespace === 'project')
      : records.filter(record => record.namespace === 'global')
  const filtered = byNs.filter(record => q === '' || record.content.toLowerCase().includes(q))
  const nsCounts = {
    all: records.length,
    global: records.filter(record => record.namespace === 'global').length,
    workspace: records.filter(record => record.namespace === 'project').length,
  }
  const groups: Array<{ key: string, label: string, items: typeof filtered }> = [
    { key: 'pending', label: t('groupPending'), items: filtered.filter(record => record.status === 'suggested') },
    { key: 'ondemand', label: t('groupOnDemand'), items: filtered.filter(record => record.status === 'approved' && !record.injected) },
    { key: 'injected', label: t('groupInjected'), items: filtered.filter(record => record.status === 'approved' && record.injected) },
  ].filter(group => group.items.length > 0)

  // ── 记忆 / 模板 切换（0.6.0）──
  const modeTabs = createElement('div', { style: { display: 'flex', gap: 4 } },
    (['mem', 'prompt'] as const).map(m => createElement('button', {
      key: m,
      type: 'button',
      onClick: () => { setMode(m) },
      style: { flex: 1, ...ssid.btn, ...(mode === m ? { color: ssid.accent, borderColor: ssid.accent } : {}) },
    }, m === 'mem' ? t('tabMemory') : t('tabPrompt')),
  ))
  if (mode === 'prompt') {
    return createElement('div', { style: ssid.wrap },
      modeTabs,
      createElement(PromptView, { visible: props.visible, cwd: props.cwd, ctx: props.ctx }),
    )
  }

  return createElement('div', { style: ssid.wrap },
    modeTabs,
    createElement('div', { style: ssid.header },
      createElement('div', { style: { display: 'flex', gap: 6 } },
        createElement('button', {
          type: 'button',
          title: t('organizeMemory'),
          onClick: () => { void organize() },
          disabled: organizing,
          style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent },
        }, organizing ? '…' : t('organizeMemory')),
        createElement('button', {
          type: 'button',
          title: t('injectPreview'),
          onClick: () => { void togglePreview() },
          style: { ...ssid.btn, ...(previewOpen ? { color: ssid.accent, borderColor: ssid.accent } : {}) },
        }, t('injectPreview')),
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
        ([null, 'global', 'workspace'] as Array<string | null>).map(ns => {
          const label = ns === null ? t('allNamespaces') : ns === 'global' ? t('nsGlobal') : t('nsWorkspace')
          const count = ns === null ? nsCounts.all : ns === 'global' ? nsCounts.global : nsCounts.workspace
          return createElement('button', {
            key: ns ?? 'all',
            onClick: () => { setNamespace(ns) },
            style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, ...ssid.btn, ...(namespace === ns ? { color: ssid.accent, borderColor: ssid.accent } : {}) },
          }, createElement('span', null, label), createElement('span', { style: ssid.count }, String(count)))
        }),
      ),
    ),
    // 内容区独立滚动：预览 + 分组列表。
    createElement('div', { style: ssid.content },
      // 注入预览（开发者）：self 自述 + 实际注入行（摘要化+预算）+ 预算使用统计
      previewOpen && preview !== null
        ? createElement('div', { style: { ...ssid.card, display: 'flex', flexDirection: 'column', gap: 6 } },
          createElement('div', { style: { ...ssid.muted, fontSize: 10.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            createElement('span', null, t('contextUsage')),
            createElement('span', null, (() => {
              const selfChars = preview.self.length
              const total = selfChars + preview.chars
              // 粗估（中英混合，标注 ≈）：中文约 1.5 字符/token，英文约 4 字符/token
              const tokens = Math.ceil(total / 2)
              const budgetText = preview.budget === null ? '' : ` / 预算 ${preview.budget}`
              const omittedText = preview.omitted > 0 ? `（省略 ${preview.omitted} 条）` : ''
              return `${selfChars}+${preview.chars} 字符${budgetText}${omittedText} ≈ ${tokens} token`
            })()),
          ),
          createElement('div', { style: { ...ssid.text, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, preview.self),
          preview.lines.length === 0
            ? createElement('div', { style: ssid.muted }, t('empty'))
            : preview.lines.map((line, index) => createElement('div', { key: index, style: { ...ssid.muted, fontSize: 11 } }, line)),
        )
        : null,
      // 未选择工作区：工作区视图显示占位（0.3.4 工作区路由语义）
      namespace === 'workspace' && (props.cwd === undefined || props.cwd === '')
        ? createElement('div', { style: ssid.empty }, t('noWorkspace'))
        : groups.length === 0
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
                createElement('span', { style: ssid.count }, String(group.items.length)),
              ),
            ),
            group.items.map(record => createElement('div', { key: record.id, style: ssid.card },
              createElement('div', { style: ssid.text }, ContentWithRefs({ text: record.content })),
              // keywords 展示（0.3.5：设计约定 UI 显示 keywords）
              record.keywords !== undefined && record.keywords.length > 0
                ? createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 } },
                  record.keywords.map(keyword => createElement('span', {
                    key: keyword,
                    style: {
                      fontSize: 10, padding: '1px 7px', borderRadius: 8,
                      background: 'var(--dsw-alias-bg-module-platform, rgba(128,148,168,.14))',
                      color: 'var(--dsw-alias-label-secondary, #67748a)',
                    },
                  }, keyword)))
                : null,
              createElement('div', { style: { ...ssid.muted, marginTop: 6 } },
                `${record.namespace} · ${record.status === 'approved' ? t('approved') : t('suggested')}${record.injected ? ` · ${t('groupInjected')}` : ''}${record.lastUsedAt !== undefined ? ` · 上搜 ${fmtDate(record.lastUsedAt)}` : ''}${isCold(record.lastUsedAt) ? ` · ${t('coldHint')}` : ''}`),
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
                    onClick: () => { void memoryApi.confirm(record.id, props.cwd).then(() => reload()) },
                  }, t('confirm'))
                  : null,
                createElement('button', {
                  style: ssid.btn,
                  onClick: () => { void memoryApi.forget(record.id, props.cwd).then(() => reload()) },
                }, t('forget')),
              ),
            )),
          )),
    ),
  )
}

/** 从 sessions 服务快照取当前会话的工作区 cwd（设置页等无 scope 上下文处）。 */
function currentSessionCwd(ctx: LocaleAwareContext): string | undefined {
  try {
    const sessions = ctx.get?.('sessions') as {
      list?: { getSnapshot?(): { byId?: Record<string, { cwd?: string }>, current?: string } }
    } | undefined
    const snapshot = sessions?.list?.getSnapshot?.()
    if (snapshot?.current === undefined) return undefined
    return snapshot.byId?.[snapshot.current]?.cwd
  } catch {
    return undefined
  }
}

/** 设置页包装：渲染时读当前会话 cwd（切换会话后重渲染即跟随）。 */
function SettingsMemoryView(props: { ctx: LocaleAwareContext }): ReactNode {
  return createElement(MemoryView, {
    visible: true,
    ctx: props.ctx,
    cwd: currentSessionCwd(props.ctx),
  })
}

/** Locale service's minimal surface (optional read + change event). */
interface LocaleFace {
  getLocale?: () => { active?: string }
}
interface LocaleAwareContext {
  get?: (name: string) => unknown
  on?: (event: string, handler: (payload: unknown) => void) => void
  effect?: (exec: () => unknown, label?: string) => unknown
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

  // 兜底入口：设置页「记忆」条目——任何环境（无 better-sidebar 也）可管理记忆。
  // 与侧栏 tab 双入口并存（2026-08-19 用户：没有侧栏就没有管理面板的问题）。
  if (slots?.inject !== undefined) {
    injectNavCss()
    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'dsh-memory',
      order: 60,
      label: () => STRINGS[localeId].tabMemory,
      inject: () => ({}),
    }, () => createElement(SettingsMemoryView, {
      ctx: ctx as LocaleAwareContext,
    })))
    // 设置导航图标：大脑（DSH 无 icon 契约，MutationObserver + CSS mask 替换齿轮）
    face.effect?.(() => registerSettingsNavIcon(() => STRINGS[localeId].tabMemory), 'dsh-memory: settings navigation icon')
  }

  // better-sidebar 可选软依赖：有侧栏时挂 tab（无则设置页兜底）。
  const root = ctx as {
    inject?(names: string[], cb: (c: unknown) => void): void
  }
  if (root.inject === undefined) return
  root.inject(['betterSidebar'], (sidebarCtx: unknown) => {
    const service = (sidebarCtx as { betterSidebar?: { registerTab?(descriptor: unknown): unknown; openFile?(scope: unknown, path: string, title?: string): unknown } }).betterSidebar
    if (service?.registerTab === undefined) return
    // 0.3.9：记忆内容 @路径 点击经 better-sidebar 文件 tab 打开。
    if (typeof service.openFile === 'function') {
      openFileRef = (path: string, title?: string) => { service.openFile?.({}, path, title) }
    }
    const tabCtx = ctx as LocaleAwareContext
    service.registerTab({
      id: '@max-null/dsh-memory:memory',
      title: () => STRINGS[localeId].tabMemory,
      icon: brainIcon,
      order: 60,
      single: true,
      component: ({ visible, scope }: { visible: boolean, scope?: { cwd?: string } }) => createElement(MemoryView, {
        visible,
        // 侧栏场景：当前会话工作区 cwd（TabComponentProps.scope）
        cwd: scope?.cwd,
        ctx: tabCtx as MemoryViewProps['ctx'],
      }),
    })
  })
}
