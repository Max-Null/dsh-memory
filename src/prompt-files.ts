/**
 * prompt-files.ts — 提示词模板 md 文件解析与目录扫描（纯 Node，零依赖可测）。
 *
 * 文件是模板的唯一事实源（设计文档 §2）：用户可直接放入/编辑/删除 md，
 * 索引层按 mtime 惰性刷新。格式：
 *
 * ```md
 * ---
 * seq: 36
 * name: "样例"          # 必填；缺 name 的文件跳过（坏文件不崩不索引）
 * dimension: "前端"
 * difficulty: "L3"
 * tags: ["Three.js"]
 * source: user          # user | agent（模型新增打 agent 角标）
 * createdAt: 2026-08-26
 * ---
 * (主提示词全文)
 * ---
 * (备用提示词，可选)
 * ```
 * 解析失败/缺 name 的文件记 warnings，不影响整体扫描。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface PromptMeta {
  seq?: number
  name: string
  dimension?: string
  difficulty?: string
  tags: string[]
  source: 'user' | 'agent'
  createdAt?: number
}

export interface PromptFile {
  path: string
  mtime: number
  meta: PromptMeta
  /** 主提示词全文。 */
  body: string
  /** 备用提示词（可选；md 中以独立 `---` 行与正文分隔）。 */
  fallback: string | null
  /** 索引摘要（正文前 200 字，替换换行）。 */
  summary: string
}

const SUMMARY_CHARS = 200

/** 解析简单 frontmatter 值：字符串（含引号）/数字/布尔/数组。 */
function parseFrontmatterValue(raw: string): unknown {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1).split(',')
      .map(part => part.trim().replace(/^["']|["']$/g, ''))
      .filter(part => part !== '')
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (/^\d+$/.test(value)) return Number(value)
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/**
 * 解析一份 md（frontmatter + 正文 + 可选备用段）。纯文本解析，不碰文件系统；
 * mtime 由调用方传入（scan 从 stat 取；纯解析测试传 0）。
 * @returns ok:true 带结构化结果；ok:false 带人读错误（跳过不索引）。
 */
export function parsePromptFile(path: string, text: string, mtime = 0): { ok: true, file: PromptFile } | { ok: false, error: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: 'missing frontmatter fence (first line must be ---)' }
  }
  let fence = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { fence = i; break }
  }
  if (fence === -1) return { ok: false, error: 'unclosed frontmatter fence' }
  const meta: Record<string, unknown> = {}
  for (const line of lines.slice(1, fence)) {
    const m = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(line)
    if (m === null || m[2] === undefined) continue
    meta[m[1]!] = parseFrontmatterValue(m[2])
  }
  const name = typeof meta.name === 'string' ? meta.name : ''
  if (name === '') return { ok: false, error: 'missing required frontmatter field "name"' }
  const source = meta.source === 'agent' ? 'agent' : 'user'

  // 正文：frontmatter 后到第一个独立 `---` 行为止（剩余为备用提示词）
  const bodyLines: string[] = []
  const fallbackLines: string[] = []
  let inFallback = false
  for (const line of lines.slice(fence + 1)) {
    if (!inFallback && line.trim() === '---') { inFallback = true; continue }
    ;(inFallback ? fallbackLines : bodyLines).push(line)
  }
  const body = bodyLines.join('\n').trim()
  if (body === '') return { ok: false, error: 'empty prompt body' }
  // 备用段首行常为「备用提示词2」之类的标题行，跳过（约定：正文与备用用 --- 分隔）
  const fallbackRaw = fallbackLines.join('\n').trim()
  const fallback = fallbackRaw === '' ? null : fallbackRaw.replace(/^\s*(备用提示词\d*|fallback\d*)\s*\n?/i, '')

  const file: PromptFile = {
    path,
    mtime,
    meta: {
      seq: typeof meta.seq === 'number' ? meta.seq : undefined,
      name,
      dimension: typeof meta.dimension === 'string' ? meta.dimension : undefined,
      difficulty: typeof meta.difficulty === 'string' ? meta.difficulty : undefined,
      tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      source,
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : undefined,
    },
    body,
    fallback,
    summary: body.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS),
  }
  return { ok: true, file }
}

/** 扫描一个目录的全部 *.md（目录不存在 = 空）。坏文件收集 warnings。 */
export function scanPromptDir(dir: string): { files: PromptFile[], warnings: string[] } {
  const files: PromptFile[] = []
  const warnings: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return { files, warnings } // 目录不存在：空库
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const path = join(dir, entry)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      warnings.push(`${path}: read failed (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const parsed = parsePromptFile(path, text, statSync(path).mtimeMs)
    if (!parsed.ok) {
      warnings.push(`${path}: ${parsed.error}`)
      continue
    }
    files.push(parsed.file)
  }
  return { files, warnings }
}

/** 文件名安全化（Windows 保留字符替换；保留中文与常用符号）。 */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
  return (safe === '' ? 'untitled' : safe).slice(0, 80)
}

/** 下一个可用序号（现有文件 `\d+_` 前缀 + 1；目录空 = 1）。 */
export function nextSeq(dir: string): number {
  let max = 0
  try {
    for (const entry of readdirSync(dir)) {
      const m = /^(\d+)_/.exec(entry)
      if (m !== null) max = Math.max(max, Number(m[1]))
    }
  } catch { /* 目录不存在：从 1 开始 */ }
  return max + 1
}

export interface PromptWriteInput {
  name: string
  dimension?: string
  difficulty?: string
  tags?: string[]
  content: string
  fallback?: string
  source: 'user' | 'agent'
}

/**
 * 写一份模板 md（目录不存在自动创建；序号自动分配；同名防追加后缀）。
 * @returns 写入路径。
 */
export function writePromptFile(dir: string, input: PromptWriteInput): string {
  mkdirSync(dir, { recursive: true })
  const seq = nextSeq(dir)
  const base = sanitizeFileName(input.name)
  let path = join(dir, `${seq}_${base}.md`)
  let attempt = 0
  while (existsSync(path)) {
    attempt += 1
    path = join(dir, `${seq}_${base}_${attempt}.md`)
  }
  const lines: string[] = ['---', `seq: ${seq}`, `name: ${JSON.stringify(input.name)}`, `source: ${input.source}`]
  if (input.dimension !== undefined && input.dimension !== '') lines.push(`dimension: ${JSON.stringify(input.dimension)}`)
  if (input.difficulty !== undefined && input.difficulty !== '') lines.push(`difficulty: ${JSON.stringify(input.difficulty)}`)
  if (input.tags !== undefined && input.tags.length > 0) lines.push(`tags: [${input.tags.map(tag => JSON.stringify(tag)).join(', ')}]`)
  lines.push(`createdAt: ${new Date().toISOString().slice(0, 10)}`, '---')
  const text = `${lines.join('\n')}\n\n${input.content.trim()}\n${input.fallback === undefined || input.fallback === '' ? '' : `\n---\n\n${input.fallback.trim()}\n`}`
  writeFileSync(path, text, 'utf8')
  return path
}
