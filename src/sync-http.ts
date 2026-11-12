/**
 * 代理感知的 Git HTTP 客户端（2026-11-13）。
 *
 * **为什么需要它**：isomorphic-git 自带的 `http/node` 直接用 node 的 http/https 模块，
 * 而 node **不读** `HTTPS_PROXY`——在必须走代理才能访问 GitHub 的网络里，云端同步
 * 的每次 push / pull 都会超时。2026-11-13 实测（用户机器）：系统 git 配了
 * `http.proxy=127.0.0.1:7897` 能通，node 直连 GitHub 19 秒 `fetch failed`，
 * 插件的 push 报 `Request timed out`。
 *
 * 这里只在**配了代理**时替换掉请求实现；没配就继续用 isomorphic-git 自带的
 * node 实现（不重复造轮子，也不改变既有行为）。
 *
 * 代理来源优先级：`sync.proxy` 配置 > `HTTPS_PROXY` > `https_proxy` > `HTTP_PROXY` > `http_proxy`。
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { HttpClient, GitHttpRequest, GitHttpResponse } from 'isomorphic-git'

/**
 * 解析代理地址。
 * @param configured - `sync.proxy` 里填的值（可空）。
 * @param env - 环境变量来源（测试注入用）。
 * @returns 代理 URL；都没配时 `undefined`（表示直连）。
 */
export function resolveProxy(
  configured: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = [configured, env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/** 把 node 的响应流包成 isomorphic-git 要的异步可迭代。 */
async function* bodyOf(response: IncomingMessage): AsyncIterableIterator<Uint8Array> {
  for await (const chunk of response) yield new Uint8Array(chunk as Buffer)
}

/**
 * 走代理的 HttpClient。
 *
 * 只对 https 请求套 `HttpsProxyAgent`——git 远端几乎都是 https，http 远端保持直连
 * （要支持 http 远端过代理得再引 `HttpProxyAgent`，目前没有场景）。
 * @param proxyUrl - 形如 `http://127.0.0.1:7897` 的代理地址。
 */
export function createProxiedHttp(proxyUrl: string): HttpClient {
  const agent = new HttpsProxyAgent(proxyUrl)
  return {
    async request(options: GitHttpRequest): Promise<GitHttpResponse> {
      const url = new URL(options.url)
      const secure = url.protocol === 'https:'
      const base: RequestOptions = {
        hostname: url.hostname,
        ...url.port === '' ? {} : { port: Number(url.port) },
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers as Record<string, string>,
      }
      const request = secure ? httpsRequest({ ...base, agent }) : httpRequest(base)

      const finished = new Promise<void>((resolve, reject) => {
        request.on('error', reject)
        if (options.body === undefined) {
          request.end()
          resolve()
          return
        }
        void (async () => {
          try {
            for await (const chunk of options.body as AsyncIterable<Uint8Array>) request.write(Buffer.from(chunk))
            request.end()
            resolve()
          } catch (error) {
            reject(error)
          }
        })()
      })

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request.on('response', resolve)
        request.on('error', reject)
      })
      // 请求体写失败不影响读响应：有些服务端会提前回 4xx 并关闭写端。
      await finished.catch(() => undefined)

      return {
        url: options.url,
        method: options.method ?? 'GET',
        headers: response.headers as Record<string, string>,
        body: bodyOf(response),
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
      }
    },
  }
}
