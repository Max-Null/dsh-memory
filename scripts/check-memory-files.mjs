#!/usr/bin/env node
/**
 * 记忆存储文件的存量体检（门三，2026-09-25）。
 *
 * **能回答什么**：给出的记忆文件里，有没有**不合规的存储块**——那种块会让整个 domain 在
 * 下次打开时失败（`dsh-storage-domain` 逐条校验，一条不合格即整体失败），表现为「整个工作区
 * 的记忆静默消失」。2026-09-25 那次 154 条 project 记忆全部不可见就是这么来的：写入放行、
 * 加载才炸、失败还被吞。
 *
 * **判据怎么算**：用插件自己的 `blockSchema`（从 `dist/engine.js` import）逐条 `safeParse`。
 * 同源是刻意的——另写一套判定迟早漂移成「扫描器说没事、打开时炸」这种最难查的形态。
 *
 * **哪些情况答不了**：
 *   - 只校验 `tables.blocks` 里的条目，不校验外层信封结构；
 *   - 不处理压缩帧（那是 `unzstd-frames.mjs` 的事）；
 *   - 不判断「记录该不该存在」——那是价值判断，本脚本只看格式。
 *
 * 用法：
 *   node scripts/check-memory-files.mjs              # 扫 $DSH_HOME 与当前目录下的记忆文件
 *   node scripts/check-memory-files.mjs <路径...>    # 扫指定文件或目录（目录会递归找 *.json）
 *
 * 退出码：0 = 全绿 / 1 = 命中不合规 / 2 = 用法或环境错误。
 *
 * 前置：本脚本 import 编译产物 `dist/engine.js`，所以要先 `npm run build`。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const USAGE = 2

function fail(message) {
  console.error(`check-memory-files: ${message}`)
  process.exit(USAGE)
}

let blockSchema
try {
  ({ blockSchema } = await import('../dist/engine.js'))
} catch (error) {
  fail(
    `无法加载 dist/engine.js（先跑 npm run build）：${error instanceof Error ? error.message : String(error)}`,
  )
}
if (blockSchema === undefined) fail('dist/engine.js 没有导出 blockSchema——构建产物太旧？')

/** 递归收集目录下的 *.json（跳过 node_modules）。 */
function collect(target, out = []) {
  let stat
  try {
    stat = statSync(target)
  } catch {
    return out
  }
  if (stat.isFile()) {
    if (target.endsWith('.json')) out.push(target)
    return out
  }
  if (!stat.isDirectory()) return out
  if (target.includes('node_modules')) return out
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    collect(join(target, entry.name), out)
  }
  return out
}

/** 默认扫描目标：$DSH_HOME/storages 与当前目录的 .dsh/storages。 */
function defaultTargets() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const targets = [join(dshHome, 'storages'), join(process.cwd(), '.dsh', 'storages')]
  return targets.filter(existsSync)
}

const args = process.argv.slice(2)
const explicit = args.length > 0
const targets = explicit ? args.map(arg => resolve(arg)) : defaultTargets()

// 显式给的路径必须存在。**把「什么都没扫到」报成「全绿」是同一个病**——偏小的数字看起来
// 正常，而判断者会据此认为存量是干净的。门二存在的理由就是这句话。
if (explicit) {
  const missing = targets.filter(target => !existsSync(target))
  if (missing.length > 0) fail(`路径不存在：${missing.join('、')}`)
}
if (targets.length === 0) fail('没有可扫描的目标（既没给路径，也没找到 $DSH_HOME/storages 或 ./.dsh/storages）')

const files = [...new Set(targets.flatMap(target => collect(target)))].sort()
let scanned = 0
let records = 0
const violations = []

for (const file of files) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    continue // 不是 JSON（或不是存储文件）—— 不是本脚本的事
  }
  const blocks = raw?.tables?.blocks
  if (blocks === null || typeof blocks !== 'object') continue
  scanned += 1
  for (const [id, block] of Object.entries(blocks)) {
    records += 1
    const parsed = blockSchema.safeParse(block)
    if (parsed.success) continue
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    violations.push({ file, id, issues })
  }
}

console.log(`check-memory-files: 扫描 ${scanned} 个记忆文件 / ${records} 条记录`)
// 一个记忆文件都没扫到，同样是可疑的——不能报「全部合规」。判断者需要知道这次体检
// **没有覆盖任何东西**（同门二：读不到就说读不到）。
if (scanned === 0) fail(`看了 ${files.length} 个 JSON，但没有一个是记忆文件——目标选对了吗？`)
if (violations.length === 0) {
  console.log('check-memory-files: ✅ 全部合规')
  process.exit(0)
}

console.error(`check-memory-files: ✗ ${violations.length} 条不合规——它们会让所在 domain 打不开`)
for (const violation of violations) {
  console.error(`  ${violation.file}`)
  console.error(`    ${violation.id}: ${violation.issues}`)
}
process.exit(1)
