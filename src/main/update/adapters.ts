import { net } from 'electron'
import type { NsisUpdater, ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { UpdateFailure, updateFailure } from './log'
import type { UpdatePort } from './service'

const LATEST_RELEASE_API = 'https://api.github.com/repos/Anthony-xyr/PlanReview/releases/latest'
const CHECK_LIMIT_MS = 30_000
const DOWNLOAD_IDLE_MS = 60_000

// Electron 的 ClientRequest 不提供 Node HTTP 的 socket 超时事件。用更新器自己的网络会话
// 终止挂住的连接，避免一次没响应的检查占住以后所有检查。不要碰主界面的网络会话。
async function bounded<T>(updater: NsisUpdater, signal: AbortSignal, ms: number,
  task: (touch: () => void) => Promise<T>, cancelDownload?: () => void): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout>
  let onAbort: () => void
  let refresh: () => void = () => {}
  let closing: Promise<void> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    const stop = (error: unknown) => {
      reject(error)
      cancelDownload?.()
      closing = Promise.resolve().then(() => updater.netSession.closeAllConnections()).catch(() => {})
    }
    onAbort = () => stop(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    refresh = () => { clearTimeout(timer); timer = setTimeout(() => stop(new UpdateFailure('timeout')), ms) }
    refresh()
  })
  // Promise.race 同时消费被取消的下载可能迟到的拒绝。
  try { return await Promise.race([deadline, task(refresh)]) }
  finally {
    clearTimeout(timer!)
    signal.removeEventListener('abort', onAbort!)
    await closing
  }
}

export function hasInstallerChecksum(info: UpdateInfo): boolean {
  return info.files?.length === 1 && /^[A-Za-z0-9_.-]+\.exe$/i.test(info.files[0].url) &&
    /^[A-Za-z0-9+/]{86}==$/.test(info.files[0].sha512)
}

/** 用打包的 app-update.yml（由正式构建的固定 GitHub 配置生成）。不接收地址或参数。 */
export function windowsUpdater(log: (event: string) => void, create = async () => {
  const { NsisUpdater } = await import('electron-updater')
  return new NsisUpdater()
}): UpdatePort {
  // 等首次检查再加载更新库，主窗创建和开发环境都不受影响。
  const load = async () => {
    const updater = await create()
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.autoDownload = false // 由服务层开始下载，明确区分状态和错误。
    updater.autoInstallOnAppQuit = false // 只在文件校验完成时开启。
    updater.disableWebInstaller = true
    updater.logger = {
      info(message) {
        // 上游会记录下载 URL 和完整路径，只保留已知的无敏感信息事件。
        const line = typeof message === 'string' ? message : ''
        if (line === 'Install on explicit quitAndInstall') log('nsis explicit update requested')
        else if (line === 'Auto install update on quit') log('nsis automatic install on exit')
        else if (line === 'Install: isSilent: true, isForceRunAfter: true') log('nsis silent installation and restart')
        else if (line === 'Install: isSilent: true, isForceRunAfter: false') log('nsis silent installation without restart')
        else if (line.startsWith('Cannot run installer:')) log('nsis could not run installer directly')
      },
      warn() { log('updater warning') },
      error() { log('updater error') }
    }
    // 监听 error，防止安装器异步启动失败成为未处理异常。Promise 错误仍由服务层处理。
    updater.on('error', (error) => log(`updater reported ${updateFailure(error, false)}`))
    return updater
  }
  let instance: ReturnType<typeof load> | undefined
  let staged: Awaited<ReturnType<typeof load>> | undefined
  let pending: UpdateCheckResult | undefined
  const getUpdater = () => (instance ??= load().catch((error) => { instance = undefined; throw error }))
  const discardCancelled = (signal: AbortSignal, error: unknown) => {
    // 上游会缓存未完成的 Promise。连接关闭后新建客户端，手动重试不等挂起的上一次。
    if (signal.aborted || error instanceof UpdateFailure && error.reason === 'timeout') instance = undefined
  }
  return {
    async check(signal) {
      const updater = await getUpdater()
      pending = undefined
      let result: UpdateCheckResult | null
      try { result = await bounded(updater, signal, CHECK_LIMIT_MS, () => updater.checkForUpdates()) }
      catch (error) { discardCancelled(signal, error); throw error }
      if (!result?.isUpdateAvailable) return null
      const info = result.updateInfo
      if (!hasInstallerChecksum(info)) throw new UpdateFailure('integrity')
      pending = result
      return { version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null }
    },
    async download(progress, signal) {
      const updater = await getUpdater()
      const token = pending?.cancellationToken
      if (!token) throw new UpdateFailure('metadata')
      pending = undefined
      staged = undefined
      updater.autoInstallOnAppQuit = false
      let verified = false
      let touch = () => {}
      const onProgress = (info: ProgressInfo) => { touch(); progress(info.percent) }
      const onDownloaded = () => {
        if (signal.aborted || token.cancelled) return
        verified = true
        // NSIS 在通知完成后立即注册 quit 监听。必须在这一刻打开，而不是早于校验。
        updater.autoInstallOnAppQuit = true
      }
      updater.on('download-progress', onProgress)
      updater.once('update-downloaded', onDownloaded)
      try {
        await bounded(updater, signal, DOWNLOAD_IDLE_MS, (refresh) => {
          touch = refresh
          return updater.downloadUpdate(token)
        }, () => token.cancel())
        if (!verified) throw new UpdateFailure('integrity')
        staged = updater
      } catch (error) {
        updater.autoInstallOnAppQuit = false
        discardCancelled(signal, error)
        throw error
      } finally {
        updater.removeListener('download-progress', onProgress)
        updater.removeListener('update-downloaded', onDownloaded)
      }
    },
    installNow() {
      if (!staged) throw new Error('没有已校验的安装包。')
      const updater = staged
      let failed = false
      const onError = () => { failed = true }
      updater.on('error', onError)
      try { updater.quitAndInstall(true, true) } finally { updater.removeListener('error', onError) }
      if (failed) throw new Error('无法启动更新安装程序，请稍后再试。')
    }
  }
}

/** 未签名的 Mac 只查询正式 Release，不使用对 ZIP 有依赖的 MacUpdater。 */
export function macReleaseChecker(fetchRelease: typeof net.fetch = (url, options) => net.fetch(url, options)): UpdatePort {
  return {
    async check(cancel) {
      const timeout = AbortSignal.timeout(CHECK_LIMIT_MS)
      const signal = AbortSignal.any([cancel, timeout])
      try {
        const response = await fetchRelease(LATEST_RELEASE_API, {
          signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/vnd.github+json' }
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          if (response.status === 404) throw new UpdateFailure('metadata')
          if (response.status === 408 || response.status === 504) throw new UpdateFailure('timeout')
          throw new UpdateFailure('network')
        }
        const info: unknown = await response.json()
        if (!info || typeof info !== 'object' || !('tag_name' in info) || typeof info.tag_name !== 'string') {
          throw new UpdateFailure('metadata')
        }
        if (('draft' in info && info.draft) || ('prerelease' in info && info.prerelease)) return null
        return { version: info.tag_name, notes: 'body' in info && typeof info.body === 'string' ? info.body : null }
      } catch (error) {
        if (timeout.aborted) throw new UpdateFailure('timeout')
        throw error
      }
    }
  }
}
