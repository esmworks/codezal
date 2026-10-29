# Design rules

This file defines **the rules to follow when writing UI**. Like ZCode's `DESIGN.md`, it is written for
agents: a rule is either measurable or a named exception. Inventing a new value is a design error, not
a matter of taste.

The measurable part is enforced by a **gate test**: `apps/desktop/src/renderer/src/lib/designScale.test.ts`
scans the sources and fails if it sees an out-of-scale value or an unnamed raw color. You cannot add a
new value by changing the rule here without updating the test.

## 1. Type scale

UI text uses **only** one of these sizes (`text-[Npx]`):

| Size | Role | Example |
|---|---|---|
| 10px | Only scale/axis text, inside badges | chart label, `+12` counter |
| 11px | Dense helper text, code badge | file path chip, log line |
| 12px | Meta under a heading, secondary line | session time, card footer |
| 13px | Secondary UI text | menu item, settings row description |
| 14px | **Body**: default UI text | chat, button, input |
| 15px | Markdown `h3`, section heading | settings section heading |
| 16px | `h2`, window title | modal title |
| 18px | `h1`, welcome | home screen heading |
| 20–22px | Showcase number | usage summary |
| 28px | Welcome greeting | home screen |

Rules:

- Code surfaces (diff, file preview, command output, `CodeView`) use their own size and are drawn with
  `--font-code`; aligned columns and shiki tokens cannot be read any other way.
- **Inline code** in chat text is also a code surface: `--font-code`, 12px, tight letter spacing and a
  chip with a 4px radius (`components/Markdown.tsx`, `CODE_CHIP`). `--font-mono` is the **UI** sans
  stack; when inline code was drawn from it, it could not be told apart from body text, and with its
  10px-radius gray fill it looked like a button. The background is `bg-chip`, the separation is
  `border-line`: both stay faint, because the chip interrupts the body text and should not stand out
  itself. A clickable file path is drawn like a link, not a chip (§3): the gray box belongs only to
  code, and so does `--font-code`.
- Tailwind's `text-sm` / `text-xs` / `text-base` classes are **not used**: the scale is the table
  above, and mixing in another scale creates two systems.
- The `html` root font size is **not changed**. (If users are to get an adjustable font size, follow
  ZCode's approach: a scale derived with `calc()` from a single `--ui-font-size` variable; on that day
  this table becomes a formula.)

## 2. Radius ladder

Radius is chosen by **nesting**, not by importance: if a box is inside another box, it steps down one
level. The steps in use and their roles:

| Radius | Role |
|---|---|
| 2px | Strip/fill piece (progress bar) |
| 3px | Marker/dot (10×10 color box) |
| 4px | Micro badge (in-card label, checkbox) |
| 5px | Micro button (inline ✕) |
| 6px | Small icon button |
| 7px | Sidebar row, menu item |
| 8px | Tool card, small surface |
| 9px | **Form control** (input, select, `h-[30px]` button) |
| 10px | Large input/button |
| 11px | Text area (textarea) |
| 12px | Card |
| 14px | Panel, boxes |
| 16px | Modal |

- Fully round (`rounded-full`) is only for true pill shapes: chip, badge, avatar.
- **Named exceptions** (single use, with the reason):
  - `18px` — the welcome card (`Welcome.tsx`): not a modal, but a one-off surface as large as one.
- Instead of adding a new radius, use the nearest step. In-between values such as 13px or 15px fail the
  gate.

## 3. Color

Colors are the **semantic** tokens in `packages/ui/src/tokens.css`; the light and dark themes feed the
same variables. The usable names:

`--bg`, `--bg2`, `--card`, `--card2`, `--chip`, `--hov`, `--sel`, `--line`, `--line2`,
`--tx`, `--tx2`, `--tx3`, `--acc`, `--accSoft`, `--accLine`, `--accTx`, `--onAcc`,
`--green`, `--amber`, `--red`, `--link`, `--linkHov`, `--add`, `--del`, `--tray`, `--scrim`.

Rules:

- Layers such as `bg-card` and `bg-bg2` are chosen **deliberately**: if one surface sits on top of
  another, the layer name should explain it.
