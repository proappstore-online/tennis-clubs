import type { ReactNode } from 'react'

// Shared responsive layout primitives (issue #40, from #26). They only choose a layout class from `index.css`; the
// classes are mobile-first, set no heights and no motion, so native controls keep their 44px minimum and the
// reduced-motion rule keeps applying to everything inside.
type Container = 'div' | 'section' | 'ul'
type Gap = 'sm' | 'md' | 'lg'

const STACK: Record<Gap, string> = { sm: 'stack-sm', md: 'stack', lg: 'stack-lg' }
const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')
// A list keeps list semantics but drops the bullets, because the cards are the visual structure.
const listReset = (as: Container) => as === 'ul' && 'list-none'

// The page frame: one centred, padded `main` per screen.
export function PageFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={join('container-app py-7 sm:py-10', className)}>{children}</main>
}

// A vertical run of children with one consistent gap.
export function Stack({ as: Tag = 'div', gap = 'md', className, children }: { as?: Container; gap?: Gap; className?: string; children: ReactNode }) {
  return <Tag className={join(STACK[gap], listReset(Tag), className)}>{children}</Tag>
}

// Cards in a grid that starts as one column on a phone. `auto` widens to two and then three columns; `3` goes straight to three.
export function CardGrid({ as: Tag = 'div', columns = 'auto', className, children }: { as?: Container; columns?: 'auto' | 3; className?: string; children: ReactNode }) {
  return <Tag className={join(columns === 3 ? 'grid-3' : 'grid-auto', listReset(Tag), className)}>{children}</Tag>
}
