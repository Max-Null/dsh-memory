#!/usr/bin/env node
/**
 * 把一个**已发布**的版本装进思灵的随包插件集（2026-11-14）。
 *
 * ## 它解决什么
 *
 * 装版插件实体（`resources/ssid-plugins/node_modules/@max-null/<pkg>`）是
 * `prepare-ssid-plugins.ts` 在打包时 `pnpm install` + 拍平出来的，**依赖是完整的**。
 * 但平时升级单个插件时，手工把 npm tarball 解包覆盖进去，就绕过了那一步——
 * 于是这个包自己的 `dependencies` 谁也不会装：
 *
 * - 0.22.0 起是 `isomorphic-git`（+ 11 个传递依赖），当时手工补过；
 * - 0.22.4 起多了 `https-proxy-agent`，2026-11-14 升级 0.23.0 时又踩了一次。
 *
 * 症状是**插件整个加载失败**（ESM import 解析不到），而 npm 那侧一切正常，很容易误判。
 *
 * ## 做法
 *
 * 1. 备份旧实体；
 * 2. `npm pack` 取发布物并解包（装的就是发布物，不是本地构建）；
 * 3. 在实体目录里 `npm install --omit=dev --no-package-lock --ignore-scripts`
 *    ——把它的 dependencies 装成**嵌套** `node_modules`（不污染插件集的公共依赖，
 *    公共目录里可能已有别的包在用的旧版本）；
 * 4. 用 `createRequire` 指向实体 `package.json`，逐个验证依赖真的解析得到。
 *
 * 用法：
 *   node scripts/install-to-ssid.mjs                      # 默认装版路径
 *   node scripts/install-to-ssid.mjs --target <目录>       # 指定别的插件集
 *   node scripts/install-to-ssid.mjs --dry-run            # 只打印计划
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PKG = '@max-null/dsh-memory'
/** Windows 上 npm 是 .cmd，execFileSync 不能直跑。 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const DEFAULT_TARGET = 'C:/Users/MaxNull/AppData/Local/Programs/ssid-shell/resources/ssid-plugins'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const targetRoot = resolve(flag('--target') ?? DEFAULT_TARGET)
const entityDir = join(targetRoot, 'node_modules', '@max-null', 'dsh-memory')
const localVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

console.log(`插件: ${PKG}@${localVersion}`)
console.log(`目标: ${entityDir}`)
if (!existsSync(join(targetRoot, 'node_modules'))) {
  console.error(`目标插件集不像一个 ssid-plugins 目录（缺 node_modules）：${targetRoot}`)
  process.exit(1)
}
if (dryRun) {
  console.log('--dry-run：只打印计划，不做任何改动')
  process.exit(0)
}

// 1. 取发布物并解包
const staging = mkdtempSync(join(tmpdir(), 'ssid-plugin-install-'))
try {
  console.log('下载发布物…')
  execFileSync(NPM, ['pack', `${PKG}@${localVersion}`, '--silent'], { cwd: staging, stdio: 'pipe', shell: true })
  const tgz = readdirSync(staging).find(name => name.endsWith('.tgz'))
  if (tgz === undefined) throw new Error('npm pack 没有产出 tgz')
  execFileSync('tar', ['-xzf', tgz], { cwd: staging, stdio: 'pipe' })
  const packedVersion = JSON.parse(readFileSync(join(staging, 'package', 'package.json'), 'utf8')).version
  if (packedVersion !== localVersion) {
    throw new Error(`运回来的版本是 ${packedVersion}，与本地 ${localVersion} 不一致`)
  }

  // 2. 备份旧实体
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const backup = `${entityDir}.bak-${stamp}`
  if (existsSync(entityDir)) {
    cpSync(entityDir, backup, { recursive: true })
    console.log(`已备份旧实体：${backup}`)
    rmSync(entityDir, { recursive: true, force: true })
  }

  // 3. 落地
  mkdirSync(entityDir, { recursive: true })
  cpSync(join(staging, 'package'), entityDir, { recursive: true })
  console.log('已解包发布物')

  // 4. 装它的 dependencies（嵌套 node_modules，不碰插件集的公共依赖）
  console.log('安装运行时依赖…')
  execFileSync(NPM, ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: entityDir,
    stdio: 'pipe',
    shell: true,
  })

  // 5. 验证
  const require = createRequire(join(entityDir, 'package.json'))
  const deps = Object.keys(JSON.parse(readFileSync(join(entityDir, 'package.json'), 'utf8')).dependencies ?? {})
  const failed = []
  for (const name of deps) {
    try {
      require.resolve(name)
    } catch {
      failed.push(name)
    }
  }
  if (failed.length > 0) {
    throw new Error(`依赖装完仍解析不到：${failed.join(', ')}`)
  }
  console.log(`依赖全部可解析：${deps.join(', ')}`)
  console.log('完成。重启思灵后生效。')
} finally {
  rmSync(staging, { recursive: true, force: true })
}
