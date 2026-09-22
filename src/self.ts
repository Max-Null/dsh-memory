/**
 * 记忆机制自述（memory:self 注入内容 + 面板「注入预览」共用）。
 * 0.3.2 起：LLM 每轮知道本环境有记忆机制；不落用户存储，随发版更新，
 * 版本号动态读取 package.json（"只跟随 dsh-memory 组件发版变动"）。
 * 0.9.2：补齐常驻注入机制——`injected` 参数、注入预算上限、预算诊断行的含义。
 * 0.10.0：修正工具清单（6 → 10，补提示词模板工具）与两层记忆说明——原清单漏了
 * `prompt_*` 系列，照它读会以为本插件只有记忆工具。
 * 0.12.0：工具清单 10 → 11（补 `memory_sweep`）；删掉「命中累计 2 次自动开启常驻」
 * （该规则已取消，命中只喂候选提示）；注入取舍依据由「最近使用」改为「最近更新」。
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
  + '你有 11 个工具：**记忆工具** memory_save / memory_search / memory_list / memory_update / memory_confirm / memory_forget / memory_sweep（`memory_confirm` 仅在用户明确要求放行隔离记录时用；`memory_sweep` 是只读体检——失效清单、久未命中、候选与预算占用，不修改任何状态）；**提示词模板工具** prompt_search / prompt_get / prompt_list / prompt_add（模板是 md 文件、**永不注入**，走这条通道，不会混进记忆检索）。'
  + '记忆分两层：`global` 跨项目（偏好 / 习惯 / 环境知识），`project` 跟随工作区（落在 `<cwd>/.dsh/storages/`，随 git 提交分享）。'
  + '**何时写入**（不必刻意找机会，遇到下面这些就动手）：'
  + '① 用户表达长期偏好或约定（「以后都…」「记住…」「我们的规矩是…」）；'
  + '② 用户纠正了你的做法或理解——把正确结论记下来；'
  + '③ 得出跨会话仍然有用的结论、路径或坑，而非本次任务的临时细节。'
  + '**不要记**：临时状态、未经验证的推测、能从代码或文档直接读到的事实（那类记「去哪查」即可）。'
  + '**怎么写**：一条一件事，并给多角度关键词（同义词、缩写、中英），否则将来检索不到它。'
  + '**锚点（可选）**：若这条记忆描述的是「随某个环境值变化的事实」（某工具版本下的行为、某环境变量决定的配置），用 anchor 参数把它绑到那个值上——值变了它会自动失效并标 stale，不会再被当成仍然正确。'
  + '写入即生效（`approved`），人工只在例外时介入；命中密钥/凭据规则的写入会被隔离（不进注入与检索）。'
  + '**常驻注入**：每轮注入「global + 当前会话工作区」里 approved 且开着常驻开关的记忆单行摘要（形如 `- [memory:id:namespace] 摘要`）；全文要靠 memory_search 取。'
  + '开关只有一条自动规则：**自动升上来的**常驻在 30 天未命中后撤下；命中次数不再自动改变注入状态（它只喂体检报告的候选提示）。**给 memory_save / memory_update 传 `injected` 即显式接管**，此后这条规则也不再适用。'
  + '**钉的判据是「失效可察觉性」**：这条记忆若没被想起来，你会不会根本意识不到自己漏了它？会 → 钉常驻（规则 / 委托 / 判据）；不会 → 留检索（事实 / 参考 / 案例）。'
  + '**注入有预算**（默认 1500 字符，约装 11 条），装不下的整条丢弃、按**最近更新**优先取舍（不是最近被检索——检索是「需要时才用」的行为，拿它决定「谁每轮在场」会让查得多的挤掉钉得牢的）——所以「钉了常驻」只等于「有资格排队」。'
  + '装不下时注入末尾会出现一行 `（另有 N 条常驻因预算未注入：…短摘要…）`——**那是「有常驻记忆并不在场」的唯一信号**，看到它就该逐条评估撤下。'
  + '发现某条记忆与实际不符时用 memory_update 修正（保持生效）；确认没用的用 memory_forget。'
  + '（English: dsh-memory provides cross-session memory. Writes take effect immediately; save durable preferences, corrections and reusable conclusions — not transient state, guesses, or facts readable from the repo (record where to look instead). Always add multi-angle keywords. Pass `injected: true` to keep one resident every turn — reserve that for rules and standing agreements; facts stay search-only. Resident injection runs on a budget, so a pinned memory is only queued, never guaranteed to be in context.)'
