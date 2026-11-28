/** 课表导入时上传的文件，已在界面里读成文本或图片 */
export interface ImportFile {
  name: string
  kind: 'text' | 'image'
  /** 文本内容，或图片的 data URL */
  content: string
}

/** 一门课每周的一次上课 */
export interface CourseMeeting {
  /** 1=周一 … 7=周日 */
  weekday: number
  start: string
  end: string
  /** 第几周上课，如 [1,2,…,16] */
  weeks: number[]
  location: string
}

export interface ScheduleDraft {
  /** 第一周的周一，'YYYY-MM-DD' */
  termStart: string
  courses: { name: string; teacher: string; location: string; meetings: CourseMeeting[] }[]
  /** 解析时的说明 / 无法确定的地方 */
  notes: string[]
}

export interface Course {
  id: string
  name: string
  location: string
  teacher: string
  meetings: CourseMeeting[]
}
