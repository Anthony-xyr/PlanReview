import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/update'
import { UpdateFailure } from './log'
import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, UpdaterService, updateMode, type UpdatePort } from './service'

const now = '2026-11-24T09:00:00.000Z'
const target = { version: '0.3.0', notes: '**新功能**' }

function fixture(port: UpdatePort | undefined, mode: UpdateState['mode'] = 'download', enabled = true) {
  const publish = vi.fn<(state: UpdateState) => void>()
  const log = vi.fn<(event: string) => void>()
  const prefs = { enabled: () => enabled, setEnabled: vi.fn(), lastCheckedAt: () => null, recordCheck: vi.fn() }
  const clock = { now: () => new Date(), after: (delay: number, fn: () => void) => {
    const timer = setTimeout(fn, delay)
    return () => clearTimeout(timer)
  } }
  const service = new UpdaterService({ currentVersion: '0.2.0', mode, port, publish, log, prefs, clock })
  const states = () => publish.mock.calls.map(([state]) => state.status)
  return { service, publish, log, prefs, states }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)) })
afterEach(() => { vi.useRealTimers() })

describe('更新器状态和交接', () => {
  it('Windows：检查、发现正式版、上报单调进度，只有校验完成后才能安装', async () => {
    const installNow = vi.fn()
    let complete!: () => void
    const download = vi.fn<NonNullable<UpdatePort['download']>>().mockImplementation((progress) => {
      for (const value of [NaN, -5, 17.8, 3, 52, Infinity]) progress(value)
      return new Promise<void>((resolve) => { complete = resolve })
    })
    const { service, publish, states, prefs } = fixture({ check: async () => target, download, installNow })
    expect(service.snapshot().status).toBe('idle')
    expect(() => service.installNow()).toThrow('没有已下载的更新。')
    const task = service.check('manual')
    await Promise.resolve() // 让检查先用当前时钟记录时间，再由 waitFor 推进计时。
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(service.snapshot()).toMatchObject({ status: 'downloading', percent: 52, lastCheckedAt: now,
      release: { version: '0.3.0', notes: '新功能' } })
    expect(service.readyVersion()).toBeNull()
    expect(() => service.installNow()).toThrow()
    complete()
    await task
    expect(states()).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloading', 'downloaded'])
    expect(publish.mock.calls.filter(([s]) => s.status === 'downloading').map(([s]) => s.percent)).toEqual([0, 17, 52])
    expect(prefs.recordCheck).toHaveBeenCalledExactlyOnceWith(now)
    expect(service.readyVersion()).toBe('0.3.0')
    service.installNow()
    await service.check('manual')
    expect(installNow).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it.each([null, { version: '0.2.0' }, { version: '0.1.99' }, { version: '1.0.0-beta.1' }, { version: 'latest' }])(
    '没有更高正式版时不下载：%j', async (release) => {
      const download = vi.fn()
      const { service, states } = fixture({ check: async () => release, download })
      await service.check('manual')
      expect(states()).toEqual(['checking', 'current'])
      expect(service.snapshot()).toMatchObject({ release: null, percent: null, error: null })
      expect(download).not.toHaveBeenCalled()
    }
  )

  it('未签名 Mac 仅提示合适的版本，不下载、不安装', async () => {
    const download = vi.fn()
    const { service, states } = fixture({ check: async () => ({ version: 'v0.3.0' }), download }, updateMode('darwin', true))
    await service.check('manual')
    expect(states()).toEqual(['checking', 'available'])
    expect(service.snapshot().release?.version).toBe('0.3.0')
    expect(download).not.toHaveBeenCalled()
    expect(service.readyVersion()).toBeNull()
    expect(() => service.installNow()).toThrow()
  })

  it.each([['win32', false, 'development'], ['darwin', false, 'development'], ['linux', true, 'unsupported-platform']] as const)(
    '%s（打包 %s）：不调度也不手动联网', async (platform, isPackaged, mode) => {
      expect(updateMode(platform, isPackaged)).toBe(mode)
      const check = vi.fn()
      const { service } = fixture({ check }, mode)
      expect(service.snapshot().status).toBe('unsupported')
      service.start()
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
      await service.check('manual')
      expect(check).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('检查失败可恢复；下载中断、超时与校验失败时不允许安装', async () => {
    const check = vi.fn<UpdatePort['check']>().mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED')).mockResolvedValue(target)
    const download = vi.fn<NonNullable<UpdatePort['download']>>()
      .mockRejectedValueOnce(new UpdateFailure('timeout')).mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockRejectedValueOnce(new Error('sha512 checksum mismatch')).mockResolvedValueOnce(undefined)
    const installNow = vi.fn()
    const { service } = fixture({ check, download, installNow })
    for (const message of ['连不上 GitHub', '连接超时', '下载中断', '校验失败']) {
      await service.check('manual')
      expect(service.snapshot().status).toBe('error')
      expect(service.snapshot().error).toContain(message)
      expect(service.readyVersion()).toBeNull()
      expect(() => service.installNow()).toThrow()
    }
    expect(installNow).not.toHaveBeenCalled()
    await service.check('manual')
    expect(service.snapshot()).toMatchObject({ status: 'downloaded', error: null })
  })
})

describe('更新定时调度', () => {
  it('启动 15 秒后首次检查，应用常驻时每 6 小时一次；释放时停止', async () => {
    expect(updateMode('win32', true)).toBe('download')
    expect(FIRST_CHECK_MS).toBe(15_000)
    expect(CHECK_INTERVAL_MS).toBe(21_600_000)
    const check = vi.fn().mockResolvedValue(null)
    const { service } = fixture({ check })
    service.start(); service.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    service.dispose()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(check).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('关闭开关不调度，重新打开才调度；手动检查不受影响', async () => {
    const check = vi.fn().mockResolvedValue(null)
    const { service, prefs } = fixture({ check }, 'download', false)
    service.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(check).not.toHaveBeenCalled()
    await service.check('manual')
    expect(check).toHaveBeenCalledTimes(1)
    service.setAutoCheck(true)
    expect(prefs.setEnabled).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(check).toHaveBeenCalledTimes(2)
    service.setAutoCheck(false)
    expect(prefs.setEnabled).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('自动失败只记录日志，不启动额外重试；下一轮按期调度', async () => {
    const check = vi.fn().mockRejectedValue(new UpdateFailure('network'))
    const { service, states, log } = fixture({ check })
    service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(states()).toEqual(['checking', 'idle'])
    expect(service.snapshot().error).toBeNull()
    expect(log).toHaveBeenCalledWith('automatic check failed network')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('关闭开关取消纯自动请求，紧接的手动检查用新请求恢复', async () => {
    const check = vi.fn<UpdatePort['check']>().mockImplementationOnce((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })).mockResolvedValueOnce(null)
    const { service, log } = fixture({ check })
    const auto = service.check('automatic')
    await Promise.resolve()
    service.setAutoCheck(false)
    const retry = service.check('manual')
    await Promise.all([auto, retry])
    expect(check).toHaveBeenCalledTimes(2)
    expect(check.mock.calls[0][0].aborted).toBe(true)
    expect(check.mock.calls[1][0].aborted).toBe(false)
    expect(log).toHaveBeenCalledWith('background update cancelled')
    expect(service.snapshot()).toMatchObject({ status: 'current', autoCheck: false })
  })

  it('开始前关闭开关完全不发请求；手动加入自动检查时只发一次且得到错误提示', async () => {
    const check = vi.fn().mockRejectedValue(new UpdateFailure('network'))
    const { service } = fixture({ check })
    const cancelled = service.check('automatic')
    service.setAutoCheck(false)
    await cancelled
    expect(check).not.toHaveBeenCalled()
    service.setAutoCheck(true)
    const automatic = service.check('automatic')
    const manual = service.check('manual')
    expect(manual).toBe(automatic)
    service.setAutoCheck(false)
    await manual
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0][0].aborted).toBe(false)
    expect(service.snapshot()).toMatchObject({ status: 'error', error: expect.stringContaining('连不上 GitHub') })
  })
})
