/**
 * 同步墓碑：把 `memory_forget` 的真删表达成「记录被修改」，而不是「文件消失」。
 *
 * **为什么需要**（设计 §3.1）：多写者下，本地看着「git 里有、我这儿没有」有两种可能——
 * 本机删了（该删远端），或另一端刚加、我还没拉到（该拉下来）。两种情况的正确动作**完全
 * 相反**，靠猜一定出错。
 *
 * 区分它们的唯一依据是**上一次同步时本机有哪些 id**：曾同步过、现在没了 ⇒ 本机删的。
 * 所以本模块配一个随仓库走的 `.sync-state.json`。
 *
 * **墓碑不删文件、只改文件**，还顺带避开 git 里最难处理的 modify/delete 冲突：删除与
 * 「另一端改了同一条」于是变成同一类冲突。
 *
 * **不记删前内容**：内容在 git 历史里（文件被删除但仍在历史），墓碑只负责回答
 * 「这条是被删的还是还没同步到」。省下的体积换的是快照体积可控。
 *
 * @module dsh-memory/sync-tombstone
 */

/** 随同步仓库走的本地状态。 */
export interface SyncState {
  /** 上次同步时 global 层有哪些 id。 */
  readonly global: readonly string[]
  /** 上次同步时各项目有哪些 id（项目名已小写）。 */
  readonly project: Readonly<Record<string, readonly string[]>>
}

/** 一条墓碑。 */
export interface Tombstone {
  readonly id: string
  readonly scope: 'global' | 'project'
  /** `project` 作用域下的项目名。 */
  readonly projectName?: string
  readonly deletedAt: number
  /**
   * 删除时的记录快照（2026-11-14）。pull 端消费墓碑前用它兜底，也方便人工恢复。
   * 只在墓碑里，不进 `records/`。
   */
  readonly snapshot?: unknown
  /** 哪个环境删的（2026-11-14）。只用于排查，不参与判定。 */
  readonly env?: string
}

/** {@link planTombstones} 的入参。 */
export interface TombstonePlanOptions {
  /** 上一次同步留下的状态；首次同步时为 `undefined`。 */
  readonly previous: SyncState | undefined
  /** 当前本地各层实际有哪些 id。 */
  readonly current: SyncState
  /** 删除时刻（epoch ms）；测试可注入。 */
  readonly at: number
}

/** 状态文件在同步仓库里的位置。 */
export const SYNC_STATE_FILE = '.sync-state.json'

/** 归一化端标识：小写、只留字母数字与 `-`、截断到 32 字符。 */
export function sanitizeEnvName(envName?: string): string {
  if (envName === undefined) return ''
  return envName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 32)
}

/**
 * 按端分片的状态文件名（2026-11-14）。
 *
 * 单份 `.sync-state.json` 记录的是「最后一次 push 那一端」的镜像全集——另一端读它，
 * 就会把自己没有的 id 全判成「删除」，这正是多端互删的判定根源。分片后每端只读自己的。
 *
 * 旧的单份文件**不迁移**（设计 §四）：首次用分片时 `previous` 为空，正好走
 * 「首次同步不产生墓碑」的保护，比把别端全集当自己的基线安全。
 *
 * @param envName - 端标识；缺省或清洗后为空时退回旧文件名（单端与测试仍可用）。
 */
export function stateFileName(envName?: string): string {
  const safe = sanitizeEnvName(envName)
  return safe === '' ? SYNC_STATE_FILE : `.sync-state.${safe}.json`
}

/** 状态文件的相对路径（含墓碑目录）。 */
export const TOMBSTONE_DIR = 'tombstones'

/**
 * 对比上一次与当前的 id 集合，算出本次该写哪些墓碑。
 *
 * **首次同步（`previous` 为空）永远不产生墓碑**：那时没有「曾经有过」这个信息，
 * 把所有"远端有、本地没有"都判成删除会把另一端刚记的东西全删掉。这是整个模块最容易
 * 写错的一处。
 *
 * @param options - 上次状态、当前状态与删除时刻。
 * @returns 待写墓碑列表。
 */
export function planTombstones(options: TombstonePlanOptions): Tombstone[] {
  const { previous, current, at } = options
  if (previous === undefined) return []

  const tombstones: Tombstone[] = []
  const currentGlobal = new Set(current.global)
  for (const id of previous.global) {
    if (!currentGlobal.has(id)) tombstones.push({ id, scope: 'global', deletedAt: at })
  }

  for (const [projectName, ids] of Object.entries(previous.project)) {
    const still = new Set(current.project[projectName] ?? [])
    for (const id of ids) {
      if (!still.has(id)) tombstones.push({ id, scope: 'project', projectName, deletedAt: at })
    }
  }

  return tombstones
}

/**
 * 把墓碑合并进上一次的状态：写过的墓碑不该在下一轮又被判成"删除"。
 *
 * 具体做法是把墓碑 id 从 `previous` 里剔掉——它们的删除已经被记录过了。
 *
 * @param state - 刚刚用于比对的那份状态。
 * @param written - 本次写下的墓碑。
 * @returns 更新后的状态。
 */
export function dropTombstoned(state: SyncState, written: readonly Tombstone[]): SyncState {
  if (written.length === 0) return state
  const globalGone = new Set(written.filter(t => t.scope === 'global').map(t => t.id))
  const projectGone = new Map<string, Set<string>>()
  for (const tombstone of written) {
    if (tombstone.scope !== 'project' || tombstone.projectName === undefined) continue
    const key = tombstone.projectName
    const set = projectGone.get(key) ?? new Set<string>()
    set.add(tombstone.id)
    projectGone.set(key, set)
  }

  const project: Record<string, readonly string[]> = {}
  for (const [name, ids] of Object.entries(state.project)) {
    const gone = projectGone.get(name)
    project[name] = gone === undefined ? ids : ids.filter(id => !gone.has(id))
  }

  return {
    global: state.global.filter(id => !globalGone.has(id)),
    project,
  }
}
