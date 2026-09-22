/**
 * 有效性锚点（2026-09-15 静默记忆机制）：把一条记忆绑定到某个**可探测的环境值**上，
 * 值变了就自动失效——解决「版本特性类记忆随环境升级静默变错」的问题。
 *
 * 探测跑在会话启动的校验路径上，因此**禁止起子进程**（那要先解决「插件直接 spawn 会绕过
 * DSH 的 shell 沙箱」的合规问题，不能顺手开这个口子）。**文件探测不在此列**：`path-exists`
 * 只有一次 `existsSync`，与读环境变量同量级。此前这里写的是「探测必须零 IO」，那句话把
 * 「禁止 spawn」误写成了「禁止一切系统调用」——0.12.0 加 `path-exists` 时改正。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 受控词汇表：写入时只能从这四种里选，不能自创（自创的锚点无法机械校验）。 */
export type AnchorKind = 'env' | 'tool-list' | 'self-version' | 'path-exists'

/** 一条记忆声明的锚点。 */
export interface MemoryAnchor {
  kind: AnchorKind
  /** `env` 类型时的变量名；其余类型省略。 */
  name?: string
  /** 写入时探测到的值。 */
  value: string
}

/** 探测上下文：由调用方提供，便于测试注入与缓存。 */
export interface AnchorProbes {
  /**
   * 当前可用工具的清单；**拿不到时必须是 `undefined` 而不是空数组**——空数组会被判成
   * 「工具全没了」，让所有 `tool-list` 锚点误失效。
   */
  toolNames?: readonly string[]
  /** dsh-memory 自身版本。 */
  selfVersion: string
  /** 环境变量读取器；缺省 `process.env`。 */
  env?: (name: string) => string | undefined
  /**
   * 会话工作区 cwd：`path-exists` 用它把**相对路径**解析成绝对路径（0.12.0）。
   *
   * 缺省时相对路径判为「**未校验**」而不是「不存在」——定位不到与文件真的不在是两件事，
   * 混起来会让所有相对路径锚点在拿不到 cwd 的路径上集体误失效。
   */
  workspaceCwd?: string
}

/**
 * 探测某个锚点当前的取值。
 *
 * @param anchor - 记忆声明的锚点。
 * @param probes - 当前环境的探测上下文。
 * @returns 当前值；**无法探测时返回 `undefined`**（调用方按「未校验」处理，不能判失效）。
 */
export function probeAnchor(anchor: MemoryAnchor, probes: AnchorProbes): string | undefined {
  switch (anchor.kind) {
    case 'env': {
      if (anchor.name === undefined || anchor.name === '') return undefined
      const read = probes.env ?? ((name: string): string | undefined => process.env[name])
      return read(anchor.name)
    }
    case 'tool-list':
      if (probes.toolNames === undefined) return undefined
      return [...probes.toolNames].sort().join(',')
    case 'self-version':
      return probes.selfVersion
    case 'path-exists': {
      if (anchor.name === undefined || anchor.name === '') return undefined
      const relative = !isAbsolute(anchor.name)
      // 相对路径但没有工作区：定位不到 → 未校验（不能判失效）
      if (relative && (probes.workspaceCwd === undefined || probes.workspaceCwd === '')) return undefined
      const target = relative ? resolve(probes.workspaceCwd as string, anchor.name) : anchor.name
      return existsSync(target) ? 'present' : 'absent'
    }
    default:
      return undefined
  }
}

/**
 * 锚点是否仍然成立。
 *
 * @returns `true` 成立；`false` 失效；`undefined` **未校验**（探测不到，不判失效——探测
 *   失败与「值变了」是两件事，混起来会误伤）。
 */
export function anchorHolds(anchor: MemoryAnchor, probes: AnchorProbes): boolean | undefined {
  const current = probeAnchor(anchor, probes)
  if (current === undefined) return undefined
  return current === anchor.value
}
