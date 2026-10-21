import { useEffect, useState } from 'react'
import type { Settings, SystemStatus } from '@shared/types'
import { Dialog } from '../ui'
import { AiSettings } from './AiSettings'

interface Props {
  settings: Settings
  onSave: (patch: Partial<Settings>) => void
  onClose: () => void
}

/** 把键盘事件转成 Electron 快捷键写法，如 Alt+Shift+Space */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
  if (!mods.length) return null
  const name = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
  return [...mods, name].join('+')
}

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [form, setForm] = useState(settings)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }))
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never)

  useEffect(() => {
    window.api.win.status().then(setStatus)
  }, [settings])

  return (
    <Dialog title="设置" onClose={onClose}>
      <form
        className="settings"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(form)
        }}
      >
        <section>
          <h3>一天与睡眠</h3>
          <label className="field">
            <span>一天从几点开始算</span>
            <select value={form.dayStartHour} onChange={(e) => set('dayStartHour', Number(e.target.value))}>
              {Array.from({ length: 13 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
            <small className="muted">在这之前的时间算作前一天。比如设为 5 点，凌晨 1 点回宿舍仍算今天。</small>
          </label>
          <div className="field-row">
            <label className="field">
              <span>睡眠窗口开始</span>
              <input type="time" required value={form.sleepStart} onChange={(e) => set('sleepStart', e.target.value)} />
            </label>
            <label className="field">
              <span>睡眠窗口结束</span>
              <input type="time" required value={form.sleepEnd} onChange={(e) => set('sleepEnd', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>睡前多少分钟开始强提醒</span>
            <input type="number" min={0} max={180} value={form.sleepLeadMin} onChange={num('sleepLeadMin')} />
            <small className="muted">设为 0 则只在进入睡眠窗口时提醒。强提醒在全屏时也会弹出。</small>
          </label>
        </section>

        <section>
          <h3>本次投入</h3>
          <div className="field-row">
            <label className="field">
              <span>直接开始计时的默认时长（分钟）</span>
              <input
                type="number"
                min={5}
                max={600}
                placeholder="不设"
                value={form.defaultSessionMin ?? ''}
                onChange={(e) => set('defaultSessionMin', e.target.value ? Number(e.target.value) : null)}
              />
            </label>
            <label className="field">
              <span>每次延长（分钟）</span>
              <input type="number" min={5} max={120} value={form.extendStepMin} onChange={num('extendStepMin')} />
            </label>
          </div>
          <small className="muted">从计划块开始计时时，本次时长就是这个计划块剩下的时间。</small>
          <label className="field">
            <span>超出本次多少时询问原因</span>
            <select value={form.overrunAskRatio} onChange={(e) => set('overrunAskRatio', Number(e.target.value))}>
              {[0.1, 0.2, 0.3, 0.5, 1].map((r) => (
                <option key={r} value={r}>
                  {Math.round(r * 100)}%
                </option>
              ))}
            </select>
          </label>
        </section>

        <section>
          <h3>提醒</h3>
          <label className="check">
            <input type="checkbox" checked={form.leaveEnabled} onChange={(e) => set('leaveEnabled', e.target.checked)} />
            提醒离开自习室
          </label>
          {form.leaveEnabled && (
            <div className="field-row">
              <label className="field">
                <span>离开时间</span>
                <input type="time" required value={form.leaveTime} onChange={(e) => set('leaveTime', e.target.value)} />
              </label>
              <label className="field">
                <span>提前几分钟</span>
                <input type="number" min={0} max={120} value={form.leaveLeadMin} onChange={num('leaveLeadMin')} />
              </label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={form.blockReminders} onChange={(e) => set('blockReminders', e.target.checked)} />
            计划开始时、保留时段（如娱乐）结束时提醒
          </label>
          <label className="check">
            <input type="checkbox" checked={form.strongSound} onChange={(e) => set('strongSound', e.target.checked)} />
            强提醒播放提示音
          </label>
        </section>

        <section>
          <h3>找回与整理</h3>
          <label className="field">
            <span>每天随机翻出几条没排期的事</span>
            <select value={form.dailyPicks} onChange={(e) => set('dailyPicks', Number(e.target.value))}>
              <option value={0}>不推送</option>
              <option value={1}>1 条</option>
              <option value={2}>2 条</option>
              <option value={3}>3 条</option>
            </select>
            <small className="muted">只从没截止、没设下次查看日、也没排进计划的事里抽，越久没碰越容易抽到。</small>
          </label>
          <div className="field-row">
            <label className="field">
              <span>收件箱多少条时提示整理</span>
              <input type="number" min={1} max={200} value={form.inboxNagCount} onChange={num('inboxNagCount')} />
            </label>
            <label className="field">
              <span>或最早一条放了几天</span>
              <input type="number" min={1} max={90} value={form.inboxNagDays} onChange={num('inboxNagDays')} />
            </label>
          </div>
          <label className="field">
            <span>每周整理日</span>
            <select value={form.weeklyReviewDay} onChange={(e) => set('weeklyReviewDay', Number(e.target.value))}>
              {'日一二三四五六'.split('').map((d, i) => (
                <option key={i} value={i}>
                  周{d}
                </option>
              ))}
            </select>
            <small className="muted">这天只要收件箱不空，就会在「今天」页提示整理。</small>
          </label>
        </section>

        <section>
          <h3>悬浮窗与快捷键</h3>
          <label className="check">
            <input type="checkbox" checked={form.floatingEnabled} onChange={(e) => set('floatingEnabled', e.target.checked)} />
            显示悬浮窗
          </label>
          <label className="check">
            <input type="checkbox" checked={form.hideInFullscreen} onChange={(e) => set('hideInFullscreen', e.target.checked)} />
            全屏游戏或视频时自动隐藏
            {status && !status.fullscreenDetection && <span className="hint-error">（这台电脑上检测不到全屏状态）</span>}
          </label>
          <label className="field">
            <span>速记快捷键</span>
            <input
              readOnly
              value={recording ? '按下新的组合键…' : form.hotkey}
              onFocus={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') return
                e.preventDefault()
                if (e.key === 'Escape') return e.currentTarget.blur()
                const acc = toAccelerator(e)
                if (acc) {
                  set('hotkey', acc)
                  e.currentTarget.blur()
                }
              }}
            />
            <small className="muted">点进输入框后按下组合键（需要带 Ctrl / Alt / Shift）。</small>
            {status && !status.hotkeyRegistered && form.hotkey === settings.hotkey && (
              <small className="hint-error">「{settings.hotkey}」被其他程序占用了，换一个试试。</small>
            )}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.closeToTray} onChange={(e) => set('closeToTray', e.target.checked)} />
            关闭主窗口时缩到托盘（提醒继续工作）
          </label>
          <label className="check">
            <input type="checkbox" checked={form.launchAtLogin} onChange={(e) => set('launchAtLogin', e.target.checked)} />
            开机自动启动（打包安装后生效）
          </label>
        </section>

        <div className="dialog-actions sticky">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit">保存</button>
        </div>
      </form>
      <AiSettings />
    </Dialog>
  )
}
