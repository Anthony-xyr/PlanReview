import { useEffect, useRef, useState } from 'react'
import type { AiConfigView, Course, CourseMeeting, ImportFile, ScheduleDraft } from '@shared/types'
import { Dialog, errorText } from '../ui'
import { ACCEPT, readImportFile } from '../importFiles'

const WEEKDAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

interface Props {
  onClose: () => void
  onOpenSettings: () => void
  onDone: (msg: string) => void
}

/** 周次数组 ↔ 文本：[1,2,3,5,7] ↔ "1-3,5,7" */
export function weeksToText(ws: number[]): string {
  const out: string[] = []
  for (let i = 0; i < ws.length; i++) {
    let j = i
    while (j + 1 < ws.length && ws[j + 1] === ws[j] + 1) j++
    out.push(i === j ? `${ws[i]}` : `${ws[i]}-${ws[j]}`)
    i = j
  }
  return out.join(',')
}

export function textToWeeks(s: string): number[] | null {
  const set = new Set<number>()
  for (const part of s.split(/[,，\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b > 30 || a > b) return null
    for (let w = a; w <= b; w++) set.add(w)
  }
  return set.size ? [...set].sort((x, y) => x - y) : null
}

/** 本周一，作为第一周日期的默认值 */
function thisMonday(): string {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ImportDialog({ onClose, onOpenSettings, onDone }: Props) {
  const [cfg, setCfg] = useState<AiConfigView | null>(null)
  const [existing, setExisting] = useState<Course[]>([])
  const [files, setFiles] = useState<ImportFile[]>([])
  const [hint, setHint] = useState('')
  const [draft, setDraft] = useState<ScheduleDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replace, setReplace] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.api.ai.getConfig().then(setCfg)
    window.api.courses.list().then(setExisting)
  }, [])

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setError(null)
    setBusy('正在读取文件…')
    try {
      const read: ImportFile[] = []
      for (const f of Array.from(list)) read.push(...(await readImportFile(f)))
      setFiles((x) => [...x, ...read])
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const parse = async () => {
    setError(null)
    setBusy('AI 正在分析课表，图片较多时可能要一两分钟…')
    try {
      const d = await window.api.ai.parseSchedule(files, hint)
      setDraft({ ...d, termStart: d.termStart || thisMonday() })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const commit = async () => {
    if (!draft) return
    setError(null)
    setBusy('正在写入…')
    try {
      const r = await window.api.courses.commit(draft, replace)
      onDone(`已导入 ${r.courses} 门课，生成 ${r.blocks} 次上课`)
    } catch (e) {
      setError(errorText(e))
      setBusy(null)
    }
  }

  const removeAll = async () => {
    if (!confirm(`删除现有的 ${existing.length} 门课和它们生成的上课时段？`)) return
    const r = await window.api.courses.removeAll()
    setExisting([])
    onDone(`已删除 ${r.courses} 门课、${r.blocks} 次上课`)
  }

  if (!cfg) return null
  const aiReady = cfg.enabled && !!cfg.baseUrl && !!cfg.model
  const hasImage = files.some((f) => f.kind === 'image')

  return (
    <Dialog title="导入课表" onClose={onClose}>
      <div className="import">
        {!aiReady ? (
          <>
            <p>课表导入要用 AI 来读文件。先在设置里开启 AI 并填好接口。</p>
            <div className="dialog-actions">
              <button className="secondary" onClick={onClose}>
                取消
              </button>
              <button onClick={onOpenSettings}>去设置</button>
            </div>
          </>
        ) : !draft ? (
          <>
            <p className="muted">
              上传课表，最好再加上学校的作息时间表（第几节课几点上下课），AI 会把「第几节」换算成具体时间。支持截图、PDF、Excel，可以多选。
            </p>
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
            >
              <button className="secondary" onClick={() => inputRef.current?.click()} disabled={!!busy}>
                选择文件
              </button>
              <span className="muted">或拖到这里</span>
              <input ref={inputRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
            </div>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, i) => (
                  <li key={i}>
                    <span className="badge">{f.kind === 'image' ? '图片' : '文字'}</span>
                    <span className="file-name">{f.name}</span>
                    {f.kind === 'text' && <span className="muted">{f.content.length} 字</span>}
                    <button className="link" aria-label={`移除 ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hasImage && !cfg.visionModel && <p className="form-warn">有图片文件。如果当前模型不能识图，请到设置里填一个识图模型。</p>}
            <label className="field">
              <span>补充说明（可选）</span>
              <textarea
                rows={2}
                value={hint}
                placeholder="例如：第一周从 9 月 7 日开始；周三下午的体育课不用导入"
                onChange={(e) => setHint(e.target.value)}
              />
            </label>
            {existing.length > 0 && (
              <p className="muted">
                现在已有 {existing.length} 门课。
                <button className="link" onClick={removeAll}>
                  全部删除
                </button>
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary" onClick={onClose}>
                取消
              </button>
              <button onClick={parse} disabled={!files.length || !!busy}>
                开始分析
              </button>
            </div>
          </>
        ) : (
          <Preview draft={draft} setDraft={setDraft} />
        )}

        {draft && (
          <>
            {existing.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                替换现有的 {existing.length} 门课（不勾选则追加）
              </label>
            )}
            <div className="dialog-actions">
              <button className="link" onClick={() => setDraft(null)} disabled={!!busy}>
                重新上传
              </button>
              <span className="spacer" />
              <button className="secondary" onClick={onClose}>
                取消
              </button>
              <button onClick={commit} disabled={!!busy || !draft.courses.length}>
                确认导入
              </button>
            </div>
          </>
        )}

        {busy && (
          <p className="muted" role="status">
            {busy}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** 预览：每一次上课一行，所有字段可改 */
function Preview({ draft, setDraft }: { draft: ScheduleDraft; setDraft: (d: ScheduleDraft) => void }) {
  const total = draft.courses.reduce((s, c) => s + c.meetings.reduce((n, m) => n + m.weeks.length, 0), 0)

  const setCourse = (ci: number, patch: Partial<ScheduleDraft['courses'][number]>) =>
    setDraft({ ...draft, courses: draft.courses.map((c, i) => (i === ci ? { ...c, ...patch } : c)) })
  const setMeeting = (ci: number, mi: number, patch: Partial<CourseMeeting>) =>
    setCourse(ci, { meetings: draft.courses[ci].meetings.map((m, j) => (j === mi ? { ...m, ...patch } : m)) })
  const removeMeeting = (ci: number, mi: number) => {
    const meetings = draft.courses[ci].meetings.filter((_, j) => j !== mi)
    setDraft({ ...draft, courses: meetings.length ? draft.courses.map((c, i) => (i === ci ? { ...c, meetings } : c)) : draft.courses.filter((_, i) => i !== ci) })
  }

  return (
    <>
      <p>
        识别出 <strong>{draft.courses.length}</strong> 门课，共 <strong>{total}</strong> 次上课。请核对，有错直接改。
      </p>
      {draft.notes.length > 0 && (
        <div className="form-warn">
          <strong>AI 提醒你核对：</strong>
          <ul>
            {draft.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="field inline">
        <span>第一周的周一</span>
        <input type="date" value={draft.termStart} onChange={(e) => setDraft({ ...draft, termStart: e.target.value })} />
      </label>
      <div className="preview-scroll">
        <table className="preview">
          <thead>
            <tr>
              <th>课程</th>
              <th>星期</th>
              <th>时间</th>
              <th>周次</th>
              <th>地点</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {draft.courses.flatMap((c, ci) =>
              c.meetings.map((m, mi) => (
                <tr key={`${ci}-${mi}`}>
                  <td>{mi === 0 ? <input aria-label="课程名" value={c.name} onChange={(e) => setCourse(ci, { name: e.target.value })} /> : <span className="muted">〃</span>}</td>
                  <td>
                    <select aria-label="星期" value={m.weekday} onChange={(e) => setMeeting(ci, mi, { weekday: Number(e.target.value) })}>
                      {WEEKDAY.slice(1).map((w, i) => (
                        <option key={i} value={i + 1}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="nowrap">
                    <input aria-label="开始" type="time" value={m.start} onChange={(e) => setMeeting(ci, mi, { start: e.target.value })} />–
                    <input aria-label="结束" type="time" value={m.end} onChange={(e) => setMeeting(ci, mi, { end: e.target.value })} />
                  </td>
                  <td>
                    <WeeksInput value={m.weeks} onChange={(weeks) => setMeeting(ci, mi, { weeks })} />
                  </td>
                  <td>
                    <input aria-label="地点" value={m.location} onChange={(e) => setMeeting(ci, mi, { location: e.target.value })} />
                  </td>
                  <td>
                    <button className="link" aria-label="删除这次课" onClick={() => removeMeeting(ci, mi)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function WeeksInput({ value, onChange }: { value: number[]; onChange: (w: number[]) => void }) {
  const [text, setText] = useState(weeksToText(value))
  const parsed = textToWeeks(text)
  return (
    <input
      aria-label="周次"
      className="weeks"
      value={text}
      aria-invalid={!parsed}
      title="如 1-16 或 1,3,5-9"
      onChange={(e) => {
        setText(e.target.value)
        const w = textToWeeks(e.target.value)
        if (w) onChange(w)
      }}
    />
  )
}
