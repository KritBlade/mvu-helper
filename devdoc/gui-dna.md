# GUI-DNA

One design system for an extension's settings panel in SillyTavern and for a standalone app in its own page: the
tokens, layout grammar, components ("genes"), copy, behaviour, i18n, accessibility and code rules that every surface
inherits. A new tab, row or dialog built from it looks right without anyone designing it. Desktop and phone run the
same markup; CSS alone switches the layout. mvu-helper's settings panel is built on it, MvuStatMenuBuilder (a Vue app)
draws its pages with it, and VectFox adopts it for its own panel.

The examples are mvu-helper's markup, with its prefix `mvuh-`.

## 1. Adopting it

Each adopter supplies:

1. a class prefix: `mvuh-` in mvu-helper, `smb-` in MvuStatMenuBuilder;
2. a root class on its panel and on its dialogs: `.mvuh-ui`;
3. a palette file giving a value to every colour role in §3, once for each theme it offers (§3, Themes);
4. its brand and nav entries, and the nav's placement (§4): the rail, with the box that scrolls the shell named
   `mvuh-scroller`, or the top bar;
5. as a standalone app, what SillyTavern would otherwise provide: the fonts (`--mainFontFamily` and `--monoFontFamily`
   on the root class, or the fallbacks in `gui-dna.css`) and the solid set of Font Awesome 6.5.2.

Everything else is shared word for word: `gui-dna.css` with the prefix swapped, the token names after the prefix,
layout, genes, copy, behaviour, accessibility and code rules. i18n (§8) binds an adopter that ships more than one
language. An adopter's `gui-dna.css` is generated from mvu-helper's and never edited by hand: a change to the DNA is
made here and synced. MvuStatMenuBuilder takes mvu-helper's `palette.css` the same way and shows its dark theme, so
it has no colours of its own: `tools/sync-gui-dna.mjs` writes both copies, and `tools/test-gui-dna.mjs` fails when
either drifts. Extensions load into the same SillyTavern page, so the prefix and the root class are what keep one
extension's CSS off another's panel: never ship an unprefixed class name.

mvu-helper's implementation is the reference, in `src/features/settings-panel/`:

| File | Holds |
|---|---|
| `gui-dna.css` | the genes' CSS: portable, every rule under the root class, no colour |
| `palette.css` | mvu-helper's palette in two glass themes (§3, Glass), Night Slate (dark, the default) and Soft Silver (light): every colour token, with its measured contrast |
| `settings-panel.css` | the stylesheet the manifest loads: it imports the palette and the DNA, then adds mvu-helper's own rules (the drawer launcher, SillyTavern's dialog around the panel and around a form that holds long text) |
| `gui-dna-core.js` | the gene builders: one pure function per gene, returning escaped markup with its fixed words keyed |
| `settings.html` | the panel's static markup |

MvuStatMenuBuilder's adoption is in `landing-app/src/shared/gui-dna/`: the generated `gui-dna.css` and `palette.css`,
and one Vue component per gene with parts. Its stylesheet entry, `landing-app/src/app.css`, loads the Noto faces the
DNA falls back to, imports the rest, and adds the page shell and the layout editor's flush main pane (§4).

`tools/gui-dna-specimen.html` renders every gene from the real stylesheets at both widths, in both nav placements and
in both themes (its theme switch swaps them), outside SillyTavern. `tools/palette-contrast.mjs` prints each colour's
lowest contrast on each surface it sits on (§3, Contrast). Tests check the rules against the source:
`tests/gui-dna-guards.test.js` (translation keys, one-line hints, no inline style, classes a selector looks for still
emitted, colours only in the palette, every role in both themes, only the extension's own classes, painted elements
unkeyed), `tests/palette-contrast.test.js` (every colour at its floor where it reads worst, and what that measure takes
as solid is solid in the stylesheets), `tests/card-gate.test.js` (a handler that edits the open card sits behind a
declaration, §7), `tests/no-native-dialogs.test.js`, `tests/popup-api-boundary.test.js` and
`tests/file-picker-boundary.test.js`. MvuStatMenuBuilder checks its pages with `tools/test-gui-dna.mjs`.

## 2. Principles

1. One idea per line. The label names it, the hint says what it does, the longer explanation waits behind (?).
2. Status is a word; colour only reinforces it.
3. Safe and destructive never share a row. Destructive lives in a danger zone or as a row's last button, and always
   confirms (§7 names the one exception).
