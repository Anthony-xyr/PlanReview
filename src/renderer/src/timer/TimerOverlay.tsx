import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TimerOverlayState } from '@shared/types'
import { formatElapsed } from '@shared/time'
import { timerProgress } from './timerProgress'

export function TimerOverlay() {
  const [state, setState] = useState<TimerOverlayState | null>(null)
  const [hovered, setHovered] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const pill = useRef<HTMLDivElement>(null)
  const running = !!state?.entry

  useEffect(() => {
    let active = true
    let receivedState = false
    let receivedHover = false
    const offState = window.api.timer.onState((next) => {
      receivedState = true
      setState(next)
      setHovered(next.hovered)
      setNow(Date.now())
    })
    const offHover = window.api.timer.onHover((next) => {
      receivedHover = true
      setHovered(next)
    })
    void window.api.timer.state().then((initial) => {
      if (!active || receivedState) return
      setState(initial)
      if (!receivedHover) setHovered(initial.hovered)
    }).catch((err: unknown) => console.error(err))
    return () => {
      active = false
      offState()
      offHover()
    }
  }, [])

  useEffect(() => {
    if (!running) return
    let interval: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      clearInterval(interval)
      if (document.hidden) return
      setNow(Date.now())
      interval = setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [running])

  useLayoutEffect(() => {
    const el = pill.current
    if (!el) return
    let previous = 0
    const observer = new ResizeObserver(() => {
      const width = Math.ceil(el.getBoundingClientRect().width)
      if (width <= 0 || width === previous) return
      previous = width
      void window.api.timer.resize(width).catch((err: unknown) => console.error(err))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [running])

  if (!state?.entry) return null
  const { title, startAt, targetEndAt } = state.entry
  const progress = timerProgress(targetEndAt, now)
  return (
    <div ref={pill} role="timer" aria-label={`本次计时：${title}`} aria-live="off"
      className={`desktop-timer${hovered ? ' is-near-cursor' : ''}${progress?.over ? ' is-over' : ''}`}
      style={{ maxWidth: state.maxWidth }}>
      <span className="desktop-timer-indicator" aria-hidden="true" />
      <span className="desktop-timer-title">{title}</span>
      <span className="desktop-timer-elapsed">{formatElapsed(now - Date.parse(startAt))}</span>
      {progress && <span className="desktop-timer-left">{progress.label}</span>}
    </div>
  )
}
