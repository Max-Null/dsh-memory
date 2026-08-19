/**
 * dsh-memory 自带面板的 HTTP 数据通道（0.3.6）。
 * 背景：client 侧 `remote.memory` 命名空间依赖 Typert 构建期产物（独立
 * npm 包生成不了——2026-08-16 设计文档结论），导致自带面板无法经 remote
 * 取数。改走本端点（panels /ssid/api 同模式：host 插件注册 HTTP 路由，
 * client fetch）——任何 profile 装 dsh-memory 即有面板，脱离 SSiD 也成立。
 * 信任围栏同 /ssid/api：loopback / trustedHosts，拒绝 cross-site。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import type { MemoryEngine } from './engine.ts'
import { SELF_DESCRIPTION } from './self.ts'

const require = createRequire(import.meta.url)

/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20

class MemoryApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'MemoryApiError'
  }
}

function writeJson(res: unknown, status: number, body: unknown): void {
  const r = res as { writeHead(status: number, headers: Record<string, string>): void; end(data: string): void }
  r.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  r.end(JSON.stringify(body))
}

function writeError(res: unknown, error: unknown): void {
  if (error instanceof MemoryApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
}

async function readJsonBody(req: AsyncIterable<string | Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new MemoryApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MemoryApiError('bad-request', 'request body is not valid JSON')
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether one request may reach the plugin routes (mirror of the /api gateway fence). */
function isTrusted(request: { headers: Record<string, string | string[] | undefined> }, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const trusted = isLoopbackHostname(hostUrl.hostname)
    || trustedHosts.some((entry) => {
      const entryUrl = parseAuthority(entry)
      return entryUrl !== undefined && entryUrl.host === hostUrl.host
    })
  if (!trusted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One API method. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/** String-ish cwd payload guard. */
function cwdOf(payload: Record<string, unknown> | null | undefined): string | undefined {
  const value = payload?.cwd
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 挂载 /memory/api 路由（apply 调用）。 */
export function mountMemoryApi(ctx: Context): void {
  // webServer/webRuntime 由 index.ts 的 inject 声明（Context 类型未扩展，断言访问）
  const webServer = (ctx as unknown as { webServer: {
    register(descriptor: { kind: string, path: string, handler: (req: unknown, res: unknown) => Promise<void> | void }): () => void
  } }).webServer
  const webRuntime = (ctx as unknown as { webRuntime: { trustedHosts: readonly string[] } }).webRuntime

  const api: Record<string, ApiMethod> = {
    'list': (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      const record = payload as Record<string, unknown> | null
      const filter = record?.filter as Record<string, unknown> | undefined
      return memory.list({
        ...filter?.namespace !== undefined && typeof filter.namespace === 'string' ? { namespace: filter.namespace as 'global' | 'project' } : {},
        ...filter?.status !== undefined && typeof filter.status === 'string' ? { status: filter.status as 'suggested' | 'approved' } : {},
        ...filter?.injected !== undefined && typeof filter.injected === 'boolean' ? { injected: filter.injected } : {},
      }, cwdOf(record))
    },
    'reload': async (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      await memory.reload()
      return memory.list({}, cwdOf(payload as Record<string, unknown> | null))
    },
    'confirm': (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      const record = payload as Record<string, unknown> | null
      if (typeof record?.id !== 'string') throw new MemoryApiError('bad-request', 'missing or invalid "id"')
      return memory.setStatus(record.id as never, 'approved', cwdOf(record))
    },
    'forget': (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      const record = payload as Record<string, unknown> | null
      if (typeof record?.id !== 'string') throw new MemoryApiError('bad-request', 'missing or invalid "id"')
      return memory.forget(record.id as never, cwdOf(record))
    },
    'setInjected': (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      const record = payload as Record<string, unknown> | null
      if (typeof record?.id !== 'string') throw new MemoryApiError('bad-request', 'missing or invalid "id"')
      if (typeof record?.injected !== 'boolean') throw new MemoryApiError('bad-request', 'missing or invalid "injected"')
      return memory.setInjected(record.id as never, record.injected, cwdOf(record))
    },
    'update': (payload) => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      const record = payload as Record<string, unknown> | null
      if (typeof record?.id !== 'string') throw new MemoryApiError('bad-request', 'missing or invalid "id"')
      if (record.content !== undefined && typeof record.content !== 'string') throw new MemoryApiError('bad-request', 'invalid "content"')
      if (record.keywords !== undefined && !(Array.isArray(record.keywords) && record.keywords.every(k => typeof k === 'string'))) {
        throw new MemoryApiError('bad-request', 'invalid "keywords"')
      }
      return memory.update(record.id as never, {
        ...record.content === undefined ? {} : { content: record.content },
        ...record.keywords === undefined ? {} : { keywords: record.keywords },
      }, cwdOf(record))
    },
    'injectionPreview': () => {
      const memory = ctx.get('memory') as MemoryEngine | undefined
      if (memory === undefined) throw new MemoryApiError('service-unavailable', 'memory service unavailable', 503)
      return { self: SELF_DESCRIPTION, injected: memory.recallRecords() }
    },
  }

  const fence = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    isTrusted(req, webRuntime.trustedHosts)

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/memory/api',
    handler: async (req: unknown, res: unknown) => {
      const request = req as { headers: Record<string, string | string[] | undefined>, method?: string, url?: string }
      if (!fence(request)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/memory/api/') ? pathname.slice('/memory/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new MemoryApiError('not-found', 'unknown memory API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req as AsyncIterable<string | Uint8Array>)
        const handler = api[method]
        if (handler === undefined) {
          throw new MemoryApiError('not-found', `unknown memory API method "${method}"`, 404)
        }
        writeJson(res, 200, { ok: true, value: await handler(payload) })
      } catch (error) {
        writeError(res, error)
      }
    },
  }), '@max-null/dsh-memory: /memory/api routes')
}
