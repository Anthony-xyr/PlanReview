import { describe, expect, it } from 'vitest'
import type { Category } from '@shared/types'
import {
  pickCategoryView,
  PRIMARY_NAV_ITEMS,
  resolveCommandAction,
  sameView,
  SIDEBAR_TOOL_SECTIONS
} from './navigation'

const cat = (id: string, archived = false): Category => ({
  id,
  name: id,
  color: '#000',
  sort: 0,
  archived
})

describe('app navigation', () => {
  it('compares views accurately across simple, category, and tag variants', () => {
    expect(sameView({ kind: 'today' }, { kind: 'today' })).toBe(true)
    expect(sameView({ kind: 'today' }, { kind: 'weekly' })).toBe(false)
    expect(sameView({ kind: 'category', id: 'c1' }, { kind: 'category', id: 'c1' })).toBe(true)
    expect(sameView({ kind: 'category', id: 'c1' }, { kind: 'category', id: null })).toBe(false)
    expect(sameView({ kind: 'tag', tag: 'a' }, { kind: 'tag', tag: 'a' })).toBe(true)
    expect(sameView({ kind: 'tag', tag: 'a' }, { kind: 'tag', tag: 'b' })).toBe(false)
  })

  it('picks the first active category with open tasks, otherwise falls back cleanly', () => {
    const categories = [cat('archived', true), cat('empty'), cat('busy')]
    expect(pickCategoryView(categories, { archived: 5, busy: 2 })).toEqual({ kind: 'category', id: 'busy' })
    expect(pickCategoryView(categories, { archived: 5 })).toEqual({ kind: 'category', id: 'empty' })
    expect(pickCategoryView([cat('archived', true)], {})).toEqual({ kind: 'category', id: null })
  })

  it('routes main commands to view switches or dialogs with dayStartHour awareness', () => {
    const earlyMorning = new Date(2026, 9, 16, 3, 0)
    expect(resolveCommandAction('stop', 4, earlyMorning)).toEqual({ type: 'dialog', dialog: { kind: 'stop' } })
    expect(resolveCommandAction('wrap-up', 4, earlyMorning)).toEqual({ type: 'dialog', dialog: { kind: 'wrap-up' } })
    expect(resolveCommandAction('review', 4, earlyMorning)).toEqual({
      type: 'dialog',
      dialog: { kind: 'review', day: '2026-10-15' }
    })
    expect(resolveCommandAction('weekly', 4, earlyMorning)).toEqual({ type: 'view', view: { kind: 'weekly' } })
    expect(resolveCommandAction('today', 4, earlyMorning)).toEqual({ type: 'view', view: { kind: 'today' } })
  })

  it('keeps declarative sidebar navigation and tool sections intact', () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.view.kind)).toEqual(['today', 'inbox', 'active', 'done', 'weekly'])
    expect(SIDEBAR_TOOL_SECTIONS.flatMap((section) => section.items.map((item) => item.id))).toEqual([
      'review',
      'wrap-up',
      'insights',
      'import',
      'float',
      'settings'
    ])
  })
})
