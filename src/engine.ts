/**
 * The memory service (`ctx.memory`): durable plaintext records over two
 * storage roots — `global` in the harness home, `project` in the current
 * project folder (`.dsh/`), so project memory follows the repository. A record
 * is always created `suggested` and becomes effective only through `setStatus`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { bm25FieldScores, cosineSimilarity, rrfFuse } from './bm25.ts'
import { parsePromptFile, scanPromptDir, writePromptFile, type PromptFile } from './prompt-files.ts'
import { detectSensitive } from './quarantine.ts'
import { SELF_VERSION } from './self.ts'
import { anchorHolds } from './anchors.ts'
import type { AnchorProbes, MemoryAnchor } from './anchors.ts'
import { QueryLog, rankGapCandidates, summarizeQueryLog, summarizeSources } from './query-log.ts'
import type { MemorySource, SourceStat } from './query-log.ts'

export type { MemorySource, QueryLogEntry, SourceStat } from './query-log.ts'

declare const memoryIdBrand: unique symbol
/** Opaque identity of one stored memory record. */
export type MemoryId = string & { readonly [memoryIdBrand]: never }
/** Brand a string as a {@link MemoryId} (compile-time only). */
export function MemoryId(id: string): MemoryId {
  return id as MemoryId
}

export type MemoryNamespace = 'global' | 'project'
/**
 * 审核维度（0.3.0）：`suggested` 未生效；`approved` 已生效。2026-09-15 起写入默认
 * `approved`（静默机制），`suggested` 主要留给被隔离的记录与人工回退。
 * 注入与否由独立维度 `injected` 控制（见 MemoryRecord）。
 */
export type MemoryStatus = 'suggested' | 'approved'

/**
 * 记录类别（0.6.0 模板库）：'fact' = 常规记忆（缺省，旧数据即此）；
 * 'prompt' = 提示词模板索引记录（文件是事实源，见 prompt-files.ts）。
 */
export type MemoryKind = 'fact' | 'prompt'

/** prompt 索引记录的附加元数据（与 md 文件 frontmatter 对齐，工具/UI 直接取用）。 */
export interface PromptMetaIndex {
  seq?: number
  name: string
  dimension?: string
  difficulty?: string
  tags: string[]
  /** 索引摘要（正文前 200 字）。 */
  summary: string
  /** md 文件绝对路径（引擎内部使用；工具输出不暴露）。 */
  path: string
  /** 索引时的文件 mtime（惰性刷新比对）。 */
  mtime: number
  /** user=用户创建；agent=模型新增（UI 角标）。 */
  source: 'user' | 'agent'
}

export interface MemoryRecord {
  id: MemoryId
  namespace: MemoryNamespace
  status: MemoryStatus
  /** 注入维度：true = 每轮全量注入 system prompt（常驻）；false = 仅检索。 */
  injected: boolean
  /**
   * 隔离位（2026-09-15）：命中危险内容规则 → 不进注入、不进检索，等人工放行或删除。
   * 与 `status` 双保险：隔离记录同时保持 `suggested`，即使某条路径漏了过滤也不会注入。
   */
  quarantined: boolean
  /** 隔离原因（命中的规则名，诊断与面板展示用）。 */
  quarantineReason?: string
  /** 命中次数（2026-09-15 淘汰机制）：被 memory_search 命中的累计次数。 */
  hitCount: number
  /**
   * 写入来源（2026-09-15 反例 5）：'agent' = 主模型写入，'human' = 人工写入；
   * 缺省 = 旧记录（来源未知，不猜测）。影响力统计按它聚合（见 sourceStats）。
   */
  source?: MemorySource
  /** 注入由信号自动开启（true）还是人工设置（缺省）；只有自动开的会被「长期未命中」自动降级。 */
  injectedAuto?: boolean
  /** 有效性锚点（2026-09-15）：绑定到某个可探测的环境值；值变了即失效。 */
  anchor?: MemoryAnchor
  /** 锚点已失效（由会话启动时的校验写入）；失效不删除，只降权并在检索结果里标注。 */
  stale?: boolean
  /** 失效原因（锚点名 + 声明值 vs 当前值，诊断用）。 */
  staleReason?: string
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
  /** 最近一次被 memory_search 命中的时间（0.5.3 冷热追踪）；无则未命中过。 */
  lastUsedAt?: number
  /** 记录类别（缺省 'fact'）。 */
  kind?: MemoryKind
  /** prompt 记录元数据（仅 kind==='prompt'）。 */
  meta?: PromptMetaIndex
  /**
   * 来源工作区（④-A 2026-09-19）：仅在跨工作区召回时出现——`undefined` = 当前会话
   * 工作区，`..` / `../..` = 上级工作区。检索结果与注入行据此标出来源，避免「记忆串味」。
   */
  scope?: string
}

export interface MemoryWrite {
  content: string
  namespace?: MemoryNamespace
  keywords?: string[]
  /** 写入来源（2026-09-15）；缺省 'agent'（主模型写入）。面板等人工路径传 'human'。 */
  source?: MemorySource
  /**
   * 有效性锚点（可选，2026-09-15）：把这条记忆绑定到某个可探测的环境值上，值变了即自动
   * 失效。只用于「随环境变化的事实」（某工具版本下的行为、某环境变量决定的配置）。
   */
  anchor?: MemoryAnchor
  /**
   * 常驻注入（可选，2026-09-18）：显式指定这条记忆是否每轮进上下文。**给值即接管**——
   * 与 {@link MemoryEngine.setInjected} 同一套语义（写 `injectedAuto: false`，此后不受自动
   * 升降影响）。省略则维持缺省行为：不注入，且**保留**「被反复命中即自动升常驻」的资格。
   */
  injected?: boolean
}

export interface MemoryFilter {
  namespace?: MemoryNamespace
  status?: MemoryStatus
  injected?: boolean
  /** 隔离过滤（2026-09-15）：缺省排除隔离记录；传 true 只取隔离记录（面板审用）。 */
  quarantined?: boolean
  /** 记录类别过滤（0.6.0）；缺省不过滤（工具层显式传 kind='fact' 保持旧行为）。 */
  kind?: MemoryKind
}

/** {@link MemoryEngine.update} 的补丁：省略的字段保持原值（`injected` 省略时连 `injectedAuto` 一起保持）。 */
export interface MemoryPatch {
  content?: string
  keywords?: string[]
  /**
   * 常驻注入（2026-09-18）：给值即接管，与 {@link MemoryEngine.setInjected} 同义（写
   * `injectedAuto: false`，此后不受自动升降影响）；省略则保持原值。
   */
  injected?: boolean
}

export interface MemoryHit {
  record: MemoryRecord
  score: number
}

/** 反查候选（{@link MemoryEngine.suggestKeywordGaps}）：一条「本应命中」的现存记忆。 */
export interface KeywordGapCandidate {
  id: string
  /** 正文摘要（{@link GAP_EXCERPT_CHARS} 字符以内）。 */
  excerpt: string
  /** 现有关键词；补写时在其基础上追加。 */
  keywords: string[]
  /** 精确词元命中数：> 0 表示「现在重搜就该命中」。 */
  exact: number
  /** 前缀近似命中的查询词元（如 vue3 ↔ vue）。 */
  relaxed: string[]
}

/** 一个空命中查询的反查结果；`candidates` 为空即知识缺口。 */
export interface KeywordGap {
  query: string
  /** 该查询在日志里空命中的次数。 */
  count: number
  /** 最近一次出现的时间。 */
  lastAt: number
  candidates: KeywordGapCandidate[]
}

/** {@link MemoryEngine.suggestKeywordGaps} 的报告（只产出报告，不自动补写）。 */
export interface KeywordGapReport {
  /** 查询日志总条数。 */
  logSize: number
  /** 空命中条数（含被 `limit` 截掉的查询）。 */
  misses: number
  /** 逐查询的候选（最多 `limit` 个查询，按最近出现排序）。 */
  gaps: KeywordGap[]
}

/** One durable memory change, emitted after the backend acknowledges the write. */
export type MemoryChange =
  | { operation: 'remembered'; record: MemoryRecord }
  | { operation: 'forgotten'; id: MemoryId }
  | { operation: 'status'; id: MemoryId; status: MemoryStatus }
  | { operation: 'injected'; id: MemoryId; injected: boolean }
  | { operation: 'quarantined'; id: MemoryId; quarantined: boolean }

/** 自动升常驻所需的命中次数（2026-09-15）：一次偶然命中不足以证明「每轮都值得付费」。 */
const AUTO_INJECT_HITS = 2
/**
 * 一次检索里最多把前多少条记为「被使用」（2026-09-15）。
 *
 * 不设上限时，命中计数退化成「和查询有任意字符重叠」：BM25 对常见 2-gram 会给全库打分，
 * 一句「实机验证标记」在本机就能命中 81 条，于是**两次检索把所有 approved 记忆都升成常驻**，
 * 注入预算当场被历史条目占满——「反复被命中才值得每轮付费」这个判据也就失效了。
 * 取前 K 名接近「模型真的会看的那几条」，且与检索返回值解耦（返回值不动）。
 */
const HIT_MARK_LIMIT = 5
/** 反查候选的正文摘要长度（字符）。 */
const GAP_EXCERPT_CHARS = 160
/** 自动降级的天数阈值（2026-09-15）：与面板的冷数据判定（COLD_DAYS=30）对齐。 */
const AUTO_DEMOTE_DAYS = 30

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryEngine
  }
  interface Events {
    /** A memory record was created, deleted, or promoted/demoted. */
    'memory/changed'(change: MemoryChange): void
  }
}

/**
 * 存储层状态保留旧枚举（auto/suggest）+ injected 可选——旧文件必须能
 * 过 schema 校验，读时由 normalizeBlock 迁移（一次性兼容转换，不重写文件）。
 */
type StoredStatus = MemoryStatus | 'auto' | 'suggest'

