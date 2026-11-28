import type { Category, TaskFilter, TaskInput } from '@shared/types'
import type { Repo } from '../db/repo'
import type { IpcRegistry } from './registry'

export function registerTasksIpc(reg: IpcRegistry, repo: Repo): void {
  reg.handle('tasks:list', (filter?: TaskFilter) => repo.listTasks(filter))
  reg.handle('tasks:get', (id: string) => repo.getTask(id))
  reg.handle('tasks:capture', (text: string, defaults?: TaskInput) => repo.capture(text, defaults))
  reg.handle('tasks:create', (input: TaskInput) => repo.createTask(input))
  reg.handle('tasks:update', (id: string, patch: TaskInput) => repo.updateTask(id, patch))
  reg.handle('tasks:remove', (id: string) => repo.deleteTask(id))
  reg.handle('tasks:spinOff', (id: string, input: TaskInput) => repo.spinOff(id, input))
  reg.handle('tasks:lineage', (id: string) => repo.lineage(id))

  reg.handle('categories:list', () => repo.listCategories())
  reg.handle('categories:create', (name: string, color: string) => repo.createCategory(name, color))
  reg.handle('categories:update', (id: string, patch: Partial<Pick<Category, 'name' | 'color' | 'sort' | 'archived'>>) =>
    repo.updateCategory(id, patch)
  )
  reg.handle('categories:remove', (id: string, moveOpenTo?: string | null) => repo.removeCategory(id, moveOpenTo))
  reg.handle('categories:reorder', (ids: string[]) => repo.reorderCategories(ids))
  reg.handle('categories:openCounts', () => repo.openCountByCategory())

  reg.handle('tags:list', () => repo.listTags())
}
