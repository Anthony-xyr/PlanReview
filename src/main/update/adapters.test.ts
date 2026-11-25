import { EventEmitter } from 'node:events'
import type { NsisUpdater, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { afterEach, expect, it, vi } from 'vitest'
import { hasInstallerChecksum, macReleaseChecker, windowsUpdater } from './adapters'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
afterEach(() => vi.useRealTimers())

const checksum = Buffer.alloc(64).toString('base64')
const installer = { url: 'PlanReview-Setup-0.3.0.exe', sha512: checksum }
const versionInfo: UpdateInfo = { version: '0.3.0', files: [installer], path: installer.url, sha512: checksum, releaseDate: '2026-11-24' }

function backend() {
  const token = { cancelled: false, cancel() { this.cancelled = true } }
  const updater = Object.assign(new EventEmitter(), {
    netSession: { closeAllConnections: vi.fn().mockResolvedValue(undefined) },
    checkForUpdates: vi.fn<() => Promise<UpdateCheckResult | null>>().mockResolvedValue({
      isUpdateAvailable: true, updateInfo: versionInfo, cancellationToken: token
    } as unknown as UpdateCheckResult),
    downloadUpdate: vi.fn<() => Promise<string[]>>(),
    quitAndInstall: vi.fn(),
    autoInstallOnAppQuit: true, autoDownload: true, allowPrerelease: true, allowDowngrade: true, disableWebInstaller: false
  })
  return { updater, token, api: updater as unknown as NsisUpdater }
}

it('Windows：缺失、非 SHA-512 或非独立安装包名称的元数据一律拒绝', () => {
  expect(hasInstallerChecksum(versionInfo)).toBe(true)
  for (const files of [[], [installer, installer], [{ ...installer, sha512: '' }], [{ ...installer, url: '../bad.exe' }],
    [{ ...installer, url: 'https://elsewhere.test/app.exe' }], [{ ...installer, url: 'contains space.exe' }]]) {
    expect(hasInstallerChecksum({ ...versionInfo, files })).toBe(false)
  }
})

it('Windows：下载库确认完整性前不允许自动安装，下载后才可静默重启安装', async () => {
  const { updater, api } = backend()
  const port = windowsUpdater(vi.fn(), async () => api)
  const signal = new AbortController().signal
  await expect(port.check(signal)).resolves.toMatchObject({ version: '0.3.0' })
  expect(updater).toMatchObject({ autoInstallOnAppQuit: false, autoDownload: false, allowPrerelease: false,
    allowDowngrade: false, disableWebInstaller: true })
  expect(() => port.installNow?.()).toThrow()
  updater.downloadUpdate.mockImplementationOnce(async () => {
    expect(updater.autoInstallOnAppQuit).toBe(false)
    updater.emit('download-progress', { percent: 30 })
    updater.emit('update-downloaded')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    return ['fixture.exe']
  })
  const progress = vi.fn()
  await port.download?.(progress, signal)
  expect(progress).toHaveBeenCalledExactlyOnceWith(30)
  expect(updater.listenerCount('download-progress')).toBe(0)
  expect(updater.listenerCount('update-downloaded')).toBe(0)
  port.installNow?.()
  expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  updater.quitAndInstall.mockImplementationOnce(() => { updater.emit('error', new Error('launch failed')) })
  expect(() => port.installNow?.()).toThrow('无法启动更新安装程序')
})

it('Windows：返回文件没有通过完成校验事件时拒绝，校验失败后监听器释放', async () => {
  const { updater, api } = backend()
  const port = windowsUpdater(vi.fn(), async () => api)
  const signal = new AbortController().signal
  await port.check(signal)
  updater.downloadUpdate.mockResolvedValueOnce(['unverified.exe'])
  await expect(port.download?.(vi.fn(), signal)).rejects.toMatchObject({ reason: 'integrity' })
  expect(updater.autoInstallOnAppQuit).toBe(false)
  expect(updater.listenerCount('update-downloaded')).toBe(0)
  expect(updater.listenerCount('download-progress')).toBe(0)
  expect(() => port.installNow?.()).toThrow()
  await port.check(signal)
  updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'))
  await expect(port.download?.(vi.fn(), signal)).rejects.toThrow('sha512')
  expect(updater.autoInstallOnAppQuit).toBe(false)
})

it('Windows：30 秒无响应后关闭连接；即使旧请求悬挂，下一次检查也能恢复', async () => {
  vi.useFakeTimers()
  const old = backend()
  old.updater.checkForUpdates.mockImplementationOnce(() => new Promise(() => {}))
  const next = backend()
  const create = vi.fn<() => Promise<NsisUpdater>>().mockResolvedValueOnce(old.api).mockResolvedValueOnce(next.api)
  const port = windowsUpdater(vi.fn(), create)
  const signal = new AbortController().signal
  const check = port.check(signal)
  const failure = expect(check).rejects.toMatchObject({ reason: 'timeout' })
  await vi.advanceTimersByTimeAsync(30_000)
  await failure
  expect(old.updater.netSession.closeAllConnections).toHaveBeenCalledTimes(1)
  await expect(port.check(signal)).resolves.toMatchObject({ version: '0.3.0' })
  expect(create).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('Windows：下载持续有进度则续期；取消时停请求并忽略迟到完成事件', async () => {
  vi.useFakeTimers()
  const { updater, token, api } = backend()
  updater.downloadUpdate.mockImplementation(() => new Promise(() => {}))
  const port = windowsUpdater(vi.fn(), async () => api)
  const controller = new AbortController()
  await port.check(controller.signal)
  const progress = vi.fn()
  const operation = port.download!(progress, controller.signal)
  const cancelled = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(59_000)
  updater.emit('download-progress', { percent: 30 })
  await vi.advanceTimersByTimeAsync(59_000)
  expect(progress).toHaveBeenCalledExactlyOnceWith(30)
  expect(token.cancelled).toBe(false)
  controller.abort()
  updater.emit('update-downloaded')
  await cancelled
  expect(token.cancelled).toBe(true)
  expect(updater.autoInstallOnAppQuit).toBe(false)
  expect(updater.netSession.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('Mac：只请求固定 GitHub 地址，不带凭据，不跟随重定向；读正式版正文', async () => {
  const handler = vi.fn<typeof import('electron').net.fetch>().mockResolvedValueOnce(Response.json({ tag_name: 'v0.3.0', body: '文本' }))
  const port = macReleaseChecker(handler)
  await expect(port.check(new AbortController().signal)).resolves.toEqual({ version: 'v0.3.0', notes: '文本' })
  expect(handler).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/Anthony-xyr/PlanReview/releases/latest',
    expect.objectContaining({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }))
  expect(port.download).toBeUndefined()
  expect(port.installNow).toBeUndefined()
})

it('Mac：预发布不提示；无资源、超时和限流时有明确错误分类', async () => {
  const handler = vi.fn<typeof import('electron').net.fetch>().mockResolvedValueOnce(Response.json({ tag_name: 'v1.0.0', prerelease: true }))
    .mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 504 }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
  const port = macReleaseChecker(handler)
  const signal = new AbortController().signal
  await expect(port.check(signal)).resolves.toBeNull()
  for (const reason of ['metadata', 'timeout', 'network']) await expect(port.check(signal)).rejects.toMatchObject({ reason })
})
