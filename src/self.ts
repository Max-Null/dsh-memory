/**
 * 记忆机制自述（memory:self 注入内容 + 面板「注入预览」共用）。
 * 0.3.2 起：LLM 每轮知道本环境有记忆机制；不落用户存储，随发版更新，
 * 版本号动态读取 package.json（"只跟随 dsh-memory 组件发版变动"）。
 */
import { createRequire } from 'node:module'

const SELF_VERSION = ((): string => {
  try {
    // dist/index.js 位于包根 package.json 同级（../package.json）
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

export const SELF_DESCRIPTION =
  `[记忆系统自述] 当前环境内置跨会话记忆服务（dsh-memory v${SELF_VERSION}）。`
  + '工作机制：①记忆以明文 JSON 存储（global→$DSH_HOME/storages、工作区→会话工作区 .dsh/storages 随 git 分享）；'
  + '②模型写入即 suggested（待审核），仅人工审核（memory_confirm）后才 approved；'
  + '③每轮注入 system prompt 的只有「global 的 approved + injected 开关打开」的记忆（常驻注入由用户控制，审核≠注入）；'
  + '④工作区记忆按会话工作区路由，靠 memory_search 检索（含待审核条目，可先评估再引用）；'
  + '⑤修正过时内容用 memory_update（改动重置待审核，注入开关保留）。'
  + `可用记忆工具共 6 个：memory_save / memory_list / memory_search / memory_confirm / memory_forget / memory_update。`
  + '使用建议：相关历史上下文先 memory_search 检索再引用；新习惯/约定用 memory_save 写入（落在待审核）。'
  + '（中/英文同义：This environment has a cross-session memory service; write suggestions via memory_save, retrieve via memory_search, and expect human review before approved.)'
