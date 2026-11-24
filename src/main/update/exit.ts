/** 正常退出和立即安装都走这里。活动计时已实时入库，保存不得结束它。 */
export function prepareUpdateExit(
  updateTo: string | null,
  flush: () => void,
  snapshot: (version: string) => void,
  log: (event: string) => void
): void {
  try { flush() } catch { log('exit database checkpoint failed') }
  if (updateTo) {
    try {
      snapshot(updateTo)
      log('before update database snapshot saved')
    } catch { log('before update database snapshot failed') }
  }
}
