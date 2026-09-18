#!/usr/bin/env node
/**
 * 孤儿记忆文件清点（④-C 2026-09-19）——**只读，不做任何处置**。
 *
 * 背景：project 记忆的文件名是 `memory_project_<djb2(工作区路径)>.json`，而代码只按这个
 * 名字去找。历史上换过命名（早期无哈希后缀、有过双重 `memory_project_` 前缀），那些旧文件
 * 因此**永远不会被打开**——不是「等人放行」，是代码已经不认识这个文件名了。实测
 * （2026-09-19）全工作区 136 条 project 记忆里有 33 条处于这个状态。
 *
 * 本脚本回答一个问题：**哪些文件当前代码打不开**。它不迁移、不删除、不修改任何东西。
 * 处置（归档 / 选择性导入 / 删除）是一次显式的人工动作，理由见设计文档 §3.4：
 * 旧文件可能含 0.7.0 之前未过 `detectSensitive` 的内容，自动捞出来等于绕过隔离检查。
 *
 * 用法：node scripts/scan-orphans.mjs [根目录]（缺省为当前目录）
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 与 engine.ts 的 projectBackendName 逐字一致：djb2 over 小写路径，36 进制。 */
function projectBackendName(cwd) {
  let h = 5381
  const text = cwd.toLowerCase()
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `memory_project_${Math.abs(h).toString(36)}`
}

/** 递归找出所有 `.dsh/storages` 目录；跳过 node_modules / .git，限深防跑飞。 */
function findStorageDirs(root, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(root, entry.name)
    if (entry.name === '.dsh') {
      const storages = join(full, 'storages')
      if (existsSync(storages)) out.push(storages)
      continue
    }
    findStorageDirs(full, depth + 1, out)
  }
  return out
}

/** 数一个记忆文件里的记录条数；读不出来返回 null（诚实报告「读不了」而不是 0）。 */
function countRecords(file) {
  try {
    const blocks = JSON.parse(readFileSync(file, 'utf8'))?.tables?.blocks ?? {}
    return Object.values(blocks).filter(block => block && block.content).length
  } catch {
    return null
  }
}

const root = process.argv[2] ?? process.cwd()
const storageDirs = findStorageDirs(root)

console.log(`扫描根：${root}`)
console.log(`发现 ${storageDirs.length} 个 storages 目录\n`)

let orphans = 0
let orphanRecords = 0
let healthy = 0

for (const storages of storageDirs) {
  const workspace = dirname(dirname(storages))
  const expected = `${projectBackendName(workspace)}.json`
  let files = []
  try {
    files = readdirSync(storages).filter(name => name.startsWith('memory_project') && name.endsWith('.json'))
  } catch {
    continue
  }
  if (files.length === 0) continue

  const rows = files.map(name => {
    const file = join(storages, name)
    return {
      name,
      ok: name === expected,
      count: countRecords(file),
      size: statSync(file).size,
      mtime: new Date(statSync(file).mtimeMs).toISOString().slice(0, 10),
    }
  })
  const bad = rows.filter(row => !row.ok)
  const good = rows.filter(row => row.ok)

  console.log(`── ${workspace}`)
  console.log(`   期望文件名：${expected}`)
  for (const row of good) {
    healthy += 1
    console.log(`   ✅ ${row.name}  ${row.count ?? '?'} 条  ${row.size}B  ${row.mtime}`)
  }
  for (const row of bad) {
    orphans += 1
    orphanRecords += row.count ?? 0
    console.log(`   ⚠️  ${row.name}  ${row.count ?? '?'} 条  ${row.size}B  ${row.mtime}  ← 代码打不开`)
  }
  console.log('')
}

console.log('── 汇总 ──')
console.log(`能被代码打开：${healthy} 个文件`)
console.log(`打不开（孤儿）：${orphans} 个文件，共 ${orphanRecords} 条记录`)
console.log('\n本脚本只清点。处置（归档 / 选择性导入 / 删除）见设计文档 §3.4，需人工拍板后单独执行。')
