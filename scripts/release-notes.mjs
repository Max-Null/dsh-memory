#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的段落，供 `gh release create --notes-file` 使用。
 *
 * 为什么不在 workflow 里内联解析：版本段的边界是「`## [版本]` 到下一个 `## [`」，
 * 写成脚本才能本地先跑一遍——发布时才发现 notes 为空，等于发布了一个没有说明的版本。
 *
 * 用法：node scripts/release-notes.mjs 0.17.0
 * 退出码：0 正常；1 CHANGELOG 里没有该版本；2 缺参数。
 */
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (version === undefined || version === '') {
  console.error('usage: release-notes.mjs <version>')
  process.exit(2)
}

const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = text.split(/\r?\n/)
const start = lines.findIndex(line => line.startsWith(`## [${version}]`))
if (start === -1) {
  console.error(`CHANGELOG: section for ${version} not found`)
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## [')) {
    end = i
    break
  }
}

process.stdout.write(`${lines.slice(start + 1, end).join('\n').trim()}\n`)
