/**
 * 存储块的 schema —— **零 peer 依赖地可独立加载**。
 *
 * 为什么单独成模块：离线扫描器（`scripts/check-memory-files.mjs`）要 import 编译产物来跑
 * 存量校验，而 `engine.js` 在运行时 import 了 `@deepseek-ai/cordis`、
 * `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-storage-json`——那三个都是**由宿主
 * 提供的 peer**，装版实体里没有。2026-09-29 实测：在 profile 里直接跑扫描器会报
 * `Cannot find package '@deepseek-ai/cordis' imported from dist/engine.js`，于是
 * 「用插件自己的 schema 扫存量」这条设计**在用户环境里根本跑不起来**。
 *
 * 本模块只依赖 `zod`（真 `dependencies`，装版有）与 `./anchors.ts`（只有 `node:fs` /
 * `node:path`），所以 `dist/schema.js` 能被独立加载——**判据仍然只有一份**，不另写。
 *
 * @see docs/设计/2026-09-25-写入兜底与失败可见化-设计方案.md §四.3
 */

import { z } from 'zod'
import { ANCHOR_KINDS } from './anchors.ts'

/**
 * 存储块的 schema（门一与门三共用的判据来源，2026-09-25）。
 *
 * 门一（写入端）在 `putBlock` 里用它拒绝不合规的块；门三（存量体检）在扫描器里用它逐条
 * 校验已有文件——**同一份定义**，因为两份判据会漂移，而漂移的方向恰好是「扫描器说没事、
 * 打开时炸」这种最难查的形态。
 */
export const blockSchema = z.object({
  namespace: z.enum(['global', 'project']),
  status: z.enum(['suggested', 'approved', 'auto', 'suggest']),
  injected: z.boolean().optional(),
  quarantined: z.boolean().optional(),
  quarantineReason: z.string().optional(),
  hitCount: z.number().optional(),
  source: z.enum(['agent', 'human']).optional(),
  injectedAuto: z.boolean().optional(),
  anchor: z.object({
    kind: z.enum(ANCHOR_KINDS),
    name: z.string().optional(),
    value: z.string(),
  }).optional(),
  stale: z.boolean().optional(),
  staleReason: z.string().optional(),
  content: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  vector: z.array(z.number()).optional(),
  kind: z.enum(['fact', 'prompt']).optional(),
  meta: z.object({
    seq: z.number().optional(),
    name: z.string(),
    dimension: z.string().optional(),
    difficulty: z.string().optional(),
    tags: z.array(z.string()),
    summary: z.string(),
    path: z.string(),
    mtime: z.number(),
    source: z.enum(['user', 'agent']),
  }).optional(),
})

/**
 * 把 zod 的 issue 压成一行（门一，2026-09-25）。
 *
 * 排查成本的大头在「从 domain 打不开倒推」——`dsh-storage-domain` 封装后的错误只给到
 * 「哪个 domain 的哪条记录不合规」（`stored record '<id>' in table 'blocks' does not
 * match its schema`），**说不出是哪个字段、什么值、期望什么**。这行补的就是那段。
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}
