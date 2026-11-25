/** 只处理正式版本，不把 beta、非版本标签或异常长的数字当成更新。 */
export function stableVersion(raw: string): string | null {
  return /^v?((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))(?:\+[\w.-]+)?$/.exec(raw)?.[1] ?? null
}

export function isNewerStable(candidate: string, current: string): boolean {
  const a = stableVersion(candidate)
  // 从预发布构建手动检查时，允许升到同编号的正式版，但不降到更早的正式版。
  const b = stableVersion(current) ?? (/^\d+\.\d+\.\d+-[\w.+-]+$/.test(current) ? stableVersion(current.split('-')[0]) : null)
  if (!a || !b) return false
  const right = b.split('.').map(Number)
  for (const [i, field] of a.split('.').entries()) {
    const left = Number(field)
    if (left !== right[i]) return left > right[i]
  }
  return stableVersion(current) === null
}
