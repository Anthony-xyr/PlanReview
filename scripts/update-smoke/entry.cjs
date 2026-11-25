'use strict'

// Test-only Electron main entry. It is not included by the production Builder file list.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { app, BrowserWindow, nativeTheme, Tray } = require('electron')
const { planReviewUpdateFixture: spec } = require('../package.json')
assert.match(spec.id, /^[a-f0-9]{10}$/)
const fixture = fs.realpathSync(spec.root)
const tree = fs.realpathSync(path.resolve(fixture, '../../../..'))
assert.equal(path.basename(tree), 'auto-update')
assert.equal(path.basename(path.dirname(tree)), 'PlanReview-wt')
assert.equal(path.relative(tree, fixture), path.join('dist', 'update-verify', 'round2', `electron-${spec.id}`))
const active = fs.readFileSync(path.join(fixture, 'active-case.txt'), 'utf8').trim()
assert.match(active, /^[a-z][a-z0-9-]{0,40}$/)
const run = fs.realpathSync(path.join(fixture, active))
assert.equal(path.dirname(run), fixture)
const dir = (name) => {
  const p = path.join(run, name)
  fs.mkdirSync(p, { recursive: true })
  assert.equal(fs.realpathSync(p), p)
  return p
}
const roaming = dir('roaming')
const local = dir('local')
const data = path.join(roaming, 'plan-review')
const control = dir('control')
const trace = path.join(run, 'electron.jsonl')
const log = (event, info) => fs.appendFileSync(trace, JSON.stringify({ time: Date.now(), pid: process.pid, event, info }) + '\n')

// Electron uses the known-folder API on Windows; do not rely on changing APPDATA alone.
const normalRoaming = app.getPath('appData')
assert.notEqual(roaming.toLowerCase(), normalRoaming.toLowerCase())
process.env.APPDATA = roaming
process.env.LOCALAPPDATA = local // electron-updater's Windows cache honors this value.
delete process.env.ELECTRON_RENDERER_URL
app.setPath('appData', roaming)
app.setPath('userData', data)
app.setPath('sessionData', dir('session'))
app.setPath('crashDumps', dir('crashes'))
assert.equal(app.getPath('appData'), roaming)
assert.equal(app.getPath('userData'), data)
assert.equal(app.isPackaged, !spec.development)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
if (!spec.development) {
  assert.match(process.execPath, new RegExp(`PlanReviewUpdateSmoke-${spec.id}\\.exe$`, 'i'))
  const installDir = path.join(fixture, 'isolated-install')
  const appDir = path.dirname(fs.realpathSync(process.execPath))
  assert.ok(appDir === installDir || (appDir.startsWith(fixture + path.sep) && path.basename(appDir) === 'win-unpacked'))
  const setAppId = app.setAppUserModelId.bind(app)
  app.setAppUserModelId = () => setAppId(`io.planreview.autoupdate.smoke.${spec.id}`)
} else {
  app.setAppPath(tree)
}
log('isolation-before-entry', { data, cache: local, session: app.getPath('sessionData'), packaged: app.isPackaged,
  executable: process.execPath, version: app.getVersion() })

// Prevent test runs from reaching an external feed even if NSIS has just installed a fresh package.
app.on('session-created', (session) => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, reply) => {
    const parsed = new URL(request.url)
    const localOnly = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
    if (!localOnly) log('external-network-blocked', { origin: parsed.origin })
    reply({ cancel: !localOnly })
  })
})

const allowedInstaller = path.join(local, `planreview-update-smoke-${spec.id}-updater`, 'pending')
const spawn = cp.spawn
cp.spawn = function (file, args, options) {
  // A fail-closed guard in the test harness only, before ever starting a downloaded executable.
  if (Array.isArray(args) && args.includes('--updated')) {
    assert.equal(path.dirname(path.resolve(file)).toLowerCase(), allowedInstaller.toLowerCase(), 'installer must be in the isolated cache')
    assert.match(path.basename(file), new RegExp(`^PlanReviewUpdateSmoke-${spec.id}-Setup-[0-9.]+\\.exe$`, 'i'))
    assert.equal(path.dirname(process.execPath), path.join(fixture, 'isolated-install'), 'only the isolated installed app may run an installer')
    const authorization = JSON.parse(fs.readFileSync(path.join(run, 'installer-authorization.json'), 'utf8'))
    assert.equal(path.basename(file).toLowerCase(), authorization.name.toLowerCase())
    const sha512 = require('node:crypto').createHash('sha512').update(fs.readFileSync(file)).digest('base64')
    assert.equal(sha512, authorization.sha512)
    assert.ok(args.includes('/S'), 'an update must be silent')
    const child = Reflect.apply(spawn, this, [file, args, options])
    log('nsis-spawn', { file, args, child: child.pid ?? null, sha512 })
    return child
  }
  return Reflect.apply(spawn, this, arguments)
}

