import { useEffect, useState } from 'react'
import { dayBackground } from '@shared/background'
import type { BackgroundFit, BackgroundMode } from '@shared/types'

function ClockBackground() {
  const [phase, setPhase] = useState(() => dayBackground(new Date()))

  useEffect(() => {
    let timer: number
    const refresh = () => {
      const now = new Date()
      setPhase(dayBackground(now))
      window.clearTimeout(timer)
      // 对齐分钟边界，并短间隔重读系统时间，以兼顾时段切换和手动改时间。
      const untilMinute = 60_000 - now.getSeconds() * 1000 - now.getMilliseconds()
      timer = window.setTimeout(refresh, Math.min(untilMinute, 15_000))
    }
    refresh()
    const offResume = window.api.events.onResume(refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearTimeout(timer)
      offResume()
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return <div className="background-layer" data-phase={phase} aria-hidden="true" />
}

interface Props {
  mode: BackgroundMode
  fit: BackgroundFit
  opacity: number
  image?: string | null
}

export function WindowBackground({ mode, fit, opacity, image }: Props) {
  if (mode === 'time') return <ClockBackground />
  if (mode !== 'custom' || !image || opacity === 0) return null
  return (
    <div className="background-layer" data-fit={fit} style={{ opacity: opacity / 100 }} aria-hidden="true">
      {fit === 'contain' && <img className="background-fill" src={image} alt="" draggable={false} />}
      <img
        className="background-photo"
        src={image}
        alt=""
        draggable={false}
        onLoad={({ currentTarget: photo }) => {
          if (photo.naturalHeight) {
            photo.style.setProperty('--wallpaper-photo-ratio', String(photo.naturalWidth / photo.naturalHeight))
          }
        }}
      />
    </div>
  )
}
