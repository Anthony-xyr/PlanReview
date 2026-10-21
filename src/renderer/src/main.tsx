import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { FloatApp } from './float/FloatApp'
import './styles.css'

// 同一份界面代码，悬浮窗通过 #float 进入
const isFloat = location.hash === '#float'
document.documentElement.classList.toggle('is-float', isFloat)

createRoot(document.getElementById('root')!).render(<StrictMode>{isFloat ? <FloatApp /> : <App />}</StrictMode>)
