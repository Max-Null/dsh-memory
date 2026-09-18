#!/usr/bin/env node
/**
 * 多帧 zstd 解压——读 DSH 会话日志的必经一步。
 *
 * **为什么需要它**：DSH 的会话日志（`session.v3.jsonl.zstd`）不是单个 zstd 流，而是
 * **多个独立帧拼接**的结果（一段事件写一帧）。`zlib.zstdDecompressSync()` 只解**第一帧**
 * 就返回——于是 1.9 MB 的日志读出来只有头一行，看起来像「日志是空的」，极易误判。
 * Node 的 zstd 绑定没有暴露「解全部帧」的选项，所以只能自己切帧。
 *
 * **能回答什么**：把 `*.jsonl.zstd` 还原成完整 jsonl 文本，交给后续分析——事件普查、
 * 找某次工具调用、统计 token 压力、解剖一个会话到底做了什么。
 *
 * **判据怎么算**：zstd 帧的 magic number 是 `28 B5 2F FD`（小端）；扫描它在文件中的
 * 全部出现位置即为候选帧边界，再逐帧解压。输出行的三个数就是判据：
 * `frames`（切出几帧）、`ok`（解出几帧）、`failed`（几帧失败）。**failed > 0 说明切帧
 * 切错了**——多半是压缩数据内部恰好出现了那 4 个字节（magic 扫描法的已知局限）。
 *
 * **哪些情况答不了**：
 * - 逐字节扫描 magic 会有**假阳性**。feral > 0 时真帧通常仍能解出，但**不保证完整**；
 *   要 100% 可靠需解析 zstd 帧头（`Frame_Header_Descriptor` 的长度字段），本脚本没做到。
 * - 只做**解压**，不解析 jsonl 语义——事件类型、token 统计属于调用方。
 * - **明文 jsonl 不需要它**：DSH 从 GUI 导出的会话就是明文（`session.v3.jsonl`），
 *   直接 `readFileSync` 即可，别绕这一道。
 *
 * 用法：
 *   node scripts/unzstd-frames.mjs <源 .zstd> <目标 .jsonl>
 *   node scripts/unzstd-frames.mjs --help
 *
 * 退出码：0 = 全部帧解出；1 = 有帧失败（结果可能不完整）；2 = 用法错误。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const USAGE = `多帧 zstd 解压——读 DSH 会话日志的必经一步。

用法：
  node scripts/unzstd-frames.mjs <源 .zstd> <目标 .jsonl>
  node scripts/unzstd-frames.mjs --help

退出码：0 = 全部帧解出；1 = 有帧失败（结果可能不完整）；2 = 用法错误。`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
if (args.length < 2) {
  console.error(USAGE)
  process.exit(2)
}
const [src, dst] = args
if (!fs.existsSync(src)) {
  console.error(`源文件不存在：${src}`)
  process.exit(2)
}

const buf = fs.readFileSync(src)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd] // zstd frame magic（小端）
const positions = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
    positions.push(i)
  }
}
positions.push(buf.length) // 末帧以文件长度收尾

const parts = []
let ok = 0
let failed = 0
for (let i = 0; i + 1 < positions.length; i++) {
  const slice = buf.subarray(positions[i], positions[i + 1])
  try {
    parts.push(zlib.zstdDecompressSync(slice))
    ok += 1
  } catch (error) {
    // 不在这里尝试 stream 容错：`createZstdDecompress()` 是异步的，在同步块里 end() 之后
    // 立刻取 chunks 必然拿不到数据。宁可如实报告失败，也不给一个看似成功的空结果。
    failed += 1
    console.error(`  帧 ${i}（偏移 ${positions[i]}）解压失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const out = Buffer.concat(parts)
fs.writeFileSync(dst, out)
console.log(`frames=${positions.length - 1} ok=${ok} failed=${failed}`)
console.log(`输出 ${out.length} 字节 → ${dst}`)
if (failed > 0) {
  console.error('⚠️ 有帧未解出，结果可能不完整（magic 扫描法的已知局限，见脚本头部注释）')
  process.exit(1)
}
