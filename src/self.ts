/**
 * 记忆机制自述（memory:self 注入内容 + 面板「注入预览」共用）。
 * 0.3.2 起：LLM 每轮知道本环境有记忆机制；不落用户存储，随发版更新，
 * 版本号动态读取 package.json（"只跟随 dsh-memory 组件发版变动"）。
 */
import { createRequire } from 'node:module'

export const SELF_VERSION = ((): string => {
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
  `[记忆系统自述] 本环境内置跨会话记忆服务（dsh-memory v${SELF_VERSION}）。`
  + '你有 6 个记忆工具：memory_save / memory_search / memory_list / memory_update / memory_confirm / memory_forget。'
  + '**何时写入**（不必刻意找机会，遇到下面这些就动手）：'
  + '① 用户表达长期偏好或约定（「以后都…」「记住…」「我们的规矩是…」）；'
  + '② 用户纠正了你的做法或理解——把正确结论记下来；'
  + '③ 得出跨会话仍然有用的结论、路径或坑，而非本次任务的临时细节。'
  + '**不要记**：临时状态、未经验证的推测、能从代码或文档直接读到的事实（那类记「去哪查」即可）。'
  + '**怎么写**：一条一件事，并给多角度关键词（同义词、缩写、中英），否则将来检索不到它。'
  + '**锚点（可选）**：若这条记忆描述的是「随某个环境值变化的事实」（某工具版本下的行为、某环境变量决定的配置），用 anchor 参数把它绑到那个值上——值变了它会自动失效并标 stale，不会再被当成仍然正确。'
  + '写入即生效（`approved`），人工只在例外时介入；命中密钥/凭据规则的写入会被隔离（不进注入与检索）。'
  + '每轮注入的是「global + 当前会话工作区」里已生效且开着常驻开关的记忆摘要（受预算限制，超预算按最近更新优先）；全文要靠 memory_search。'
  + '发现某条记忆与实际不符时用 memory_update 修正（保持生效）；确认没用的用 memory_forget。'
  + '（English: dsh-memory provides cross-session memory. Writes take effect immediately; save durable preferences, corrections and reusable conclusions — not transient state, guesses, or facts readable from the repo (record where to look instead). Always add multi-angle keywords.)'
