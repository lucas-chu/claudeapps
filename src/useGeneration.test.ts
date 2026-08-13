import { describe, it, expect } from 'vitest'
import { describeAction } from './useGeneration'

describe('describeAction', () => {
  it('labels a creation', () => {
    expect(describeAction(0)).toBe('created a box')
  })
  it('labels an edit', () => {
    expect(describeAction(1)).toBe('edited a box')
  })
  it('names the count when several boxes are context', () => {
    expect(describeAction(3)).toBe('used 3 boxes as context')
  })
})
