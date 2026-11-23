function captionColors(dark: boolean) {
  return { color: dark ? '#1f1f22' : '#fbfbfa', symbolColor: dark ? '#ecebe8' : '#1f1e1b', height: 34 }
}

export function mainWindowChrome(dark: boolean): Pick<Electron.BrowserWindowConstructorOptions, 'backgroundColor' | 'titleBarStyle' | 'titleBarOverlay'> {
  const overlay = captionColors(dark)
  if (process.platform !== 'win32') return { backgroundColor: overlay.color }
  return { backgroundColor: overlay.color, titleBarStyle: 'hidden', titleBarOverlay: overlay }
}

export function updateMainWindowChrome(
  win: Pick<Electron.BrowserWindow, 'setBackgroundColor' | 'setTitleBarOverlay'>, dark: boolean
): void {
  const overlay = captionColors(dark)
  win.setBackgroundColor(overlay.color)
  if (process.platform === 'win32') win.setTitleBarOverlay(overlay)
}
