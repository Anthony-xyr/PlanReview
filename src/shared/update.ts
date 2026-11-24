export const RELEASES_URL = 'https://github.com/Anthony-xyr/PlanReview/releases'

export const UPDATE_IPC = {
  state: 'update:state',
  check: 'update:check',
  setAutoCheck: 'update:setAutoCheck',
  restart: 'update:restart',
  respondToRestart: 'update:respondToRestart',
  openReleases: 'update:openReleases',
  changed: 'update:changed'
} as const

export interface UpdateRelease {
  version: string
  notes: string
  notesTruncated: boolean
}

export interface UpdateState {
  runId: string
  currentVersion: string
  installedVersion: string | null
  mode: 'download' | 'check-only' | 'development' | 'unsupported-platform'
  autoCheck: boolean
  lastCheckedAt: string | null
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  release: UpdateRelease | null
  percent: number | null
  error: string | null
}

export interface UpdateConfirmation {
  id: string
  version: string
  timerTitle: string
  source: 'main' | 'tray'
}

export interface UpdateSnapshot extends UpdateState {
  confirmation: UpdateConfirmation | null
}

export interface UpdateApi {
  state(): Promise<UpdateSnapshot>
  check(): Promise<void>
  setAutoCheck(enabled: boolean): Promise<void>
  restart(): Promise<void>
  respondToRestart(id: string, accept: boolean): Promise<void>
  openReleases(): Promise<void>
  onChanged(callback: (state: UpdateSnapshot) => void): () => void
}