let tray
const setMenu = Tray.prototype.setContextMenu
Tray.prototype.setContextMenu = function (menu) {
  tray = menu
  return setMenu.call(this, menu)
}
app.on('browser-window-created', (_event, win) => {
  const web = win.webContents
  const send = web.send
  web.send = function (channel, ...args) {
    if (channel === 'update:changed') log('update-state', args[0])
    return send.call(this, channel, ...args)
  }
  web.once('did-finish-load', () => log('loaded', { url: web.getURL(), win: win.id }))
  web.on('render-process-gone', (_e, detail) => log('renderer-gone', detail))
  web.on('console-message', ({ message }) => {
    const prefix = 'update-smoke-trusted-input '
    if (!message.startsWith(prefix)) return
    const input = JSON.parse(message.slice(prefix.length))
    if (input.trusted === true) log('trusted-input', input)
  })
})
app.on('before-quit', () => log('before-quit'))
app.on('will-quit', () => log('will-quit'))
app.on('quit', (_e, code) => log('quit', code))
process.on('uncaughtExceptionMonitor', (error) => log('uncaught', error.stack))
process.on('unhandledRejection', (error) => { log('unhandled-rejection', String(error)); app.exit(89) })

const game = spec.development ? path.join(tree, 'out', 'main', 'index.js') : '../out/main/index.js'
require(game)
assert.equal(app.getPath('userData'), data, 'the real entry must use the isolated path for the database and lock')
log('real-entry-isolated', data)

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => {
    const url = win.webContents.getURL()
    return url.includes('/renderer/index.html') && !new URL(url).hash
  })
}
async function capture(win, name) {
  assert.match(name, /^[a-z0-9-]{1,60}$/)
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  try {
    const { data: png } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const payload = Buffer.from(png, 'base64')
    assert.ok(payload.length > 1024)
    const file = path.join(run, `${name}.png`)
    fs.writeFileSync(file, payload)
    const modal = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.software-update-settings')
      return { dark: matchMedia('(prefers-color-scheme: dark)').matches, visible: !!el && el.getBoundingClientRect().height > 0,
        scroll: el?.getBoundingClientRect().top ?? null, color: getComputedStyle(document.documentElement).color,
        status: el?.querySelector('[role=status]')?.textContent ?? '', progress: el?.querySelector('progress')?.value ?? null }
    })()`)
    return { file, sha256: require('node:crypto').createHash('sha256').update(payload).digest('hex'), ...modal }
  } finally { dbg.detach() }
}

const interval = setInterval(() => {
  for (const name of fs.readdirSync(control)) {
    if (!/^\d+(?:-\d+)?\.request\.json$/.test(name)) continue
    const target = path.join(control, name)
    const req = JSON.parse(fs.readFileSync(target, 'utf8'))
    fs.unlinkSync(target)
    const finish = (answer) => {
      const out = target.replace('.request.json', '.response.json')
      fs.writeFileSync(`${out}.tmp`, JSON.stringify({ ...answer, pid: process.pid }))
      fs.renameSync(`${out}.tmp`, out)
    }
    void (async () => {
      const win = mainWindow()
      switch (req.action) {
        case 'info': return { version: app.getVersion(), packaged: app.isPackaged, path: process.execPath, data: app.getPath('userData'),
          visible: win?.isVisible() ?? false, minimized: win?.isMinimized() ?? false, dark: nativeTheme.shouldUseDarkColors, windows: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()) }
        case 'render': return await win.webContents.executeJavaScript(req.source, true)
        case 'capture': return await capture(win, req.file)
        case 'key': {
          assert.ok(win?.isVisible())
          const modifiers = req.shift ? ['shift'] : []
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: req.key, modifiers })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: req.key, modifiers })
          return true
        }
        case 'mouse': {
          assert.ok(win?.isVisible())
          const web = win.webContents
          assert.equal(web.getZoomFactor(), 1)
          const { x, y } = req
          assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
          if (!win.isFocused()) win.focus()
          web.sendInputEvent({ type: 'mouseMove', x, y })
          web.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          web.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          return true
        }
        case 'minimize': win.minimize(); return true
        case 'tray': return tray?.items.map((item) => item.label)
        case 'tray-click': {
          const item = tray?.items.find((item) => item.label === req.label)
          assert.ok(item, `missing tray item ${req.label}`)
          log('tray-menu-activated', { label: item.label, visible: win?.isVisible(), minimized: win?.isMinimized() })
          setTimeout(() => item.click(), 100)
          return true
        }
        case 'close-to-tray': win.close(); return !win.isVisible()
        case 'reload': win.webContents.reload(); return true
        case 'exit-without-install': setTimeout(() => app.exit(86), 100); return true
        default: throw new Error('Unknown smoke request')
      }
    })().then((value) => finish({ value }), (error) => finish({ error: error.stack || String(error) }))
  }
}, 40)
app.on('will-quit', () => clearInterval(interval))
