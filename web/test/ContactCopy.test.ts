import { describe, expect, it } from 'vitest'
import { CONTACT_VISIBILITY_NOTICE } from '../src/contactCopy'

describe('contact visibility copy', () => {
  it('states who can see contact details before a manager saves one', () => {
    expect(CONTACT_VISIBILITY_NOTICE).toContain('club managers')
    expect(CONTACT_VISIBILITY_NOTICE).toContain('Never shown to players')
  })
})
