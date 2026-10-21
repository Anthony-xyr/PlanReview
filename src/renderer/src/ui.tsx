import { useEffect, useRef, type ReactNode } from 'react'

/** 执行一个修改操作：出错时提示，成功后通知各页面刷新 */
export type Mutate = <T>(fn: () => Promise<T>) => Promise<T | undefined>

/** 模态对话框，基于原生 <dialog>，自带 Esc 关闭与焦点管理 */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    if (!d.open) d.showModal()
    return () => d.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  )
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // IPC 抛回的错误带有 "Error invoking remote method 'x': Error: " 前缀
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
