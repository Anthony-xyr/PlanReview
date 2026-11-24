import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, createReadStream, createWriteStream, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import yaml from 'js-yaml'

const tree = realpathSync(process.cwd())
assert.equal(process.platform, 'win32')
assert.equal(path.basename(tree), 'auto-update')
assert.equal(path.basename(path.dirname(tree)), 'PlanReview-wt')
const evidence = path.join(tree, 'dist', 'update-verify')
const fixture = realpathSync((await readFile(path.join(evidence, 'latest-electron-fixture.txt'), 'utf8')).trim())
const spec = JSON.parse(await readFile(path.join(fixture, 'fixture.json'), 'utf8'))
assert.equal(spec.root, fixture)
assert.equal(fixture, path.join(evidence, `electron-${spec.id}`))
assert.match(spec.id, /^[a-f0-9]{10}$/)
assert.equal(spec.shortName, `PlanReviewUpdateSmoke-${spec.id}`)
assert.equal(spec.appId, `io.planreview.autoupdate.smoke.${spec.id}`)
assert.equal(spec.install, path.join(fixture, 'isolated-install'))
assert.equal(spec.cacheName, `planreview-update-smoke-${spec.id}-updater`)
assert.match(spec.guid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
const exeName = spec.shortName + '.exe'
const oldExe = path.join(spec.old.unpacked, exeName)
const installExe = path.join(spec.install, exeName)
const ports = `${spec.port}`
assert.match(ports, /^\d{4,5}$/)
const key = 'active-case.txt'
const releaseNotes = '# 真实下载测试\n\n- **更新计时**\n- [链接文字](https://example.invalid/ignore)\n\n<script>DO_NOT_SHOW</script>\n\n' + '计划与复盘。'.repeat(240)
const revisedYml = yaml.dump({ ...yaml.load(spec.next.yml), releaseNotes })
const shutdown = new Set()
const maxDuration = 25_000

const sha512 = async (file) => {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}
function eventList(run) {
  const trace = path.join(run, 'electron.jsonl')
  return existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  }) : []
}
async function until(get, desc, ms = maxDuration) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { const result = await get(); if (result) return result } catch (err) { last = err }
    await sleep(55)
  }
  throw new Error(`${desc}: deadline exceeded${last ? ` (${last.message})` : ''}`, { cause: last })
}
let traceFile
const record = (...data) => {
  const text = data.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
  console.log(text)
  if (traceFile) appendFileSync(traceFile, `${new Date().toISOString()} ${text}\n`)
}
function childTrace(p, run, label) {
  p.stdout?.pipe(createWriteStream(path.join(run, `${label}-stdout.log`)))
  p.stderr?.pipe(createWriteStream(path.join(run, `${label}-stderr.log`)))
  p.on('error', (err) => record('child error', label, err.message))
  p.on('exit', (code, signal) => record('child exit', { label, pid: p.pid, code, signal }))
  return p
}
async function useRun(label) {
  const name = `${label}-${randomBytes(3).toString('hex')}`
  const run = path.join(fixture, name)
  await mkdir(run)
  for (const dir of ['control', 'local', 'roaming', 'temp']) await mkdir(path.join(run, dir))
  assert.equal(realpathSync(run), run)
  await writeFile(path.join(fixture, key), name + '\n')
  traceFile = path.join(run, 'smoke.log')
  record('ISOLATED:', run, 'appId', spec.appId)
  return run
}
const appData = (run) => path.join(run, 'roaming', 'plan-review')
const appLog = (run) => path.join(appData(run), 'logs', 'updater.log')
const updaterLines = (run) => existsSync(appLog(run)) ? readFileSync(appLog(run), 'utf8') : ''
const testEnv = (run) => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(APPDATA|LOCALAPPDATA|TEMP|TMP|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS)$/i.test(key)) delete env[key]
  return { ...env, APPDATA: path.join(run, 'roaming'), LOCALAPPDATA: path.join(run, 'local'), TEMP: path.join(run, 'temp'), TMP: path.join(run, 'temp') }
}
function launch(run, exe, args = []) {
  return childTrace(spawn(exe, args, { cwd: run, env: testEnv(run), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] }), run, 'electron')
}
let serial = 0
async function command(run, action, options = {}, deadline = 6000) {
  const seq = `${Date.now()}-${++serial}`
  const base = path.join(run, 'control', seq)
  await writeFile(`${base}.tmp`, JSON.stringify({ action, ...options }))
  await rename(`${base}.tmp`, `${base}.request.json`)
  const reply = await until(() => existsSync(`${base}.response.json`) && JSON.parse(readFileSync(`${base}.response.json`, 'utf8')), action, deadline)
  if (reply.error) throw new Error(reply.error)
  return reply.value
}
const render = (run, source) => command(run, 'render', { source })
const current = (run) => render(run, 'window.api.update.state()')
const state = (run, wanted, ms) => until(async () => {
  const snapshot = await current(run)
  return snapshot.status === wanted && snapshot
}, `expected ${wanted}`, ms)
const click = (run, text, scope = 'body') => render(run, `(() => {
  const btn = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.textContent.trim() === ${JSON.stringify(text)});
  if (!btn || btn.disabled) throw new Error('Button missing or disabled: ' + ${JSON.stringify(text)});
  btn.click(); return true;
})()`)
const tray = (run) => command(run, 'tray')
const targetTray = `重启并更新到 ${spec.next.version}`
const updateSelector = '.software-update-settings'
const banner = (run) => render(run, "document.querySelector('.update-banner')?.innerText ?? ''")
async function showSettings(run) {
  if (!(await render(run, `!!document.querySelector(${JSON.stringify(updateSelector)})`))) await click(run, '设置', 'body')
  await until(() => render(run, `!!document.querySelector(${JSON.stringify(updateSelector + ' [role=status]')})`), 'software update settings opened')
  await render(run, `document.querySelector(${JSON.stringify(updateSelector)}).scrollIntoView({block:'center'}); true`)
}
async function closeSettings(run) {
  if (await render(run, "!!document.querySelector('dialog[aria-label=设置][open]')")) {
    await click(run, '取消', 'dialog[aria-label=设置] .dialog-actions')
    await until(() => render(run, '!document.querySelector("dialog[aria-label=设置][open]")'), 'settings closed')
  }
}
async function capture(run, file, dark, status, inSettings = true) {
  const result = await command(run, 'capture', { file })
  assert.equal(result.dark, dark)
  if (inSettings) {
    assert.equal(result.visible, true)
    assert.match(result.status, status)
  }
  record('PNG', result)
  return result
}
async function bothThemes(run, name, expectation) {
  const captures = []
  for (const theme of ['light', 'dark']) {
    await render(run, `window.api.settings.update({theme:${JSON.stringify(theme)}})`)
    await until(() => render(run, `matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `theme ${theme}`)
    await showSettings(run)
    captures.push(await capture(run, `${name}-${theme}`, theme === 'dark', expectation))
  }
  assert.notEqual(captures[0].sha256, captures[1].sha256, 'themes rendered identically')
  return captures
}
async function ready(run, executable, version = spec.old.version) {
  await until(() => eventList(run).find((e) => e.event === 'real-entry-isolated' && e.info === appData(run)), 'startup with isolation before app entry')
  const info = await until(async () => {
    const snapshot = await command(run, 'info', {}, 2200)
    return snapshot.visible && snapshot
  }, 'main window shown')
  assert.equal(info.version, version)
  assert.equal(info.data, appData(run))
  assert.equal(info.path.toLowerCase(), executable.toLowerCase())
  await until(() => render(run, "!!window.api && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '设置')"), 'renderer ready')
  record('MAIN ready:', info)
  return info
}
async function toggleAuto(run, enabled, byKeyboard = false) {
  await showSettings(run)
  const selector = `${updateSelector} input[type=checkbox]`
  if ((await current(run)).autoCheck !== enabled) {
    await render(run, `(() => { const box = document.querySelector(${JSON.stringify(selector)});
      if (!box || box.disabled) throw new Error('Automatic check unavailable');
      ${byKeyboard ? 'box.focus()' : 'box.click()'}; return document.activeElement === box; })()`)
    if (byKeyboard) await command(run, 'key', { key: 'Space' })
  }
  await until(async () => (await current(run)).autoCheck === enabled, 'auto setting changed')
}
async function leave(run, pid, exitCode = 0) {
  if (exitCode === 0) await command(run, 'tray-click', { label: '退出' })
  else await command(run, 'exit-without-install')
  if (exitCode === 0) await until(() => eventList(run).some((e) => e.pid === pid && e.event === 'quit' && e.info === exitCode), 'Electron quit event')
}
function assertClean(run) {
  const unexpected = eventList(run).filter((e) => ['renderer-gone', 'uncaught', 'unhandled-rejection', 'external-network-blocked'].includes(e.event))
  assert.deepEqual(unexpected, [])
}

let mode = 'current'
let holdCheck = false
let holdDownload = false
const hits = []
let server
async function startFeed() {
  assert.equal(server, undefined)
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${spec.port}`)
    const filename = decodeURIComponent(url.pathname.slice(1))
    hits.push({ time: Date.now(), name: filename, mode })
    record('HTTP', req.method, filename, mode)
    res.on('error', () => {})
    void (async () => {
      if (filename === 'latest.yml') {
        while (holdCheck && !res.destroyed) await sleep(80)
        if (res.destroyed) return
        const body = mode === 'current' ? spec.old.yml : revisedYml
        res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
        return res.end(body)
      }
      if (filename !== spec.next.file.url) { res.writeHead(404); return res.end('not part of fixture') }
      assert.ok(['good', 'corrupt', 'disconnect', 'stalled'].includes(mode))
      const responseMode = mode
      const size = spec.next.file.size
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' })
      let offset = 0
      const slow = holdDownload || responseMode === 'disconnect' || responseMode === 'stalled'
      for await (const chunk of createReadStream(spec.next.installer, { highWaterMark: slow ? 1024 * 1024 : 4 * 1024 * 1024 })) {
        if (res.destroyed) return
        offset += chunk.length
        if (responseMode === 'corrupt' && offset === size) chunk[chunk.length - 1] ^= 0x01
        if (responseMode === 'disconnect' && offset >= 5 * 1024 * 1024) { res.destroy(); return }
        if (!res.write(chunk)) await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.once('drain', done); res.once('close', done)
        })
        if (responseMode === 'stalled' && offset >= 4 * 1024 * 1024) {
          while (!res.destroyed) await sleep(100)
          return
        }
        if (holdDownload && offset <= 12 * 1024 * 1024) await sleep(220)
        if (offset >= 32 * 1024 * 1024) while (holdDownload && !res.destroyed) await sleep(80)
      }
      res.end()
    })().catch((err) => { record('HTTP server error', err.stack); res.destroy() })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(spec.port, '127.0.0.1', resolve))
}
async function stopFeed() {
  if (!server) return
  const stopping = server
  server = undefined
  stopping.closeAllConnections()
  await new Promise((resolve) => stopping.close(resolve))
}
const checkButton = (run) => click(run, '检查更新', updateSelector)
async function fixtureIntegrity() {
  for (const build of [spec.old, spec.next]) {
    assert.equal(realpathSync(build.unpacked), path.join(fixture, build.version, 'win-unpacked'))
    assert.equal(realpathSync(build.installer), path.join(fixture, build.version, `${spec.shortName}-Setup-${build.version}.exe`))
    assert.equal(statSync(build.installer).size, build.file.size)
    assert.equal(await sha512(build.installer), build.file.sha512)
    const source = yaml.load(readFileSync(path.join(build.unpacked, 'resources', 'app-update.yml'), 'utf8'))
    assert.deepEqual(source, { provider: 'generic', url: `http://127.0.0.1:${spec.port}/`, updaterCacheDirName: spec.cacheName, useMultipleRangeRequest: false })
  }
}

