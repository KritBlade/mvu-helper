/**
 * MVU Helper — G12: the palette's contrast, measured where each colour reads worst (devdoc/gui-dna.md §3, Contrast).
 * The panel is glass: a see-through surface's colour is the canvas under it, then its own layers. tools/palette-contrast.mjs
 * composites every surface over every canvas point it can sit on, at every stop of its gradients; text holds 4.5:1, a
 * control, an icon and the focus ring 3:1, in both themes. The surfaces the measure takes as solid (a dialog, a select's
 * list, the phone strip's base) are checked solid in the stylesheets, so the measure and the page cannot drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paletteThemes, contrastRows, PALETTE_CSS } from '../tools/palette-contrast.mjs';

const PANEL_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'settings-panel');
const read = (file) => readFileSync(path.join(PANEL_FOLDER, file), 'utf8').replace(/\r\n/g, '\n');
const themes = paletteThemes(readFileSync(PALETTE_CSS, 'utf8'));
const describeRow = (row) => `${row.ink}${row.use ? ` (${row.use})` : ''} on the ${row.surface}: ${row.ratio.toFixed(2)} < ${row.minimum}`;

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css, selector) {
    const start = css.indexOf(`${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
}

describe('G12 — palette contrast', () => {
    for (const theme of ['dark', 'light']) {
        it(`${theme}: every colour holds its floor on every surface it sits on`, () => {
            const rows = contrastRows(themes[theme]);
            expect(rows.length).toBeGreaterThan(80);   // a measure that found nothing would pass anything
            expect(rows.filter((row) => !row.holds).map(describeRow)).toEqual([]);
        });
    }

    it('a see-through card is measured over the canvas under it, not on its own colour', () => {
        // A canvas lit as bright as the muted text: the same card colour now fails.
        const theme = new Map(themes.dark).set('bg-gradient', 'radial-gradient(100% 100% at 50% 50%, rgb(181 197 213 / 100%) 0%, transparent 100%)');
        const muted = contrastRows(theme).find((row) => row.ink === 'text-muted' && row.surface === 'card');
        expect(muted.holds).toBe(false);
    });

    it('what the measure takes as solid is solid in the stylesheets', () => {
        const dna = read('gui-dna.css');
        expect(ruleBody(dna, 'dialog.mvuh-ui.mvuh-dialog')).toContain('background-color: var(--mvuh-surface-solid);');
        expect(ruleBody(dna, '.mvuh-ui .mvuh-select option')).toContain('background-color: var(--mvuh-surface-solid);');
        expect(ruleBody(read('settings-panel.css'), 'dialog.popup.mvuh-popup')).toContain('background-color: var(--mvuh-surface-solid);');
        // The sticky phone strip: the nav colour over the canvas colour.
        const phone = dna.slice(dna.indexOf('@container mvuh-shell (max-width: 720px)'));
        expect(ruleBody(phone, '    .mvuh-ui .mvuh-nav')).toContain('background: linear-gradient(var(--mvuh-nav) 0 0), var(--mvuh-bg);');
    });
});
