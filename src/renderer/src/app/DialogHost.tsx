import type { Category, Settings, Task, TimeEntry } from '@shared/types'
import { dayOf } from '@shared/time'
import { DailyReviewDialog } from '../components/DailyReviewDialog'
import { ImportDialog } from '../components/ImportDialog'
import { InsightsDialog } from '../components/InsightsDialog'
import { PlannerDialog } from '../components/PlannerDialog'
import { SettingsDialog } from '../components/SettingsDialog'
import type { useSoftwareUpdate } from '../components/SoftwareUpdate'
import { ExtendDialog, StopDialog } from '../components/Timer'
import { UpdateConfirmDialog } from '../components/UpdateConfirmDialog'
import { WrapUpDialog } from '../components/WrapUpDialog'
import type { Mutate } from '../ui'
import type { ActiveDialog, View } from './navigation'

type SoftwareUpdateController = ReturnType<typeof useSoftwareUpdate>

interface Props {
  dialog: ActiveDialog | null
  settings: Settings
  backgroundImage?: string | null
  onThemeChange: (theme: Settings['theme']) => Promise<void>
  onSaveSettings: (patch: Partial<Settings>, image?: string | null) => Promise<void>
  categories: Category[]
  running: TimeEntry | null
  runningTask: Task | null
  softwareUpdate: SoftwareUpdateController
  mutate: Mutate
  notify: (text: string, error?: boolean) => void
  showToast: (text: string, error?: boolean) => void
  onChangeDialog: (dialog: ActiveDialog | null) => void
  onSelectView: (view: View) => void
}

export function DialogHost({
  dialog,
  settings,
  backgroundImage,
  onThemeChange,
  onSaveSettings,
  categories,
  running,
  runningTask,
  softwareUpdate,
  mutate,
  notify,
  showToast,
  onChangeDialog,
  onSelectView
}: Props) {
  const close = () => onChangeDialog(null)

  return (
    <>
      {dialog?.kind === 'stop' && running && (
        <StopDialog
          running={running}
          task={runningTask}
          overrunRatio={settings.overrunAskRatio}
          onClose={close}
          onConfirm={async (input) => {
            close()
            const r = await mutate(() => window.api.entries.stop(input))
            if (r?.discarded) showToast('这次不到 1 分钟，没有保存记录')
            else if (r) showToast(input.complete ? '已结束并完成任务' : '已结束本次投入，任务留在待办里')
          }}
        />
      )}

      {dialog?.kind === 'extend' && running && (
        <ExtendDialog
          step={settings.extendStepMin}
          onClose={close}
          onExtend={async (min) => {
            close()
            await mutate(() => window.api.entries.extend(min))
          }}
          onClear={async () => {
            close()
            await mutate(() => window.api.entries.setTarget(null))
          }}
        />
      )}

      {dialog?.kind === 'wrap-up' && (
        <WrapUpDialog
          settings={settings}
          mutate={mutate}
          onClose={close}
          onReview={() => onChangeDialog({ kind: 'review', day: dayOf(new Date(), settings.dayStartHour) })}
        />
      )}

      {dialog?.kind === 'insights' && <InsightsDialog mutate={mutate} onClose={close} />}

      {dialog?.kind === 'planner' && (
        <PlannerDialog
          day={dialog.day}
          mutate={mutate}
          onClose={close}
          onDone={(msg) => {
            close()
            notify(msg)
          }}
        />
      )}

      {dialog?.kind === 'review' && (
        <DailyReviewDialog
          key={dialog.day}
          day={dialog.day}
          categories={categories}
          mutate={mutate}
          onClose={close}
          onSwitchDay={(day) => onChangeDialog({ kind: 'review', day })}
        />
      )}

      {dialog?.kind === 'import' && (
        <ImportDialog
          onClose={close}
          onOpenSettings={() => onChangeDialog({ kind: 'settings' })}
          onDone={(msg) => {
            close()
            notify(msg)
            onSelectView({ kind: 'today' })
          }}
        />
      )}

      {dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={settings}
          backgroundImage={backgroundImage}
          onThemeChange={onThemeChange}
          updateState={softwareUpdate.state}
          updateReadError={softwareUpdate.readError}
          onUpdateRestart={softwareUpdate.requestRestart}
          onClose={close}
          onSave={async (patch, image) => {
            await onSaveSettings(patch, image)
            close()
          }}
        />
      )}

      {softwareUpdate.state?.confirmation && (
        <UpdateConfirmDialog
          confirmation={softwareUpdate.state.confirmation}
          returnFocus={softwareUpdate.state.confirmation.source === 'main' ? softwareUpdate.restartTrigger.current : null}
          onDecision={(id, accept) => window.api.update.respondToRestart(id, accept)}
          onError={(message) => notify(message, true)}
        />
      )}
    </>
  )
}
