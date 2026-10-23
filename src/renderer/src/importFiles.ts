import type { ImportFile } from '@shared/types'

/** 图片最长边，够看清课表又不至于太大 */
const MAX_IMAGE_SIDE = 2000
/** 扫描版 PDF 最多转几页图片 */
const MAX_PDF_IMAGE_PAGES = 3
const MAX_FILE_BYTES = 20 * 1024 * 1024

export const ACCEPT = '.png,.jpg,.jpeg,.webp,.bmp,.pdf,.xlsx,.xls,.csv,.txt'

/** 把用户选的文件读成模型能吃的形式：图片 → data URL，PDF / 表格 → 文本 */
export async function readImportFile(file: File): Promise<ImportFile[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`「${file.name}」超过 20MB`)
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    return [{ name: file.name, kind: 'image', content: await imageToDataUrl(file) }]
  }
  if (ext === 'pdf') return readPdf(file)
  if (['xlsx', 'xls'].includes(ext)) return [{ name: file.name, kind: 'text', content: await readSheet(file) }]
  if (['csv', 'txt'].includes(ext)) return [{ name: file.name, kind: 'text', content: await file.text() }]
  throw new Error(`不支持「${file.name}」这种文件，请用图片、PDF、Excel 或文本`)
}

async function imageToDataUrl(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  return canvas.toDataURL('image/jpeg', 0.9)
}

async function readSheet(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  // 每个工作表转成 CSV，合并单元格的值会出现在左上角那格
  return wb.SheetNames.map((n) => `## 工作表：${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join('\n\n')
}

async function readPdf(file: File): Promise<ImportFile[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: './cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './standard_fonts/',
    useWorkerFetch: false
  })
  const doc = await task.promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      // 按行还原：y 坐标相同的放一行，用制表符隔开，表格结构能保留个大概
      const rows = new Map<number, { x: number; s: string }[]>()
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue
        const y = Math.round(it.transform[5])
        const row = rows.get(y) ?? []
        row.push({ x: it.transform[4], s: it.str })
        rows.set(y, row)
      }
      const lines = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r.sort((a, b) => a.x - b.x).map((c) => c.s).join('\t'))
      pages.push(lines.join('\n'))
    }
    const text = pages.join('\n\n')
    // 文字太少，大概是扫描件：转成图片
    if (text.replace(/\s/g, '').length >= 30) return [{ name: file.name, kind: 'text', content: text }]
    const out: ImportFile[] = []
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_IMAGE_PAGES); i++) {
      const page = await doc.getPage(i)
      const vp0 = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: Math.min(2.5, MAX_IMAGE_SIDE / Math.max(vp0.width, vp0.height)) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
      out.push({ name: `${file.name} 第${i}页`, kind: 'image', content: canvas.toDataURL('image/jpeg', 0.9) })
    }
    return out
  } finally {
    await task.destroy()
  }
}
