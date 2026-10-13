# CompliR design system

Same language as the reference (dark-first, hairlines, 2px radius, mono data, one electric accent, serif-italic emphasis), **cyan accent, warm light theme, our own motifs: pixel meters for risk tiers and signal-flow diagrams for verdict pipelines.**

Tone: a datasheet. Short declarative lines, numbers with units, `dt/dd` specs. "Counterparty risk oracle. Compiled to signed verdicts."

Everything lives in `src/app/globals.css`. Pages use the primitives below; CSS modules only add layout.

## Tokens

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0a0b0d` | `#f5f4ef` | page background |
| `--panel` | `#0f1114` | `#faf9f5` | cards, sheets |
| `--panel-solid` | `#121418` | `#ffffff` | inputs, code, menus, SVG nodes |
| `--text` | `#ecedee` | `#111214` | ink |
| `--muted` | `#9ba1a9` | `#4d525a` | body copy, kickers |
| `--faint` | `#60656d` | `#62676f` | labels, SVG strokes, meta |
| `--line` | `#ecedee14` (8%) | `#1112141f` (12%) | hairlines |
| `--line-2` | `#ecedee26` (15%) | `#11121438` (22%) | stronger hairlines, borders on chips/buttons |
| `--acc` | `#3fe0c8` | `#0d8f7c` | the one accent: primary action, live dots, signal edge, serif word |
| `--acc-dim` | `#3fe0c81f` (12%) | `#0d8f7c1f` | fills, glows, focus ring, active menu item |
| `--on-acc` | `#06211d` | `#ffffff` | ink on accent |
| `--warn` | `#ff9a4a` | `#a84c06` | dry-run, overdue, planned |
| `--red` | `#ff5c5c` | `#b91c1c` | errors, failure-mode labels |
| `--violet` | `#a78bfa` | `#6d28d9` | reserved (analyst / LLM provenance) |
| `--low` | `#4ade80` | `#15803d` | **tier data only** |
| `--medium` | `#fbbf24` | `#b45309` | **tier data only** |
| `--high` | `#f87171` | `#b91c1c` | **tier data only** |
| `--radius` | `2px` | | every corner except dots |
| `--wrap` | `none` | | containers are full-bleed boxes padded by `--pad`; no centring margin is added |
| `--pad` | `max(16px, calc((100vw - 1296px) / 2))` | | side gutter: 16px on phones, 72px at 1440, 312px at 1920; content = 100vw − 2·pad (1296px on desktop) |
| `--sans` / `--mono` / `--serif` | Geist / Geist Mono / Instrument Serif | | wired in `src/app/layout.tsx` via `next/font/google` |

Legacy aliases (`--bg-elev`, `--fg`, `--fg-muted`, `--border`, `--border-strong`, `--accent`, `--accent-soft`, `--code-bg`, `--shadow`, `--font-sans`, `--font-mono`, `--*-soft`) map onto the tokens above so older CSS modules inherit the look.

Theme: dark is the default. `prefers-color-scheme: light` switches unless `<html data-theme>` is set. The nav toggle (`ThemeToggle`) writes `data-theme` and persists `complir.theme` in `localStorage`; an inline script in `layout.tsx` applies it before paint.

## Type scale

| Role | Face | Size | Tracking |
| --- | --- | --- | --- |
| Landing h1 | Geist 500 | `clamp(40px, 6.2vw, 84px)`, line-height 0.98 | `-0.045em` |
| Emphasised word (`.grad`, `em`) | Instrument Serif italic 400 | 1.06× parent | `-0.02em`, accent colour |
| Section h2 | Geist 500 | `clamp(1.7rem, 3.2vw, 2.6rem)` | `-0.035em` |
| Page h1 (inner) | Geist 500 | `clamp(1.6rem, 3vw, 2.1rem)` | `-0.03em` |
| Card title | Geist 500 | 1–1.05rem | `-0.02em` |
| Body | Geist 400 | 15–16px, muted colour | |
| Kicker / label / th / dt | Geist Mono 500 | 10–11px, uppercase | `0.12em` |
| Data (addresses, hashes, units, stats sub) | Geist Mono 400 | 11–13.5px | `0.02–0.04em` |
| Stat value | Geist 500 | `clamp(1.35rem, 2vw, 1.75rem)`, tabular | `-0.03em` |

## Primitives

