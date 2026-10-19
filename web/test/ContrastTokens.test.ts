import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// WCAG 2.1 AA contrast for the text/background pairs the directory and fixture pages actually render (issue #32).
// Values are read from index.css so a token change is checked without updating this file.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('../src/index.css')

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`selector not found: ${selector}`)
  const block = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]))
}

const light = tokens(':root {')
const dark = { ...light, ...tokens(":root[data-theme='dark'] {") }

function channels(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Mixes `foreground` over `background` at `alpha`, for tinted backgrounds such as bg-[var(--danger)]/10.
function blend(foreground: string, background: string, alpha: number) {
  const [fr, fg, fb] = channels(foreground)
  const [br, bg, bb] = channels(background)
  return '#' + [fr, fg, fb].map((value, i) => Math.round(value * alpha + [br, bg, bb][i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
}

function contrast(a: string, b: string) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

// Each pair is [text token, background token, optional tint of the text-colour token over the background].
const RENDERED_PAIRS: [string, string, number?][] = [
  // Page text and card surfaces (FixtureList cards, Comps stats, fixture dialog).
  ['ink', 'paper'],
  ['ink', 'surface'],
  ['ink', 'paper-deep'],
  ['muted', 'surface'],
  ['muted', 'paper-deep'],
  // Accent text used for eyebrows, links and the "Your team" line.
  ['accent', 'surface'],
  ['accent-deep', 'surface'],
  ['accent-deep', 'accent-soft'],
  ['mint-deep', 'mint-soft'],
  // Primary buttons and the selected tab: text on the accent fill.
  ['on-accent', 'accent'],
  // Error banners: danger text on a 10% danger tint over the surface.
  ['danger-ink', 'danger', 0.1],
]

describe('contrast of rendered token pairs (WCAG AA, 4.5:1 for body text)', () => {
  for (const [theme, tokensForTheme] of [['light', light], ['dark', dark]] as const) {
    it(`${theme} theme: every rendered pair meets 4.5:1`, () => {
      const failures: string[] = []
      for (const [text, background, tint] of RENDERED_PAIRS) {
        const backdrop = tint === undefined ? tokensForTheme[background] : blend(tokensForTheme[background], tokensForTheme.surface, tint)
        const ratio = contrast(tokensForTheme[text], backdrop)
        if (ratio < 4.5) failures.push(`${text} on ${background}${tint === undefined ? '' : ` at ${tint}`}: ${ratio.toFixed(2)}`)
      }
      expect(failures).toEqual([])
    })
  }
})

// WCAG 2.1 SC 1.4.11: a visible focus indicator needs 3:1 against the colours it sits on.
describe('focus indicator contrast (non-text, 3:1)', () => {
  for (const [theme, tokensForTheme] of [['light', light], ['dark', dark]] as const) {
    it(`${theme} theme: the focus ring meets 3:1 on the page and card surfaces`, () => {
      for (const background of ['paper', 'surface', 'paper-deep']) {
        expect(contrast(tokensForTheme['sky-deep'], tokensForTheme[background])).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
