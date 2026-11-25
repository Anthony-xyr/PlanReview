import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { RELEASES_URL, UPDATE_IPC, type UpdateState } from '@shared/update'
import { migrate } from '../db/schema'
import { snapshotBeforeUpdate } from './backup'
import { prepareUpdateExit } from './exit'
import { registerUpdateIpc } from './ipc'
import { updateErrorText, updaterLog } from './log'
import { UpdatePreferences } from './preferences'
import { releaseNotes } from './releaseNotes'
import { isNewerStable, stableVersion } from './version'

// 测试产生的临时数据库和日志也只在本工作树内，清理只删除创建的文件。
const scratch = () => mkdtempSync(join(process.cwd(), '.update-test-'))

it('SQLite：自动检查默认打开，开关和时间写入后重新连接仍可读', () => {
  const root = scratch()
  const file = join(root, 'fixture.db')
  let db = new DatabaseSync(file)
  try {
    migrate(db)
    const prefs = new UpdatePreferences(db)
    expect(prefs.enabled()).toBe(true)
    expect(prefs.lastCheckedAt()).toBeNull()
    prefs.setEnabled(false)
    prefs.recordCheck('2026-11-24T00:00:00.000Z')
    db.close()
    db = new DatabaseSync(file)
    const reopened = new UpdatePreferences(db)
    expect(reopened.enabled()).toBe(false)
    expect(reopened.lastCheckedAt()).toBe('2026-11-24T00:00:00.000Z')
    reopened.setEnabled(true)
    expect(new UpdatePreferences(db).enabled()).toBe(true)
  } finally {
    db.close()
    unlinkSync(file)
    rmdirSync(root)
  }
})

it('版本通知：只在显式更新重启且目标版本确实启动时播报一次', () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const prefs = new UpdatePreferences(db)
    expect(prefs.recordStartup('0.2.0')).toBeNull()
    prefs.expectRestart('0.3.0')
    expect(prefs.recordStartup('0.3.0')).toBe('0.3.0')
    expect(prefs.recordStartup('0.3.0')).toBeNull()
    prefs.expectRestart('0.4.0')
    expect(prefs.recordStartup('0.3.0')).toBeNull()
    expect(prefs.recordStartup('0.4.0')).toBeNull()
    expect(prefs.recordStartup('0.5.0')).toBeNull()
  } finally { db.close() }
})

it('SQLite 备份包含 WAL 中未回写数据，保留最新三份且不删其他文件', () => {
  const root = scratch()
  const directory = join(root, 'backups')
  const file = join(root, 'fixture.db')
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT); PRAGMA wal_checkpoint(TRUNCATE)')
    const insert = db.prepare('INSERT INTO entries VALUES (?, ?)')
    const files: string[] = []
    for (let i = 1; i <= 5; i++) {
      insert.run(i, `计时-${i}`)
      if (i === 1) {
        // 不使用 SQLite 连接读取基线文件，以免测试本身触发 WAL 恢复或写用户库。
        expect(readFileSync(file).includes(Buffer.from('计时-1'))).toBe(false)
        expect(readFileSync(`${file}-wal`).includes(Buffer.from('计时-1'))).toBe(true)
      }
      const current = snapshotBeforeUpdate(db, root, '0.3.0', new Date(Date.UTC(2026, 10, 24, 0, 0, i)))
      const copy = new DatabaseSync(current, { readOnly: true })
      try {
        expect(copy.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
        expect(copy.prepare('SELECT title FROM entries WHERE id = ?').get(i)).toMatchObject({ title: `计时-${i}` })
        expect(copy.prepare('SELECT COUNT(*) count FROM entries').get()).toMatchObject({ count: i })
      } finally { copy.close() }
      files.push(current)
      if (i === 1) writeFileSync(join(directory, 'readme.txt'), 'unrelated')
    }
    expect(readdirSync(directory).sort()).toEqual([...files.slice(-3).map((p) => p.split(/[\\/]/).at(-1)), 'readme.txt'].sort())
  } finally {
    db.close()
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name))
    rmdirSync(directory)
    unlinkSync(file)
    rmdirSync(root)
  }
})

it('安装前保存顺序：先合入已写入的计时，再备份；备份失败也不拦截退出', () => {
  const order: string[] = []
  const flush = () => { order.push('保存'); throw Error('checkpoint failure') }
  const snapshot = (version: string) => { order.push(`备份 ${version}`); throw Error('snapshot failure') }
  prepareUpdateExit('0.3.0', flush, snapshot, (event) => order.push(event))
  expect(order).toEqual(['保存', 'exit database checkpoint failed', '备份 0.3.0', 'before update database snapshot failed'])
  order.length = 0
  prepareUpdateExit(null, () => order.push('普通退出保存'), snapshot, (event) => order.push(event))
  expect(order).toEqual(['普通退出保存'])
})

it.each([
  [new Error('net::ERR_PROXY_CONNECTION_FAILED https://secret.example'), false, '连不上 GitHub'],
  [new Error('SSL net::ERR_CERT_AUTHORITY_INVALID'), false, '连不上 GitHub'],
  [new Error('socket hang up'), true, '下载中断'],
  [new Error('net::ERR_TIMED_OUT'), true, '连接超时'],
  [new Error('sha512 checksum mismatch'), true, '校验失败'],
  [new Error('404 Not Found'), false, '找不到可用的更新文件'],
  [new Error('private details not for display'), false, '暂时无法检查更新'],
  [null, true, '下载更新失败']
] as const)('失败提示只返回中文分类（%s）', (error, downloading, wanted) => {
  const text = updateErrorText(error, downloading)
  expect(text).toContain(wanted)
  expect(text).not.toMatch(/secret|ERR_|private details/)
})

