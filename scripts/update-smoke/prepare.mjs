import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import yaml from 'js-yaml'

const tree = await realpath(process.cwd())
assert.equal(process.platform, 'win32')
assert.equal(path.basename(tree), 'auto-update')
assert.equal(path.basename(path.dirname(tree)), 'PlanReview-wt')
const evidence = path.join(tree, 'dist', 'update-verify')
assert.equal(await realpath(evidence), evidence)
const id = randomBytes(5).toString('hex')
const guid = randomUUID()
const root = path.join(evidence, `electron-${id}`)
await mkdir(root)
assert.equal(await realpath(root), root)
const loopback = createServer()
await new Promise((resolve, reject) => loopback.listen(0, '127.0.0.1', resolve).once('error', reject))
const port = loopback.address().port
await new Promise((resolve) => loopback.close(resolve))
const base = `http://127.0.0.1:${port}/`
const shortName = `PlanReviewUpdateSmoke-${id}`
const settings = { id, root, port, shortName, appId: `io.planreview.autoupdate.smoke.${id}`, guid,
  cacheName: `planreview-update-smoke-${id}-updater`, install: path.join(root, 'isolated-install') }
const temp = path.join(root, 'build-temp')
await mkdir(temp)
process.env.TEMP = temp
process.env.TMP = temp
const { build, Arch, Platform } = await import('electron-builder')
const { extractFile, listPackage } = await import('@electron/asar')
const production = yaml.load(await readFile('electron-builder.yml', 'utf8'))
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(manifest.version, '0.2.0')
assert.notEqual(settings.appId, production.appId)
assert.notEqual(settings.shortName, production.nsis.shortcutName)
assert.equal(production.nsis.oneClick, false)
assert.equal(production.nsis.perMachine, false)
assert.equal(production.nsis.allowToChangeInstallationDirectory, true)
const builtMain = await readFile('out/main/index.js')
const productionAsar = path.join(tree, 'dist', 'win-unpacked', 'resources', 'app.asar')
const entries = listPackage(productionAsar).map((p) => p.replaceAll('\\', '/'))
for (const file of ['node_modules/electron-updater/package.json', 'node_modules/marked/package.json', 'node_modules/parse5/package.json']) {
  assert.ok(entries.includes('/' + file), `missing /${file}`)
}
assert.ok(entries.some((p) => p.endsWith('/koffi.node')))
assert.ok(!entries.some((p) => /update-smoke|entry\.cjs/.test(p)))
assert.deepEqual(extractFile(productionAsar, path.join('out', 'main', 'index.js')), builtMain)
assert.equal(JSON.parse(extractFile(productionAsar, path.join('node_modules', 'electron-updater', 'package.json'))).version, manifest.dependencies['electron-updater'])
const origin = yaml.load(await readFile(path.join(tree, 'dist/win-unpacked/resources/app-update.yml'), 'utf8'))
assert.deepEqual(Object.fromEntries(['provider', 'owner', 'repo', 'releaseType'].map((key) => [key, origin[key]])),
  { provider: 'github', owner: 'Anthony-xyr', repo: 'PlanReview', releaseType: 'release' })
console.log('Production package: electron-updater', manifest.dependencies['electron-updater'], 'marked, parse5, native koffi and fixed GitHub source; no fixture entry.')

const testEntry = 'out/update-smoke-entry.cjs'
const fixtureSource = path.join(tree, 'scripts/update-smoke/entry.cjs')
const feedConfig = yaml.dump({ provider: 'generic', url: base, updaterCacheDirName: settings.cacheName, useMultipleRangeRequest: false })
async function checksum(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

// Create fixture-only entries under dist and add them with a Builder FileSet; never edit formal package.json or production files.
const bootFiles = path.join(root, 'test-entry')
await mkdir(bootFiles)
await copyFile(fixtureSource, path.join(bootFiles, 'update-smoke-entry.cjs'))
const old = manifest.version
for (const version of [old, '0.3.0']) {
  const output = path.join(root, version)
  const config = { ...production, appId: settings.appId, productName: shortName, executableName: shortName,
    directories: { ...production.directories, output },
    extraMetadata: { name: settings.cacheName.replace(/-updater$/, ''), productName: shortName, version,
      main: testEntry, planReviewUpdateFixture: { id, root } },
    files: [...production.files, { from: bootFiles, to: 'out', filter: ['update-smoke-entry.cjs'] }],
    win: { ...production.win, artifactName: `${shortName}-Setup-\${version}.\${ext}` },
    nsis: { ...production.nsis, guid, shortcutName: shortName, menuCategory: shortName, uninstallDisplayName: shortName } }
  await build({ targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config, publish: 'never' })
  const unpacked = path.join(output, 'win-unpacked')
  const metadata = path.join(unpacked, 'resources', 'app-update.yml')
  const asar = path.join(unpacked, 'resources', 'app.asar')
  const pkg = JSON.parse(extractFile(asar, 'package.json'))
  assert.equal(pkg.version, version)
  assert.equal(pkg.main, testEntry)
  assert.equal(pkg.productName, shortName)
  assert.deepEqual(extractFile(asar, path.join('out', 'main', 'index.js')), builtMain, 'test package must use the exact app main output')
  assert.deepEqual(extractFile(asar, path.normalize(testEntry)), await readFile(fixtureSource))
  // A3: the only test-feed change is made here, to the unpacked test copy.
  await writeFile(metadata, feedConfig)
  await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, prepackaged: unpacked, publish: 'never' })
  assert.equal(await readFile(metadata, 'utf8'), feedConfig)
  const yml = await readFile(path.join(output, 'latest.yml'), 'utf8')
  const info = yaml.load(yml)
  const file = info.files[0]
  assert.equal(info.version, version)
  assert.equal(file.url, `${shortName}-Setup-${version}.exe`)
  const installer = path.join(output, file.url)
  assert.equal((await stat(installer)).size, file.size)
  assert.equal(await checksum(installer), file.sha512)
  settings[version === old ? 'old' : 'next'] = { version, unpacked, installer, yml, file }
  console.log('Isolated pack verified:', JSON.stringify({ version, unpacked, appId: settings.appId, guid, shortcut: shortName,
    sha512: file.sha512, installer, loopback: base }))
}

// A development-only Electron launch is built from the same test harness; no production URL is present.
const dev = path.join(root, 'development')
await mkdir(dev)
await copyFile(fixtureSource, path.join(dev, 'entry.cjs'))
// entry resolves fixture metadata as ../package.json for both package layouts.
await writeFile(path.join(root, 'package.json'), JSON.stringify({ planReviewUpdateFixture: { id, root, development: true } }))
await writeFile(path.join(dev, 'package.json'), JSON.stringify({ name: settings.cacheName.replace(/-updater$/, ''), version: old, main: 'entry.cjs' }))
await writeFile(path.join(root, 'fixture.json'), JSON.stringify(settings, null, 2) + '\n')
await writeFile(path.join(evidence, 'latest-electron-fixture.txt'), root + '\n')
console.log('Fixture ready:', root)