interface StoredBlock {
  namespace: MemoryNamespace
  status: StoredStatus
  injected?: boolean
  /** 隔离位（2026-09-15）；缺省 = 未隔离。 */
  quarantined?: boolean
  /** 隔离原因（规则名）。 */
  quarantineReason?: string
  /** 命中次数（2026-09-15 淘汰机制）；缺省 0。 */
  hitCount?: number
  /** 写入来源（2026-09-15）；缺省 = 旧记录（来源未知；迁移不动它）。 */
  source?: MemorySource
  /** 注入由信号自动开启（true）还是人工设置（false/缺省）；只有自动开的会被自动降级。 */
  injectedAuto?: boolean
  /** 有效性锚点（2026-09-15）；缺省 = 未绑定锚点。 */
  anchor?: MemoryAnchor
  /** 锚点已失效（会话启动校验写入）；失效只降权并标注，不删除。 */
  stale?: boolean
  /** 失效原因（锚点名 + 声明值 vs 当前值）。 */
  staleReason?: string
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /** 混合检索向量（0.5.2，仅有 embeddings 配置时生成；明文可读）。 */
  vector?: number[]
  /** 记录类别（0.6.0 模板库；缺省 fact）。 */
  kind?: MemoryKind
  /** prompt 索引元数据（仅 kind==='prompt'）。 */
  meta?: PromptMetaIndex
}

const blockSchema = z.object({
  namespace: z.enum(['global', 'project']),
  status: z.enum(['suggested', 'approved', 'auto', 'suggest']),
  injected: z.boolean().optional(),
  quarantined: z.boolean().optional(),
  quarantineReason: z.string().optional(),
  hitCount: z.number().optional(),
  source: z.enum(['agent', 'human']).optional(),
  injectedAuto: z.boolean().optional(),
  anchor: z.object({
    kind: z.enum(['env', 'tool-list', 'self-version']),
    name: z.string().optional(),
    value: z.string(),
  }).optional(),
  stale: z.boolean().optional(),
  staleReason: z.string().optional(),
  content: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  vector: z.array(z.number()).optional(),
  kind: z.enum(['fact', 'prompt']).optional(),
  meta: z.object({
    seq: z.number().optional(),
    name: z.string(),
    dimension: z.string().optional(),
    difficulty: z.string().optional(),
    tags: z.array(z.string()),
    summary: z.string(),
    path: z.string(),
    mtime: z.number(),
    source: z.enum(['user', 'agent']),
  }).optional(),
})

/** Shared table shape; the two domains differ only by name and backend route. */
function memorySpec(name: string) {
  return defineDomain({
    name,
    version: 1,
    tables: { blocks: domainTable<string, StoredBlock>(blockSchema) },
  })
}

/** 读 unit 文件头的 name（文件不存在 → undefined；非法 JSON/结构异常抛错）。 */
function unitHeaderName(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const document = JSON.parse(readFileSync(path, 'utf8')) as { unit?: { name?: unknown } }
  return typeof document.unit?.name === 'string' ? document.unit.name : undefined
}

/** 改写 unit 文件头的 name（保持 2 空格缩进 + 尾换行，与 storage-json/format 一致）。 */
function rewriteUnitName(path: string, name: string): void {
  const document = JSON.parse(readFileSync(path, 'utf8')) as { unit?: { name?: unknown } }
  if (document.unit === undefined) throw new Error(`unit '${path}': missing unit header`)
  document.unit.name = name
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
}

/** 迁移旧 unit 文件：校验头名 → 改写为新名并落位规范路径 → 删除旧文件。 */
function migrateUnit(legacyPath: string, canonicalPath: string, legacyName: string, canonicalName: string): void {
  const document = JSON.parse(readFileSync(legacyPath, 'utf8')) as { unit?: { name?: unknown } }
  if (document.unit?.name !== legacyName) throw new Error(`unit '${legacyPath}': unexpected unit header`)
  document.unit.name = canonicalName
  writeFileSync(canonicalPath, `${JSON.stringify(document, null, 2)}\n`)
  rmSync(legacyPath)
}

/**
 * 旧 schema 迁移（0.3.0，设计文档「迁移规则」）：
 * - 旧 `auto` → approved + injected:true（行为不变：仍常驻注入）
 * - 旧 `suggest` → suggested + injected:false
 * - 缺 injected 的 approved → injected:false（新写路径兜底）
 * - 其余 → suggested + injected:false
 */
function normalizeBlock(block: StoredBlock): { status: MemoryStatus; injected: boolean } {
  if (block.status === 'auto') return { status: 'approved', injected: true }
  if (block.status === 'suggest') return { status: 'suggested', injected: false }
  return { status: block.status, injected: block.injected ?? false }
}

function toRecord(id: string, block: StoredBlock): MemoryRecord {
  const base: MemoryRecord = {
    id: MemoryId(id),
    namespace: block.namespace,
    ...normalizeBlock(block),
    content: block.content,
    keywords: block.keywords,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    ...block.lastUsedAt === undefined ? {} : { lastUsedAt: block.lastUsedAt },
    quarantined: block.quarantined === true,
    ...block.quarantineReason === undefined ? {} : { quarantineReason: block.quarantineReason },
    hitCount: block.hitCount ?? 0,
    // ⑧ 来源（2026-09-15）：旧记录无此字段 → 不透传（= 来源未知），不猜
    ...block.source === undefined ? {} : { source: block.source },
    ...block.injectedAuto === undefined ? {} : { injectedAuto: block.injectedAuto },
    ...block.anchor === undefined ? {} : { anchor: block.anchor },
    ...block.stale === undefined ? {} : { stale: block.stale },
    ...block.staleReason === undefined ? {} : { staleReason: block.staleReason },
  }
  // 0.6.0 模板库字段（缺省 fact；prompt 元数据透传）
  return {
    ...base,
    ...block.kind === undefined ? {} : { kind: block.kind },
    ...block.meta === undefined ? {} : { meta: block.meta },
  }
}

/** Harness-home root for `global` memories. */
function globalRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages')
}

/** Project-folder root for `project` memories — follows the repository. */
function projectRoot(): string {
  return join(process.cwd(), '.dsh', 'storages')
}

/**
 * 嵌入能力（0.5.2 混合检索）：缺省不配置 = 纯 BM25（行为不变）；
 * 配置后 memory_search 以 BM25 与语义结果做 RRF 融合，向量持久化到
 * 存储文件（vector 字段，外部可读），失败自动降级回纯 BM25。
 */
export interface MemoryEmbeddings {
  /** 文本 → 向量（与输入等长，一维浮点数组）。 */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>
  /** 相似度函数（缺省余弦相似度）。 */
  similarity?: (left: readonly number[], right: readonly number[]) => number
}

/** Engine configuration: the two storage roots, defaulted to home and project. */
export interface MemoryConfig {
  /** Root for `global` memories; defaults to `$DSH_HOME/storages`. */
  globalRoot?: string
  /** Root for `project` memories; defaults to `<cwd>/.dsh/storages`. */
  projectRoot?: string
  /**
   * 常驻注入预算（字符，0.5.2）：`memory:recall` 每轮注入的摘要总量上限，
   * 超预算按「最近更新优先」省略（面板提示省略数）。null/0 = 不限制。
   * 默认 DEFAULT_INJECTION_BUDGET（1500 字符，约 400-700 token）。
   */
  injectionBudget?: number | null
  /** 单条注入摘要截断上限（字符）；默认 DEFAULT_SUMMARY_CHARS（80）。 */
  summaryChars?: number
  /** 混合语义检索（0.5.2）：缺省纯 BM25；配置后与 BM25 做 RRF 融合。 */
  embeddings?: MemoryEmbeddings
  /** 语义侧参与融合的 topK（0.5.2）；默认 5。 */
  semanticTopK?: number
  /** 全局提示词模板根目录（0.6.0）；默认 `$DSH_HOME/prompt-library`。
   *  project 模板随工作区（`<workspace>/.dsh/prompt-library`，与记忆同构）。 */
  promptGlobalRoot?: string
  /**
   * 查询日志文件路径（2026-09-15 §六.6）；默认为全局存储根下的 `query-log.json`
   * ——即与 `memory.json` **同目录**（`$DSH_HOME/storages/query-log.json`），不落子目录。
   */
  queryLogPath?: string
}

/**
 * Cross-session plaintext memory over the storage hub, split by namespace:
 * `global` lives in the harness home, `project` in the session's workspace
 * folder (`<workspace>/.dsh/storages`, follows the repository) — 0.3.4:
 * project memory routes by the CALLER's workspace cwd (工具/面板按当前会话
 * 工作区路由), not the process launch dir.
 */
export class MemoryEngine extends Service {
  static inject = ['storage']

  private globalTable?: KvTable<string, StoredBlock>
  /** project 域按工作区 cwd 懒打开 + 缓存（多会话并发各工作区独立）。 */
  private projectTables = new Map<string, KvTable<string, StoredBlock>>()
  /** 子项目发现缓存（④-B 2026-09-19）：key = 工作区路径；值 = 其直接子目录中带记忆的（按条数降序）。 */
  private readonly neighborCache = new Map<string, Array<{ name: string, count: number }>>()
  /** 进行中的子项目发现（key → promise）：预热是 fire-and-forget，之后的显式调用与它合流而非重复扫描。 */
  private readonly neighborOpenings = new Map<string, Promise<Array<{ name: string, count: number }>>>()
  /** 进行中的工作区打开（key → promise）：并发调用复用同一次，见 {@link projectTableFor}。 */
  private readonly projectOpenings = new Map<string, Promise<KvTable<string, StoredBlock>>>()
  private projectFacilities = new Map<string, DomainFacility>()
  /** backend 只注册一次（registry 重名抛 duplicate；reload 清缓存后不得重复注册）。 */
  private registeredProjectBackends = new Set<string>()
  private facility?: DomainFacility
  /** 各存储文件上次被我们确认过的指纹；用于识别「另一个实例写过」。 */
  private readonly storeStamps = new Map<string, string>()
  /** 写入串行链：「刷新—读—改—写」必须整体互斥，否则并发写会在其间穿插。 */
  private writeChain: Promise<unknown> = Promise.resolve()
  /** 会话启动维护只跑一次的标记（2026-09-15）。 */
  private maintenanceDone = false

  constructor(ctx: import('@deepseek-ai/cordis').Context, private readonly config: MemoryConfig = {}) {
    super(ctx, 'memory')
  }

