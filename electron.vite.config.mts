import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(import.meta.dirname, 'src/shared') }

const require = createRequire(import.meta.url)
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))

function pdfjsAssetsPlugin(): Plugin {
  const cmapsDir = join(pdfjsDir, 'cmaps')
  const fontsDir = join(pdfjsDir, 'standard_fonts')
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        let targetDir: string | null = null
        let relPath = ''
        if (url.startsWith('/cmaps/')) {
          targetDir = cmapsDir
          relPath = url.slice('/cmaps/'.length)
        } else if (url.startsWith('/standard_fonts/')) {
          targetDir = fontsDir
          relPath = url.slice('/standard_fonts/'.length)
        }
        if (targetDir) {
          const filePath = join(targetDir, relPath.split('?')[0])
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            res.setHeader('Content-Type', 'application/octet-stream')
            return createReadStream(filePath).pipe(res)
          }
        }
        next()
      })
    },
    closeBundle() {
      const outCmaps = resolve(import.meta.dirname, 'out/renderer/cmaps')
      const outFonts = resolve(import.meta.dirname, 'out/renderer/standard_fonts')
      cpSync(cmapsDir, outCmaps, { recursive: true })
      cpSync(fontsDir, outFonts, { recursive: true })
    }
  }
}

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), pdfjsAssetsPlugin()]
  }
})
