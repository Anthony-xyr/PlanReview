import { useEffect, useRef, useState } from 'react'
import type { UpdateRelease, UpdateSnapshot, UpdateState } from '@shared/update'
import { errorText } from '../ui'
import './SoftwareUpdate.css'

const UI_MEMORY = 'planreview.update.dismissals'

function visibilityKey(runId: string, key: string, dismiss = false): boolean {
  // 同一次应用运行中，新建主窗口或重新加载页面也记得“稍后”。新运行用新的 runId。
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_MEMORY) ?? 'null') as { runId: string; keys: string[] } | null
    const keys = parsed?.runId === runId && Array.isArray(parsed.keys) ? parsed.keys : []
    if (dismiss && !keys.includes(key)) localStorage.setItem(UI_MEMORY, JSON.stringify({ runId, keys: [...keys, key] }))
    return !keys.includes(key)
  } catch { return true }
}

export function useSoftwareUpdate() {
  const [state, setState] = useState<UpdateSnapshot | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const restartTrigger = useRef<HTMLButtonElement | null>(null)
  const requestRestart = (trigger: HTMLButtonElement) => {
    restartTrigger.current = trigger
    return window.api.update.restart()
  }
  useEffect(() => {
    let alive = true
    let received = false
    const off = window.api.update.onChanged((next) => { received = true; setState(next) })
    void window.api.update.state().then((next) => {
      if (alive && !received) setState(next)
    }).catch(() => { if (alive && !received) setReadError('暂时无法读取更新状态。') })
    return () => { alive = false; off() }
  }, [])
  return { state, readError, restartTrigger, requestRestart }
}

function statusText(state: UpdateState): string {
  switch (state.status) {
    case 'idle': return '尚未检查'
    case 'checking': return '检查中…'
    case 'current': return '已是最新版本'
    case 'available': return state.mode === 'download'
      ? `发现新版本 ${state.release?.version ?? ''}`
      : `有新版本 ${state.release?.version ?? ''}，前往下载。`
    case 'downloading': return `发现新版本 ${state.release?.version ?? ''}，下载中 ${state.percent ?? 0}%`
    case 'downloaded': return `已下载 ${state.release?.version ?? ''}，待安装`
    case 'error': return `检查失败：${state.error ?? '请稍后再试。'}`
    case 'unsupported': return state.mode === 'development' ? '开发版不支持自动更新' : '当前系统不支持自动更新'
  }
}

function useUpdateAction() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try { await action() } catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  return { error, busy, run }
}

function ReleaseDetails({ release, open }: { release: UpdateRelease; open: () => void }) {
  return (
    <details className="update-notes">
      <summary>更新说明</summary>
      {release.notes && <p>{release.notes}</p>}
      {(!release.notes || release.notesTruncated) && (
        <button type="button" className="link" onClick={open}>{release.notes ? '查看完整说明' : '详见发布页'}</button>
      )}
    </details>
  )
}

interface UpdateEntryProps {
  state: UpdateState | null
  onRestart: (trigger: HTMLButtonElement) => Promise<void>
}

export function SoftwareUpdateSettings({ state, readError, onRestart }: UpdateEntryProps & { readError: string | null }) {
  const { error, busy, run } = useUpdateAction()
  const open = () => { void run(() => window.api.update.openReleases()) }
  const unsupported = !state || state.status === 'unsupported'
  const checking = state?.status === 'checking' || state?.status === 'downloading'
  const progress = state?.status === 'downloading' ? state.percent ?? 0 : null
  return (
    <section className="software-update-settings" aria-labelledby="software-update-title">
      <h3 id="software-update-title">软件更新</h3>
      {state && <div className="update-version">当前版本 <strong>{state.currentVersion}</strong></div>}
      <label className="check">
        <input type="checkbox" checked={state?.autoCheck ?? true} disabled={unsupported || busy && !checking}
          onChange={(event) => {
            const enabled = event.currentTarget.checked
            void run(() => window.api.update.setAutoCheck(enabled))
          }} />
        自动检查更新
      </label>
      {!unsupported && <small className="muted">开关立即生效，不影响手动检查。</small>}
      <div className="update-actions">
        <button type="button" className="secondary" disabled={unsupported || busy || checking || state?.status === 'downloaded'}
          onClick={() => { void run(() => window.api.update.check()) }}>检查更新</button>
        {state?.status === 'downloaded' && <button type="button" disabled={busy} onClick={(event) => {
          const trigger = event.currentTarget
          void run(() => onRestart(trigger))
        }}>重启并更新</button>}
        {state?.status === 'available' && state.mode === 'check-only' && <button type="button" className="secondary" onClick={open}>前往下载</button>}
      </div>
      {state && <small className="muted">上次检查：{state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查'}</small>}
      <p className={`update-status${state?.status === 'error' ? ' hint-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        {state ? statusText(state) : readError ?? '正在读取更新状态…'}
      </p>
      {progress !== null && (
        <div className="update-progress">
          <progress aria-label="更新下载进度" max={100} value={progress} />
        </div>
      )}
      {state?.release && <ReleaseDetails release={state.release} open={open} />}
      {error && <p className="hint-error update-status" role="alert">{error}</p>}
    </section>
  )
}

export function SoftwareUpdateBanner({ state, onRestart }: UpdateEntryProps) {
  const { error, busy, run } = useUpdateAction()
  const [dismissed, setDismissed] = useState<string[]>([])
  if (!state) return null
  const release = state.status === 'downloaded' || state.status === 'available' && state.mode === 'check-only' ? state.release : null
  const key = release ? `ready-${release.version}` : state.installedVersion ? `installed-${state.installedVersion}` : null
  if (!key || dismissed.includes(key) || !visibilityKey(state.runId, key)) return null
  const dismiss = () => { visibilityKey(state.runId, key, true); setDismissed((keys) => [...keys, key]) }
  const open = () => { void run(() => window.api.update.openReleases()) }
  return (
    <section className="update-banner" aria-label="软件更新提示">
      <div className="update-banner-main">
        <div role="status" aria-live="polite">
          <strong>{!release ? `已更新到 ${state.installedVersion}` : state.mode === 'download'
            ? `更新 ${release.version} 已下载` : `有新版本 ${release.version}`}</strong>
          {release && state.mode === 'download' && <small>也可在下次正常退出时安装。</small>}
        </div>
        <div className="update-actions">
          {release && (state.mode === 'download' ? <>
            <button type="button" disabled={busy} onClick={(event) => {
              const trigger = event.currentTarget
              void run(() => onRestart(trigger))
            }}>重启并更新</button>
            <button type="button" className="secondary" onClick={dismiss}>稍后</button>
          </> : <button type="button" className="secondary" onClick={open}>前往下载</button>)}
          <button type="button" className="secondary update-dismiss" aria-label="关闭软件更新提示" onClick={dismiss}>×</button>
        </div>
      </div>
      {release && <ReleaseDetails release={release} open={open} />}
      {error && <p className="hint-error update-status" role="alert">{error}</p>}
    </section>
  )
}
