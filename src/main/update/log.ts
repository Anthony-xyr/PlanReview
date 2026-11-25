import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class UpdateFailure extends Error {
  constructor(readonly reason: 'network' | 'timeout' | 'integrity' | 'interrupted' | 'metadata' | 'unknown') {
    super(reason)
  }
}

type Reason = UpdateFailure['reason']
export function updateFailure(error: unknown, downloading: boolean): Reason {
  if (error instanceof UpdateFailure) return error.reason
  const details = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; statusCode?: unknown } : null
  const text = `${details?.code ?? ''} ${details?.message ?? (typeof error === 'string' ? error : '')}`
  if (/sha.?512|checksum|signature|digest|hash.*(mismatch|match)|ERR_UPDATER_INVALID_SIGNATURE/i.test(text)) return 'integrity'
  if (/timeout|timed?[ _-]?out|ETIMEDOUT/i.test(text) || details?.statusCode === 408 || details?.statusCode === 504) return 'timeout'
  if (/interrupt|aborted|cancel|ERR_CONTENT_LENGTH_MISMATCH|premature close/i.test(text)) return downloading ? 'interrupted' : 'network'
  if (downloading && /ERR_(CONNECTION_(RESET|CLOSED)|EMPTY_RESPONSE)|ECONNRESET|socket hang up/i.test(text)) return 'interrupted'
  if (/ENOTFOUND|EAI_AGAIN|ERR_(INTERNET|NAME_NOT_RESOLVED|CONNECTION|PROXY|TUNNEL|CERT|NETWORK)|ECONN|EHOST|ENET|fetch failed|socket hang up/i.test(text) ||
      [401, 403, 429, 500, 502, 503].includes(Number(details?.statusCode))) return 'network'
  if (/ERR_UPDATER_(CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND|INVALID_UPDATE_INFO)|404 Not Found|No published versions/i.test(text) || details?.statusCode === 404) return 'metadata'
  return 'unknown'
}

export function updateErrorText(error: unknown, downloading: boolean): string {
  switch (updateFailure(error, downloading)) {
    case 'network': return '连不上 GitHub，请检查网络或代理后再试。'
    case 'timeout': return '连接超时，请检查网络后再试。'
    case 'integrity': return '下载文件校验失败，未安装。请重新检查更新。'
    case 'interrupted': return '下载中断，未安装。请检查网络后再试。'
    case 'metadata': return 'GitHub 上暂时找不到可用的更新文件，请稍后再试或查看发布页。'
    default: return downloading ? '下载更新失败，未安装。请稍后再试。' : '暂时无法检查更新，请稍后再试。'
  }
}

/** 只写应用控制的事件和错误分类；上游日志可能含请求头、签名 URL 等，绝不落盘。 */
export function updaterLog(userData: string, maxBytes = 128 * 1024): (event: string) => void {
  const file = join(userData, 'logs', 'updater.log')
  return (event) => {
    if (!/^[a-z][a-z0-9 -]{0,150}$/i.test(event)) return
    try {
      const line = `${new Date().toISOString()} ${event}\n`
      mkdirSync(dirname(file), { recursive: true })
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > maxBytes) {
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line, 'utf8')
    } catch { /* 日志不能阻止应用使用或退出 */ }
  }
}
