import type { Category, Settings, StartTimerInput, TimeEntry } from '@shared/types'
import { dayOf } from '@shared/time'
import { TasksView } from '../components/TasksView'
import { TodayView } from '../components/TodayView'
import { WeeklyView } from '../components/WeeklyView'
import type { Mutate } from '../ui'
import type { ActiveDialog, View } from './navigation'

interface Props {
  view: View
  settings: Settings
  categories: Category[]
  version: number
  running: TimeEntry | null
  mutate: Mutate
  notify: (text: string, error?: boolean) => void
  onStartTimer: (input: StartTimerInput) => void
  onSelectView: (view: View) => void
  onOpenDialog: (dialog: ActiveDialog) => void
}

export function ViewHost({
  view,
  settings,
  categories,
  version,
  running,
  mutate,
  notify,
  onStartTimer,
  onSelectView,
  onOpenDialog
}: Props) {
  if (view.kind === 'weekly') {
    return (
      <WeeklyView
        settings={settings}
        categories={categories}
        version={version}
        mutate={mutate}
        onOpenSettings={() => onOpenDialog({ kind: 'settings' })}
      />
    )
  }

  if (view.kind === 'today') {
    return (
      <TodayView
        key={dayOf(new Date(), settings.dayStartHour)}
        settings={settings}
        categories={categories}
        version={version}
        mutate={mutate}
        running={running}
        onStartTimer={onStartTimer}
        onOpenInbox={() => onSelectView({ kind: 'inbox' })}
        onOpenReview={(day) => onOpenDialog({ kind: 'review', day })}
        onOpenPlanner={(day) => onOpenDialog({ kind: 'planner', day })}
        notify={notify}
      />
    )
  }

  return (
    <TasksView
      view={view}
      categories={categories}
      version={version}
      mutate={mutate}
      running={running}
      onStartTimer={onStartTimer}
      onNavigate={onSelectView}
      notify={notify}
    />
  )
}