it('更新日志仅留下固定事件，按大小轮转为最近两份', () => {
  const root = scratch()
  const folder = join(root, 'logs')
  const file = join(folder, 'updater.log')
  try {
    const log = updaterLog(root, 110)
    log('manual check started')
    log('https://example.test?token=hidden')
    log('download verified and ready')
    log('automatic check failed network')
    expect(readdirSync(folder).sort()).toEqual(['updater.log', 'updater.log.1'])
    expect(readFileSync(file, 'utf8')).toContain('automatic check failed network')
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('download verified and ready')
    for (const name of [file, `${file}.1`]) {
      expect(readFileSync(name).length).toBeLessThanOrEqual(110)
      expect(readFileSync(name, 'utf8')).not.toMatch(/hidden|token|http/)
    }
  } finally {
    unlinkSync(file)
    unlinkSync(`${file}.1`)
    rmdirSync(folder)
    rmdirSync(root)
  }
})

it('发布说明：解析 Markdown、HTML 与实体为文字，清除脚本、图片和各类链接地址', async () => {
  const raw = '# 更新\n\n- **课表** &amp; &lt;文字&gt;\n- [查看](https://example.test/secret)\n\n' +
    '<p onclick="BAD_ATTRIBUTE">新的说明</p><script>BAD_SCRIPT</script><style>BAD_CSS</style>' +
    '<img src="https://example.test/BAD_IMAGE"><iframe src="test">BAD_FRAME</iframe>\n\n' +
    '<span>无\u202e方向控制</span>'
  const result = await releaseNotes(raw)
  expect(result).toMatchObject({ notesTruncated: false })
  expect(result.notes).toContain('• 课表 & <文字>')
  expect(result.notes).toContain('• 查看')
  expect(result.notes).toContain('新的说明')
  expect(result.notes).toContain('无方向控制')
  expect(result.notes).not.toMatch(/BAD|https:\/\/|onclick|\*\*/)
})

it('发布说明：限制长度、不截断表情的代理对，空说明返回空文本', async () => {
  expect(await releaseNotes('   ')).toEqual({ notes: '', notesTruncated: false })
  expect(await releaseNotes('<script>bad</script>')).toEqual({ notes: '', notesTruncated: false })
  const result = await releaseNotes('😀'.repeat(2000))
  expect(result).toEqual({ notes: '😀'.repeat(1200) + '…', notesTruncated: true })
  expect((await releaseNotes(' '.repeat(33_000) + 'ending')).notesTruncated).toBe(true)
})

it('仅接受向前的稳定版本，允许同号预览版升级至正式版', () => {
  expect(stableVersion('v0.3.0+build.12')).toBe('0.3.0')
  for (const value of ['1.1', '01.1.1', '1.1.1-beta.2', '999999999999.0.0']) expect(stableVersion(value)).toBeNull()
  expect(isNewerStable('v0.3.0', '0.3.0-beta.1')).toBe(true)
  expect(isNewerStable('v0.2.99', '0.3.0-beta.1')).toBe(false)
  expect(isNewerStable('v1.0.0', '0.20.99')).toBe(true)
})

it('更新 IPC：只接受主窗口主帧、严格校验参数、仅打开固定发布页', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = { handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => { handlers.set(channel, handler) } }
  const main = { mainFrame: {} } as WebContents
  const ok = { sender: main, senderFrame: main.mainFrame } as IpcMainInvokeEvent
  const wrongWindow = { sender: {}, senderFrame: main.mainFrame } as IpcMainInvokeEvent
  const wrongFrame = { sender: main, senderFrame: {} } as IpcMainInvokeEvent
  const detachedFrame = { sender: main, senderFrame: null } as IpcMainInvokeEvent
  const actions = {
    state: vi.fn(() => ({ status: 'current' } as UpdateState)), check: vi.fn(async () => {}),
    setAutoCheck: vi.fn(), restart: vi.fn(async () => {}), openExternal: vi.fn(async () => {})
  }
  registerUpdateIpc(ipc, () => main, actions)
  const commands = [UPDATE_IPC.state, UPDATE_IPC.check, UPDATE_IPC.setAutoCheck, UPDATE_IPC.restart, UPDATE_IPC.openReleases]
  expect([...handlers.keys()].sort()).toEqual([...commands].sort())
  for (const command of commands) {
    for (const denied of [wrongWindow, wrongFrame, detachedFrame]) expect(() => handlers.get(command)!(denied)).toThrow('仅主窗口')
    expect(() => handlers.get(command)!(ok, 'https://example.test/untrusted')).toThrow()
  }
  for (const args of [[], [null], [1], [{ enabled: true }], [false, true]]) expect(() => handlers.get(UPDATE_IPC.setAutoCheck)!(ok, ...args)).toThrow()
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
  expect(handlers.get(UPDATE_IPC.state)!(ok)).toMatchObject({ status: 'current' })
  await handlers.get(UPDATE_IPC.check)!(ok)
  handlers.get(UPDATE_IPC.setAutoCheck)!(ok, false)
  await handlers.get(UPDATE_IPC.restart)!(ok)
  await handlers.get(UPDATE_IPC.openReleases)!(ok)
  expect(actions.check).toHaveBeenCalledTimes(1)
  expect(actions.restart).toHaveBeenCalledTimes(1)
  expect(actions.setAutoCheck).toHaveBeenCalledExactlyOnceWith(false)
  expect(actions.openExternal).toHaveBeenCalledExactlyOnceWith(RELEASES_URL)
})