async function smokeUI() {
  const run = await useRun('ui')
  await fixtureIntegrity()
  let child = launch(run, oldExe)
  shutdown.add(child)
  const boot = await ready(run, oldExe)
  assert.equal(boot.packaged, true)
  await showSettings(run)
  assert.equal((await current(run)).autoCheck, true)
  assert.match(await render(run, `document.querySelector(${JSON.stringify(updateSelector)}).innerText`), /当前版本 0\.2\.0/)
  assert.equal(await render(run, `document.querySelector(${JSON.stringify(updateSelector + ' [role=status]')}).getAttribute('aria-live')`), 'polite')
  // Real automatic check with the server closed, including no modal/no banner and no retries during observation.
  await until(() => updaterLines(run).includes('automatic check failed network'), 'offline automatic check', 40_000)
  assert.equal((await current(run)).status, 'idle')
  assert.equal(await banner(run), '')
  assert.equal(eventList(run).filter((e) => e.event === 'native-messagebox').length, 0)
  assert.equal(updaterLines(run).match(/automatic check started/g)?.length, 1)
  await checkButton(run)
  assert.match((await state(run, 'error')).error, /连不上 GitHub/)
  await bothThemes(run, 'failed', /检查失败：连不上 GitHub/)
  await toggleAuto(run, false, true)
  await startFeed()
  const hitsAt = hits.length
  await sleep(16_000)
  assert.equal(hits.length, hitsAt, 'automatic network with switch disabled')
  assert.equal(updaterLines(run).match(/automatic check started/g)?.length, 1)
  record('OFFLINE and DISABLED PASS: automatic failure logged silently; no automatic HTTP request with switch off; manual failure rendered.')

  holdCheck = true
  await checkButton(run)
  await state(run, 'checking')
  await bothThemes(run, 'checking', /检查中/)
  holdCheck = false
  await state(run, 'current')
  await bothThemes(run, 'current', /已是最新版本/)
  assert.notEqual((await current(run)).lastCheckedAt, null)

  mode = 'disconnect'
  await checkButton(run)
  assert.match((await state(run, 'error')).error, /下载中断/)
  assert.ok(!(await tray(run)).includes(targetTray))
  assert.equal(await banner(run), '')
  mode = 'corrupt'
  await checkButton(run)
  assert.match((await state(run, 'error')).error, /校验失败/)
  assert.ok(!(await tray(run)).includes(targetTray))
  assert.equal(await banner(run), '')
  assert.ok(!eventList(run).some((e) => e.event === 'update-state' && e.info.status === 'downloaded'))
  await capture(run, 'checksum-rejected-dark', true, /校验失败/)
  record('CORRUPT and INTERRUPTED PASS: no ready state, banner, or install action.')

  mode = 'good'
  holdDownload = true
  await checkButton(run)
  await until(async () => { const s = await current(run); return s.status === 'downloading' && s.percent > 0 && s.percent < 100 }, 'progress reported before completing real download')
  for (const image of await bothThemes(run, 'downloading', /下载中 \d+%/)) assert.ok(image.progress > 0 && image.progress < 100)
  holdDownload = false
  const downloaded = await state(run, 'downloaded', 45_000)
  assert.equal(downloaded.release.version, spec.next.version)
  assert.equal(downloaded.percent, 100)
  assert.match(downloaded.release.notes, /更新计时/)
  assert.doesNotMatch(downloaded.release.notes, /example\.invalid|DO_NOT_SHOW|<script>/)
  assert.equal(downloaded.release.notesTruncated, true)
  const cached = path.join(run, 'local', spec.cacheName, 'pending', spec.next.file.url)
  assert.equal(await sha512(cached), spec.next.file.sha512)
  await bothThemes(run, 'downloaded', /已下载 0\.3\.0，待安装/)
  assert.ok((await tray(run)).includes(targetTray), 'tray must expose install action')
  await closeSettings(run)
  assert.match(await banner(run), /更新 0\.3\.0 已下载/)
  await capture(run, 'banner-dark', true, /./, false)
  assert.equal(await render(run, "document.querySelectorAll('dialog[open]').length"), 0)
  assert.equal(eventList(run).filter((e) => e.event === 'native-messagebox').length, 0)
  await click(run, '稍后', '.update-banner')
  assert.equal(await banner(run), '')
  assert.ok((await tray(run)).includes(targetTray))
  await command(run, 'reload')
  await ready(run, oldExe)
  assert.equal(await banner(run), '', 'later must survive renderer reload in the same run')
  assert.equal((await current(run)).autoCheck, false)
  assert.ok((await tray(run)).includes(targetTray))
  assert.equal(eventList(run).filter((e) => e.event === 'nsis-spawn').length, 0)
  assertClean(run)
  record('PACKAGED UI and DOWNLOAD PASS: actual renderer/IPC, real full download, SHA-512, tray, later, reload; no installer invoked.')
  await leave(run, child.pid, 86)
  await until(() => child.exitCode !== null, 'unpacked app exited without installing')
  assert.equal(child.exitCode, 86)
  shutdown.delete(child)

  child = launch(run, oldExe)
  shutdown.add(child)
  await ready(run, oldExe)
  assert.equal((await current(run)).autoCheck, false)
  const beforeDisabledBoot = hits.length
  await sleep(16_000)
  assert.equal(hits.length, beforeDisabledBoot, 'no automatic request on startup with the persisted switch off')
  assert.equal(updaterLines(run).match(/automatic check started/g)?.length, 1)
  record('DISABLED STARTUP PASS: persisted setting prevented networking past 15 seconds.')
  await leave(run, child.pid, 86)
  await until(() => child.exitCode !== null, 'reopened unpacked app exited')
  shutdown.delete(child)
  await stopFeed()
}

