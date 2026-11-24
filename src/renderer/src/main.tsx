import './styles.css'
import './background.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { FloatApp } from './float/FloatApp'
import { TimerOverlay } from './timer/TimerOverlay'

const route = location.hash
document.documentElement.classList.toggle('is-float', route === '#float')
document.documentElement.classList.toggle('is-desktop-timer', route === '#timer')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{route === '#timer' ? <TimerOverlay /> : route === '#float' ? <FloatApp /> : <App />}</StrictMode>
)
