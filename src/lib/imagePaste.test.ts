import { describe, it, expect } from 'vitest'
import { sortImageCandidates } from './imagePaste'

describe('sortImageCandidates', () => {
  const f = (type: string) => new File([new Uint8Array([0])], 'x', { type })

  it('puts an undecodable tiff behind a decodable png', () => {
    const out = sortImageCandidates([f('image/tiff'), f('image/png')])
    expect(out.map((x) => x.type)).toEqual(['image/png', 'image/tiff'])
  })

  it('preserves the documented preference order', () => {
    const out = sortImageCandidates([f('image/gif'), f('image/jpeg'), f('image/png')])
    expect(out.map((x) => x.type)).toEqual(['image/png', 'image/jpeg', 'image/gif'])
  })

  it('sorts unknown types last without dropping them', () => {
    const out = sortImageCandidates([f('image/heic'), f('image/jpeg')])
    expect(out.map((x) => x.type)).toEqual(['image/jpeg', 'image/heic'])
    expect(out).toHaveLength(2)
  })

  it('is case-insensitive about the mime type', () => {
    const out = sortImageCandidates([f('image/tiff'), f('IMAGE/PNG')])
    expect(out[0].type.toLowerCase()).toBe('image/png')
  })
})
