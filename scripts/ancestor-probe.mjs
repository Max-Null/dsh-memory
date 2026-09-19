#!/usr/bin/env node
/**
 * 祖先链探针——验证 dsh-memory「④-A 祖先链」在**运行时**是否生效。
 *
 * **为什么需要它**：`test/workspace-chain.spec.ts` 证明的是代码逻辑，证明不了
 * 「装进 profile、跑在真实会话里」的行为。而运行时验证有个陷阱：`scope` 标记只在
 * **跨级命中**时出现，得先有一个「带记忆的祖先层」——可这台机器上 `H:\MaxNull\.dsh`
 * 这类祖先层往往**根本不存在**。于是「在子项目会话里搜父目录记忆」这件事，在祖先链
 * 失效时表现**逐字相同**（零可观测差异的观测点）。所以要先**把前提造出来**。
 *
 * **能回答什么**：
 *   - `plan`：当前 cwd 的祖先链解析结果——链上有哪些层、每层期望的文件名、哪些真的存在。
 *     这就是引擎 `projectChain()` 的 `existsSync` 判定，可在会话外独立复算。
 *   - `seed` / `clean`：造出 / 撤销「祖先层有记忆」这个前提。
 *   - `check`：探针是否被**跨链记账**——`markUsed` 跨链生效时，`hitCount` 会被写回
 *     **祖先层自己的文件**（这正是「祖先记录不会被 30 天规则误撤」的机制）。
 *
 * **判据怎么算**：
 *   - 链 = `projectChain()` 的同语义实现：沿 cwd 向上、depth 每步 +1、**只收文件已存在的层**。
 *     本例内置 djb2 指纹自检（见 `FINGERPRINTS`）——算法漂移时报错退出，而不是**静默算错
 *     文件名**（路径形式敏感，`H:\a\b` 与 `H:/a/b` 哈希不同，错了不报错，只是找不到）。
 *   - `check` 看三个数：`records`（该层记录总数）、`hitCount`、`lastUsedAt`。
 *     `hitCount > 0` 且 `lastUsedAt` 晚于 `createdAt` = 被跨链命中过。
 *
 * **哪些情况答不了**：
 *   - **只对「尚未打开过该层的会话」有效（最要紧的一条）**：引擎的工作区表是**打开一次就
 *     缓存**的，而写路径的新鲜度门 `refreshForWrite()` 只比对 **global + 当前 cwd** 两个
 *     文件——**不含祖先层**。于是同一个会话若此前打开过目标层（跑过 `check`、或搜过该层
 *     的记忆），seed 出的探针**它看不到**；更糟的是该会话下一次对该层的命中记账会把磁盘
 *     **改写成它的内存态**，探针被直接抹掉。判据：`check` 报「没有探针记录」而文件里躺着的
 *     是别的记录（往往是上一轮删掉的旧记录，`hitCount` 还在涨），那就是被覆盖了。
 *     要用探针，就**换一个没打开过该层的会话**，或者重启会话。
 *   - **答不了「检索是否跨链」**：`memory_search` 是模型工具，脚本调不到。本脚本负责
 *     「造前提」与「读记账」，中间那一步（在会话里搜 token、看结果有没有 `scope` 字段）
 *     必须由调用它的会话完成——这是全流程里唯一不能脚本化的一步。
 *   - **不打开 DSH 存储设施**：只用 `fs` 直接读写那个 JSON 文件，不开句柄、不碰引擎缓存。
 *     所以它给的是**文件层事实**；引擎内存态是否正确，由 `check` 之后的会话行为体现。
 *   - **只验「链只向上」的一半**：脚本能算出 cwd 的祖先链，但看不到子目录。
 *     「父目录会话看不到子目录记忆」要另开会话验（判据：索引行条数不含子目录那些）。
 *   - 不判断记忆内容质量，不迁移、不合并、不触碰任何**非探针**记录。
 *
 * 用法：
 *   node scripts/ancestor-probe.mjs plan  [--cwd <会话 cwd>]
 *   node scripts/ancestor-probe.mjs seed  --layer <祖先层绝对路径> [--cwd <会话 cwd>] --apply
 *   node scripts/ancestor-probe.mjs check --layer <祖先层绝对路径>
 *   node scripts/ancestor-probe.mjs clean --layer <祖先层绝对路径> --apply
 *   node scripts/ancestor-probe.mjs --help
 *
 * 完整流程（五步）：
 *   1) plan                            看链；若已有祖先层带记忆 → 直接用它，跳过 2
 *   2) seed --layer <层> --apply        造探针（打印一个 token）
 *   3) 在**同一 cwd 的会话里** memory_search 那个 token —— 命中且结果带 `scope` 即检索侧生效
 *   4) check --layer <层>               读 hitCount：被记账 = 定位侧（markUsed 跨链）生效
 *   5) clean --layer <层> --apply       撤销前提，恢复原状（空目录一并收回）
 *
 * 退出码：0 成功 / 1 前置条件不满足（拒绝执行）/ 2 用法错误 / 3 算法指纹不自检。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PROBE_MARKER = '[ancestor-chain-probe]'

// djb2 指纹：必须与 src/engine.ts 的 projectBackendName 逐字一致。写成常量表而非注释，
// 是为了在算法漂移时**报错**——哈希错了不会抛异常，只会静默指向另一个文件。
const FINGERPRINTS = [
  ['dsh-memory', 'oy76k6'],
  ['workstation', '3kjfw6'],
  ['a', '3t3a'],
  ['', '45h'], // 空串 = 5381 的 base36，即 djb2 初值
  ['h:\\X', 'ykhwcb'], // 与 'H:\\x' 同值——顺带验证 toLowerCase 也在算法里
  ['H:\\x', 'ykhwcb'],
]

const USAGE = `祖先链探针——验证 dsh-memory「④-A 祖先链」在运行时是否生效。

用法：
  node scripts/ancestor-probe.mjs plan  [--cwd <会话 cwd>]
  node scripts/ancestor-probe.mjs seed  --layer <祖先层绝对路径> [--cwd <会话 cwd>] --apply
  node scripts/ancestor-probe.mjs check --layer <祖先层绝对路径>
  node scripts/ancestor-probe.mjs clean --layer <祖先层绝对路径> --apply
  node scripts/ancestor-probe.mjs --help

  --cwd 默认取进程工作目录；脚本通常从仓库目录运行，**它未必等于你的会话 cwd**，
        所以对不上时务必显式传。
  seed / clean 必须带 --apply 才真的写盘；不带就是 dry-run（只打印将做什么）。

退出码：0 成功 / 1 前置条件不满足（拒绝执行）/ 2 用法错误 / 3 算法指纹不自检。`

/** 与 engine.ts:484-489 逐字对应（含 toLowerCase、|0 截断、abs 后取 base36）。 */
function projectBackendName(cwd) {
  let h = 5381
  const text = cwd.toLowerCase()
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `memory_project_${Math.abs(h).toString(36)}`
}

