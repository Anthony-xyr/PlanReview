import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import yaml from 'js-yaml'

const dist = 'dist'
const workflow = yaml.load(await readFile('.github/workflows/build.yml', 'utf8'))
const patterns = (job, action, key) => workflow.jobs[job].steps.find((step) => step.uses?.startsWith(`${action}@`)).with[key].trim().split(/\s+/)
const upload = patterns('build-windows', 'actions/upload-artifact', 'path')
const macUpload = patterns('build-macos', 'actions/upload-artifact', 'path')
const release = patterns('release', 'softprops/action-gh-release', 'files')
const matches = (name, globs) => globs.some((pattern) => posix.matchesGlob(`${dist}/${name}`, pattern))
const safeName = /^[A-Za-z0-9_.-]+$/

async function checksum(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function verifyFile(dir, entry) {
  assert.ok(typeof entry.url === 'string' && safeName.test(entry.url), '更新清单文件名不可有路径、空格或 URL 编码')
  const file = `${dir}/${entry.url}`
  const actual = await stat(file)
  assert.ok(actual.isFile(), `产物不是文件：${file}`)
  if (entry.size !== undefined) assert.equal(actual.size, entry.size, `大小不一致：${file}`)
  assert.equal(await checksum(file), entry.sha512, `SHA-512 不一致：${file}`)
}

const entries = await readdir(dist, { withFileTypes: true })
const localFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
const manifest = yaml.load(await readFile(`${dist}/latest.yml`, 'utf8'))
assert.equal(manifest.files?.length, 1, 'Windows 应有一个 x64 NSIS 安装包')
const installer = manifest.files[0]
await verifyFile(dist, installer)
assert.match(installer.url, /^PlanReview-Setup-[0-9A-Za-z.+-]+\.exe$/)
assert.equal(manifest.path, installer.url)
assert.equal(manifest.sha512, installer.sha512)
const required = [installer.url, 'latest.yml', `${installer.url}.blockmap`]
for (const name of required) {
  assert.ok(localFiles.includes(name) && (await stat(`${dist}/${name}`)).size > 0, `缺少 Windows 文件 ${name}`)
  assert.ok(matches(name, upload) && matches(name, release), `Windows 上传和发布规则未覆盖 ${name}`)
  console.log(`Windows 上传和发布选中：${name}`)
}
for (const name of ['PlanReview-TARGET-arm64.dmg', 'latest-mac.yml', 'PlanReview-TARGET-arm64.dmg.blockmap']) {
  assert.ok(matches(name, macUpload) && matches(name, release), `Mac 上传和发布规则未覆盖 ${name}`)
}
console.log(`Windows 安装包 SHA-512（Base64）：${installer.sha512}`)

if (process.argv.includes('--prepare-release')) {
  // 两种架构的同名清单先分目录下载；发布只使用一个清单，并集齐可用架构。
  const root = `${dist}/macos-artifacts`
  let dirs
  try { dirs = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error; dirs = [] }
  const macFiles = new Map()
  for (const dir of dirs.filter((item) => item.isDirectory() && item.name.startsWith('PlanReview-macOS-'))) {
    const path = `${root}/${dir.name}`
    try {
      const assets = (await readdir(path, { withFileTypes: true })).filter((asset) => asset.isFile()).map((asset) => asset.name)
      for (const name of assets.filter((asset) => /^PlanReview-[0-9A-Za-z.+-]+-(?:arm64|x64)\.dmg(?:\.blockmap)?$/.test(asset))) {
        if (matches(name, release)) await copyFile(`${path}/${name}`, `${dist}/${name}`)
      }
      if (!assets.includes('latest-mac.yml')) continue
      const mac = yaml.load(await readFile(`${path}/latest-mac.yml`, 'utf8'))
      assert.equal(mac.version, manifest.version, 'Windows 与 Mac 版本号不同')
      for (const item of mac.files) {
        assert.match(item.url, /^PlanReview-[0-9A-Za-z.+-]+-(?:arm64|x64)\.dmg$/)
        await verifyFile(path, item)
        macFiles.set(item.url, item)
      }
    } catch (error) {
      // Mac 打包或其可选更新清单失败，不挡已验证的 Windows 发布。
      console.warn(`未能收集完整 Mac 清单（${dir.name}）：${error.message}`)
    }
  }
  if (macFiles.size) {
    const files = [...macFiles.values()].sort((a, b) => a.url.localeCompare(b.url))
    await writeFile(`${dist}/latest-mac.yml`, yaml.dump({ version: manifest.version, files, path: files[0].url, sha512: files[0].sha512,
      releaseDate: manifest.releaseDate }))
    console.log(`Mac 发布清单：${files.map((file) => file.url).join(', ')}`)
  } else console.log('没有可用的 Mac 更新清单，不阻止发布 Windows。')
}
