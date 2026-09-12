import { describe, expect, test } from 'bun:test'
import type { SpeechDetectionRules } from '@/types/store'
import { getSpokenText, sanitizeForTts } from './speechDetection'

const rules: SpeechDetectionRules = {
  skipHtmlComments: true,
  asterisked: 'skip',
  quoted: 'speech',
  undecorated: 'narration',
}

describe('sanitizeForTts HTML comments', () => {
  test('removes a complete multiline comment before speech detection', () => {
    const text = `Public opening.
<!--DATE_SIM_CASE
CASE: secret profile
END_DATE_SIM_CASE-->
"Hello."`

    expect(sanitizeForTts(text)).toBe('Public opening. "Hello."')
    expect(getSpokenText(text, rules)).toBe('Public opening. Hello.')
  })

  test('removes multiple comments and a trailing unclosed comment', () => {
    expect(sanitizeForTts('One. <!--first--> Two. <!--unfinished')).toBe('One. Two.')
  })

  test('preserves HTML comments when the option is disabled', () => {
    const text = 'Before <!--DATE_SIM_CASE: secret--> After'

    expect(sanitizeForTts(text, { skipHtmlComments: false })).toBe(text)
    expect(getSpokenText(text, { ...rules, skipHtmlComments: false }))
      .toContain('DATE_SIM_CASE: secret')
  })
})