4. Group by what the user decides, not by how the code is split.
5. One markup, two layouts. CSS switches at 720px panel width; no phone-only markup, no JS layout.
6. The panel owns its look: no host theme class, no inline style, no colour outside the tokens.

## 3. Tokens

Custom properties on the root class. The roles are shared; each adopter's palette file gives the values
(mvu-helper's: `palette.css`).

**Themes.** A palette may offer a dark and a light theme. The default theme's values sit on the root class, the other's
under `html[data-mvuh-theme="<its name>"] .mvuh-ui`. The theme switch (§5) writes that attribute on `<html>`, so one
write reaches the panel and every dialog; the saved choice is written at startup, before the first dialog opens. Each
theme block names every role and sets `color-scheme`, so a select's list and the scrollbars follow it. G5 fails when
one block names a role the other leaves out, which would show the default's colour in the other theme, or no colour at
all in the default. mvu-helper's default is dark, its light values sit under `html[data-mvuh-theme="light"] .mvuh-ui`,
and the choice is the global setting `panelTheme`.

**Colour roles**

| Token | Role |
|---|---|
| `--mvuh-bg` | panel background (the canvas), under its light (`--mvuh-bg-gradient`) |
| `--mvuh-surface` | card, record card and notice: a pane over the canvas; a shade apart from the fields, so they stand out |
| `--mvuh-surface-header` | card and record card header band |
| `--mvuh-surface-raised` | action tile, list row, secondary button, chip, page icon tile; never under a field |
| `--mvuh-surface-solid` | what floats over the host page and hides it: a dialog, a select's list |
| `--mvuh-field` | input, select, textarea |
| `--mvuh-border` | card and control borders (a checkbox's is `--mvuh-control-off`), dividers, the split divider |
| `--mvuh-border-strong` | hovered control border |
| `--mvuh-text` | primary text |
| `--mvuh-text-muted` | hints, descriptions, eyebrow |
| `--mvuh-text-faint` | placeholders, disabled, the (?) icon |
| `--mvuh-nav` | nav rail, top bar and phone strip |
| `--mvuh-nav-text` | nav items and brand, a hovered theme option |
| `--mvuh-nav-text-muted` | nav group labels (the top bar's dividers), the theme options not chosen, the strip's scrollbar |
| `--mvuh-nav-accent` | the brand icon, the focus ring on the nav |
| `--mvuh-nav-hover` | hovered nav item, the theme switch's track |
| `--mvuh-nav-active`, `--mvuh-nav-active-text`, `--mvuh-nav-active-glow` | the active nav item's and the chosen theme option's fill, their text and icon, their glow |
| `--mvuh-nav-edge` | the line between the nav and the main pane: beside the rail, under the top bar and the phone strip |
| `--mvuh-accent` | graphics: switch on, slider, checked box, primary action card border, a dragged split divider |
| `--mvuh-accent-fill`, `--mvuh-accent-fill-hover` | fills under on-accent text (primary button, badge); the slider thumb's outer edge |
| `--mvuh-on-accent` | text and icons on the accent or its fill; a checkbox's tick |
| `--mvuh-accent-ink` | accent text and icons on a surface: links, chip, row and action icons, secondary-button icons, quiet button, an open (?); the focus ring |
| `--mvuh-accent-soft` | detail panel, icon toggle on, quiet button hover |
| `--mvuh-control-off`, `--mvuh-switch-knob` | a control's off or unfilled part: the switch track while off, the slider's track, an unchecked box's edge; the switch's knob |
| `--mvuh-check-empty` | an unchecked box's fill: in a dark theme a step lighter than the card, so the box never reads as a hole |
| `--mvuh-success`, `-soft`, `-ink` | installed, enabled, valid |
| `--mvuh-warning`, `-soft`, `-ink` | needs attention: a copy missing, nothing open to act on, drift |
| `--mvuh-danger`, `-soft`, `-border`, `-ink` | destructive, missing, failed, invalid |
| `--mvuh-neutral`, `-soft`, `-ink` | disabled, off |
| `--mvuh-dialog-shadow` | the dialog's shadow |
| `--mvuh-dialog-backdrop` | the page behind a standalone app's own dialog |
| `--mvuh-bg-gradient`, `--mvuh-surface-gradient`, `--mvuh-surface-header-gradient`, `--mvuh-nav-gradient` | image layers over the canvas (its light), a card or record card (and a dialog), its header band, and the nav (rail, top bar or phone strip; the palette picks the direction) |
| `--mvuh-surface-raised-gradient` | image layer over a list row, an action tile and the page icon tile |
| `--mvuh-accent-gradient`, `--mvuh-accent-gradient-hover` | image layers over the accent fill |
| `--mvuh-accent-glow` | the accent fill's glow |
| `--mvuh-surface-rim` | a card's and record card's rim: an image layer on a 1px ring inside the border |
| `--mvuh-surface-shadow` | a card's and record card's lift |
| `--mvuh-surface-raised-shadow` | the lit top edge of an action tile, a list row, a chip and the page icon tile |

A status colour marks the dot, the border and the fill; its word is written in the ink, on the soft fill.

**Contrast** (WCAG): every text token reads at least 4.5:1 on each surface it sits on, and every control, icon and the
focus ring at least 3:1, measured where each reads worst (Glass, below). Text never sits on the accent itself, only on
the deeper accent fill, so the accent stays for graphics. The focus ring is drawn in the accent ink: a text colour, it
clears 3:1 on every surface, a notice's or the danger zone's status fill included. Muted text still passes on the card,
the canvas and a field, and faint text where it is used: a placeholder in a field, an icon on the card. A field stands
apart from the card, and the card from the canvas, by a small step that nothing relies on for meaning.
`node tools/palette-contrast.mjs` prints each colour's lowest ratio on each surface, and
`tests/palette-contrast.test.js` (G12) fails a pair under its floor. A palette file states each colour's lowest figure
beside its values.

**Glass**: the canvas carries the light, coloured glows painted in `--mvuh-bg-gradient`. A card, a record card, a
notice, a row, a tile and a field are panes over it, their colours carrying alpha, so the light shows through them;
in a dark palette the nav is one too. The canvas stays put while the page scrolls (below), so the panes slide over the
light. A card's and a record card's edge catches it: `--mvuh-surface-rim` paints a 1px ring inside the border,
brightest where the light falls, and `--mvuh-surface-shadow` lifts the card. A raised surface (an action tile, a row,
a chip, the page icon tile) carries a lit top edge, `--mvuh-surface-raised-shadow`. What floats over the host page
sits on `--mvuh-surface-solid`, since no canvas lies under it: a dialog, a select's list. On phone the strip is sticky
and the page scrolls under it, so its nav colour sits on `--mvuh-bg`. No `backdrop-filter`: the only thing behind a
pane is the canvas, already soft, so a blur would change nothing seen and cost a repaint on every scroll.

A see-through surface has no one colour, so contrast is measured over every canvas point the surface can sit on (a
card anywhere in the pane, the page header across its top, the rail down its start), at every stop of its gradients.
The brightest light in a dark palette and the deepest tint in a light one set the floor, wherever a card's header band
can scroll over it. A palette without glass gives its surfaces solid colours, `none` to the rim and both shadows,
`transparent` to the nav edge, and its surface colour to `--mvuh-surface-solid`.

**Gradients**: a gradient is an image layer over its role's colour, and every stop is measured like a solid colour.
To add or change one:

1. Write its token in the palette file on ONE line, ending on its role's colour where it should blend into it
   (`var(--mvuh-nav)`). G5 accepts a colour only on the line that declares a token, so a stop on a continuation
   line, or a hex value in a palette comment, fails the guard.
2. In the gene's rule, set `background-image: var(--mvuh-…-gradient)` beside `background-color`, never the
   `background` shorthand, which drops the layer. A rule that must stay flat over a gradient another rule set
   resets with the shorthand on purpose: the danger dialog's OK button, `background: var(--mvuh-danger-soft)`.
3. Run `node tools/palette-contrast.mjs` and write each colour's lowest figure in the palette header. A pair under its
   floor fails G12: lighten that text colour in a dark palette, darken it in a light one, or dim the light under it.

A palette without gradients sets each gradient token to `none`. The rail's gradient sits on the sticky inner, which is
as tall as the visible column when the adopter names its scroller (§4), so the gradient runs from the column's top to
its foot and stays behind the items. The canvas gradient is painted by the adopter's own rule on the
panel's scroller: a scroller's own background stays put while the page scrolls, so the gradient spans the visible
pane. mvu-helper paints it on its dialog's scroller (`settings-panel.css`). A top-bar shell is itself the fixed box
behind its scrolling main pane, so the shell's own canvas already stays put.

**Type**: inherit the host's font: SillyTavern's `--mainFontFamily` and size; code uses `--monoFontFamily`. A
standalone app sets those two properties itself, or takes the fallbacks. Sizes in `em`, so SillyTavern's font-scale
setting scales the panel.

| Role | Size | Weight |
|---|---|---|
| Page title | 1.45em | 600 |
| Card title | 0.95em, uppercase, letter-spacing 0.04em | 700 |
| Label, control, body | 1em | 500 label, 400 body |
| Hint, description | 0.86em, muted | 400 |
| Pill, eyebrow, nav group | 0.78em | 600 |

**Space**: a 4px scale, 4 8 12 16 20 24 32. Card padding 16 (phone 12); field grid gap 16 across, 14 down; 16 between
cards.
**Radius**: control 8, card 12, pill 999, badge 50%.
**Elevation**: a card and a record card have a border, the rim and a lift (`--mvuh-surface-rim`,
`--mvuh-surface-shadow`); an action tile, a row, a chip and the page icon tile a lit top edge
(`--mvuh-surface-raised-shadow`); a dialog a shadow; and the active nav item, the chosen theme option and the primary
button glow.
**Motion**: 150ms ease-out on hover, switch knob, collapse; none under `prefers-reduced-motion`.
**Size**: control 36px tall (phone 40); phone touch targets at least 40px; switch 40×22; nav item 40; icon tile 36;
badge 28; split divider 12 wide.
**Breakpoint**: one, 720px, measured on the panel, not the viewport. The shell is a named container
(`container: mvuh-shell / inline-size`), and the phone rules sit in `@container mvuh-shell (max-width: 720px)`. The
panel is a dialog or a page of its own, so the box the layout has to fit is the measure. A list row and a danger zone
need no breakpoint: each wraps by its own width (§5).

`gui-dna.css` holds the shared sizes as tokens too: `--mvuh-radius-control` (8px), `--mvuh-radius-card` (12px),
`--mvuh-control-height` (36px), `--mvuh-gap` (16px), `--mvuh-motion` (150ms ease-out), and the card gate's
`--mvuh-inert-opacity` (0.5, §7). `--mvuh-split-start` is the width of a split's start pane: 40% until its divider sets
it.

## 4. Layout grammar

```
.mvuh-ui.mvuh-shell                       the panel root, a container; + .is-topbar for the top bar
├── nav.mvuh-nav                          brand · group labels · tab buttons · footer (the theme switch)
└── main.mvuh-main
    └── .mvuh-page  (one per tab)
        ├── header.mvuh-page-header       icon tile · eyebrow · title · subtitle | chip · pills
        ├── .mvuh-notice …                conditions
        ├── section.mvuh-card × n
        └── .mvuh-danger-zone             at most one, always last
```

**Nav placement.** The rail, the default: the nav is a 200px column on the left, and the main pane scrolls with
whatever scrolls the panel. The adopter names that box `container: mvuh-scroller / size`, and the rail is drawn as tall
as the box's visible height. The box takes its height from outside, never from its content: a dialog of fixed height,
or a page's viewport. mvu-helper names its dialog's scroller (`settings-panel.css`). Without the name the rail still
works, its gradient spanning only the items. The top bar, `.mvuh-shell.is-topbar`: the nav is one row above
the main pane at every width, the brand first and each group label drawn as a thin divider; the shell fills its
container's height and the main pane is its scroller, so the bar never scrolls away. The rail suits a panel of
settings pages; the top bar suits an app whose pages need the whole width (MvuStatMenuBuilder's workbenches). On
phone both are the same scrolling strip above the page.

**Workbench page** `.mvuh-page.is-workbench`: a page that fills the main pane's height and never scrolls itself. Its
header comes first, then optionally a compact card, then a split or a single pane that takes the rest; each pane
scrolls inside. It needs the top bar's main pane, which gives it a height.

```
.mvuh-page.is-workbench
├── header.mvuh-page-header
├── section.mvuh-card                     optional, compact: a row of actions above the panes
└── .mvuh-split                           or one section.mvuh-card.is-pane
    ├── section.mvuh-card.is-pane         the start pane, --mvuh-split-start wide
    ├── .mvuh-split-divider               role="separator", dragged or moved with the arrow keys
    └── section.mvuh-card.is-pane         the end pane, the rest
```

A page an adopter draws itself sits in a workbench page and keeps its own classes and styles inside it:
MvuStatMenuBuilder's layout editor, whose live preview renders the author's status menu in the author's own CSS.
No gene rule reaches into such a surface; the root's inherited font, colour and line height do, so the surface sets
on its own root whatever it needs different. The adopter's guards name it.

Card bodies:
- `.mvuh-grid`: 2 columns, 1 on phone. The default for fields.
- `.mvuh-grid-pair`: stays 2 columns on phone, for short numeric pairs (width × height).
- `.mvuh-span`: one field across the whole row (textareas, lists, long switch rows).
- `.mvuh-stack`: fields one under another at any width: a dialog's form.
- `.mvuh-group-title`: a sub-heading inside a card, followed by its own grid or list; it hides while the list after
  it is empty.
- `.mvuh-divider`: a 1px rule between groups.
- `.is-fill` on a pane's body: the pane is one editor, and its textarea fills the body edge to edge.

A slot a renderer paints (a `div` in a page or a grid) shows only while it holds something, so an empty one leaves no
gap.

## 5. Genes

**Nav item** `button.mvuh-nav-item`: icon + label; `.is-active` is the nav's active fill with its own text colour and
glow (`--mvuh-nav-active*`). The rail and the top bar are a dark surface with their own text colours (`--mvuh-nav-*`).

**Theme switch** `.mvuh-nav-footer > .mvuh-theme-switch`: a pill track, `role="group"` named by a translated `title`,
holding one `button.mvuh-theme-option` per theme, icon + label, its theme in `data-mvuh-theme-option`. The chosen one
carries `.is-active` and `aria-pressed="true"` and is drawn like the active nav item. The footer sits at the rail's
foot (under the last item on a rail only as tall as its items) and at the end of the top bar and the phone strip.

**Page header** `.mvuh-page-header`: icon tile, eyebrow "<group> / <tab>", title, subtitle (one line); on the right,
the scope chip and the tab's status pill. Static markup per page; the tab fills its pill. Phone: chip and pills wrap
under the subtitle.

**Card** `section.mvuh-card`: its header sits on a tinted band. Header: badge, title, one-line description, a
header-actions slot (icon buttons, one compact select, or a master switch), collapse chevron. `.is-collapsed` hides
the body. Open by default; `.is-advanced` cards start collapsed. Phone: the description and header actions wrap under
the title. A pane, `.is-pane`, is a card in a workbench: it fills its share and its body scrolls; it does not
collapse.

```html
<section class="mvuh-card" id="mvuh_card_debug">
  <header class="mvuh-card-header">
    <span class="mvuh-badge"><i class="fa-solid fa-bug"></i></span>
    <h3 class="mvuh-card-title" data-i18n="Debug">Debug</h3>
    <p class="mvuh-card-desc" data-i18n="Debug desc">Console logging for MVU Helper.</p>
    <div class="mvuh-card-actions">
      <select id="mvuh_debug_verbosity" class="mvuh-select" data-i18n-title="Console verbosity" title="Console verbosity">…</select>
    </div>
    <button type="button" class="mvuh-collapse" aria-expanded="true" data-i18n-title="Show or hide" title="Show or hide"><i class="fa-solid fa-chevron-up"></i></button>
  </header>
  <div class="mvuh-card-body mvuh-grid">…</div>
</section>
```

**Field** `.mvuh-field`: label row (label + optional `button.mvuh-help-toggle`), control, hint `.mvuh-hint`, detail
`.mvuh-detail` (the longer explanation, shown while the field has `.is-help-open`), and an optional "More detail"
link `a.mvuh-more` after the detail, shown with it. A field's control may be a group of controls (a list of condition
rows); its label is then a caption (`<span>`) rather than a `<label for>`.

```html
<div class="mvuh-field">
  <div class="mvuh-field-label">
    <label for="mvuh_timeout_sec" data-i18n="Call timeout (s)">Call timeout (s)</label>
    <button type="button" class="mvuh-help-toggle" aria-expanded="false" data-i18n-title="More about this" title="More about this"><i class="fa-solid fa-circle-question"></i></button>
  </div>
  <input type="number" id="mvuh_timeout_sec" class="mvuh-input" min="5" max="600" step="5">
  <p class="mvuh-hint" data-i18n="Call timeout hint">Seconds before a stalled call is dropped. The other calls carry on.</p>
  <p class="mvuh-detail" data-i18n="Call timeout detail">…</p>
  <a class="mvuh-more" href="…" target="_blank" rel="noopener"><i class="fa-solid fa-book-open"></i><span data-i18n="More detail">More detail</span></a>
</div>
```

**Controls**: `.mvuh-input` (text, number), `.mvuh-select` (no native look, a chevron), `.mvuh-textarea`; `.is-code` on
an input or a textarea sets the monospace font (prompts, patterns, pasted files). 36px, field background, 1px border,
radius 8, focus ring. `.is-missing` is a warning border. Native number spinners, no custom steppers.
`.mvuh-control-row` puts controls and buttons on one line, a select or input taking the free width (a preset select
with New, Rename, Delete; an editor's Save and Cancel); buttons that do not fit wrap to the next line.

**Slider + number** `.mvuh-slider`: `<input type="range" class="mvuh-range" data-mvuh-slider-for="<number id>">`
beside the number input, which stays the value owner. The DNA draws the track (`--mvuh-control-off`) and the thumb (the
accent), because SillyTavern restyles every range input on the page. Only for bounded ranges of at most 20 steps.

**Switch row** `label.mvuh-switch-row`: wraps `<input type="checkbox" role="switch" class="mvuh-switch">`, a title and
a one-line description. Track off is `--mvuh-control-off`, on is the accent; the knob is `--mvuh-switch-knob`. The
track's width and height are `!important`: the switch is a checkbox, and any extension may size every checkbox on the
page with an `!important` rule of its own. Every on/off setting is a switch. Plain checkboxes (`.mvuh-check`) remain
only for choosing members of a set; the DNA draws the box and its tick, so they look the same with or without a host
stylesheet. The empty box is filled with `--mvuh-check-empty` and edged in `--mvuh-control-off`, so it reads against the
card as a switch off does; checked, it fills with the accent and its tick is `--mvuh-on-accent`.

**Buttons**: real `<button type="button">`, keyboard-native. Font Awesome 6 as SillyTavern bundles it (6.5.2 in
SillyTavern 1.18; a standalone app ships the same version), `fa-solid`, the icon left of the label. One icon set: no
text glyphs (✔ ✖ ✓ ✗ ✕ ⚠ ▶ ▼) as icons. An icon button that opens a doc section is a link drawn as one:
`<a class="mvuh-btn mvuh-btn-icon" target="_blank" rel="noopener">`.

| Kind | Class | Look | Use |
|---|---|---|---|
| Primary | `.mvuh-btn.mvuh-btn-primary` | accent fill (`--mvuh-accent-fill`), on-accent text | the one main action of a card; at most one per card |
| Secondary | `.mvuh-btn` | raised surface, border, accent-ink icon | every other action |
| Quiet | `.mvuh-btn.mvuh-btn-quiet` | no fill, accent-ink text | small inline actions (Reset to default) |
| Danger | `.mvuh-btn.mvuh-btn-danger` | danger-soft fill, danger border and text, icon | destructive; always confirms |
| Icon | `.mvuh-btn.mvuh-btn-icon` | 32px square (phone 40), a translated `title` as its name | row actions; `.mvuh-btn-danger` added for delete |
| Icon toggle | `.mvuh-btn.mvuh-btn-icon` + `aria-pressed` | `.is-on` is the accent-soft fill with an accent-ink icon | a per-row on/off |

**Status pill** `.mvuh-pill` + `.is-success | .is-warning | .is-danger | .is-neutral | .is-accent`: a dot or icon in
the status colour, the word in the status ink, on the status soft fill. Status is never a bare coloured dot, and never
needs a legend.

**Scope chip** `.mvuh-chip`: whose data a page's settings belong to ("Global", "Card: <name>"). A card whose scope
differs from its page's carries its own chip. Hints never repeat the scope. An app that edits one project at a time
has one scope and shows no chip.

**Code chip** `.mvuh-code`: a tag, path or pattern shown as written inside a line of text (the live `[name]` a call
reads). Never translated: a hint that leads into one keys its words in a span of their own. A chip that wraps is drawn
whole on each line.

**Notice** `.mvuh-notice` + `.is-info | .is-warning | .is-danger`: a full-width banner: icon, one sentence, an optional
button, beside a short sentence and under a long one, at the end of the line either way. For conditions (nothing open
to act on, a dependency missing, a trust warning, a read that failed), never for help.

**Result list** `.mvuh-result`: the outcome of a validation, import or generation: lines of icon + text,
`.is-success | .is-warning | .is-danger`, with an optional heading; a plain line carries an icon of its own.

**Action card** `.mvuh-action-card` (+ `.is-primary`): icon, title, two-line description, full-width button.
`.mvuh-action-grid`: auto-fit columns of at least 220px on desktop; on phone, 2 compact columns where the description
clamps to two lines and the button stretches over the whole tile (CSS only) with a chevron. The primary card stays
full width.

**List row** `.mvuh-row`: leading icon, a name (or a fixed word) over sub-lines (version, id, source, description; a
line may mix fixed words and values), status pills, trailing actions (icon buttons, danger last). It lays itself out by
its own width, not at the 720px switch: beside the rail a panel wider than 720px still leaves a row too little room for
its pills and actions. The name keeps at least 160px, so the pills wrap under it first (the name and pills share
`.mvuh-row-info`), and the actions take a line of their own across the row once they no longer fit beside it. A row
with no pills or no actions keeps no empty line for them.

**Record card** `.mvuh-record`: a card for a user-made record with many fields, collapsible, drawn like a card (its
fields stand out on the card surface, its header sits on the tinted band). Header: enable switch, icon, name, pills,
trailing icon actions, then the collapse chevron; body: a `.mvuh-grid`, or one field (an editor opened under its row).
A record edited in place rewrites its header (name, pills) as its fields change and never repaints itself, so the
field being typed in keeps its focus.

**Tree** `.mvuh-tree`: nested rows that open and close (a data tree). Each `.mvuh-tree-row` holds, in order, the
grip `.mvuh-tree-grip` of a row that can be dragged into a new place, the branch's chevron `button.mvuh-tree-toggle`
(`aria-expanded`; a leaf holds `.mvuh-tree-spacer` in its place), its controls and name (`.mvuh-tree-name`; a key or
value control takes the free width), then `.mvuh-tree-actions` (icon buttons and icon toggles, delete last). `.is-off`
greys a row left out of a pick. A branch's children follow its row in `.mvuh-tree-branch`, indented along a guide
line. Opening and closing is not saved.

**Advanced row**: a `.mvuh-card.is-advanced` drawn as one row (chevron, title, muted description) until opened. It may
sit inside a card's body (`.mvuh-span`), where it shares that card's scope chip.

**Danger zone** `.mvuh-danger-zone`: a danger-soft card: trash icon, title, "Requires confirmation", danger buttons on
the right. Like a list row it lays itself out by its own width: the text (`.mvuh-danger-text`) keeps at least 160px,
and the buttons go below it, side by side, once they no longer fit beside it.

**Empty state** `.mvuh-empty`: a muted icon, one line, an optional primary button.

**Pager** `.mvuh-pager`: previous and next icon buttons (`disabled` at the ends) around "x / y".

**Split** `.mvuh-split`: two panes and the divider between them (§4). The divider is a focusable
`role="separator"` with `aria-orientation="vertical"` and its position in `aria-valuenow`, `-valuemin` and `-valuemax`
(pixels). Dragging it, or the arrow keys (16px a step; Home and End go to the limits), set `--mvuh-split-start`;
`.is-dragging` marks it while held. Each pane keeps a usable minimum width.

**Dialog**: the adopter's own dialogs carry the root class too. An extension in SillyTavern opens SillyTavern's popup
and styles it in its own stylesheet (mvu-helper: `settings-panel.css`); a standalone app opens a
`<dialog class="mvuh-ui mvuh-dialog">` holding `.mvuh-dialog-body` and `.mvuh-dialog-buttons`. Text, in
`.mvuh-dialog-text`: the question first (bold), the things it touches one per line (values bold,
`.mvuh-dialog-value`), then one line per answer, each naming its button. Buttons on a bar of their own,
right-aligned: the action as a verb, primary, or danger for a safety question (§7), then Cancel, secondary. A form is
a stack of field genes. Fixed sentences are keyed; values stay outside them.

## 6. Copy genes

- Label: at most 4 words, sentence case, names the thing.
- Hint: one line, at most 90 characters: what the control does, or what blank means. Optional when the label already
  says it.
- Detail (behind ?): at most 3 short sentences: the consequences and edge cases needed to decide. No rationale,
  history or implementation.
- More detail: a link to the adopter's public doc section, only where one exists. A guide that explains a whole tab
  lives in that doc, linked from the tab's card headers and fields; the page never carries a manual.
- Card description and page subtitle: one line each.
- Buttons start with a verb, dialog buttons included. A destructive confirm says what is lost, and a dialog's answer
  lines name its buttons.
- No scope sentences (the chip says it); no colour legends (the pill says it).

## 7. Behaviour genes

- Every control applies on change; no save bar or Apply button. An app whose work is a file saves it through its own
  export action.
- Destructive is a danger button plus the adopter's one confirm helper, which answers NO when the dialog cannot
  open. Never the browser's native `confirm()`, `alert()` or `prompt()`. The one exception: removing one line of an
  editor being filled in (a condition row, an extra field, a leaf of a data tree) is an icon button with no confirm,
  because it loses one line that is retyped in a moment. Removing anything with a header of its own (a record, an
  event, a template, a branch with children) confirms.
- A dialog is danger only for a safety question: one whose yes lets code reach beyond the adopter's own work, such as
  a pack whose code can read or change SillyTavern's settings. A question whose yes deletes, removes, replaces or
  resets something is destructive, its action primary: red on every destructive question scares people, and teaches
  them to click through the one that matters. A danger or destructive dialog opens on Cancel, so Enter never says yes
  to it; any other dialog opens on its action.
- A control that cannot act now for a reason of its own is `disabled` (the property) and says why in a pill or notice.
- The card gate, for an extension in SillyTavern: a region that waits for something outside the panel (a card open or
  its chat started) declares it where it sits, `data-mvuh-needs="card"` or `"chat"`, on a card, a danger zone or one
  control. The shell makes every region whose need is unmet `inert` (no click, no keystroke, no focus), greyed whole by
  `--mvuh-inert-opacity`, and shows the page's notice (`data-mvuh-notice-for`, outside every region, so a screen reader
  still reaches it). `inert`, never `disabled`, so each control's own disabled state stays underneath. A need the
  build does not know always waits. A button a renderer builds outside a declared region declares its own, and a
  delegated handler that acts on the card selects only declared controls (`[data-mvuh-needs]`).
- (?) opens the detail inline, which works on touch; never a hover tooltip.
- Cards and advanced rows collapse, and a split's divider moves; neither state is saved.
- After any repaint, sliders re-sync, and in an adopter that translates the locale is re-applied.
- A file picker's input is created for each pick and never joins the page: a dismissed picker fires a `cancel` that
  bubbles, and the dialog the panel sits in closes on it.

## 8. i18n genes

These bind an adopter that ships more than one language (mvu-helper). One that ships a single language
(MvuStatMenuBuilder) writes its strings plain, and none of this section applies to it.

- Every visible string carries `data-i18n` (text), `data-i18n-title` (tooltips, icon buttons) or
  `data-i18n-placeholder`, with its translation in the same commit. Builders emit these, so a row built by JS is keyed
  by construction.
- A translated node holds plain text only: a translator that swaps text drops child markup, so links, code chips,
  glyphs and icons sit outside the translated span.
- A translated node is never a paint target, and a paint target never carries a key. A message built at runtime keys
  its fixed words and leaves the variable part outside the span.
- Keys: `<Label>`, `<Label> hint`, `<Label> detail`, `<Card> desc`, `<Tab> subtitle`.
- No fixed label widths: Chinese labels are shorter, English ones longer.

## 9. Accessibility genes

- Native elements: `<button>`, `<input type="checkbox" role="switch">`, `<label for>`, `<select>`.
- A `:focus-visible` ring on everything interactive.
- AA contrast for every text token (§3); controls at least 3:1; touch targets at least 40px on phone.
- `prefers-reduced-motion` turns transitions off.
- Icon-only buttons carry a translated `title`, which is also their accessible name; icon toggles carry
  `aria-pressed`.
- A split divider is a focusable separator the arrow keys move.

## 10. Code genes

- One stylesheet entry, which imports the palette file and the DNA: an extension's manifest loads it from its `css`
  field, a standalone app imports it from its entry module. No style injected from JS, and no gene or page carries a
  style block of its own: an adopter's own rules live in its own stylesheet.
- Every selector is scoped under the root class.
- Every class the adopter writes is its own: the prefix, a state class (`is-*`) or a Font Awesome icon (`fa-*`). No
  host style class (SillyTavern's `menu_button`, `text_pole`, `flex-container`, …) and no bare name. An entry placed
  in SillyTavern's own UI (the extensions drawer's launcher, a wand-menu item) keeps SillyTavern's look, and a surface
  an adopter draws itself (§4) keeps its own classes and styles inside it.
- Colours only as tokens, and every colour value in the palette file. No inline `style=` except `display:none` on an
  element a script shows later, and a split's `--mvuh-split-start`, which its divider writes.
- Style classes are not JS hooks. JS finds elements by id, `data-*`, or a framework's own reference.
- Each gene's markup lives in one place. A renderer builds genes through the adopter's one module of builders
  (mvu-helper's `gui-dna-core.js`), never hand-written gene markup; a Vue app writes each gene with parts (page
  header, card, field, switch row, notice, result list, list row, record card, action card, split, dialog) as one
  component, and its pages use those components. A gene of one element (a button, a control, a pill, a chip) is
  written as that element with its classes; a tree's rows are written by the one component that draws that tree.
