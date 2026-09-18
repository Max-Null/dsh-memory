#!/usr/bin/env node
/**
 * 测量 dsh-memory 常驻注入的预算占用。
 *
 * 复现 `src/injection.ts` 的 `renderInjection`：摘要取首行、上限 `--summary` 字符，
 * 每行加固定开销 27 字符，超出 `--budget` 时按「最近使用优先」省略。
 *
 * 用法：
 *   node scripts/measure-injection.mjs
 *   node scripts/measure-injection.mjs --workspace H:/path/to/ws --budget 1500
 *
 * 默认：global 读 `$DSH_HOME/storages/memory.json`（DSH_HOME 缺省 `~/.dsh`），
 * project 读 `<workspace>/.dsh/storages/memory_project_*.json`（workspace 缺省 cwd）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LINE_OVERHEAD = 27

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const workspace = path.resolve(argOf('workspace', process.cwd()))
const budget = Number(argOf('budget', 1500))
const summaryChars = Number(argOf('summary', 80))
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

function readRecords(file) {
  if (!fs.existsSync(file)) return []
  const blocks = JSON.parse(fs.readFileSync(file, 'utf8'))?.tables?.blocks ?? {}
  return Object.entries(blocks).map(([id, record]) => ({ id, ...record }))
}

function lineCost(record) {
  const firstLine = String(record.content ?? '').split('\n')[0].trim()
  const summary = firstLine.length <= summaryChars ? firstLine : `${firstLine.slice(0, summaryChars)}…`
  const line = `- [memory:${String(record.id).slice(0, 8)}:${record.namespace ?? '?'}] ${summary}`
  return line.length + LINE_OVERHEAD
}

function projectStore(dir) {
  const storages = path.join(dir, '.dsh', 'storages')
  if (!fs.existsSync(storages)) return undefined
  const match = fs.readdirSync(storages)
    .filter(name => /^memory_project_[^.]*\.json$/.test(name))
    .map(name => path.join(storages, name))
  return match[0]
}

const sources = [
  ['global', path.join(dshHome, 'storages', 'memory.json')],
  ['project', projectStore(workspace)],
]

const injected = []
for (const [label, file] of sources) {
  if (file === undefined) { console.log(`[${label}] 未找到存储文件`); continue }
  const records = readRecords(file)
  const approved = records.filter(record => record.status === 'approved')
  const always = approved.filter(record => record.injected === true)
  const allCost = approved.reduce((sum, record) => sum + lineCost(record), 0)
  console.log(`[${label}] ${file}`)
  console.log(`  共 ${records.length} 条 · approved ${approved.length} 条 · 其中常驻 ${always.length} 条`)
  console.log(`  approved 全部常驻需要 ${allCost.toLocaleString()} 字符`)
  injected.push(...always)
}

const ordered = injected.sort((left, right) =>
  (right.lastUsedAt ?? right.updatedAt ?? 0) - (left.lastUsedAt ?? left.updatedAt ?? 0))

let chars = 0
let omitted = 0
let kept = 0
for (const record of ordered) {
  const cost = lineCost(record)
  if (chars + cost > budget) { omitted++; continue }
  kept++
  chars += cost
}

console.log('\n===== 当前常驻注入 =====')
console.log(`候选 ${injected.length} 条 → 注入 ${kept} 条 · ${chars} 字符 · 省略 ${omitted} 条`)
console.log(`预算利用率 ${(100 * chars / budget).toFixed(1)}%（预算 ${budget}，余 ${budget - chars}）`)
const average = kept > 0 ? chars / kept : LINE_OVERHEAD + 1
console.log(`单条平均开销 ${Math.round(average)} 字符 · 每轮上限约 ${Math.floor(budget / average)} 条`)