async function smokeDev() {
  const run = await useRun('dev')
  mode = 'current'
  await startFeed()
  const before = hits.length
  const exe = path.join(tree, 'node_modules', 'electron', 'dist', 'electron.exe')
  const child = launch(run, exe, [path.join(fixture, 'development')])
  shutdown.add(child)
  const info = await ready(run, exe)
  assert.equal(info.packaged, false)
  assert.equal((await current(run)).mode, 'development')
  await bothThemes(run, 'development', /开发版不支持自动更新/)
  assert.equal(await render(run, `document.querySelector(${JSON.stringify(updateSelector + ' button')}).disabled`), true)
  await render(run, 'window.api.update.check()')
  await sleep(16_000)
  assert.equal(hits.length, before)
  assert.equal(updaterLines(run), '')
  assert.equal((await current(run)).lastCheckedAt, null)
  assertClean(run)
  await leave(run, child.pid)
  await until(() => child.exitCode !== null, 'development app exited')
  assert.equal(child.exitCode, 0)
  shutdown.delete(child)
  record('DEVELOPMENT PASS: disabled state, two themes, no requests or check timestamp.')
  await stopFeed()
}

// Only inspect the independently generated NSIS identity and shortcuts, never the real app's registry or data.
function installation() {
  const code = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$n = $env:PLANREVIEW_SMOKE_NAME; $g = $env:PLANREVIEW_SMOKE_GUID
if ($n -cnotmatch '^PlanReviewUpdateSmoke-[a-f0-9]{10}$' -or $g -cnotmatch '^[a-f0-9-]{36}$') { throw 'invalid smoke identity' }
$i = 'HKCU:\Software\' + $g
$u = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $g
$install = if (Test-Path -LiteralPath $i) { Get-ItemProperty -LiteralPath $i }
$remove = if (Test-Path -LiteralPath $u) { Get-ItemProperty -LiteralPath $u }
$roots = @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))
$links = @(); $com = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (!(Test-Path -LiteralPath $root -PathType Container)) { continue }
  $folders = @($root, (Join-Path $root $n))
  foreach ($f in $folders) {
    if (!(Test-Path -LiteralPath $f -PathType Container)) { continue }
    foreach ($l in (Get-ChildItem -LiteralPath $f -Filter "$n*.lnk" -File)) {
      $lnk = $com.CreateShortcut($l.FullName)
      $links += @{ path=$l.FullName; target=$lnk.TargetPath; arguments=$lnk.Arguments }
    }
  }
}
$machine = (Test-Path -LiteralPath ('HKLM:\Software\' + $g)) -or (Test-Path -LiteralPath ('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $g))
$ids = @($n, "$n-Setup-0.2.0", "$n-Setup-0.3.0")
$processes = @(Get-Process -Name $ids -ErrorAction SilentlyContinue | ForEach-Object { @{ id=$_.Id; path=$_.Path; visible=($_.MainWindowHandle -ne 0); title=$_.MainWindowTitle } })
@{ install=$install.InstallLocation; guidPresent=($null -ne $install); uninstall=$remove.UninstallString; version=$remove.DisplayVersion; name=$remove.DisplayName; machine=$machine; links=$links; processes=$processes } | ConvertTo-Json -Depth 5 -Compress
`
  const escaped = Buffer.from(code, 'utf16le').toString('base64')
  return JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', escaped], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'], timeout: 12_000, env: { ...process.env, PLANREVIEW_SMOKE_NAME: spec.shortName, PLANREVIEW_SMOKE_GUID: spec.guid }
  }))
}
function assertInstall(info, version) {
  assert.equal(info.name, spec.shortName)
  assert.equal(info.version, version)
  assert.equal(info.machine, false)
  assert.equal(path.resolve(info.install).toLowerCase(), spec.install.toLowerCase())
  assert.equal(realpathSync(spec.install).toLowerCase(), spec.install.toLowerCase())
  assert.equal(info.links.length, 2)
  for (const link of info.links) {
    assert.equal(path.basename(link.path), `${spec.shortName}.lnk`)
    assert.equal(path.resolve(link.target).toLowerCase(), installExe.toLowerCase())
    assert.equal(link.arguments, '')
  }
}
function assertNoWizard(info) {
  assert.deepEqual(info.processes.filter((item) => item.visible && path.basename(item.path ?? '').startsWith(`${spec.shortName}-Setup-`)), [])
}
async function waitChild(p, why, expected = 0) {
  await until(() => p.exitCode !== null || p.signalCode !== null, why, 85_000)
  assert.equal(p.exitCode, expected, `${why}: exit code`)
  shutdown.delete(p)
}
async function installOld(run, existing) {
  const info = installation()
  assert.equal(info.machine, false)
  if (existing) assertInstall(info, spec.next.version)
  else {
    assert.equal(info.guidPresent, false)
    assert.equal(info.uninstall, null)
    assert.equal(info.links.length, 0)
    assert.equal(existsSync(spec.install), false)
  }
  assert.deepEqual(info.processes, [])
  const args = ['/S', '/currentuser', `/D=${spec.install}`]
  assert.equal(path.dirname(realpathSync(spec.old.installer)), path.join(fixture, spec.old.version))
  assert.equal(await sha512(spec.old.installer), spec.old.file.sha512)
  assert.match(spec.install, /^[A-Za-z]:\\[^\r\n]+\\electron-[a-f0-9]{10}\\isolated-install$/)
  record('ALLOW isolated base install only', { executable: spec.old.installer, args, guid: spec.guid, appId: spec.appId })
  const installer = childTrace(spawn(spec.old.installer, args, { cwd: run, env: testEnv(run), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] }), run, 'base-installer')
  shutdown.add(installer)
  await waitChild(installer, 'isolated base NSIS installer')
  const after = installation()
  assertInstall(after, spec.old.version)
  assertNoWizard(after)
  assert.equal(await sha512(installExe), await sha512(oldExe))
  assert.equal(await readFile(path.join(spec.install, 'resources', 'app-update.yml'), 'utf8'), await readFile(path.join(spec.old.unpacked, 'resources', 'app-update.yml'), 'utf8'))
  record('INSTALLED base with separate registry, directory, shortcuts:', after)
}
function dbContents(run, filename = 'plan-review.db') {
  const dir = appData(run)
  assert.equal(realpathSync(dir), dir)
  const file = path.join(dir, filename)
  assert.ok(realpathSync(file).startsWith(dir + path.sep))
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const version = db.prepare('PRAGMA user_version').get().user_version
    const contents = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      assert.match(name, /^[a-z_]+$/)
      const where = name === 'settings' ? "WHERE key NOT IN ('lastRunVersion','updateRestartTarget') " : ''
      return [name, db.prepare(`SELECT * FROM ${name} ${where}ORDER BY rowid`).all()]
    }))
    return { version, contents, hash: createHash('sha256').update(JSON.stringify(contents)).digest('hex') }
  } finally { db.close() }
}
async function seeded(run, label) {
  await render(run, "window.api.settings.update({closeToTray:true,strongSound:false,leaveEnabled:false,blockReminders:false,floatingEnabled:true,launchAtLogin:false})")
  await toggleAuto(run, false)
  const completed = { title: `保留的历史记录 ${label}`, startAt: new Date(Date.now() - 120 * 60_000).toISOString(), endAt: new Date(Date.now() - 110 * 60_000).toISOString() }
  const entry = await render(run, `window.api.entries.create(${JSON.stringify(completed)})`)
  assert.ok(entry.id)
  const running = await render(run, `window.api.entries.start(${JSON.stringify({ title: `更新中的计时 ${label}`, durationMin: 180 })})`)
  assert.equal(running.endAt, null)
  assert.ok(running.id && running.startAt && running.targetEndAt)
  await until(async () => (await command(run, 'info')).windows.some((url) => url.endsWith('#timer')), 'timer window active')
  const actual = await render(run, 'window.api.entries.running()')
  assert.deepEqual(actual, running)
  return running
}
async function backupAfter(run, expected) {
  const directory = path.join(appData(run), 'backups')
  const files = (await readdir(directory)).filter((name) => /^before-update-0\.3\.0-.*\.db$/.test(name))
  assert.equal(files.length, 1)
  const snapshot = dbContents(run, path.join('backups', files[0]))
  assert.equal(snapshot.hash, expected.hash)
  assert.equal(snapshot.version, expected.version)
  record('BACKUP integrity and application data hash:', path.join(directory, files[0]), snapshot.hash)
}
async function readyToInstall(run) {
  await writeFile(path.join(run, 'installer-authorization.json'), JSON.stringify({ name: spec.next.file.url, sha512: spec.next.file.sha512 }))
  await showSettings(run)
  await checkButton(run)
  await state(run, 'downloaded', 45_000)
  await closeSettings(run)
  await until(async () => (await banner(run)).includes(`更新 ${spec.next.version} 已下载`), 'downloaded banner without focus grab')
  assert.ok((await tray(run)).includes(targetTray))
  assert.equal(eventList(run).filter(({ event }) => ['nsis-spawn','native-messagebox','quit'].includes(event)).length, 0)
  assert.equal(existsSync(path.join(appData(run), 'backups')), false)
}
async function confirmedUpdate(run, response, realDialog = false) {
  const before = eventList(run).length
  if (!realDialog) await writeFile(path.join(run, 'next-update-choice.json'), JSON.stringify({ response }), { flag: 'wx' })
  // The explicit install acceptance result is injected in the isolated test build only. The production IPC,
  // checkpoint, NSIS process and restart stay real. The real native dialog can be shown and cancelled separately.
  if (realDialog) await click(run, '重启并更新', '.update-banner')
  else await render(run, 'void window.api.update.restart(); true')
  const event = realDialog ? 'native-messagebox' : 'fixture-messagebox-choice'
  const opened = await until(() => eventList(run).slice(before).find((e) => e.event === event), 'confirmation requested')
  assert.match(opened.info.message, /正在计时/)
  assert.match(opened.info.detail, /先保存当前计时/)
  assert.deepEqual(opened.info.buttons, ['重启并更新','取消'])
  if (realDialog) {
    assert.equal(response, 1, 'this test must only cancel the actual dialog')
    record('ACTION REQUIRED: cancel the real confirmation in the isolated test app only.', { pid: opened.pid, name: spec.shortName })
    const choice = await until(() => eventList(run).slice(before).find((e) => e.event === 'native-messagebox-result'), 'native confirmation choice', 240_000)
    assert.equal(choice.info, response)
  } else {
    assert.equal(opened.info.response, response)
    record('FIXTURE confirmation response (not a native button click)', response)
  }
}
async function verifyTransition(run, exited, wasExplicit, before) {
  await waitChild(exited, 'old app quit completely')
  const sequence = eventList(run).filter((e) => e.pid === exited.pid)
  const installer = sequence.find((e) => e.event === 'nsis-spawn')
  assert.ok(installer?.info.child)
  assert.deepEqual(installer.info.args, wasExplicit ? ['--updated','/S','--force-run'] : ['--updated','/S'])
  assert.equal(installer.info.sha512, spec.next.file.sha512)
  assert.ok(sequence.some((e) => e.event === 'before-quit'))
  assert.ok(sequence.some((e) => e.event === 'will-quit'))
  const final = sequence.find((e) => e.event === 'quit' && e.info === 0)
  assert.ok(final, 'old Electron app emitted quit and exited 0')
  const seenInstall = sequence.indexOf(installer)
  const seenQuit = sequence.indexOf(final)
  assert.equal(wasExplicit, seenInstall < seenQuit)
  const updater = updaterLines(run)
  const snapshot = updater.indexOf('before update database snapshot saved')
  const start = updater.indexOf(wasExplicit ? 'nsis explicit update requested' : 'nsis automatic install on exit')
  assert.ok(snapshot !== -1 && start > snapshot, 'database snapshot must complete before the installer is requested')
  await backupAfter(run, before)
  await until(() => {
    const info = installation()
    assertNoWizard(info)
    return !info.processes.some((p) => p.id === installer.info.child) && info.version === spec.next.version && info
  }, 'silent NSIS installer completed without a wizard', 85_000)
  const afterState = installation()
  assertInstall(afterState, spec.next.version)
  assertNoWizard(afterState)
  assert.equal(await sha512(installExe), await sha512(path.join(spec.next.unpacked, exeName)))
  assert.equal(await sha512(path.join(spec.install, 'resources', 'app.asar')), await sha512(path.join(spec.next.unpacked, 'resources', 'app.asar')))
  record('NSIS complete with same install path and 2 test shortcuts:', installer.info, afterState)
  return afterState
}
async function verifyAfter(run, expected, running, expectNotice) {
  const main = await ready(run, installExe, spec.next.version)
  assert.equal(main.visible, true)
  assert.equal((await current(run)).currentVersion, spec.next.version)
  if (expectNotice) await until(async () => (await banner(run)).includes(`已更新到 ${spec.next.version}`), 'one-time success banner')
  else assert.equal(await banner(run), '')
  const recovered = await render(run, 'window.api.entries.running()')
  assert.deepEqual(recovered, running)
  const after = dbContents(run)
  assert.equal(after.version, expected.version)
  assert.deepEqual(after.contents, expected.contents)
  assert.equal(after.hash, expected.hash)
  record('ALL application tables and active timer preserved', { tables: Object.keys(after.contents), hash: after.hash, running: recovered })
  assertClean(run)
}
async function cleanupTestInstall(run, version = spec.next.version) {
  const info = installation()
  assertInstall(info, version)
  assert.deepEqual(info.processes, [])
  const known = [spec.old, spec.next].find((build) => build.version === version)
  assert.equal(await sha512(installExe), await sha512(path.join(known.unpacked, exeName)))
  assert.equal(await sha512(path.join(spec.install, 'resources', 'app.asar')), await sha512(path.join(known.unpacked, 'resources', 'app.asar')))
  const prefix = `"${spec.install}${path.sep}Uninstall ${spec.shortName}.exe"`
  assert.equal(info.uninstall, `${prefix} /currentuser`)
  const file = prefix.slice(1,-1)
  assert.equal(realpathSync(file).toLowerCase(), file.toLowerCase())
  assert.equal(path.dirname(file), spec.install)
  const p = childTrace(spawn(file, ['/S', '/currentuser'], { cwd: run, env: testEnv(run), windowsHide: true, stdio: ['ignore','pipe','pipe'] }), run, 'test-uninstaller')
  shutdown.add(p)
  await waitChild(p, 'isolated uninstaller')
  await until(() => {
    const clean = installation()
    return !clean.guidPresent && !clean.uninstall && !clean.links.length && !existsSync(installExe)
  }, 'isolated test shortcuts, registry, and program removed')
  record('CLEANED only the test NSIS identity; sandbox databases and verification evidence kept.')
}
async function smokeInstall() {
  await fixtureIntegrity()
  mode = 'good'
  await startFeed()
  let run = await useRun('install-explicit')
  await installOld(run, false)
  let child = launch(run, installExe)
  shutdown.add(child)
  await ready(run, installExe)
  let running = await seeded(run, '立即更新')
  await readyToInstall(run)
  let before = dbContents(run)
  await confirmedUpdate(run, 1, process.argv.includes('--native-cancel'))
  assert.equal(child.exitCode, null)
  assert.ok(!eventList(run).some((e) => e.event === 'nsis-spawn' || e.event === 'before-quit'))
  assert.deepEqual(await render(run, 'window.api.entries.running()'), running)
  assert.equal(existsSync(path.join(appData(run), 'backups')), false)
  await confirmedUpdate(run, 0)
  const installed = await verifyTransition(run, child, true, before)
  await verifyAfter(run, before, running, true)
  const relaunch = await until(() => eventList(run).find((e) => e.event === 'isolation-before-entry' && e.info.version === spec.next.version), 'installer-launched app PID')
  assert.notEqual(relaunch.pid, child.pid)
  assert.equal(installed.links.length, 2)
  await command(run, 'tray-click', { label: '退出' })
  await until(() => eventList(run).find((e) => e.event === 'quit' && e.pid === relaunch.pid && e.info === 0), 'installer-launched app quit')
  await until(() => installation().processes.length === 0, 'installer-launched process ended')
  child = launch(run, installExe, ['--hidden'])
  shutdown.add(child)
  // Same version starts hidden on explicit --hidden after the one-time notification was consumed.
  await until(async () => (await command(run, 'info')).version === spec.next.version, 'next restart version')
  assert.equal((await command(run, 'info')).visible, false)
  await command(run, 'tray-click', { label: '打开主窗口' })
  await ready(run, installExe, spec.next.version)
  assert.equal(await banner(run), '')
  await leave(run, child.pid)
  await waitChild(child, 'next app after the one-time notice')
  record('EXPLICIT INSTALL PASS: cancellation, then fixture confirmation; actual silent installer relaunched app and restored timer; one-time notice consumed.')

  run = await useRun('install-on-quit')
  await installOld(run, true)
  child = launch(run, installExe)
  shutdown.add(child)
  await ready(run, installExe)
  running = await seeded(run, '退出安装')
  await readyToInstall(run)
  before = dbContents(run)
  await click(run, '稍后', '.update-banner')
  assert.equal(await banner(run), '')
  assert.equal(await command(run, 'close-to-tray'), true)
  assert.equal(child.exitCode, null)
  assert.ok(!eventList(run).some((e) => e.event === 'nsis-spawn'))
  await command(run, 'tray-click', { label: '退出' })
  await verifyTransition(run, child, false, before)
  assert.ok(!eventList(run).some((e) => e.event === 'native-messagebox'))
  assert.ok(!eventList(run).some((e) => e.event === 'isolation-before-entry' && e.info.version === spec.next.version), 'normal exit must not relaunch without user choosing restart')
  child = launch(run, installExe)
  shutdown.add(child)
  await verifyAfter(run, before, running, false)
  await leave(run, child.pid)
  await waitChild(child, 'normal-start app after exit update')
  record('INSTALL ON QUIT PASS: close-to-tray did not install; normal tray exit installed silently; subsequent launch resumed timer and kept same data and shortcuts.')
  await cleanupTestInstall(run)
}

async function run() {
  const scenario = process.argv[2]
  assert.ok(['ui', 'dev', 'install', 'recover-isolated-install'].includes(scenario))
  if (scenario === 'recover-isolated-install') {
    const checkpoint = await useRun('recover')
    await fixtureIntegrity()
    const info = installation()
    assert.ok([spec.old.version, spec.next.version].includes(info.version))
    await cleanupTestInstall(checkpoint, info.version)
  }
  if (scenario === 'ui') await smokeUI()
  if (scenario === 'dev') await smokeDev()
  if (scenario === 'install') await smokeInstall()
}
try { await run() }
catch (err) { record('FAIL', err.stack || String(err)); process.exitCode = 1 }
finally {
  holdCheck = false
  holdDownload = false
  await stopFeed()
  // Only stop direct test children. No global process-name matching or formal app is touched.
  for (const child of shutdown) if (child.exitCode === null) child.kill()
}
