/**
 * 云同步 token 的本地存放（2026-11-13）。
 *
 * **为什么不进 profile 配置**：`cordis.patch.yml` 会被复制、分享、提交——token
 * 落进去等于泄露。这里落在 `$DSH_HOME/memory-sync-token` 一个独立文件里：
 * 它不在任何 profile 里，也不在备份扫描范围内（备份只扫 `storages` 与 `diary`）。
 *
 * **读取优先级：环境变量 `DSH_MEMORY_SYNC_TOKEN` > 本文件。** 环境变量适合
 * 一次性/CI 场景，文件适合面板里点着设；两者都设时以环境变量为准，因为它是
 * 调用方显式注入的那一层。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** token 文件路径。 */
export function syncTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory-sync-token')
}

/**
 * 读 token。
 * @returns 去空白后的 token；文件不存在或内容为空时 `undefined`（视同未设置）。
 */
export function readSyncTokenFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = syncTokenPath(env)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? undefined : text
}

/**
 * 写 token；传空串等于清除。
 *
 * `mode: 0o600` 在 Windows 上不生效（POSIX 权限位无意义），但保留它让类 Unix
 * 平台默认就收紧；Windows 侧的隔离靠「不放进 profile、不进备份」。
 */
export function writeSyncTokenFile(token: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = syncTokenPath(env)
  const trimmed = token.trim()
  if (trimmed === '') {
    rmSync(file, { force: true })
    return
  }
  writeFileSync(file, `${trimmed}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** 清除 token 文件（不存在也不报错）。 */
export function clearSyncTokenFile(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(syncTokenPath(env), { force: true })
}
