import { useId, useLayoutEffect, useRef } from 'react'
import type { UpdateConfirmation } from '@shared/update'
import { errorText } from '../ui'

interface Props {
  confirmation: UpdateConfirmation
  returnFocus: HTMLButtonElement | null
  onDecision: (id: string, accept: boolean) => Promise<void>
  onError: (message: string) => void
}

export function UpdateConfirmDialog({ confirmation, returnFocus, onDecision, onError }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const replyId = useRef<string | null>(null)
  const initialReturnFocus = useRef(returnFocus)

  useLayoutEffect(() => {
    const element = dialog.current!
    const previous = initialReturnFocus.current ?? element.ownerDocument.activeElement
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  // 有新确认请求时重新聚焦取消按钮，避免误确认刚切换的任务。
  useLayoutEffect(() => { cancel.current?.focus() }, [confirmation.id])

  const choose = (accept: boolean) => {
    const id = confirmation.id
    if (replyId.current === id) return
    replyId.current = id
    void onDecision(id, accept).catch((err) => onError(errorText(err))).finally(() => {
      if (replyId.current === id) replyId.current = null
    })
  }

  return (
    <dialog
      ref={dialog}
      className="dialog update-confirmation"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      closedby="none"
      onCancel={(event) => { event.preventDefault(); choose(false) }}
      onMouseDown={(event) => { if (event.target === dialog.current) event.preventDefault() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          choose(false)
        } else if (event.key === 'Tab') {
          // 只有两个按钮，正向和反向 Tab 都切换到另一个按钮。
          event.preventDefault()
          const active = dialog.current!.ownerDocument.activeElement
          const next = active === cancel.current ? confirm.current : cancel.current
          next?.focus()
        }
      }}
    >
      <h2 id={titleId}>现在更新吗？</h2>
      <div id={descriptionId}>
        <p className="dialog-lead">
          正在计时的任务
          <strong className="update-confirmation-task" title={confirmation.timerTitle}>{confirmation.timerTitle}</strong>
        </p>
        <p className="dialog-lead">会先保存这次计时，并在更新前尝试自动备份。仍在进行的计时会沿用原来的开始时间，安装耗时也计入已用时。</p>
      </div>
      <div className="dialog-actions">
        <button ref={cancel} type="button" className="secondary" onClick={() => choose(false)}>稍后再说</button>
        <button ref={confirm} type="button" onClick={() => choose(true)}>保存并更新</button>
      </div>
    </dialog>
  )
}
