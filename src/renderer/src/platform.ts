/** 主窗和悬浮窗由预加载脚本提供系统信息。顶部计时窗只有计时 API。 */
export const platformName = window.api?.win?.platform ?? ''
export const isMacPlatform = platformName === 'darwin'
