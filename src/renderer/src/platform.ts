/** 渲染进程判断当前系统：只用来调整文案和按键叫法，不参与业务逻辑 */
export const isMacPlatform = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
export const platformName = isMacPlatform ? 'darwin' : 'win32'