  protected async [Service.init](): Promise<void> {
    // backend 只注册一次：registry 对重名注册抛 duplicate-backend
    // （storage/tests/registry.spec 实测），reload 不得重复注册。
    const globalBackend = new JsonStorageBackend(this.config.globalRoot ?? globalRoot())
    this.ctx.storage.backend.register('memory-global', globalBackend)
    await this.openGlobalFacility()
    this.ctx.effect(() => () => {
      void this.facility?.closeAll()
      for (const facility of this.projectFacilities.values()) void facility.closeAll()
    }, 'memory.domainsClose')
  }

  /** 打开全局存储域（init 与 reload 共用；backend 复用已注册实例）。 */
  private async openGlobalFacility(): Promise<void> {
    const facility = new DomainFacility(this.ctx, { backend: 'memory-global', routes: {} })
    const globalDomain = await facility.open(memorySpec('memory'))
    this.facility = facility
    this.globalTable = globalDomain.table('blocks')
  }

  /** 工作区 project 存储根（<workspace>/.dsh/storages，随 git 分享）。 */
  private projectRootFor(cwd: string): string {
    return join(cwd, '.dsh', 'storages')
  }

  /** 稳定 backend 名（registry 重名抛错，按 cwd hash 唯一化；只允许 [a-z0-9_]，domain 名校验）。 */
  private projectBackendName(cwd: string): string {
    let h = 5381
    const text = cwd.toLowerCase() // Windows 路径大小写不敏感
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return `memory_project_${Math.abs(h).toString(36)}`
  }

  /**
   * 工作区表是否已经打开（同步判断）。组装路径用它决定「要不要等一次预热」——
   * 表已打开是常态，那时这条路径不该付出任何异步代价。
   */
  projectOpen(projectCwd?: string): boolean {
    if (projectCwd === undefined || projectCwd === '') return false
    return this.projectTables.has(join(projectCwd))
  }

  /**
   * 按工作区 cwd 取 project 表（懒打开 + 缓存）。无 cwd（未选工作区）
   * 返回 undefined——调用方（工具/面板）按此跳过 project 部分。
   *
   * **打开是异步的，调用方却会并发**：预热是 fire-and-forget，注入路径、工具路径、
   * 面板路径各来一次。底层 unit 句柄只允许一个，两次并发打开会让后到者以
   * `unit '…' is already open; a unit has exactly one live handle` 失败——而调用方
   * 普遍把预热失败当无碍吞掉，于是表现为「这一轮工作区记忆缺席」。所以这里复用
   * 进行中的那次打开。
   */
  private async projectTableFor(projectCwd?: string): Promise<KvTable<string, StoredBlock> | undefined> {
    if (projectCwd === undefined || projectCwd === '') return undefined
    const key = join(projectCwd) // 规范化（Windows 大小写/尾斜杠）
    const cached = this.projectTables.get(key)
    if (cached !== undefined) return cached
    const inFlight = this.projectOpenings.get(key)
    if (inFlight !== undefined) return await inFlight
    const opening = this.openProjectTable(key)
    this.projectOpenings.set(key, opening)
    try {
      return await opening
    } finally {
      this.projectOpenings.delete(key)
    }
  }

  /** {@link projectTableFor} 的实际打开步骤；并发去重由调用方负责。 */
  private async openProjectTable(key: string): Promise<KvTable<string, StoredBlock>> {
    const backendName = this.projectBackendName(key)
    // 0.5.2：旧实现 domain 名多一层 memory_project_ 前缀（文件名双重前缀，
    // 且 unit 文件头 name 同为旧名）。打开前统一迁移到规范名：
    // ①规范名已存在 + 头为旧名（0.5.2 首版只 rename 未改 header 的中间态）→ 改写头；
    // ②旧名文件存在且头匹配 → 改写头并落位规范名；③其他情况回退旧域名（不动数据）。
    const legacyDomainName = `memory_project_${backendName}`
    const root = this.projectRootFor(key)
    const canonicalFile = join(root, `${backendName}.json`)
    const legacyFile = join(root, `${legacyDomainName}.json`)
    let domainName = backendName
    try {
      const canonicalHeader = unitHeaderName(canonicalFile)
      if (canonicalHeader === legacyDomainName) {
        rewriteUnitName(canonicalFile, backendName)
      } else if (canonicalHeader === undefined && unitHeaderName(legacyFile) === legacyDomainName) {
        migrateUnit(legacyFile, canonicalFile, legacyDomainName, backendName)
      } else if (canonicalHeader === undefined && existsSync(legacyFile)) {
        domainName = legacyDomainName // 外域/未知内容：保持旧名路径继续打开，不触碰数据
      }
    } catch {
      domainName = legacyDomainName // 迁移出错：回退旧名打开，数据不动（后续可重试）
    }
    if (!this.registeredProjectBackends.has(backendName)) {
      const backend = new JsonStorageBackend(root)
      this.ctx.storage.backend.register(backendName, backend)
      this.registeredProjectBackends.add(backendName)
    }
    const facility = new DomainFacility(this.ctx, { backend: backendName, routes: {} })
    const domain = await facility.open(memorySpec(domainName))
    const table = domain.table('blocks')
    this.projectFacilities.set(key, facility)
    this.projectTables.set(key, table)
    return table
  }

  /**
   * 强制重载存储：关闭全局域与全部已开工作区域后重开（unit 释放后
   * backend 重读文件），放弃内存缓存。供外部编辑记忆文件后刷新
   * （JsonStorageBackend 打开时加载一次，无 watch——2026-08-19 实测）；
   * 多实例写入协调（0.7.1）让它在每次「磁盘被别人改过」时自动触发。
   *
   * **已打开的工作区要重开，而不是一关了之**：注入 provider 是同步回调、只读
   * 已打开的表，关掉就等同于「这个工作区没有常驻记忆」——工作区记忆会从上下文里
   * 静默消失，直到某次工具调用把它重新打开。重开的表同样从磁盘重读，
   * 「放弃内存缓存」这条语义不变，改变的只是「重读完别忘了装回去」。
   */
  async reload(): Promise<void> {
    // 进行中的打开先落地：否则它们会在下面的 clear 之后把表塞回已清空的映射，
    // 留下「表在映射里但 facility 已关」的半死状态。
    await Promise.allSettled([...this.projectOpenings.values()])
    const opened = [...this.projectTables.keys()]
    await this.facility?.closeAll()
    for (const facility of this.projectFacilities.values()) await facility.closeAll()
    this.projectTables.clear()
    this.projectFacilities.clear()
    this.neighborCache.clear() // ④-B：子项目发现随存储一并作废（外部实例可能刚改过）
    await this.openGlobalFacility()
    for (const key of opened) {
      // 重开失败 = 该工作区退回「未打开」（本轮注入缺这部分，下次访问重试），
      // 不该让触发重载的那一整次写入跟着失败。
      await this.projectTableFor(key).catch(() => undefined)
    }
  }

  /**
   * Create one record. 低危内容直接 `approved`（静默生效，2026-09-15 静默记忆机制）；
   * 命中危险内容规则则隔离：`status` 留 `suggested`（天然不注入）**并且**置
   * `quarantined`（不进检索），双保险，等待人工放行或删除。
   */
  // ── 多实例写入协调（2026-09-17）────────────────────────────────────────
  //
  // 另一个 DSH 实例（web 与 SSiD 同时运行）共用同一个 DSH_HOME 时，它写的记忆只落在
  // 磁盘上；我们的内存态若比磁盘旧，下一次整份覆盖就会把对方的新记忆抹掉。DSH 的
  // 存储层明确不做跨进程协调（storage-json「writer per process and last-write-wins
  // is correct」、storage-sqlite「cross-process coordination is out of scope」），
  // 所以协调放在这里：开写前比对存储文件指纹，变过就重载——等价于「update 前先
  // select」。残余窗口只剩两个实例真正同时写，而记忆写入是低频操作。

