import { MAX_BACKGROUND_EDGE, MAX_BACKGROUND_FILE_BYTES, MAX_BACKGROUND_IMAGE_BYTES } from '@shared/background'

async function rasterType(file: File): Promise<string | null> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const matches = (offset: number, signature: number[]) => signature.every((byte, i) => header[offset + i] === byte)
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png'
  if (matches(0, [255, 216, 255])) return 'image/jpeg'
  if (matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])) return 'image/webp'
  return null
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取背景图片失败'))
    reader.readAsDataURL(blob)
  })
}

/** 在渲染进程缩放并重新编码，保存的是独立副本，不依赖原文件路径。 */
export async function prepareBackgroundImage(file: File): Promise<string> {
  if (file.size > MAX_BACKGROUND_FILE_BYTES) throw new Error('请选择不超过 20 MB 的图片')
  const type = await rasterType(file)
  if (!type) throw new Error('请选择一张有效的 JPG、PNG 或 WebP 图片')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file.slice(0, file.size, type), { imageOrientation: 'from-image' })
  } catch {
    throw new Error('无法打开这张图片，请检查文件是否损坏')
  }

  const canvas = document.createElement('canvas')
  try {
    const scale = Math.min(1, MAX_BACKGROUND_EDGE / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法处理这张图片，请尝试换一张')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const encode = (quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
    let result = await encode(0.88)
    if (result && result.size > MAX_BACKGROUND_IMAGE_BYTES) result = await encode(0.72)
    if (!result || result.type !== 'image/webp' || result.size > MAX_BACKGROUND_IMAGE_BYTES) {
      throw new Error('无法保存这张图片，请尝试尺寸更小的图片')
    }
    return await dataUrl(result)
  } finally {
    bitmap.close()
    canvas.width = canvas.height = 0
  }
}
