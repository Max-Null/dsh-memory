/**
 * 危险内容硬拦（2026-09-15 静默记忆机制第一版）：写入路径上的确定性规则检测。
 *
 * 这一类判断不交给模型：凭据一旦进了记忆库，检索就会把它交给模型，而模型无法
 * 可靠判断「这段是不是密钥」。所以用固定规则拦下，命中即隔离（不注入、不检索），
 * 由人显式放行或删除——这是设计文档里唯一不由 LLM 承担的判断。
 *
 * 误报的代价（一条正常记忆被隔离）小于漏报的代价（密钥进入每轮上下文），
 * 因此规则偏保守：宁可多拦，且放行只需一次人工动作。
 */

/** 隔离判定的结果。 */
export interface QuarantineVerdict {
  /** 是否应隔离。 */
  quarantined: boolean
  /** 命中的规则名（诊断与面板展示用）；未命中时为 undefined。 */
  reason?: string
}

/** 单条规则：名字进诊断，正则做判定。命中任意一条即隔离。 */
const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // 常见平台的密钥前缀
  { name: 'api-key-prefix', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // 私钥块
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 赋值式秘密：password/token/api_key = 值
  { name: 'assigned-secret', pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*\S{6,}/i },
  // 认证头
  { name: 'authorization-header', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  // 带口令的连接串（scheme://user:pass@host）
  { name: 'credential-url', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i },
]

/**
 * 判定一段文本是否应被隔离。
 *
 * @param parts - 参与判定的文本片段（正文与关键词都算：关键词里塞密钥同样会外泄）。
 * @returns 命中任意规则即 `quarantined: true`，并给出规则名。
 */
export function detectSensitive(...parts: readonly string[]): QuarantineVerdict {
  const text = parts.filter(part => part !== '').join('\n')
  if (text === '') return { quarantined: false }
  for (const rule of RULES) {
    // 规则都是无状态正则（无 /g），test 不会受 lastIndex 影响
    if (rule.pattern.test(text)) return { quarantined: true, reason: rule.name }
  }
  return { quarantined: false }
}
