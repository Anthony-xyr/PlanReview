import { useCallback, useEffect, useState } from 'react'
import type { Category, Settings, StartTimerInput, Task, TimeEntry } from '@shared/types'
import { dayOf } from '@shared/time'
import { SoftwareUpdateBanner, useSoftwareUpdate } from './components/SoftwareUpdate'
import { TimerBar } from './components/Timer'
import { ReminderCard } from './components/ReminderCard'
import { errorText, type Mutate } from './ui'
import { reminderActions, useReminder } from './reminderActions'
import { DialogHost } from './app/DialogHost'
import { resolveCommandAction, type ActiveDialog, type ToolActionId, type View } from './app/navigation'
import { Sidebar } from './app/Sidebar'
import { ViewHost } from './app/ViewHost'
import { WindowBackground } from './components/WindowBackground'

export type { View } from './app/navigation'

export function App() {
  const [view, setView] = useState<View>({ kind: 'today' })
  const [dialog, setDialog] = useState<ActiveDialog | null>(null)
  const [version, setVersion] = useState(0)
  const [categories, setCategories] = useState<Category[]>([])
  const [inboxCount, setInboxCount] = useState(0)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [backgroundImage, setBackgroundImage] = useState<string | null>()
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [runningTask, setRunningTask] = useState<Task | null>(null)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const reminder = useReminder()
  const softwareUpdate = useSoftwareUpdate()

  const showToast = useCallback((text: string, error?: boolean) => {
    setToast({ text, error })
  }, [])

  // Show a toast message and refresh active views.
  const notify = useCallback((text: string, error?: boolean) => {
    setToast({ text, error })
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    ;(async () => {
      const [c, inbox, s, r] = await Promise.all([
        window.api.categories.list(),
        window.api.tasks.list({ status: 'inbox' }),
        window.api.settings.get(),
        window.api.entries.running()
      ])
      setCategories(c)
      setInboxCount(inbox.length)
      setSettings(s)
      setRunning(r)
      setRunningTask(r?.taskId ? await window.api.tasks.get(r.taskId) : null)
    })().catch((e) => setToast({ text: errorText(e), error: true }))
  }, [version])

  // 只有在主窗口要显示图片或打开外观设置时，才读取已保存的背景。
  const needsBackgroundImage = settings?.backgroundMode === 'custom' || dialog?.kind === 'settings'
  useEffect(() => {
    if (!needsBackgroundImage || backgroundImage !== undefined) return
    let active = true
    window.api.settings.getBackgroundImage().then((image) => {
      if (active) setBackgroundImage((current) => current === undefined ? image : current)
    }).catch((e) => {
      if (active) setToast({ text: errorText(e), error: true })
    })
    return () => { active = false }
  }, [needsBackgroundImage, backgroundImage])

  // Subscribe to cross-window data updates and tray/float commands.
  useEffect(() => {
    const offData = window.api.events.onDataChanged(() => setVersion((v) => v + 1))
    const offCmd = window.api.events.onCommand((cmd) => {
      if (cmd === 'review') {
        void window.api.settings.get().then((s) => {
          const effect = resolveCommandAction(cmd, s.dayStartHour)
          if (effect.type === 'dialog') setDialog(effect.dialog)
        })
        return
      }
      const effect = resolveCommandAction(cmd, 0)
      if (effect.type === 'dialog') setDialog(effect.dialog)
      else setView(effect.view)
    })
    return () => {
      offData()
      offCmd()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  const mutate: Mutate = useCallback(async (fn) => {
    try {
      const result = await fn()
      setVersion((v) => v + 1)
      return result
    } catch (e) {
      setToast({ text: errorText(e), error: true })
      setVersion((v) => v + 1)
      return undefined
    }
  }, [])

  const startTimer = (input: StartTimerInput) => mutate(() => window.api.entries.start(input))

  if (!settings) return null
  const isCustomTitleBar = window.api.win.platform === 'win32'

  const handleToolAction = (action: ToolActionId) => {
    switch (action) {
      case 'review':
        setDialog({ kind: 'review', day: dayOf(new Date(), settings.dayStartHour) })
        break
      case 'wrap-up':
        setDialog({ kind: 'wrap-up' })
        break
      case 'insights':
        setDialog({ kind: 'insights' })
        break
      case 'import':
        setDialog({ kind: 'import' })
        break
      case 'float':
        void window.api.win.showFloat()
        break
      case 'settings':
        setDialog({ kind: 'settings' })
        break
    }
  }

  const showWallpaper = settings.backgroundMode === 'custom' && !!backgroundImage && settings.backgroundOpacity > 0
  const showBackground = settings.backgroundMode === 'time' || showWallpaper
  return (
    <div className={`app${isCustomTitleBar ? ' has-titlebar' : ''}${showBackground ? ' has-background' : ''}${showWallpaper ? ' has-wallpaper' : ''}`}>
      <WindowBackground mode={settings.backgroundMode} fit={settings.backgroundFit} opacity={settings.backgroundOpacity} image={backgroundImage} />
      {isCustomTitleBar && (
        <div className="window-titlebar">
          <div className="window-titlebar-left">
            <span className="brand">计划与复盘</span>
          </div>
          <div className="window-titlebar-drag" />
        </div>
      )}

      <Sidebar
        view={view}
        categories={categories}
        inboxCount={inboxCount}
        showBrand={!isCustomTitleBar}
        onSelectView={setView}
        onToolAction={handleToolAction}
      />

      <div className="content">
        <SoftwareUpdateBanner state={softwareUpdate.state} onRestart={softwareUpdate.requestRestart} />
        {running && (
          <TimerBar
            running={running}
            onStop={() => setDialog({ kind: 'stop' })}
            onExtend={() => setDialog({ kind: 'extend' })}
          />
        )}
        {reminder && (
          <div className="reminder-host">
            <ReminderCard
              reminder={reminder}
              {...reminderActions(reminder, mutate, {
                onStop: () => setDialog({ kind: 'stop' }),
                onWrapUp: () => setDialog({ kind: 'wrap-up' })
              })}
            />
          </div>
        )}
        <ViewHost
          view={view}
          settings={settings}
          categories={categories}
          version={version}
          running={running}
          mutate={mutate}
          notify={notify}
          onStartTimer={startTimer}
          onSelectView={setView}
          onOpenDialog={setDialog}
        />
      </div>

      {toast && (
        <div className={`toast ${toast.error ? 'is-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.text}
        </div>
      )}

      <DialogHost
        backgroundImage={backgroundImage}
        onThemeChange={async (theme) => setSettings(await window.api.settings.update({ theme }))}
        onSaveSettings={async (patch, image) => {
          const saved = await window.api.settings.update(patch, image)
          setSettings(saved)
          if (image !== undefined) setBackgroundImage(image)
          setVersion((v) => v + 1)
        }}
        dialog={dialog}
        settings={settings}
        categories={categories}
        running={running}
        runningTask={runningTask}
        softwareUpdate={softwareUpdate}
        mutate={mutate}
        notify={notify}
        showToast={showToast}
        onChangeDialog={setDialog}
        onSelectView={setView}
      />
    </div>
  )
}
