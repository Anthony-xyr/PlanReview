const INPUT_LIMIT = 32_000
const OUTPUT_LIMIT = 1200
const BLOCK = new Set(['p', 'div', 'li', 'br', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'hr'])
const IGNORE = new Set(['script', 'style', 'iframe', 'object', 'template', 'svg', 'math', 'noscript', 'head'])

/** 在主进程解析，不创建浏览器 DOM，也不加载说明里的任何远程内容。 */
export async function releaseNotes(raw: string | null | undefined): Promise<{ notes: string; notesTruncated: boolean }> {
  if (!raw?.trim()) return { notes: '', notesTruncated: false }
  const [{ parse }, { parseFragment }] = await Promise.all([import('marked'), import('parse5')])
  const tree = parseFragment(parse(raw.slice(0, INPUT_LIMIT), { async: false }))
  const parts: string[] = []
  type Entry = { node: (typeof tree.childNodes)[number]; end?: boolean }
  const work: Entry[] = tree.childNodes.map((node) => ({ node })).reverse()
  while (work.length) {
    const { node, end } = work.pop()!
    if (end) { parts.push('\n'); continue }
    if ('value' in node) { parts.push(node.value); continue }
    if (!('tagName' in node) || IGNORE.has(node.tagName)) continue
    if (BLOCK.has(node.tagName)) {
      parts.push(node.tagName === 'li' ? '\n• ' : '\n')
      work.push({ node, end: true })
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) work.push({ node: node.childNodes[i] })
  }
  const text = parts.join('')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const chars = Array.from(text)
  const notesTruncated = raw.length > INPUT_LIMIT || chars.length > OUTPUT_LIMIT
  return { notes: chars.slice(0, OUTPUT_LIMIT).join('').trimEnd() + (notesTruncated && chars.length ? '…' : ''), notesTruncated }
}