const projectRootFor = (cwd) => path.join(cwd, '.dsh', 'storages')
const layerFile = (layer) => path.join(projectRootFor(path.join(layer)), `${projectBackendName(path.join(layer))}.json`)

/** cwd 的全部祖先层（含自身，depth 0 起）——与链无关，plan 用它展示「上面有什么」。 */
function ancestorLayers(cwd) {
  const key = path.join(cwd)
  const out = [{ key, depth: 0 }]
  let cur = key
  let depth = 0
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) break // 到盘根
    cur = parent
    depth += 1
    out.push({ key: cur, depth })
  }
  return out
}

/** 引擎 projectChain() 的同语义实现：只收**记忆文件已存在**的层（depth 0 自身始终纳入）。 */
function projectChain(cwd) {
  return ancestorLayers(cwd).filter((l) => l.depth === 0 || fs.existsSync(layerFile(l.key)))
}

function readDoc(file) {
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function probeRecords(doc) {
  const blocks = doc?.tables?.blocks
  if (blocks === undefined) return []
  return Object.entries(blocks).filter(([, b]) => typeof b.content === 'string' && b.content.includes(PROBE_MARKER))
}

function selfCheck() {
  const bad = []
  for (const [input, expect] of FINGERPRINTS) {
    const want = `memory_project_${expect}`
    const got = projectBackendName(input)
    if (got !== want) bad.push(`${JSON.stringify(input)}: 期望 ${want}，实得 ${got}`)
  }
  if (bad.length > 0) {
    console.error('算法指纹不自检——projectBackendName 与 src/engine.ts 已不一致：')
    for (const line of bad) console.error(`  ${line}`)
    console.error('  → 先核对 src/engine.ts 的 projectBackendName，再更新本脚本的 FINGERPRINTS。')
    process.exit(3)
  }
}

function parseArgs(argv) {
  const out = { command: undefined, apply: false, help: false, cwd: undefined, layer: undefined }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--cwd' || a === '--layer') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) {
        console.error(`参数 ${a} 缺值`)
        process.exit(2)
      }
      out[a.slice(2)] = v
    } else if (a.startsWith('-')) {
      console.error(`未知参数：${a}\n\n${USAGE}`)
      process.exit(2)
    } else rest.push(a)
  }
  out.command = rest[0]
  return out
}

