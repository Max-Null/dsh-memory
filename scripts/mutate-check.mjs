#!/usr/bin/env node
/**
 * 变异演示（mutation demo）：用**故意的失败**证明守卫真的会红。
 *
 * 做法：逐条拿掉一个已修复的行为（退回修复前的写法），跑对应用例，断言它们**必须失败**；
 * 无论成败都把源码恢复并校验哈希。
 *
 * 为什么需要它：测试长时间全绿之后，「这条用例还测得到东西吗」没有人能回答。这个脚本把
 * 那个问题变成一条可执行、可重复的检查——而不是靠某次手工验证的记忆。人工做同样的动作
 * 有个已知风险：忘了恢复，或者以为自己恢复了。这里用 sha256 兜住。
 *
 * 用法：node scripts/mutate-check.mjs [变异名片段]
 * 退出码：0 = 全部变异如期导致失败（守卫有效）｜1 = 有变异后测试仍通过（守卫失效）｜2 = 出错
 *        （变异点找不到、或源码恢复失败）
 *
 * 只在本仓库跑（需要 node_modules 里的 vitest）。它是开发工具，不进 npm 包的 files。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 变异清单。每条 = 一个被守卫盯住的行为 + 推翻它的写法 + 应当变红的用例文件。
 *
 * `needle` 找不到时**报错退出**而不是跳过：一个不再命中任何东西的变异脚本，等于没有验证。
 */
const MUTATIONS = [
  {
    name: '注入中和（0.11.1）',
    file: join(ROOT, 'src', 'index.ts'),
    spec: 'test/injection-assembly.spec.ts',
    needle: "return neutralizeBraces(parts.join('\\n'))",
    mutant: "return parts.join('\\n')",
    guard: '记忆正文含字面 {{ }} 时，注入副本必须已被中和',
  },
  {
    name: '注入排序（0.12.0）',
    file: join(ROOT, 'src', 'injection.ts'),
    spec: 'test/injection.spec.ts',
    needle: 'const ordered = [...records].sort((left, right) => right.updatedAt - left.updatedAt)',
    mutant: 'const ordered = [...records].sort((left, right) =>'
      + ' (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt))',
    guard: '检索不再改变注入顺序（lastUsedAt 不得影响排序）',
  },
  {
    name: '取消自动升（0.12.0）',
    file: join(ROOT, 'src', 'engine.ts'),
    spec: 'test/memory.spec.ts',
    // 单行 needle：多行模板字符串里的 `\n` 与检出文件的 `\r\n` 不匹配，Windows 上会假报
    // 「变异点已不存在」。单行对行尾免疫。
    needle: '      hitCount: (block.hitCount ?? 0) + 1,',
    mutant: '      hitCount: (block.hitCount ?? 0) + 1,\n'
      + '      ...((block.kind ?? \'fact\') !== \'prompt\' && block.injected !== true'
      + ' && (block.hitCount ?? 0) + 1 >= CANDIDATE_HITS'
      + ' ? { injected: true, injectedAuto: true } : {}),',
    guard: '命中次数不再自动改变注入状态（只进候选）',
  },
  {
    name: '体检写回（0.12.1）',
    file: join(ROOT, 'src', 'engine.ts'),
    spec: 'test/memory.spec.ts',
    needle: '    this.lastSweep = report',
    mutant: '',
    guard: '调用 sweep 会刷新注入侧读的那份报告（不再只有会话启动维护写它）',
  },
  {
    name: '改锚点当场校验（0.12.1）',
    file: join(ROOT, 'src', 'engine.ts'),
    spec: 'test/memory.spec.ts',
    needle: '      if (patch.anchor === undefined) return patched',
    mutant: '      return patched',
    guard: 'update 带 anchor 时必须真的改写并当场校验（含 null 清除）',
  },
]

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

function abort(message, code) {
  console.error(`\n✗ ${message}\n`)
  process.exit(code)
}

/** 跑一条变异：返回 'caught'（如期变红）/ 'missed'（仍然通过）。源码无论成败都恢复。 */
function runMutation(mutation) {
  const original = readFileSync(mutation.file, 'utf8')
  if (!original.includes(mutation.needle)) {
    abort(
      `[${mutation.name}] 变异点已不存在（源码结构变了）：\n    ${mutation.needle}\n`
      + '  该脚本需要同步更新——静默跳过等于没有验证。',
      2,
    )
  }
  const originalHash = digest(original)
  const mutated = original.replace(mutation.needle, mutation.mutant)
  if (mutated === original) abort(`[${mutation.name}] 替换未生效`, 2)

  writeFileSync(mutation.file, mutated, 'utf8')
  console.log(`\n· [${mutation.name}] 守卫：${mutation.guard}`)
  console.log(`  变异：${mutation.needle.split('\n')[0].trim()} …`)

  let testExit = 0
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', mutation.spec], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } catch (error) {
    testExit = typeof error.status === 'number' ? error.status : 1
  } finally {
    // 恢复必须在 finally：脚本中途失败时源码不能留在被改状态
    writeFileSync(mutation.file, original, 'utf8')
  }

  if (digest(readFileSync(mutation.file, 'utf8')) !== originalHash) {
    abort(`[${mutation.name}] 源码恢复失败（期望 sha256 ${originalHash}）——请手动检查 ${mutation.file}`, 2)
  }
  console.log(`  源码已恢复（sha256 ${originalHash}）`)
  return testExit === 0 ? 'missed' : 'caught'
}

const filter = process.argv[2]
const selected = filter === undefined
  ? MUTATIONS
  : MUTATIONS.filter(mutation => mutation.name.includes(filter))
if (selected.length === 0) abort(`没有匹配「${filter}」的变异`, 2)

const missed = []
for (const mutation of selected) {
  if (runMutation(mutation) === 'missed') missed.push(mutation.name)
}

if (missed.length > 0) {
  abort(`这些变异后测试仍然通过 → 对应用例没有测到东西（守卫失效）：${missed.join('、')}`, 1)
}

console.log(`\n✓ ${selected.length} 条变异全部如期导致失败——对应的守卫确实在守着那些行为\n`)
