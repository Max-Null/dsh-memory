/**
 * 日记的存储层 —— 与记忆的 block 存储**完全分离**。
 *
 * 为什么不复用 `ctx.storage` / `storageDomain` / `storage-json`：那条路的写入模型是
 * **writer per process and last-write-wins**（`packages/storage/storage-json/src/index.ts:5-9`），
 * sqlite 的 README 明写 **cross-process coordination is out of scope**。2026-09-17 实测中
 * `workspace.json` 与 `memory.json` 都被另一个实例静默覆盖过。日记只由本模块的 `node:fs`
 * 读写，不进那套服务，就不会被任何实例的「读—改—写」周期吃掉。
 *
 * @see docs/设计/2026-10-24-日记机制-设计方案.md §四
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 本地时区的日期串 `YYYY-MM-DD`。
 *
 * 用 `sv-SE` 的本地化格式取日期而不是手拼 `getMonth()+1`：`sv-SE` 的日期格式恰好是
 * ISO 顺序且按本地时区输出，省掉补零与时区换算两处容易写错的地方。
 * @param at - 毫秒时间戳；缺省取当前时刻。
 * @returns `YYYY-MM-DD`。
 */
export function localDate(at: number = Date.now()): string {
  return new Date(at).toLocaleDateString('sv-SE')
}

/**
 * 展开前导波浪号。
 *
 * `$DSH_HOME` 允许写成 `~/env-dsh`（官方 `resolveDshHome` 同样处理），而 `path.resolve`
 * 不会展开它，直接拼会得到一个字面名为 `~` 的目录。
 * @param value - 可能带 `~` 的路径。
 * @returns 绝对路径。
 */
function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
}

/**
 * harness home：`$DSH_HOME`，缺省 `~/.dsh`。
 *
 * 空或仅空白的 `$DSH_HOME` 视为未设置（与官方 `resolveDshHome` 一致），否则空值会把
 * 路径解析到进程当前目录。
 * @returns 绝对路径。
 */
export function dshHome(): string {
  const raw = process.env.DSH_HOME
  return raw !== undefined && raw.trim() !== ''
    ? path.resolve(expandHome(raw.trim()))
    : path.join(os.homedir(), '.dsh')
}

/**
 * 日记目录：`<DSH_HOME>/diary`，缺省 `~/.dsh/diary`。
 *
 * 与 `storages/`、`storages-ssid/` 平级，互不相干——这是「不被覆盖」这条判据的落点，
 * 不是随手选的位置。
 * @returns 绝对路径（目录可能尚不存在）。
 */
export function diaryDir(): string {
  return path.join(dshHome(), 'diary')
}

/**
 * 某一天的日记文件路径。
 * @param date - `YYYY-MM-DD`。
 * @returns 绝对路径。
 */
export function dayFile(date: string): string {
  return path.join(diaryDir(), `${date}.md`)
}

/**
 * 读某一天的日记原文。
 * @param date - `YYYY-MM-DD`。
 * @returns 原文；这一天没有日记时 `undefined`（不是空串——「没有」与「写了空」要能分开）。
 */
export function readDay(date: string): string | undefined {
  try {
    return fs.readFileSync(dayFile(date), 'utf8')
  } catch {
    // 文件不存在就是没有这一天的日记，是本函数的正常返回，不是故障。
    return undefined
  }
}

/** {@link appendEntry} 的结果。 */
export interface AppendResult {
  /** 写入的文件绝对路径。 */
  readonly file: string
  /** 写入所属的日期（本地时区）。 */
  readonly date: string
  /** 这一天是不是本次才创建的。 */
  readonly created: boolean
}

/**
 * 往当天的日记追加一段。
 *
 * **追加而不是覆盖**：一天里可能有多场对话，每场结束各写一段；覆盖会让前一扬的内容消失。
 * 用 `appendFileSync` 而非「读全文—拼接—写回」：追加在 POSIX 上是带 `O_APPEND` 的单次写，
 * 即便两个实例同时追加也不会互相截断（长度交错是可能的，内容不会丢）。
 * @param text - 这一段正文；首尾空白会被裁掉，空内容被拒绝。
 * @param at - 毫秒时间戳；缺省取当前时刻。
 * @returns 写入位置与是否新建。
 * @throws 当 `text` 裁掉空白后为空。
 */
export function appendEntry(text: string, at: number = Date.now()): AppendResult {
  const body = text.trim()
  if (body === '') throw new Error('日记内容为空')

  const date = localDate(at)
  const file = dayFile(date)
  fs.mkdirSync(diaryDir(), { recursive: true })
  const created = !fs.existsSync(file)
  const hhmm = new Date(at).toTimeString().slice(0, 5)
  // 新建时补一级标题；之后的每一段只占一个二级标题。
  const chunk = created
    ? `# ${date}\n\n## ${hhmm}\n\n${body}\n`
    : `\n## ${hhmm}\n\n${body}\n`
  fs.appendFileSync(file, chunk, 'utf8')
  return { file, date, created }
}

/**
 * 最近写过日记的日子，从新到旧。
 * @param limit - 最多返回多少天。
 * @returns `YYYY-MM-DD` 列表；目录不存在时为空。
 */
export function recentDates(limit = 7): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(diaryDir())
  } catch {
    // 目录还没建过——一篇日记都没有，是正常状态。
    return []
  }
  return names
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => name.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, limit)
}

/**
 * 最后一次写入日记的时间戳。收尾节流用它判断「该不该提醒写日记」。
 * @returns 毫秒时间戳；一篇日记都没有时 `undefined`。
 */
export function lastWriteAt(): number | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(diaryDir())
  } catch {
    return undefined
  }
  const dir = diaryDir()
  let latest: number | undefined
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs
      if (latest === undefined || m > latest) latest = m
    } catch {
      // 扫目录与 stat 之间被删：跳过这一天，不影响其余日期的判断。
    }
  }
  return latest
}

/**
 * 注入用的指针行。**只有目录与最近日期，不含正文**——注入预算属于记忆，日记不占。
 *
 * 这一行本身是「失效可察觉性」判据的应用：它不在，我不会意识到自己有日记可读。
 * @returns 一行 markdown 文本。
 */
export function pointerLine(): string {
  const dir = diaryDir()
  const dates = recentDates(3)
  return dates.length === 0
    ? `日记目录：${dir}（还没有任何一篇）`
    : `日记目录：${dir}；最近写入：${dates.join('、')}`
}