function cmdPlan(args) {
  const cwd = path.join(args.cwd ?? process.cwd())
  const layers = ancestorLayers(cwd)
  const chain = projectChain(cwd)

  console.log(`cwd = ${cwd}`)
  if (args.cwd === undefined) {
    console.log('      （取自进程工作目录；**若它不等于你的会话 cwd，请用 --cwd 重跑**——链是按会话 cwd 算的）')
  }
  console.log('\n祖先层（depth 0 = 自身）：')
  console.log('  depth  存在记忆文件  记录数  路径')
  for (const l of layers) {
    const file = layerFile(l.key)
    const exists = fs.existsSync(file)
    let count = '-'
    if (exists) {
      try {
        count = String(Object.keys(readDoc(file)?.tables?.blocks ?? {}).length)
      } catch {
        count = '解析失败'
      }
    }
    console.log(`  ${String(l.depth).padEnd(6)} ${(exists ? '是' : '否').padEnd(14)} ${count.padEnd(8)} ${l.key}`)
  }

  const withMemory = chain.filter((l) => l.depth > 0)
  console.log(`\n引擎会纳入的链：${chain.length} 级（自身 + ${withMemory.length} 个祖先层）`)

  if (withMemory.length > 0) {
    const nearest = withMemory[0]
    const scopeText = Array.from({ length: nearest.depth }, () => '..').join('/')
    console.log(`\n结论：**可以直接验证，不必造探针**——最近的带记忆祖先层是 ${nearest.key}`)
    console.log(`  在会话里搜该层任一记忆的关键词，结果应带 scope="${scopeText}"。`)
  } else {
    const candidate = layers.find((l) => l.depth === 1)
    if (candidate === undefined) {
      console.log('\n结论：cwd 已在盘根，**没有祖先层可放探针** → 换一个更深的 cwd 再验。')
      process.exit(1)
    }
    console.log('\n结论：**祖先链在当前 cwd 上是零可观测差异的**——以上祖先层都没有记忆文件，')
    console.log('      祖先链无论生效与否，行为逐字相同。要观测它，先造一层：')
    console.log(`\n  node scripts/ancestor-probe.mjs seed --layer "${candidate.key}" --cwd "${cwd}" --apply`)
  }
}

