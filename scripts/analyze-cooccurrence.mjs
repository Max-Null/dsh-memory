#!/usr/bin/env node
/**
 * 关键词共现分析——回答「记忆之间有没有关系网」。
 *
 * **为什么需要它**：记忆系统有两个方向可选——「报规模与主题」（我们现在的做法）与
 * 「给记忆建关系」（图 / 相关推荐）。选哪个不该靠直觉，而该看数据里到底有没有关系。
 * 本脚本就是量这件事的：把两条记忆共享的关键词个数当关联强度，统计多少对有关联、
 * 它们连成几个簇、多少条是孤立点。
 *
 * **能回答什么**：
 * - 孤立点占比——**关系维度值不值得做**的第一判据。孤立率高（比如 >50%）说明记忆
 *   本质是「一条条独立事实」，图与相关推荐都没有数据支撑。
 * - 簇的规模与主题——若确实成簇，簇内高频词就是「成片的主题」，比全局词频 top-N 更聚焦。
 * - 阈值敏感度——共享 1 个词 vs 2 个词的对数比，决定「关联」的门槛该定在哪。
 *
 * **判据怎么算**：
 * - 只统计 approved、非隔离、非模板（`kind !== 'prompt'`）的记录——与 `indexNotice` /
 *   `recallRecords` 的候选口径一致，否则会把不该参与的东西算进来。
 * - 关联门槛默认「共享 ≥2 个关键词」。**不要降到 1**：实测共享 1 个的有 273 对、
 *   共享 ≥2 的只有 38 对（7 倍差），降到 1 等于把「都含 dsh」也算成关联。
 * - 连通分量用洪水填充；**孤立点 = 自己成一个分量的记录**。
 *
 * **哪些情况答不了**：
 * - 只做**词面**共现，不理解语义：「pnpm」与「包管理器」不共享词就是孤立点，哪怕它们
 *   讲的是同一件事。跨过这一层需要语义检索（见 `docs/决策/2026-09-18-语义检索通道启用判据.md`）。
 * - 结论只在「关键词是多角度的」这个前提下成立：若写入时关键词给得敷衍（比如都只给一个
 *   项目名），脚本会报出虚高的关联。
 * - **只读**：不写任何存储文件，可随时重跑。
 *
 * 用法：
 *   node scripts/analyze-cooccurrence.mjs [--workspace <路径>] [--min-shared N] [--top N] [--help]
 *
 * 退出码：0 = 正常；2 = 用法错误。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const USAGE = `关键词共现分析——回答「记忆之间有没有关系网」。

用法：
  node scripts/analyze-cooccurrence.mjs [--workspace <路径>] [--min-shared N] [--top N] [--help]

  --workspace P   工作区根（默认从 cwd 起向上找第一个含 .dsh/storages 的目录）
  --min-shared N  关联门槛：共享几个关键词才算有关联（默认 2，不建议降到 1）
  --top N         展示最大的几个簇（默认 5）

只读，不写任何文件。
退出码：0 = 正常；2 = 用法错误。`

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
const readString = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const readNumber = (name, fallback) => {
  const raw = readString(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} 需要一个非负整数，收到：${raw}`)
    process.exit(2)
  }
  return value
}
const MIN_SHARED = readNumber('--min-shared', 2)
const TOP = readNumber('--top', 5)

/** 从 cwd 起向上找第一个含 `.dsh/storages` 的目录——工作区根通常就是它。 */
function findWorkspace(start) {
  let current = start
  for (;;) {
    if (existsSync(join(current, '.dsh', 'storages'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

const workspace = readString('--workspace') ?? findWorkspace(process.cwd())
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 两个存储：`project` 在工作区下（随 git 分享），`global` 在 DSH_HOME 下。
 * project 的文件名带 cwd 哈希后缀，所以扫目录而不是拼固定名；双重前缀的历史残骸
 * （`memory_project_memory_project_*`）不是当前代码认得的名字，排除掉。
 */
const sources = []
const projectStorages = join(workspace, '.dsh', 'storages')
let projectNames = []
try {
  projectNames = readdirSync(projectStorages)
} catch {
  projectNames = [] // 工作区没有 project 存储：只分析 global
}
for (const name of projectNames) {
  if (!name.startsWith('memory_project') || !name.endsWith('.json')) continue
  if (name.startsWith('memory_project_memory_project')) continue
  sources.push(['project', join(projectStorages, name)])
}
sources.push(['global', join(dshHome, 'storages', 'memory.json')])

console.log(`工作区：${workspace}`)
console.log(`DSH_HOME：${dshHome}\n`)

const records = []
for (const [namespace, file] of sources) {
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    continue // 存储不存在或读不动：跳过，不报错
  }
  for (const [id, block] of Object.entries(doc.tables?.blocks ?? {})) {
    if (block === null || typeof block !== 'object' || typeof block.content !== 'string') continue
    if (block.quarantined === true) continue
    if ((block.status ?? 'approved') !== 'approved') continue
    if ((block.kind ?? 'fact') === 'prompt') continue
    records.push({
      id: String(id),
      namespace,
      keywords: new Set((block.keywords ?? []).map(keyword => String(keyword).toLowerCase())),
      title: block.content.split('\n')[0].slice(0, 46),
    })
  }
}

if (records.length === 0) {
  console.log('没有可分析的记忆（未找到 project / global 存储，或库里没有 approved 记录）。')
  process.exit(0)
}

console.log(`候选记忆：${records.length} 条（approved、非隔离、非模板）`)
const sizes = records.map(record => record.keywords.size)
console.log(`关键词密度：平均 ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1)} / 最少 ${Math.min(...sizes)} / 最多 ${Math.max(...sizes)}`)
console.log(`关联门槛：共享 ≥${MIN_SHARED} 个关键词\n`)

const histogram = new Map()
const adjacency = new Map()
const link = (a, b) => {
  if (!adjacency.has(a)) adjacency.set(a, new Set())
  if (!adjacency.has(b)) adjacency.set(b, new Set())
  adjacency.get(a).add(b)
  adjacency.get(b).add(a)
}
for (let i = 0; i < records.length; i += 1) {
  for (let j = i + 1; j < records.length; j += 1) {
    let shared = 0
    for (const keyword of records[i].keywords) if (records[j].keywords.has(keyword)) shared += 1
    if (shared === 0) continue
    histogram.set(shared, (histogram.get(shared) ?? 0) + 1)
    if (shared >= MIN_SHARED) link(records[i].id, records[j].id)
  }
}

console.log('共享关键词个数的分布（对数）：')
for (const [shared, count] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
  const noise = shared === 1 ? '   ← 噪声级，通常不计入关联' : ''
  console.log(`  ${String(shared).padStart(2)} 个 → ${String(count).padStart(4)} 对${noise}`)
}

const seen = new Set()
const clusters = []
for (const record of records) {
  if (seen.has(record.id)) continue
  const stack = [record.id]
  const component = []
  seen.add(record.id)
  while (stack.length > 0) {
    const current = stack.pop()
    component.push(current)
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor)
        stack.push(neighbor)
      }
    }
  }
  clusters.push(component)
}
clusters.sort((a, b) => b.length - a.length)
const isolated = clusters.filter(cluster => cluster.length === 1).length

console.log(`\n连通分量：${clusters.length} 个`)
console.log(`  规模：${clusters.map(cluster => cluster.length).slice(0, 12).join(' / ')}${clusters.length > 12 ? ' …' : ''}`)
console.log(`  孤立点：${isolated} 个（${((isolated / records.length) * 100).toFixed(0)}%）  |  参与成簇：${records.length - isolated} 个`)

const byId = new Map(records.map(record => [record.id, record]))
console.log(`\n最大的 ${TOP} 个簇（簇内高频词 = 成片的主题）：`)
let shown = 0
for (const component of clusters) {
  if (component.length === 1 || shown >= TOP) break
  shown += 1
  const frequency = new Map()
  for (const id of component) {
    for (const keyword of byId.get(id).keywords) frequency.set(keyword, (frequency.get(keyword) ?? 0) + 1)
  }
  const top = [...frequency.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  console.log(`\n  ● ${component.length} 条：${top.map(([keyword, count]) => `${keyword}(${count})`).join('、') || '(无重复词)'}`)
  for (const id of component.slice(0, 5)) console.log(`      · ${byId.get(id).title}`)
  if (component.length > 5) console.log(`      … 另 ${component.length - 5} 条`)
}
