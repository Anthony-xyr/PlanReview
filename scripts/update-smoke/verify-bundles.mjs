import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import yaml from 'js-yaml'

const tree = realpathSync(process.cwd())
assert.equal(path.basename(tree), 'auto-update')
assert.equal(path.basename(path.dirname(tree)), 'PlanReview-wt')
const evidence = path.join(tree, 'dist', 'update-verify', 'round2')
const fixture = realpathSync(readFileSync(path.join(evidence, 'latest-electron-fixture.txt'), 'utf8').trim())
assert.equal(path.dirname(fixture), evidence)
const spec = JSON.parse(readFileSync(path.join(fixture, 'fixture.json'), 'utf8'))
assert.equal(spec.root, fixture)
assert.equal(fixture, path.join(evidence, `electron-${spec.id}`))

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name)
    return entry.isDirectory() ? filesIn(child) : [child]
  })
}

const hash = (data) => createHash('sha256').update(data).digest('hex')
const outputs = filesIn(path.join(tree, 'out'))
assert.ok(outputs.length > 10)
const oldOverride = /showMessageBox(?:Sync)?|next-update-choice\.json|fixture-messagebox-choice|native-messagebox-result/
const testMarker = /planReviewUpdateFixture|update-smoke-trusted-input|installer-authorization\.json/
for (const [label, directory] of Object.entries({
  production: path.join(tree, 'dist', 'win-unpacked'),
  old: spec.old.unpacked,
  next: spec.next.unpacked
})) {
  const archive = path.join(directory, 'resources', 'app.asar')
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString())
  const config = yaml.load(readFileSync(path.join(directory, 'resources', 'app-update.yml'), 'utf8'))
  for (const file of outputs) {
    const name = path.relative(tree, file)
    const bytes = extractFile(archive, name)
    assert.equal(hash(bytes), hash(readFileSync(file)), `${label} has different application bytes: ${name}`)
    if (name.startsWith(path.join('out', 'main')) || name.startsWith(path.join('out', 'preload'))) {
      assert.doesNotMatch(bytes.toString(), oldOverride, `${label} has an old confirmation hook: ${name}`)
      assert.doesNotMatch(bytes.toString(), testMarker, `${label} has a test-only entry point: ${name}`)
    }
  }
  console.log(`${label}: ${outputs.length} application build files match SHA-256 with out/`)
  if (label === 'production') {
    assert.equal(metadata.main, 'out/main/index.js')
    assert.equal(metadata.version, '0.2.0')
    assert.doesNotMatch(JSON.stringify(metadata), testMarker)
    assert.deepEqual(config, {
      provider: 'github', owner: 'Anthony-xyr', repo: 'PlanReview', releaseType: 'release', updaterCacheDirName: 'plan-review-updater'
    })
    const main = extractFile(archive, path.join('out', 'main', 'index.js')).toString()
    assert.match(main, /new NsisUpdater\(\)/)
    assert.match(main, /https:\/\/api\.github\.com\/repos\/Anthony-xyr\/PlanReview\/releases\/latest/)
    assert.doesNotMatch(main, /setFeedURL|forceDevUpdateConfig|updateConfigPath|UPDATE_(?:URL|FEED|PROVIDER)|--update-(?:url|feed|provider)/i)
    assert.match(main, /update:respondToRestart/)
    const updaterPackage = path.join('node_modules', 'electron-updater', 'package.json')
    assert.equal(JSON.parse(extractFile(archive, updaterPackage).toString()).version, '6.8.12')
    const listing = listPackage(archive).map((name) => name.replaceAll('\\', '/'))
    assert.ok(!listing.some((name) => /update-smoke|node_modules\/jsdom\//.test(name)))
    console.log('Production: electron-updater 6.8.12 and public GitHub app-update.yml; no application feed override, native update dialog, fixture entry or confirmation-result injection.')
  } else {
    assert.equal(metadata.main, 'out/update-smoke-entry.cjs')
    const entry = extractFile(archive, path.normalize(metadata.main)).toString()
    assert.doesNotMatch(entry, oldOverride)
    assert.match(entry, /web\.sendInputEvent/)
    assert.deepEqual(config, {
      provider: 'generic', url: `http://127.0.0.1:${spec.port}/`, updaterCacheDirName: spec.cacheName, useMultipleRangeRequest: false
    })
    console.log(`${label}: isolated loopback config and Electron input harness; no confirmation-result injection.`)
  }
}
