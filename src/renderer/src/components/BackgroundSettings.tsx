import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { DAY_BACKGROUND_SCHEDULE } from '@shared/background'
import type { BackgroundFit, BackgroundMode } from '@shared/types'
import { prepareBackgroundImage } from '../backgroundImage'
import { errorText } from '../ui'
import { WindowBackground } from './WindowBackground'

interface Props {
  mode: BackgroundMode
  fit: BackgroundFit
  opacity: number
  image?: string | null
  disabled: boolean
  picking: boolean
  onModeChange: (mode: BackgroundMode) => void
  onFitChange: (fit: BackgroundFit) => void
  onOpacityChange: (opacity: number) => void
  onImageChange: (image: string | null) => void
  onPicking: (picking: boolean) => void
}

const scheduleHint = DAY_BACKGROUND_SCHEDULE.map(({ startHour, label }) => `${String(startHour).padStart(2, '0')}:00 ${label}`).join(' · ')
const windowRatio = () => window.innerWidth / Math.max(window.innerHeight, 1)

function BackgroundPreview({ mode, fit, opacity, image }: Pick<Props, 'mode' | 'fit' | 'opacity' | 'image'>) {
  const [ratio, setRatio] = useState(windowRatio)
  useEffect(() => {
    const resize = () => setRatio(windowRatio())
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const custom = mode === 'custom'
  const showsPhoto = custom && !!image && opacity > 0
  return (
    <figure className="background-preview-wrap">
      <div className={`background-preview${showsPhoto ? ' has-wallpaper' : ''}`} style={{ aspectRatio: ratio, maxWidth: 152 * ratio }} aria-hidden="true">
        <WindowBackground mode={mode} fit={fit} opacity={opacity} image={image} />
        <div className="background-preview-sidebar"><i /><i /><i /></div>
        {custom ? (
          <div className="background-preview-today">
            <div className="background-preview-head"><i /></div>
            <div className="background-preview-board">
              <div className="background-preview-pool"><i /><i /></div>
              <div className="background-preview-grid" />
            </div>
          </div>
        ) : <div className="background-preview-content"><i /><i /><i /></div>}
      </div>
      <figcaption className="muted">主窗口预览</figcaption>
    </figure>
  )
}

export function BackgroundSettings({ mode, fit, opacity, image, disabled, picking, onModeChange, onFitChange, onOpacityChange, onImageChange, onPicking }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const opacityId = useId()
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const pickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = '' // 取消选择后不改原图，也允许重选同一个文件。
    if (!file) return
    onPicking(true)
    setError('')
    try {
      onImageChange(await prepareBackgroundImage(file))
      setName(file.name)
    } catch (err) {
      setError(errorText(err))
    } finally {
      onPicking(false)
    }
  }

  return (
    <div className="background-settings">
      <label className="field">
        <span>背景</span>
        <select value={mode} disabled={disabled || picking} onChange={(e) => onModeChange(e.target.value as BackgroundMode)}>
          <option value="plain">默认背景</option>
          <option value="time">随系统时间变化</option>
          <option value="custom">自定义图片</option>
        </select>
        <small className="muted">仅应用到主窗口，与界面深浅配色独立，保存后生效。</small>
      </label>
      {mode === 'time' && <small className="muted">按本机时间切换：{scheduleHint}</small>}
      {mode === 'custom' && (
        <>
          {!image && <small className="muted" role="status">请先选择一张背景图片，再保存自定义背景。</small>}
          <div className="background-file-actions">
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onChange={pickImage} />
            <button type="button" className="secondary" disabled={disabled || picking} onClick={() => fileInput.current?.click()}>
              {image ? '更换图片' : '选择图片'}
            </button>
            {image && (
              <button type="button" className="link" disabled={disabled || picking} onClick={() => {
                setName('')
                setError('')
                onImageChange(null)
                onModeChange('plain')
              }}>移除图片</button>
            )}
            <small className="muted background-file-name" role="status" title={name || undefined}>
              {picking ? '正在处理…' : image ? name || '已保存的图片' : 'JPG、PNG、WebP，最大 20 MB'}
            </small>
          </div>
          {error && <small className="hint-error" role="alert">{error}</small>}
          <label className="field background-fit">
            <span>图片适配</span>
            <select value={fit} disabled={disabled || picking} onChange={(e) => onFitChange(e.target.value as BackgroundFit)}>
              <option value="cover">铺满窗口</option>
              <option value="contain">完整显示</option>
            </select>
            <small className="muted">{fit === 'cover' ? '保持比例铺满窗口，可能裁掉边缘。' : '保持比例显示整张图片，留边用同一张图柔化填充。'}</small>
          </label>
          <div className="field background-opacity">
            <div className="background-opacity-caption">
              <label htmlFor={opacityId}>图片不透明度</label>
              <span aria-hidden="true">{opacity}%</span>
            </div>
            <input
              id={opacityId}
              type="range"
              min={0}
              max={100}
              step={1}
              value={opacity}
              disabled={disabled || picking || !image}
              aria-valuetext={`${opacity}%`}
              aria-describedby={`${opacityId}-hint`}
              onChange={(e) => onOpacityChange(e.currentTarget.valueAsNumber)}
            />
            <small id={`${opacityId}-hint`} className="muted">0% 隐藏图片，100% 显示原色。</small>
          </div>
        </>
      )}
      {(mode === 'time' || (mode === 'custom' && image)) && <BackgroundPreview mode={mode} fit={fit} opacity={opacity} image={image} />}
    </div>
  )
}
