import { useEffect, useRef, type ReactNode } from 'react'

/** 执行一个修改操作：出错时提示，成功后通知各页面刷新 */
export type Mutate = <T>(fn: () => Promise<T>) => Promise<T | undefined>

/** 模态对话框，基于原生 <dialog>，自带 Esc 关闭与焦点管理 */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const d = ref.current!
    if (!d.open) d.showModal()
    // 浏览器自己把对话框关掉时（比如连按两次 Esc 时 Chromium 不再允许拦截），
    // 也要通知外面，否则外面还以为它开着，再点入口就打不开了。
    // close 事件是异步派发的：开发模式下 StrictMode 先卸载再挂载，卸载时那次 close() 的事件
    // 会在重新挂载之后才到，这时对话框其实开着，要忽略
    const closed = (e: Event) => {
      if (e.target === d && !d.open) onCloseRef.current()
    }
    d.addEventListener('close', closed)
    return () => {
      d.removeEventListener('close', closed)
      d.close()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        // 对话框里还套着对话框时（如设置里的速记习惯），里面那个的 Esc 会冒泡上来，只处理自己的
        if (e.target !== ref.current) return
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        // 点遮罩才关闭。点对话框自己的滚动条或内边距时，事件目标也是 <dialog>，
        // 所以要看点的位置在不在对话框的矩形外面
        const d = ref.current
        if (e.target !== d || !d) return
        const r = d.getBoundingClientRect()
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose()
      }}
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