function cmdSeed(args) {
  if (args.layer === undefined) {
    console.error(`seed 需要 --layer <祖先层绝对路径>\n\n${USAGE}`)
    process.exit(2)
  }
  const cwd = path.join(args.cwd ?? process.cwd())
  const layer = path.join(args.layer)

  if (layer === cwd) {
    console.error('拒绝：--layer 等于 cwd 自身。探针必须放在**祖先**层——同层命中证明不了跨链。')
    process.exit(1)
  }
  const layers = ancestorLayers(cwd)
  if (!layers.some((l) => l.key === layer)) {
    console.error(`拒绝：${layer} 不是 ${cwd} 的祖先层（链只向上，放子目录无效）。`)
    process.exit(1)
  }

  const file = layerFile(layer)
  const existing = readDoc(file)
  if (existing !== undefined) {
    const blocks = existing.tables?.blocks ?? {}
    const mine = probeRecords(existing)
    if (mine.length > 0) {
      console.error(`拒绝：${file} 里已经有探针记录（${mine.length} 条）。先 clean 再 seed。`)
      process.exit(1)
    }
    if (Object.keys(blocks).length > 0) {
      console.error(`拒绝：${file} 已含 ${Object.keys(blocks).length} 条真实记录，不去动它——`)
      console.error('      请换一层，或直接用它做验证（plan 会指出这种「祖先层本来就有记忆」的情况）。')
      process.exit(1)
    }
  }

  const token = `aprobe${crypto.randomBytes(4).toString('hex')}`
  const depth = layers.find((l) => l.key === layer).depth
  const scope = Array.from({ length: depth }, () => '..').join('/')
  const now = Date.now()
  const id = crypto.randomUUID()

  if (!args.apply) {
    console.log('[dry-run] 将写入（加 --apply 才真的写）：')
    console.log(`  文件  ${file}`)
    console.log(`  记录  ${id}`)
    console.log(`  令牌  ${token}`)
    console.log(`  层深  depth ${depth}（对应 scope="${scope}"）`)
    process.exit(0)
  }

  const doc = existing ?? {
    unit: { name: projectBackendName(layer), version: 1 },
    global: null,
    tables: { blocks: {} },
  }
  doc.tables ??= { blocks: {} }
  doc.tables.blocks ??= {}
  doc.tables.blocks[id] = {
    namespace: 'project',
    status: 'approved',
    injected: false,
    content:
      `${PROBE_MARKER} 临时探针，验证完请删——用 scripts/ancestor-probe.mjs clean 收尾。\n\n` +
      `由 ancestor-probe.mjs seed 写入祖先层 \`${layer}\`（depth ${depth}），` +
      `目的是让会话 cwd \`${cwd}\` 拥有一个「带记忆的祖先层」，从而让 ④-A 祖先链可被观测。\n\n` +
      `检索令牌：${token}`,
    keywords: [token, '祖先链探针', 'ancestor-chain-probe', '④-A 验证'],
    createdAt: now,
    updatedAt: now,
    hitCount: 0,
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

  console.log(`已写入探针 → ${file}`)
  console.log(`  记录  ${id}`)
  console.log(`  令牌  ${token}`)
  console.log(`  层深  depth ${depth}（结果里应出现 scope="${scope}"）`)
  console.log('\n下一步（脚本做不到，必须由会话完成）：')
  console.log(`  1) 在同一 cwd 的会话里 memory_search "${token}" —— 命中等且结果带 scope="${scope}" 即检索侧生效`)
  console.log(`  2) node scripts/ancestor-probe.mjs check --layer "${layer}"`)
  console.log('\n⚠️ 前提：目标层必须是**本会话此前没有打开过**的层。引擎的表打开即缓存，而写路径的')
  console.log('   新鲜度门（refreshForWrite）只比对 global + 当前 cwd，不含祖先层——已经被缓存过的')
  console.log('   层，探针不但搜不到，还会被该会话的内存态覆盖掉。第 1 步搜不到就先换会话。')
}

function cmdCheck(args) {
  if (args.layer === undefined) {
    console.error(`check 需要 --layer <祖先层绝对路径>\n\n${USAGE}`)
    process.exit(2)
  }
  const layer = path.join(args.layer)
  const file = layerFile(layer)
  const doc = readDoc(file)
  if (doc === undefined) {
    console.error(`该层没有记忆文件：${file}`)
    process.exit(1)
  }
  const blocks = doc.tables?.blocks ?? {}
  const mine = probeRecords(doc)
  console.log(`层   ${layer}`)
  console.log(`文件 ${file}`)
  console.log(`记录总数 ${Object.keys(blocks).length}，其中探针 ${mine.length} 条`)
  if (mine.length === 0) {
    console.log('\n该层没有探针记录。磁盘上现有的记录：')
    const others = Object.entries(blocks)
    if (others.length === 0) console.log('  （空表）')
    for (const [id, b] of others) {
      console.log(`  ${id}  hitCount=${b.hitCount ?? 0}  keywords=${JSON.stringify((b.keywords ?? []).slice(0, 2))}`)
    }
    console.log('\n两种可能：① 这层本来就有真实记忆——用 plan 给出的关键词直接验证即可；')
    console.log('          ② 探针被运行中会话的内存态覆盖了（该层此前被打开过）——换会话重试。')
    process.exit(1)
  }
  for (const [id, b] of mine) {
    const used = b.lastUsedAt === undefined ? '从未' : new Date(b.lastUsedAt).toISOString()
    console.log(`\n探针 ${id}`)
    console.log(`  hitCount   ${b.hitCount ?? 0}`)
    console.log(`  createdAt  ${new Date(b.createdAt).toISOString()}`)
    console.log(`  lastUsedAt ${used}`)
    if ((b.hitCount ?? 0) > 0 && b.lastUsedAt !== undefined && b.lastUsedAt > b.createdAt) {
      console.log('  → **被跨链命中并记账了**：markUsed 路径生效，祖先记录不会被 30 天规则误撤。')
    } else {
      console.log('  → 还没被记账。若你已经在会话里搜过这个令牌并命中，说明检索侧通了但记账没回写；')
      console.log('    若根本没搜过，先做 seed 输出里的第 1 步。')
    }
  }
}

function cmdClean(args) {
  if (args.layer === undefined) {
    console.error(`clean 需要 --layer <祖先层绝对路径>\n\n${USAGE}`)
    process.exit(2)
  }
  const layer = path.join(args.layer)
  const file = layerFile(layer)
  const doc = readDoc(file)
  if (doc === undefined) {
    console.error(`该层没有记忆文件，无需清理：${file}`)
    process.exit(1)
  }
  const mine = probeRecords(doc)
  if (mine.length === 0) {
    console.error(`拒绝：${file} 里没有探针记录（只有本脚本写的探针才会被删）。`)
    process.exit(1)
  }

  const rmDirs = []
  const storages = projectRootFor(layer)
  const dshDir = path.join(layer, '.dsh')

  if (!args.apply) {
    console.log('[dry-run] 将删除（加 --apply 才真的删）：')
    console.log(`  ${mine.length} 条探针记录，位于 ${file}`)
    console.log(`  若文件因此变空 → 删文件；若上级目录变空 → 一并收回 ${storages}`)
    process.exit(0)
  }

  for (const [id] of mine) delete doc.tables.blocks[id]
  if (Object.keys(doc.tables.blocks).length === 0) {
    fs.rmSync(file)
    console.log(`已删除探针文件 ${file}`)
    for (const d of [storages, dshDir]) {
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d)
        rmDirs.push(d)
      }
    }
    for (const d of rmDirs) console.log(`已收回空目录 ${d}`)
  } else {
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    console.log(`已从 ${file} 删除 ${mine.length} 条探针记录（该层还有 ${Object.keys(doc.tables.blocks).length} 条真实记录，文件保留）`)
  }
  console.log('\n若前面观察到索引行条数因探针 +1，下一轮注入应回落到原值——链是实时 existsSync 现算的。')
}

const args = parseArgs(process.argv.slice(2))
if (args.help || args.command === undefined) {
  console.log(USAGE)
  process.exit(args.help ? 0 : 2)
}
selfCheck()

switch (args.command) {
  case 'plan':
    cmdPlan(args)
    break
  case 'seed':
    cmdSeed(args)
    break
  case 'check':
    cmdCheck(args)
    break
  case 'clean':
    cmdClean(args)
    break
  default:
    console.error(`未知子命令：${args.command}\n\n${USAGE}`)
    process.exit(2)
}