| Class | What |
| --- | --- |
| `.kicker` | mono uppercase line above a heading; `b` inside is accent |
| `.sec-bar` | mono label + hairline that fills the row; `.sec-n` index, `.sec-meta` right-aligned meta |
| `.stats` → `.stat` / `.stat-label` / `.stat-value` / `.stat-unit` / `.stat-sub` | 6 → 3 → 2 column tile grid; hairline cells, no gaps |
| `.pixels` → `.px` (`.on`, `[data-tier]`) | LED / pixel bar; tier colours only when `data-tier` is set |
| `.chip` / `.tag` (`-acc`, `-warn`) | mono uppercase hairline tag |
| `.badge` + `.badgeLOW/MEDIUM/HIGH/Neutral` | tier badge, same shape as a chip |
| `.btn` / `.btnPrimary` / `.btnGhost` / `.btnSmall` / `.btnLg` | 2px buttons; primary = accent fill + `--on-acc` ink |
| `.input` | hairline field, accent focus ring `0 0 0 3px var(--acc-dim)` |
| `.card` | hairline panel, 2px, no shadow |
| `.table` / `.tableWrap` | datasheet table: mono uppercase `th`, hairline rows |
| `.dl` | spec list: mono uppercase `dt`, hairline rows; `.dl dd.mono` for mono values |
| `.alert` / `.alertError` / `.alertInfo` | 2px left rule in red / accent |
| `.pageHead` | inner page header with bottom hairline |
| `.bg-grid` | fixed faint grid, fades on mobile |
| `.live-dot` | 7px accent dot, `ds-blink` |
| `.flow-edge` / `.flow-edge-sig` / `.flow-edge-dash` / `.flow-node` / `.flow-label` | signal-flow SVG parts; `-sig` animates via `ds-flow` |
| `.reveal` | scroll reveal; only active under `html.js-motion` (set by `MotionInit` when motion is allowed) |

Animations: `ds-flow` (stroke-dashoffset), `ds-blink` (opacity .15 → .9), `shimmer`. All disabled under `prefers-reduced-motion`.

## Motifs

1. **Background grid** — 1px lines at 6% alpha, 64px, masked toward the top. One per page, behind everything.
2. **Pixels** — product cards carry an 8-cell bar; the Trust Map / console tier bars are the "meter" form. Tier colours appear only on tier data.
3. **Signal flow** — inline SVG with hairline edges in `--faint`, one animated accent edge, blinking live dot on the terminal node. Landing pipeline, funder graph.
4. **Datasheet** — `dt/dd` specs, 2-col price table, hairline FAQ rows, mono footer meta (chain id, contracts, build date).

## Do / don't

- Do use the accent once per view: the primary button, live dots, the serif word. Everything else is ink, muted, faint.
- Do set numbers in tabular figures with a mono unit beside them.
- Do write labels in mono uppercase at 10–11px with `0.12em` tracking.
- Do keep 1px hairlines at 8–15% alpha; stack tiles with shared borders instead of gaps.
- Don't use tier colours for anything that is not a tier (status pills use accent / warn / red).
- Don't add shadows except menus and toasts (`--menu-shadow`).
- Don't round corners past 2px (dots excepted). No pills.
- Don't put more than one serif-italic word in a headline.
- Don't animate under `prefers-reduced-motion`; never hide content behind `.reveal` without `js-motion`.

## Pass 2 additions (2026-10-13) — no boxes-in-a-box
- `.fig` instrument panel (`src/components/figures/Fig.tsx`): no border; corner bracket marks + an 8 px scale rule along the top edge via layered gradients; `fig-head` = `FIG. nn · label` (mono) + right-aligned meta; 94% panel so the SignalField shows through. Inner `.card`s flatten into rule-separated sections. Inner pages reuse it via `composes: fig from global`.
- `.rail` / `.rail-n`: numbered datasheet list on a thin vertical rail (replaces step tiles).
- `TimingDiagram` (`src/components/figures/TimingDiagram.tsx`): logic-analyser capture of one screen (lanes, sub-traces, cursor, readouts, re-screen return). Replaces the boxes-and-arrows pipeline.
- Rule: grids of bordered tiles are banned; use hairline rows, `dl` spec lists, or a figure. The only boxes are tables and code listings.
- Animated surfaces: `HeroLattice` (hero), `SignalField` (page background, pointer/click/scroll reactive). All rAF ≤30 fps, paused when hidden/out of view, static under reduced motion, SVG coordinates rounded to 2 dp.
