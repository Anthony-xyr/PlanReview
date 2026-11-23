type PickerState = { open: boolean; query: string }
type PickerAction = { type: 'open' | 'reset' | 'escape' } | { type: 'query'; query: string }

export const closedPicker: PickerState = { open: false, query: '' }

export function pickerState(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case 'open': return { open: true, query: '' }
    case 'query': return state.open ? { ...state, query: action.query } : state
    case 'escape': return state.query ? { ...state, query: '' } : closedPicker
    case 'reset': return closedPicker
  }
}

/** -1 表示搜索框，列表里的结果使用从 0 开始的索引。 */
export function pickerArrowIndex(current: number, count: number, direction: 1 | -1): number {
  if (current === -1 && direction === -1) return count - 1
  return Math.max(-1, Math.min(count - 1, current + direction))
}