  /** 文件指纹：mtime + size（size 兜住同一毫秒内的两次写）。 */
  private static fileStamp(file: string): string {
    try {
      const stat = statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }

  /** 全局记忆的存储文件（JsonStorageBackend 的 unit 文件名 = domain 名）。 */
  private globalStoreFile(): string {
    return join(this.config.globalRoot ?? globalRoot(), 'memory.json')
  }

  /** 某工作区记忆的存储文件。 */
  private projectStoreFile(projectCwd: string): string {
    const key = join(projectCwd)
    return join(this.projectRootFor(key), `${this.projectBackendName(key)}.json`)
  }

  /**
   * 工作区链（④-A 2026-09-19）：当前 cwd 起向上，收集**记忆文件已存在**的层级。
   *
   * 两条约束：
   * ① **自身始终纳入**（depth 0）——即使文件还不存在，也保持既有行为（`projectTableFor`
   *    会创建它，会话预热路径同样如此）。
   * ② **祖先只收文件已存在的**——对不存在的层级打开表会让 JsonStorageBackend **创建**空
   *    文件，等于在用户每个祖先目录里留一个空记忆文件。
   *
   * `depth` 是真实的上级层数（每向上一步 +1，无论该级是否有文件），供来源标记渲染成
   * `..` / `../..`。路径一律先 `join()` 规范化再算哈希——`projectBackendName` 对字符串
   * 敏感，`H:\a\b` 与 `H:/a/b` 会得出**不同**的文件名（设计文档 §2.3）。
   */
  private projectChain(cwd: string): Array<{ key: string, depth: number }> {
    const key = join(cwd)
    const chain: Array<{ key: string, depth: number }> = [{ key, depth: 0 }]
    let cur = key
    let depth = 0
    for (;;) {
      const parent = dirname(cur)
      if (parent === cur) break // 到盘根
      cur = parent
      depth += 1
      if (existsSync(this.projectStoreFile(cur))) chain.push({ key: cur, depth })
    }
    return chain
  }

  /**
   * 打开工作区链上的表（由近及远）。复用 {@link projectTableFor} 的缓存与并发去重——
   * 链上每级各自一张表，重复调用不会重复打开。
   */
  private async projectChainTables(cwd?: string): Promise<Array<{ key: string, depth: number, table: KvTable<string, StoredBlock> }>> {
    if (cwd === undefined || cwd === '') return []
    const out: Array<{ key: string, depth: number, table: KvTable<string, StoredBlock> }> = []
    for (const { key, depth } of this.projectChain(cwd)) {
      const table = await this.projectTableFor(key).catch(() => undefined)
      if (table !== undefined) out.push({ key, depth, table })
    }
    return out
  }

  /** 来源标记：depth 0（当前工作区）不带标记；祖先渲染为 `..` / `../..`。 */
  private static scopeLabel(depth: number): string | undefined {
    if (depth === 0) return undefined
    return Array.from({ length: depth }, () => '..').join('/')
  }

  /**
   * 子项目发现（④-B 2026-09-19）：扫描 cwd 的**直接子目录**（不递归——实测一层即覆盖全部
   * 实际情况：19 个子目录里 3 个带记忆），找出带记忆文件、且其中有非隔离记录的。
   *
   * 结果缓存进 {@link neighborCache}——注入 provider 是同步的，只能读缓存；扫描本身在这个
   * 异步方法里做，由 `ensureProjectOpen` 预热路径触发。
   *
   * 跳过点开头的目录（`.dsh` / `.git` 等不是子项目）；只报条数、不搬运内容——索引行的用途
   * 是「告诉你去搜」，不是把子项目的记忆变成当前会话的持续成本。
   */
  async discoverNeighbors(projectCwd: string): Promise<Array<{ name: string, count: number }>> {
    const key = join(projectCwd)
    const cached = this.neighborCache.get(key)
    if (cached !== undefined) return cached
    // 进行中那次复用：`ensureProjectOpen` 的预热是 fire-and-forget，紧随其后的显式调用
    // （工具路径 / 测试 / 面板）若各扫一遍，既浪费也可能读到半成品。与 `projectTableFor`
    // 同一套去重语义。
    const inFlight = this.neighborOpenings.get(key)
    if (inFlight !== undefined) return await inFlight
    const scan = this.scanNeighbors(key)
    this.neighborOpenings.set(key, scan)
    try {
      return await scan
    } finally {
      this.neighborOpenings.delete(key)
    }
  }

  /** {@link discoverNeighbors} 的实际扫描；并发去重由调用方负责。 */
  private async scanNeighbors(key: string): Promise<Array<{ name: string, count: number }>> {
    const found: Array<{ name: string, count: number }> = []
    let entries: Dirent[] = []
    try {
      entries = await readdir(key, { withFileTypes: true })
    } catch {
      entries = [] // 目录读不到（不存在 / 无权限）：当作没有子项目，不报错
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sub = join(key, entry.name)
      if (!existsSync(this.projectStoreFile(sub))) continue
      const table = await this.projectTableFor(sub).catch(() => undefined)
      if (table === undefined) continue
      const count = this.recordsOf(table).filter(record => record.quarantined !== true).length
      if (count > 0) found.push({ name: entry.name, count })
    }
    found.sort((left, right) => right.count - left.count)
    this.neighborCache.set(key, found)
    return found
  }

  /**
   * 同步读取已发现的子项目（④-B）：注入 provider 是同步回调，只能读缓存。
   * 缓存由 {@link discoverNeighbors} 在预热路径填充；未跑过时返回空数组——该轮索引行
   * 缺席、下一轮补上，与工作区表预热同一套取舍。
   */
  neighborsOf(projectCwd?: string): Array<{ name: string, count: number }> {
    if (projectCwd === undefined || projectCwd === '') return []
    return this.neighborCache.get(join(projectCwd)) ?? []
  }

  /**
   * 同步读取索引候选（① 2026-09-19）：global + 工作区链上**已打开**的表里的全部记录。
   *
   * 与 {@link recallRecords} 的分工：后者只取 `injected` 的（进注入行），前者取全部
   * （供索引行统计规模与主题）。同样是同步只读已缓存的表——注入 provider 是同步回调，
   * 未打开的层级本轮不计入，影响可忽略（链上祖先在检索路径打开后即缓存）。
   */
  indexCandidates(projectCwd?: string): MemoryRecord[] {
    const candidates = this.recordsOf(this.requireTable('global'))
    if (projectCwd === undefined || projectCwd === '') return candidates
    for (const { key } of this.projectChain(projectCwd)) {
      const table = this.projectTables.get(key)
      if (table !== undefined) candidates.push(...this.recordsOf(table))
    }
    return candidates
  }

  /**
   * 按 id 定位记录所在表：global 优先，其次工作区链（自身 → 祖先，由近及远）。
   * **异步版**——写路径必须用它：`writeScope` 可能在本次进入前刚 `reload()`，
   * 那时同步缓存已被清空（同 {@link markUsedInner} 的注释）。
   */
  private async locateRecord(id: MemoryId, projectCwd?: string): Promise<{ table: KvTable<string, StoredBlock>, block: StoredBlock } | undefined> {
    const global = this.requireTable('global')
    const globalBlock = global.get(id)
    if (globalBlock !== undefined) return { table: global, block: globalBlock }
    for (const { table } of await this.projectChainTables(projectCwd)) {
      const block = table.get(id)
      if (block !== undefined) return { table, block }
    }
    return undefined
  }

  /**
   * 写入协调覆盖的存储文件：global + **全部已打开的工作区表** + 本次 cwd。
   *
   * 记录（{@link noteStoreStamps}）与比对（{@link refreshForWrite}）必须共用这一个定义——
   * 两边各写一份正是漂移的来源：在此之前比对侧只列 global + cwd，而 ④-A 把**读**路径扩到了
   * 祖先链（`projectChain`），于是被缓存过的祖先层「指纹记下了却从不被检查」——外部改动看不见，
   * 下一次写回把它**整份覆盖**。**读扩到哪，门就得跟着扩到哪。**
   */
  private storeScopeFiles(projectCwd?: string): string[] {
    const files = [this.globalStoreFile()]
    const scopes = new Set(this.projectTables.keys())
    if (projectCwd !== undefined && projectCwd !== '') scopes.add(join(projectCwd))
    for (const key of scopes) files.push(this.projectStoreFile(key))
    return files
  }

  /** 记录当前指纹，作为「这就是我们造成的状态」的基准（写入完成后调用）。 */
  private noteStoreStamps(projectCwd?: string): void {
    for (const file of this.storeScopeFiles(projectCwd)) {
      this.storeStamps.set(file, MemoryEngine.fileStamp(file))
    }
  }

  /**
   * 写前新鲜度门：存储文件被外部改过就重载，避免整份覆盖吃掉对方的写入。
   * 必须在取表**之前**调用——{@link reload} 重开 facility，此前取到的 table 引用会失效。
   */
  private async refreshForWrite(projectCwd?: string): Promise<void> {
    if (this.storeStamps.size === 0) {
      this.noteStoreStamps(projectCwd)
      return
    }
    for (const file of this.storeScopeFiles(projectCwd)) {
      if (MemoryEngine.fileStamp(file) === this.storeStamps.get(file)) continue
      await this.reload()
      this.noteStoreStamps(projectCwd)
      return
    }
  }

  /**
   * 一次写入的完整作用域：串行化 → 新鲜度门 → 执行 → 记指纹。
   * 刷新与「读—改—写」必须同处一个互斥区，否则并发写会在两者之间穿插。
   * @param projectCwd - 本次写入涉及的工作区；无则只覆盖全局存储。
   * @param run - 实际的读改写；必须在内部重新取表（刷新后旧引用失效）。
   * @returns `run` 的返回值。
   */
  private writeScope<T>(projectCwd: string | undefined, run: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(async () => {
      await this.refreshForWrite(projectCwd)
      const result = await run()
      this.noteStoreStamps(projectCwd)
      return result
    })
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }

  async remember(input: MemoryWrite, projectCwd?: string): Promise<MemoryRecord> {
    return this.writeScope(projectCwd, () => this.rememberInner(input, projectCwd))
  }

  /** {@link remember} 的实现体；必须经 `writeScope` 进入（多实例写入协调）。 */
  private async rememberInner(input: MemoryWrite, projectCwd?: string): Promise<MemoryRecord> {
    const namespace = input.namespace ?? 'global'
    const table = namespace === 'project'
      ? await this.projectTableFor(projectCwd)
      : this.tableFor('global')
    if (table === undefined) throw new Error('cannot write project memory without a workspace cwd')
    const id = randomUUID()
    const now = Date.now()
    // 关键词一并参与判定：密钥塞进 keywords 同样会在检索结果里外泄
    const verdict = detectSensitive(input.content, ...(input.keywords ?? []))
    const block: StoredBlock = {
      namespace,
      status: verdict.quarantined ? 'suggested' : 'approved',
      // 常驻注入（2026-09-18）：显式给值即接管；隔离内容一律不注入
      injected: verdict.quarantined ? false : input.injected ?? false,
      content: input.content,
      keywords: (input.keywords ?? []).map(keyword => keyword.toLowerCase()),
      createdAt: now,
      updatedAt: now,
      // ⑧ 来源（2026-09-15）：缺省 'agent'——写入这条记忆的就是主模型
      source: input.source ?? 'agent',
      // 显式指定注入即接管：此后既不被自动降级，也不被自动升级（同 setInjected，2026-09-18）
      ...input.injected === undefined ? {} : { injectedAuto: false },
      // 有效性锚点（可选）：值变了这条记忆会被标 stale，不再被当成仍然正确
      ...input.anchor === undefined ? {} : { anchor: input.anchor },
      ...verdict.quarantined
        ? { quarantined: true, ...verdict.reason === undefined ? {} : { quarantineReason: verdict.reason } }
        : {},
    }
    await table.put(id, block)
    const record = toRecord(id, block)
    this.ctx.emit('memory/changed', { operation: 'remembered', record })
    return record
  }

  async list(filter?: MemoryFilter, projectCwd?: string): Promise<MemoryRecord[]> {
    const records = await this.allRecords(filter?.namespace, projectCwd)
    return records.filter(record =>
      // 隔离记录默认整体排除（不进列表、不进检索，因而也不进注入预览）；
      // 面板要用 filter.quarantined === true 显式取出来审（2026-09-15）。
      (filter?.quarantined === undefined ? record.quarantined !== true : record.quarantined === filter.quarantined)
      && (filter?.status === undefined || record.status === filter.status)
      && (filter?.injected === undefined || record.injected === filter.injected)
      && (filter?.kind === undefined || (record.kind ?? 'fact') === filter.kind))
  }

  /**
   * 关键词检索。每次成功返回的检索都记一条查询日志（⑥ 2026-09-15）——命中与否都记：
   * 漏检不产生任何事件，只有日志能事后回答「哪些查询本该命中谁」（反例 4）。日志是旁路：
   * 写失败只记 warn，绝不改变本次检索结果。
   */
  async search(query: string, filter?: MemoryFilter, projectCwd?: string): Promise<MemoryHit[]> {
    const hits = await this.rank(query, filter, projectCwd)
    this.recordQuery(query, hits.length, filter)
    return hits
  }

  /** 检索打分本体（BM25 + 可选语义融合）；查询日志由 {@link search} 记录。 */
  private async rank(query: string, filter?: MemoryFilter, projectCwd?: string): Promise<MemoryHit[]> {
    // 记忆检索默认只看 fact（2026-09-15）：模板是文件库、有独立的 prompt_search 通道，
    // 混进来的代价不只是占返回条数——模板也会被记命中，然后「因为经常被搜到」升成常驻。
    // 显式传 kind 的调用方（prompt_search）照旧生效。
    const records = await this.list({ kind: 'fact', ...filter }, projectCwd)
    // 0.5.2：content 与 keywords 分离打加权 BM25（人工关键词命中权重更高）
    const scores = bm25FieldScores(query, records.map(record => ({
      body: record.content,
      tags: record.keywords.join(' '),
    })))
    const bm25Ranked = records
      .map((record, index) => ({ record, score: scores[index] ?? 0 }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
    // 0.5.3：命中即标记使用（冷热追踪）——写回按命中快照之后执行，不影响本次结果。
    // 2026-09-15：只记前 `HIT_MARK_LIMIT` 名（BM25 命中面极宽，全记等于给全库计数）；
    // 记账在语义融合之前，按 BM25 名次取，融合结果只影响返回顺序、不影响计数。
    await this.markUsed(bm25Ranked.slice(0, HIT_MARK_LIMIT).map(hit => hit.record.id), projectCwd)
    // 0.5.2：配置 embeddings 时与语义结果 RRF 融合；缺省/失败降级回纯 BM25
    if (this.config.embeddings === undefined) return bm25Ranked
    try {
      const semantic = await this.semanticRanking(query, records.map(record => record.id), projectCwd)
      if (semantic.length === 0) return bm25Ranked
      const byId = new Map(records.map(record => [String(record.id), record]))
      return rrfFuse([
        bm25Ranked.map(hit => String(hit.record.id)),
        semantic.map(hit => String(hit.id)),
      ]).flatMap(([id, score]) => {
        const record = byId.get(id)
        return record === undefined ? [] : [{ record, score }]
      })
    } catch (error) {
      // 语义通道失败降级：不影响检索可用性（BM25 结果照常返回）
      this.ctx.logger?.warn?.(`dsh-memory: semantic search degraded: ${error instanceof Error ? error.message : String(error)}`)
      return bm25Ranked
    }
  }

  /**
   * 语义排序（0.5.2）：查询向量 + 候选向量的余弦相似度，仅在有
   * embeddings 配置时被调用。缺失向量（新增/更新过的记录）在此补生成
   * 并持久化（vector 字段）；生成失败抛给调用方降级。
   */
  private async semanticRanking(query: string, ids: MemoryId[], projectCwd?: string): Promise<Array<{ id: MemoryId; score: number }>> {
    const config = this.config.embeddings
    if (config === undefined) return []
    const similarity = config.similarity ?? cosineSimilarity
    const topK = this.config.semanticTopK ?? 5
    const queryVector = (await config.embed([query]))?.[0]
    if (queryVector === undefined) return []

    // 缺失向量批量补写（本轮直接用本地生成的向量参与打分，写回不阻塞结果）
    const missing: Array<{ table: KvTable<string, StoredBlock>, id: MemoryId, content: string }> = []
    for (const id of ids) {
      const table = this.tableOf(id, projectCwd)
      const block = table?.get(id)
      if (table === undefined || block === undefined) continue
      if (block.vector === undefined) missing.push({ table, id, content: block.content })
    }
    const fresh = new Map<string, number[]>()
    if (missing.length > 0) {
      const vectors = await config.embed(missing.map(missingRecord => missingRecord.content))
      for (const [index, missingRecord] of missing.entries()) {
        const vector = vectors[index]
        if (vector === undefined) continue
        fresh.set(String(missingRecord.id), [...vector])
        const block = missingRecord.table.get(missingRecord.id)
        if (block !== undefined) {
          await missingRecord.table.put(missingRecord.id, { ...block, vector: [...vector] })
        }
      }
    }

    const scored: Array<{ id: MemoryId; score: number }> = []
    for (const id of ids) {
      const block = this.tableOf(id, projectCwd)?.get(id)
      const vector = fresh.get(String(id)) ?? block?.vector
      if (vector === undefined) continue
      scored.push({ id, score: similarity(queryVector, vector) })
    }
    return scored
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
  }

  /** 按已知 id 定位记录所在表（global 优先，其次当前工作区表）。 */
  /**
   * 会话启动维护（2026-09-15）：一次扫描做完三件事——旧数据迁移、长期未命中的自动降级、
   * 锚点批量校验。只跑一次、幂等、**失败不阻断**（记忆可用性优先于维护完成度）。
   *
   * 调用点在 `ensureProjectOpen`：它是 async，且每会话首次打开工作区表时必经。
   * `memory:recall` 的 provider 是**同步**回调，不能在那里 await。
   *
   * @param projectCwd - 会话工作区：迁移/降级/校验都连它一起处理。
   */
  private async runMaintenanceOnce(projectCwd: string): Promise<void> {
    if (this.maintenanceDone) return
    this.maintenanceDone = true
    try {
      const migration = await this.migrateLegacy(projectCwd)
      if (migration.approved > 0 || migration.quarantined > 0 || migration.counted > 0) {
        this.ctx.logger?.info?.(
          `dsh-memory: 旧数据迁移 放行 ${migration.approved} / 隔离 ${migration.quarantined}`
          + ` / 回填计数 ${migration.counted}`,
        )
      }
      const demoted = await this.demoteStale(projectCwd)
      if (demoted > 0) this.ctx.logger?.info?.(`dsh-memory: 长期未命中，撤下常驻 ${demoted} 条`)
      const staled = await this.verifyAnchors(this.anchorProbes(), projectCwd)
      if (staled > 0) this.ctx.logger?.info?.(`dsh-memory: 锚点校验更新 ${staled} 条`)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-memory: 启动维护失败（不影响使用）：${String(error)}`)
    }
  }

  /**
   * 锚点探测上下文。`toolNames` 拿不到时返回 `undefined`——**不能给空数组**：那会被判成
   * 「工具全没了」，让所有 `tool-list` 锚点误失效。
   */
  private anchorProbes(): AnchorProbes {
    let toolNames: string[] | undefined
    try {
      const tools = this.ctx.get('tools') as { list?: () => Array<{ name?: string }> } | undefined
      const listed = tools?.list?.()
      if (Array.isArray(listed)) {
        toolNames = listed
          .map(tool => tool.name)
          .filter((name): name is string => typeof name === 'string')
      }
    } catch {
      toolNames = undefined
    }
    return { ...(toolNames === undefined ? {} : { toolNames }), selfVersion: SELF_VERSION }
  }

  /** 同步版定位：只查**已打开**的表（global + 链上已缓存的工作区表）。 */
  private tableOf(id: MemoryId, projectCwd?: string): KvTable<string, StoredBlock> | undefined {
    const global = this.requireTable('global')
    if (global.get(id) !== undefined) return global
    if (projectCwd === undefined || projectCwd === '') return undefined
    for (const { key } of this.projectChain(projectCwd)) {
      const table = this.projectTables.get(key)
      if (table !== undefined && table.get(id) !== undefined) return table
    }
    return undefined
  }

  /** 命中标记：写回 lastUsedAt 与命中次数，达标即自动升常驻（2026-09-15）。 */
  private async markUsed(ids: MemoryId[], projectCwd?: string): Promise<void> {
    return this.writeScope(projectCwd, () => this.markUsedInner(ids, projectCwd))
  }

  /** {@link markUsed} 的实现体；必须经 `writeScope` 进入（`recordUse` 在此之内）。 */
  private async markUsedInner(ids: MemoryId[], projectCwd?: string): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    const global = this.requireTable('global')
    // 取表走异步版：`writeScope` 可能在本次进入前刚 `reload()`（外部实例改过存储），
    // 那时同步缓存已被清空——继续读缓存会把 project 侧的命中静默漏记。
    // ④-A：链上的祖先表同样纳入。跨工作区命中的条目也要记账——否则它们的
    // `lastUsedAt` 长期不动，会被 30 天规则误撤（「用得到却没被记录」）。
    const chainTables = await this.projectChainTables(projectCwd)
    for (const id of ids) {
      const globalBlock = global.get(id)
      if (globalBlock !== undefined) {
        await this.recordUse(global, id, globalBlock, now)
        continue
      }
      for (const { table } of chainTables) {
        const block = table.get(id)
        if (block !== undefined) {
          await this.recordUse(table, id, block, now)
          break
        }
      }
    }
  }

  /**
   * 命中记账 + 自动升级（2026-09-15 静默记忆机制）：命中次数达阈值即自动打开常驻
   * 注入——「被反复检索命中」是它值得每轮付费的唯一客观证据。统计性字段不 emit，
   * 只有真的改变了注入状态才发 `memory/changed`。
   */
  private async recordUse(
    table: KvTable<string, StoredBlock>,
    id: MemoryId,
    block: StoredBlock,
    now: number,
  ): Promise<void> {
    const hitCount = (block.hitCount ?? 0) + 1
    const normalized = normalizeBlock(block)
    // 人工设置过的（injectedAuto === false）双向豁免：既不被降级，也不被升级。
    // 少了这一条，人手动关掉的记忆会在下次命中时被系统重新打开——用户唯一能
    // 表达「不要这条常驻」的动作就失效了，而这与降级侧「人工决定优先」不对称。
    const promote = normalized.status === 'approved'
      && block.quarantined !== true
      && block.injectedAuto !== false
      // 模板永不注入（0.6.0）：prompt 记录连自动升级的资格都没有。少了这一条，
      // 模板会因「经常被搜到」而升成常驻，把注入预算花在从不该进上下文的东西上。
      && (block.kind ?? 'fact') !== 'prompt'
      && !normalized.injected
      && hitCount >= AUTO_INJECT_HITS
    const updated: StoredBlock = {
      ...block,
      hitCount,
      lastUsedAt: now,
      ...promote ? { injected: true, injectedAuto: true } : {},
    }
    await table.put(id, updated)
    if (promote) this.ctx.emit('memory/changed', { operation: 'injected', id, injected: true })
  }

  // ── 查询日志与影响力统计（⑥ 2026-09-15）────────────────────────────────
  /** 查询日志（惰性创建；位置见 {@link queryLogPath}）。 */
  private queryLogInstance?: QueryLog

  private queryLog(): QueryLog {
    this.queryLogInstance ??= new QueryLog({ path: this.queryLogPath() })
    return this.queryLogInstance
  }

  /** 查询日志文件路径：与 `memory.json` 同目录（不落子目录）。 */
  private queryLogPath(): string {
    return this.config.queryLogPath ?? join(this.config.globalRoot ?? globalRoot(), 'query-log.json')
  }

  /**
   * 记录一次检索：查询文本（截断到 120 字符）+ 命中条数 + 时间。**失败绝不影响检索**——
   * 日志是旁路证据，不是检索的一部分。模板库检索不进日志：`prompt_search` 复用同一条
   * `search` 通道，但模板是文件库、不属于「记忆漏检」的观察面。
   *
   * 查询文本是新的明文落盘点，因此先过危险内容硬拦（与写入路径同一套规则）：命中就只记
   * 规则名、不留原文——凭据不该因为「只是被搜了一下」而进另一个明文文件。
   */
  private recordQuery(query: string, hits: number, filter?: MemoryFilter): void {
    if (filter?.kind === 'prompt') return
    try {
      const verdict = detectSensitive(query)
      this.queryLog().appendQuery(verdict.quarantined
        ? { query: `[已脱敏：命中 ${verdict.reason ?? 'dangerous-content'}]`, hits }
        : { query, hits })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-memory: 查询日志写入跳过：${String(error)}`)
    }
  }

  /**
   * 影响力统计（⑥ / 反例 5）：按来源聚合「写入量 / 被检索命中数 / 常驻注入数」。
   * 只算 fact 记录（模板索引不是记忆），隔离记录不计（与 list 的默认口径一致：
   * 它们不在流通里）。「被人工删除数」暂缺的原因见 `summarizeSources` 的注释。
   */
  async sourceStats(projectCwd?: string): Promise<SourceStat[]> {
    const records = await this.list({ kind: 'fact' }, projectCwd)
    return summarizeSources(records.map(record => ({
      ...record.source === undefined ? {} : { source: record.source },
      hitCount: record.hitCount,
      injected: record.injected,
    })))
  }

  /**
   * 低频反查（⑥，**只产出报告，不自动改写**）：拿「命中 0 的查询」与既有记忆反查，
   * 给出「本应命中却没命中」的候选，供人工或模型补 keywords。
   *
   * 不做自动补写：判断「这条记忆是否真该被那个查询找到」需要 LLM 语义判断，插件只提供
   * 证据（候选为空即知识缺口——「这类知识你还没有」本身也是有用信息）。调用时机由人
   * 或模型定，不在检索路径上、不产生每轮成本。
   *
   * @param projectCwd - 会话工作区；候选库连工作区记忆一起取。
   * @param limit - 最多反查几个空命中查询（按最近出现排序）。
   */
  async suggestKeywordGaps(projectCwd?: string, limit = 10): Promise<KeywordGapReport> {
    const summary = summarizeQueryLog(this.queryLog().readLog(), limit)
    if (summary.gaps.length === 0) return { logSize: summary.total, misses: summary.misses, gaps: [] }
    const records = await this.list({ kind: 'fact' }, projectCwd)
    const byId = new Map(records.map(record => [String(record.id), record]))
    const docs = records.map(record => ({
      id: String(record.id),
      body: record.content,
      tags: record.keywords.join(' '),
    }))
    return {
      logSize: summary.total,
      misses: summary.misses,
      gaps: summary.gaps.map(gap => ({
        query: gap.query,
        count: gap.count,
        lastAt: gap.lastAt,
        candidates: rankGapCandidates(gap.query, docs).flatMap(candidate => {
          const record = byId.get(candidate.id)
          return record === undefined ? [] : [{
            id: candidate.id,
            excerpt: record.content.slice(0, GAP_EXCERPT_CHARS),
            keywords: record.keywords,
            exact: candidate.exact,
            relaxed: candidate.relaxed,
          }]
        }),
      })),
    }
  }

  /**
   * 长期未命中的自动降级（2026-09-15 淘汰机制）：**只撤自动开的常驻注入**——人工开
   * 的开关不会被时间悄悄关掉（那是人的决定，不是信号的结论）。判定用 lastUsedAt，
   * 从未命中过则回退 updatedAt。会话启动时调一次即可（见 index.ts 的预热路径）。
   *
   * @param projectCwd - 会话工作区；给了就连工作区表一起扫。
   * @param now - 当前时间（测试注入用）。
   * @returns 被撤下的条数（诊断与日志用）。
   */
  async demoteStale(projectCwd?: string, now = Date.now()): Promise<number> {
    return this.writeScope(projectCwd, () => this.demoteStaleInner(projectCwd, now))
  }

  /** {@link demoteStale} 的实现体；必须经 `writeScope` 进入。 */
  private async demoteStaleInner(projectCwd?: string, now = Date.now()): Promise<number> {
    const threshold = now - AUTO_DEMOTE_DAYS * 24 * 60 * 60 * 1000
    const tables: Array<KvTable<string, StoredBlock>> = [this.requireTable('global')]
    if (projectCwd !== undefined && projectCwd !== '') {
      const project = await this.projectTableFor(projectCwd)
      if (project !== undefined) tables.push(project)
    }
    let demoted = 0
    for (const table of tables) {
      // 先快照键值对：put 会改到底层 Map，边遍历边写不安全
      for (const [id, block] of [...table.entries()]) {
        if (block.injectedAuto !== true) continue
        if (block.quarantined === true) continue
        if (normalizeBlock(block).status !== 'approved') continue
        const last = block.lastUsedAt ?? block.updatedAt
        if (last > threshold) continue
        await table.put(id, { ...block, injected: false, injectedAuto: false })
        this.ctx.emit('memory/changed', { operation: 'injected', id: MemoryId(id), injected: false })
        demoted += 1
      }
    }
    return demoted
  }

  /**
   * 锚点批量校验（2026-09-15）：会话启动时调一次，把失效的条目标成 `stale`。
   *
   * 失效同时**撤掉常驻注入**——内容可能已经错了，继续每轮注入就是在误导（反例 2 的
   * 教训）；但**不删除、也不排除检索**，它在结果里带标注，等模型核对后回写。
   * 探测不到（`undefined`）按「未校验」处理，不动任何状态。
   *
   * @param probes - 探测上下文（工具清单 / 自身版本 / env 读取器）。
   * @param projectCwd - 会话工作区；给了就连工作区表一起校验。
   * @returns 本次状态发生变化的条数。
   */
  async verifyAnchors(probes: AnchorProbes, projectCwd?: string): Promise<number> {
    return this.writeScope(projectCwd, () => this.verifyAnchorsInner(probes, projectCwd))
  }

  /** {@link verifyAnchors} 的实现体；必须经 `writeScope` 进入。 */
  private async verifyAnchorsInner(probes: AnchorProbes, projectCwd?: string): Promise<number> {
    const tables: Array<KvTable<string, StoredBlock>> = [this.requireTable('global')]
    if (projectCwd !== undefined && projectCwd !== '') {
      const project = await this.projectTableFor(projectCwd)
      if (project !== undefined) tables.push(project)
    }
    let changed = 0
    for (const table of tables) {
      for (const [id, block] of [...table.entries()]) {
        if (block.anchor === undefined) continue
        const holds = anchorHolds(block.anchor, probes)
        if (holds === undefined) continue          // 未校验：探测不到就不动
        if ((block.stale === true) === !holds) continue   // 状态没变
        const label = `${block.anchor.kind}${block.anchor.name === undefined ? '' : `:${block.anchor.name}`}`
        const updated: StoredBlock = holds
          ? { ...block, stale: false, staleReason: undefined }
          : {
              ...block,
              stale: true,
              staleReason: `${label} 声明为 ${block.anchor.value}，当前不符`,
              injected: false,
              injectedAuto: false,
            }
        await table.put(id, updated)
        this.ctx.emit('memory/changed', { operation: 'status', id: MemoryId(id), status: normalizeBlock(updated).status })
        changed += 1
      }
    }
    return changed
  }

  /**
   * 旧数据迁移（2026-09-15 静默记忆机制）：一次性、幂等，会话启动维护时调用。
   *
   * 旧语义里 `suggested` 是「等人工审核」，新语义里它只剩「隔离」与「人工回退」两种含义——
   * 不迁移的话那些记录会永久卡住：既不注入，也没人去放行。迁移逐条过危险内容检测：
   * 安全则升 `approved`（写入即生效），命中则标 `quarantined` 进隔离（**必须先检测再放行**：
   * 历史条目若含密钥，直接放行等于让它开始进注入）。
   *
   * 另外把「有 `lastUsedAt` 但无 `hitCount`」的老记录回填 `hitCount = 1`——它们可能早已被
   * 反复用过，不该从零开始攒两次命中。旧 `injected: true` 且无 `injectedAuto` 的一律不动：
   * 那是人工决定，不该被自动降级。
   *
   * @param projectCwd - 会话工作区；给了就连工作区表一起迁移。
   * @returns 迁移统计（放行 / 隔离 / 回填计数）。
   */
  async migrateLegacy(projectCwd?: string): Promise<{ approved: number, quarantined: number, counted: number }> {
    return this.writeScope(projectCwd, () => this.migrateLegacyInner(projectCwd))
  }

  /** {@link migrateLegacy} 的实现体；必须经 `writeScope` 进入。 */
  private async migrateLegacyInner(projectCwd?: string): Promise<{ approved: number, quarantined: number, counted: number }> {
    const tables: Array<KvTable<string, StoredBlock>> = [this.requireTable('global')]
    if (projectCwd !== undefined && projectCwd !== '') {
      const project = await this.projectTableFor(projectCwd)
      if (project !== undefined) tables.push(project)
    }
    const stats = { approved: 0, quarantined: 0, counted: 0 }
    // 幂等：先判断是否真的有事可做——没有就直接返回，连备份都不做（否则每天首次启动
    // 都会留下一份无意义的 .bak）
    const needsMigration = tables.some(table => [...table.entries()].some(([, block]) => {
      const normalized = normalizeBlock(block)
      if (normalized.status === 'suggested' && block.quarantined !== true) return true
      return block.hitCount === undefined && block.lastUsedAt !== undefined
    }))
    if (!needsMigration) return stats
    // 迁移前备份全局存储（工作区记忆随 git 分享，有 git 兜底）。备份失败只记日志、不阻断：
    // 迁移本身就是幂等的，最坏情况是重复跑一次。
    try {
      const file = join(this.config.globalRoot ?? globalRoot(), 'memory.json')
      if (existsSync(file)) {
        const backup = `${file}.bak-${new Date().toISOString().slice(0, 10)}-migration`
        if (!existsSync(backup)) writeFileSync(backup, readFileSync(file))
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-memory: migration backup skipped: ${String(error)}`)
    }
    for (const table of tables) {
      for (const [id, block] of [...table.entries()]) {
        const normalized = normalizeBlock(block)
        let updated: StoredBlock | undefined
        // ① 旧的 suggested：安全则放行、危险则隔离
        if (normalized.status === 'suggested' && block.quarantined !== true) {
          const verdict = detectSensitive(block.content, ...block.keywords)
          if (verdict.quarantined) {
            updated = {
              ...block,
              status: 'suggested',
              injected: false,
              quarantined: true,
              ...verdict.reason === undefined ? {} : { quarantineReason: verdict.reason },
            }
            stats.quarantined += 1
          } else {
            updated = { ...block, status: 'approved', injected: normalized.injected }
            stats.approved += 1
          }
        }
        // ② 命中计数回填（在 ① 的结果之上叠加，避免两次 put 互相覆盖）
        const base = updated ?? block
        if (base.hitCount === undefined && base.lastUsedAt !== undefined) {
          updated = { ...base, hitCount: 1 }
          stats.counted += 1
        }
        if (updated !== undefined) await table.put(id, updated)
      }
    }
    return stats
  }

  async forget(id: MemoryId, projectCwd?: string): Promise<boolean> {
    return this.writeScope(projectCwd, () => this.forgetInner(id, projectCwd))
  }

  /** {@link forget} 的实现体；必须经 `writeScope` 进入。 */
  private async forgetInner(id: MemoryId, projectCwd?: string): Promise<boolean> {
    if (await this.requireTable('global').delete(id)) {
      this.ctx.emit('memory/changed', { operation: 'forgotten', id })
      return true
    }
    // ④-A：删除要能命中链上的祖先表——「检索得到却删不掉」是最别扭的一种不一致
    for (const { table } of await this.projectChainTables(projectCwd)) {
      if (await table.delete(id)) {
        this.ctx.emit('memory/changed', { operation: 'forgotten', id })
        return true
      }
    }
    return false
  }

  async setStatus(id: MemoryId, status: MemoryStatus, projectCwd?: string): Promise<MemoryRecord> {
    return this.writeScope(projectCwd, () => this.setStatusInner(id, status, projectCwd))
  }

  /** {@link setStatus} 的实现体；必须经 `writeScope` 进入。 */
  private async setStatusInner(id: MemoryId, status: MemoryStatus, projectCwd?: string): Promise<MemoryRecord> {
    // ④-A：定位走工作区链（global 优先，其次自身 → 祖先）——检索得到的记录就该改得动
    const found = await this.locateRecord(id, projectCwd)
    if (found === undefined) throw new Error(`cannot set status of unknown memory '${id}'`)
    const { table, block } = found
    const updated: StoredBlock = {
      ...block,
      status,
      // 旧数据可能缺 injected，写回时补全（读时迁移值）
      injected: normalizeBlock(block).injected,
      // 人工放行 = 审核通过并解除隔离（2026-09-15）
      ...status === 'approved' ? { quarantined: false, quarantineReason: undefined } : {},
      updatedAt: Date.now(),
    }
    await table.put(id, updated)
    const record = toRecord(id, updated)
    this.ctx.emit('memory/changed', { operation: 'status', id, status })
    return record
  }

  /**
   * 注入维度开关（0.3.0）：只改 injected，不动审核状态。供 UI 面板「常驻注入」开关调用
   * （remote.setInjected）。2026-09-18 起模型侧有等价路径——`memory_save` / `memory_update`
   * 的 `injected` 参数，经 {@link remember} / {@link update} 写同一套 `injectedAuto: false`
   * 语义。差异只在越界处理：本方法对隔离记录**抛错**（用户明确要开，该被告知），
   * 而写入/更新路径**静默降级为不注入**（那是顺带设置，不该中断整次写入）。
   */
  async setInjected(id: MemoryId, injected: boolean, projectCwd?: string): Promise<MemoryRecord> {
    return this.writeScope(projectCwd, () => this.setInjectedInner(id, injected, projectCwd))
  }

  /** {@link setInjected} 的实现体；必须经 `writeScope` 进入。 */
  private async setInjectedInner(id: MemoryId, injected: boolean, projectCwd?: string): Promise<MemoryRecord> {
    // ④-A：定位走工作区链（global 优先，其次自身 → 祖先）
    const found = await this.locateRecord(id, projectCwd)
    if (found === undefined) throw new Error(`cannot set injected of unknown memory '${id}'`)
    // 模板永不注入（0.6.0）：prompt 记录拒绝开关（UI 对该类不展示开关，此处兜底）
    if ((found.block.kind ?? 'fact') === 'prompt') {
      throw new Error(`cannot set injected of prompt record '${id}': prompt templates are never injected`)
    }
    // 隔离记录不可注入（2026-09-15）：先放行（setStatus approved）再开开关
    if (injected && found.block.quarantined === true) {
      throw new Error(`cannot inject quarantined memory '${id}': approve it first`)
    }
    const updated: StoredBlock = {
      ...found.block,
      status: normalizeBlock(found.block).status,
      injected,
      // 人工设置过即接管：此后既不被「长期未命中」自动降级，也不被「反复命中」自动升级（2026-09-15）
      injectedAuto: false,
      updatedAt: Date.now(),
    }
    await found.table.put(id, updated)
    const record = toRecord(id, updated)
    this.ctx.emit('memory/changed', { operation: 'injected', id, injected })
    return record
  }

  /**
   * 修改一条记忆的内容/关键词/注入位（0.3.1 整理记忆用）。2026-09-15 起：改动**不再**
   * 退回待审核——静默机制下记忆由系统与模型自行维护，更新即保持原有审核状态。2026-09-18
   * 起可改 `injected`：**省略则保留原值**（连 `injectedAuto` 一起不动），给值即接管。若新
   * 内容命中危险规则则转为隔离（与写入路径同一判定），并连带撤下注入。
   */
  async update(id: MemoryId, patch: MemoryPatch, projectCwd?: string): Promise<MemoryRecord> {
    return this.writeScope(projectCwd, () => this.updateInner(id, patch, projectCwd))
  }

  /** {@link update} 的实现体；必须经 `writeScope` 进入。 */
  private async updateInner(id: MemoryId, patch: MemoryPatch, projectCwd?: string): Promise<MemoryRecord> {
    const applyPatch = (block: StoredBlock): StoredBlock => {
      const normalized = normalizeBlock(block)
      const content = patch.content ?? block.content
      const keywords = patch.keywords === undefined
        ? block.keywords
        : patch.keywords.map(keyword => keyword.toLowerCase())
      const verdict = detectSensitive(content, ...keywords)
      // 命中危险规则：退回 suggested（不注入）+ 隔离（不检索）双保险；否则保持原状态
      const status = verdict.quarantined ? 'suggested' : normalized.status
      // 常驻注入（2026-09-18）：显式给值即接管；未审核或已隔离一律不注入（与自动升级同一门槛）
      const injected = status === 'approved' ? patch.injected ?? normalized.injected : false
      return {
        ...block,
        status,
        injected,
        // 显式改注入即视为有意决定：此后不受自动升降影响（省略时连 injectedAuto 一起保持）
        ...patch.injected === undefined ? {} : { injectedAuto: false },
        ...verdict.quarantined
          ? { quarantined: true, ...verdict.reason === undefined ? {} : { quarantineReason: verdict.reason } }
          : { quarantined: false, quarantineReason: undefined },
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.keywords === undefined ? {} : { keywords }),
        updatedAt: Date.now(),
      }
    }
    // 注入位变化单独发一条事件：客户端与面板据此刷新「常驻」列，只发 status 会漏掉它
    const publish = (previous: StoredBlock, updated: StoredBlock): MemoryRecord => {
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'status', id, status: normalizeBlock(updated).status })
      const wasInjected = normalizeBlock(previous).injected
      const isInjected = normalizeBlock(updated).injected
      if (isInjected !== wasInjected) {
        this.ctx.emit('memory/changed', { operation: 'injected', id, injected: isInjected })
      }
      return record
    }
    // ④-A：定位走工作区链（global 优先，其次自身 → 祖先）——检索得到的记录就该改得动
    const found = await this.locateRecord(id, projectCwd)
    if (found === undefined) throw new Error(`cannot update unknown memory '${id}'`)
    const { table, block } = found
    const updated = applyPatch(block)
    await table.put(id, updated)
    return publish(block, updated)
  }

  /**
   * 预热某工作区的 project 表（异步打开并缓存）。system prompt 的
   * `memory:recall` provider 是同步回调——只读已打开的表；预热让
   * 会话创建/首次请求后本轮或下一轮即可注入工作区记忆。
   */
  async ensureProjectOpen(projectCwd: string): Promise<void> {
    const key = join(projectCwd)
    // ④-B：子项目发现与表预热相互独立——表可能早已打开，而发现还没跑过。
    // 注入 provider 是同步的、只能读缓存，所以必须在这条异步预热路径上先把发现做掉。
    if (!this.neighborCache.has(key)) void this.discoverNeighbors(key).catch(() => undefined)
    if (this.projectTables.has(key)) return
    await this.projectTableFor(key)
    // 会话内首次打开工作区表时做一次启动维护（迁移 / 降级 / 锚点校验，2026-09-15）
    await this.runMaintenanceOnce(projectCwd)
  }

  /**
   * 注入专用（0.3.4 + 0.5.1）：system prompt 的 `memory:recall` context
   * provider 可经 AssembleContext.agent 拿到当前会话 header.cwd，因此
   * 注入 = global 的 approved+injected + 当前会话工作区的 approved+injected。
   * provider 是同步回调：只读已打开/缓存的表，未打开的工作区本轮为空
   * （`ensureProjectOpen` 提供预热，工具/面板路径也会打开）。
   */
  recallRecords(projectCwd?: string): MemoryRecord[] {
    const injected = (table: KvTable<string, StoredBlock>): MemoryRecord[] =>
      // 模板永不注入（0.6.0）：这一条是兜底——即使存储里出现被标了 injected 的 prompt
      // 记录（旧版本或人工改文件留下的），也不让它进上下文。
      this.recordsOf(table).filter(record => record.status === 'approved'
        && record.injected
        && (record.kind ?? 'fact') !== 'prompt')
    const global = injected(this.requireTable('global'))
    if (projectCwd === undefined || projectCwd === '') return global
    const project = this.projectTables.get(join(projectCwd))
    if (project === undefined) return global
    return [...global, ...injected(project)]
  }

  private async allRecords(namespace?: MemoryNamespace, projectCwd?: string): Promise<MemoryRecord[]> {
    // ④-A：project 侧从「当前 cwd 那一张表」扩为「工作区链上的表」（自身 + 已存在的祖先）。
    // 祖先记录带 scope 标记（`..` / `../..`），让调用方与用户都看得出这条来自哪一级。
    const projectRecords = async (): Promise<MemoryRecord[]> => {
      const tables = await this.projectChainTables(projectCwd)
      return tables.flatMap(({ depth, table }) => {
        const scope = MemoryEngine.scopeLabel(depth)
        return this.recordsOf(table).map(record => scope === undefined ? record : { ...record, scope })
      })
    }
    if (namespace === 'project') return projectRecords()
    if (namespace === 'global') return this.recordsOf(this.requireTable('global'))
    return [...this.recordsOf(this.requireTable('global')), ...await projectRecords()]
  }

  private recordsOf(table: KvTable<string, StoredBlock>): MemoryRecord[] {
    return [...table.entries()].map(([id, block]) => toRecord(id, block))
  }

  private tableFor(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    return this.requireTable(namespace)
  }

  private requireTable(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    const table = namespace === 'global' ? this.globalTable : undefined
    if (table === undefined) throw new Error('memory engine is not started yet')
    return table
  }

  // ── 提示词模板库（0.6.0）：md 文件是事实源，索引记录 kind='prompt' ──────
  /** 全局模板根（默认 `$DSH_HOME/prompt-library`，可配置覆盖）。 */
  private promptGlobalDir(): string {
    return this.config.promptGlobalRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'prompt-library')
  }

  /** project 模板根（随工作区 `<workspace>/.dsh/prompt-library`，与记忆同构）。 */
  private promptProjectDir(projectCwd?: string): string {
    if (projectCwd === undefined || projectCwd === '') return ''
    return join(projectCwd, '.dsh', 'prompt-library')
  }

  /** 稳定索引 id（按路径 hash；文件删除后随刷新清理）。 */
  private promptIdOf(path: string): MemoryId {
    let h = 5381
    const text = path.toLowerCase()
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return MemoryId(`prompt-${Math.abs(h).toString(36)}`)
  }

  /**
   * 扫描模板目录并同步索引（mtime 惰性：未变条目零写；目录缺失 = 空库）。
   * @returns 统计（扫描数/变更数/清理数 + 坏文件警告）。
   */
  async refreshPromptIndex(projectCwd?: string): Promise<{ scan: number, changed: number, removed: number, warnings: string[] }> {
    const globalDir = this.promptGlobalDir()
    const projectDir = this.promptProjectDir(projectCwd)
    const globalScan = scanPromptDir(globalDir)
    const projectScan = scanPromptDir(projectDir)
    const scanned = [...globalScan.files, ...projectScan.files]
    const warnings = [...globalScan.warnings, ...projectScan.warnings]
    const globalTable = this.requireTable('global')
    const projectTable = projectCwd !== undefined && projectCwd !== ''
      ? await this.projectTableFor(projectCwd)
      : undefined
    const existing = await this.list({ kind: 'prompt' }, projectCwd)
    const existingById = new Map(existing.map(record => [String(record.id), record]))
    const seen = new Set<string>()
    let changed = 0
    let removed = 0
    const now = Date.now()
    for (const file of scanned) {
      const id = this.promptIdOf(file.path)
      seen.add(String(id))
      const isGlobal = file.path.startsWith(globalDir)
      const table = isGlobal ? globalTable : projectTable
      if (table === undefined) continue
      const prev = existingById.get(String(id))
      if (prev?.meta !== undefined && prev.meta.mtime === file.mtime) continue // mtime 未变：零写
      const keywords = [
        file.meta.name,
        ...(file.meta.dimension !== undefined ? [file.meta.dimension] : []),
        ...(file.meta.difficulty !== undefined ? [file.meta.difficulty] : []),
        ...file.meta.tags,
      ].filter(keyword => keyword !== '').map(keyword => keyword.toLowerCase())
      const block: StoredBlock = {
        namespace: isGlobal ? 'global' : 'project',
        status: 'approved',   // 文件存在即生效（设计文档 §三：模板不做审核流）
        injected: false,      // 模板永不注入
        content: [file.meta.name, file.meta.dimension ?? '', file.meta.difficulty ?? '', file.meta.tags.join(' '), file.summary]
          .filter(part => part !== '').join(' '),
        keywords,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        kind: 'prompt',
        meta: {
          seq: file.meta.seq,
          name: file.meta.name,
          dimension: file.meta.dimension,
          difficulty: file.meta.difficulty,
          tags: file.meta.tags,
          summary: file.summary,
          path: file.path,
          mtime: file.mtime,
          source: file.meta.source,
        },
      }
      await table.put(id, block)
      changed++
    }
    for (const record of existing) {
      if (seen.has(String(record.id))) continue
      if (record.meta === undefined) continue
      const isGlobal = record.meta.path.startsWith(globalDir)
      const table = isGlobal ? globalTable : projectTable
      if (table !== undefined) {
        await table.delete(record.id)
        removed++
      }
    }
    return { scan: scanned.length, changed, removed, warnings }
  }

  /**
   * 取模板（id 或名称/路径片段定位），返回 md 全文（直读文件，忽略索引缓存）。
   * @throws 未命中或文件解析失败（错误信息可读）。
   */
  async promptGet(nameOrId: string, projectCwd?: string): Promise<PromptFile> {
    const records = await this.list({ kind: 'prompt' }, projectCwd)
    const needle = nameOrId.trim()
    const hit = records.find(record => {
      if (record.meta === undefined) return false
      const stem = (record.meta.path.split(/[\\/]/).pop() ?? '').replace(/\.md$/i, '')
      const afterSeq = stem.replace(/^\d+_/, '') // 去掉序号前缀：36_名称 → 名称
      return String(record.id) === needle || afterSeq === needle || afterSeq.includes(needle)
    })
    if (hit === undefined || hit.meta === undefined) {
      throw new Error(`prompt '${nameOrId}' not found（可用 prompt_list 查看全部）`)
    }
    const text = readFileSync(hit.meta.path, 'utf8')
    const parsed = parsePromptFile(hit.meta.path, text)
    if (!parsed.ok) throw new Error(`prompt file ${hit.meta.path} parse failed: ${parsed.error}`)
    return parsed.file
  }

  /**
   * 新增模板：写 md 文件（序号自动分配/文件名安全化/同名防覆盖）+ 刷新索引。
   * 返回索引记录（模型新增 source='agent'，UI 角标提示）。
   */
  async promptAdd(
    input: { name: string, dimension?: string, difficulty?: string, tags?: string[], content: string, fallback?: string, source: 'user' | 'agent', namespace?: MemoryNamespace },
    projectCwd?: string,
  ): Promise<MemoryRecord> {
    const dir = input.namespace === 'project' ? this.promptProjectDir(projectCwd) : this.promptGlobalDir()
    if (dir === '') throw new Error('cannot write project prompt without a workspace cwd')
    const path = writePromptFile(dir, input)
    await this.refreshPromptIndex(projectCwd)
    const found = (await this.list({ kind: 'prompt' }, projectCwd))
      .find(record => String(record.id) === String(this.promptIdOf(path)))
    if (found === undefined) throw new Error('prompt written but index refresh failed')
    return found
  }

  /** 删除模板：md 文件与索引一并删除；未命中返回 false。 */
  async promptRemove(idOrName: string, projectCwd?: string): Promise<boolean> {
    let file: PromptFile | null = null
    try {
      file = await this.promptGet(idOrName, projectCwd)
    } catch {
      return false
    }
    rmSync(file.path, { force: true })
    await this.refreshPromptIndex(projectCwd)
    return true
  }
}