- Green/amber/red are only for **real status**: success, warning, error. Not for decoration.
- **Blue has a single meaning: "this is clickable."** Links and clickable file paths (`Markdown.tsx`,
  `LINK_TX`) are written with `--link` and an underline fainter than the text color; on hover the text
  turns to `--linkHov` and the underline to full blue. Because it is the palette's only blue, it is not
  used as a decoration, emphasis or info color — if it is, the "blue = clickable" reading breaks.
- In chat text, two surfaces say two things: **gray chip = code**, **blue + underline = clickable**.
  That is why a clickable file path is not drawn like a chip — putting blue text on a gray background
  carried two opposing signals ("blue but a box"). Blue text stays in the **same font and size** as the
  body: the distinction is made by color and underline, not by typeface; jumping to the mono stack
  inside the text moved the file path out of the sentence (22 Sep 2026).
- Diff lines use their own tokens (`--add` / `--del`); they are independent of success/error.
- Status is **not conveyed by color alone**: the text says it too ("failed", "stopped").
- Raw neutral colors (`bg-white`, `bg-black/70`, `text-white`) are allowed only on **content surfaces
  that must not follow the theme**, and every use is listed with its reason in the gate's exception
  list: the web preview (browser, design frame) and image overlays (lightbox, remove button). If used
  anywhere else, the gate fails.

## 4. Spacing and sizing

- The base unit is 4px; the rhythm is `4 / 8 / 12 / 16 / 20–24`. In-between values such as
  `gap-[6px]`, `py-[7px]`, `px-[11px]` are fine-tuning inside a control and are allowed; spacing
  **between sections** is chosen from the rhythm.
- Wherever text must be truncated/shrunk, use `min-w-0`; in nested scroll/split layouts, use
  `min-h-0`. When either is missing, overflow breaks silently.
- Touch/click target is at least 24px (`h-6`); sidebar rows are 26–28px.

## 5. Elevation (shadow)

Four levels, in ascending order:

1. **Base** — no shadow; separation by border (`border-line`).
2. **Surface** — card/panel; a border is enough, no shadow needed.
3. **Overlay** — menu, dropdown, modal: `shadow-panel`.
4. **Attention** — toast only.

Background layering comes before shadow; instead of strengthening the shadow, separate the layer.

## 6. Motion

Short and calm: menu/modal `transition-colors` ~100ms, panel width ~200ms `ease-out`. Springy, long or
playful animation is not used in the main workspace. `prefers-reduced-motion` is supported: for a user
who turns motion off, the transition duration is zeroed.

Ongoing work is not conveyed by a **spinning icon** (a long-lived animation consumes render resources):
the verb of the running row shimmers (`cz-shimmer`), and the status text says it.

## 7. Accessibility

- Every interaction can be done with the keyboard; focus stays visible (`focus-visible`).
- An icon-only button has an accessible name (`aria-label`); the `Icon` component is `aria-hidden`.
- A modal carries `role="dialog"` + `aria-modal`, keeps focus inside itself, and `Escape` closes only
  it.
- Status/warning is announced with `role="status"` or `role="alert"`; the chat transcript is
  `role="log"`.
- Room is left for long translations: the layout must not work only with short English text, and
  truncation alone is not a solution.

## 8. Command marker row

The command-result marker (ZCode's `timelineMarker` row) is a **center-aligned single line** in the
middle of the chat: a thin line on both sides (`h-px bg-line`), a 13px icon + `text-muted` text in the
middle.

- The text is `text-tx2`, a failed result is `text-tx3`: the error text ("Context could not be
  compacted") already says it, and the color does not shout a second time. Red is used only on real
  error surfaces.
- The row carries `role="status"`: in the middle of the chat transcript (`role="log"`), it is announced
  to the screen reader.
- The scroll anchor is its own id (`m-<id>`); the row does not enter the turn group and does not
  collapse.

## 9. Test IDs

Behavior tests use role/text selectors (Playwright's recommendation; accessibility benefits from it
too). Tests that **measure layout** use the `TEST_IDS` identifiers in
`packages/contracts/src/test-ids.ts` — they do not bind to class names or DOM order, because that
binding was the cause of the tests that broke yesterday.
