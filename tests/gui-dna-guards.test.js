/**
 * MVU Helper — the GUI-DNA guards: the settings panel's design system (devdoc/gui-dna.md) checked against the source.
 *   G1  every translation key the panel uses has a zh-cn entry
 *   G2  a hint, card description, switch description or page subtitle is one line: ≤ 90 characters — in the markup,
 *       and in every hint a renderer builds
 *   G3  no inline style except display:none, in the markup or any panel renderer
 *   G4  every class a JS selector looks for is still emitted somewhere
 *   G5  colours live only in palette.css's token blocks: no other panel file holds one, and both themes name every role
 *   G6  every class mvu-helper writes is its own (mvuh-, is-, fa-): no SillyTavern style class, no bare name
 *   G7  an element the code paints into carries no translation key
 * G8–G12 have files of their own: no-native-dialogs, popup-api-boundary, file-picker-boundary, card-gate and palette-contrast.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, jsFilesUnder } from './code-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const PANEL_FOLDER = path.join(SRC, 'features', 'settings-panel');
const SETTINGS_HTML = path.join(PANEL_FOLDER, 'settings.html');
const GUI_DNA_CSS = path.join(PANEL_FOLDER, 'gui-dna.css');
const PALETTE_CSS = path.join(PANEL_FOLDER, 'palette.css');

const read = (file) => readFileSync(file, 'utf8');
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const decodeEntities = (text) => text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const withoutHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

// Everything that paints the panel: its markup and every renderer that writes rows into it.
const PANEL_FILES = [
    SETTINGS_HTML,
    ...filesUnder(path.join(SRC, 'features'), ['-ui.js']),
    path.join(SRC, 'features', 'artifact-dev-loop', 'artifact-dev-loop.js'),
    path.join(SRC, 'features', 'llm-task-router', 'llm-task-router.js'),
    path.join(SRC, 'shared', 'card-artifact-store.js'),
];

// ── G1 ─────────────────────────────────────────────────────────────────────────────────────────────
const I18N_KEY = /data-i18n(?:-title|-placeholder)?="([^"]*)"/g;
// A gene builder keys its `text:`, `title:` and `placeholder:` (gui-dna-core.js), so in a file that builds with them —
// it imports the settings-panel barrel — and in the builders themselves, each such string literal is a key.
const GUI_DNA_CORE = path.join(PANEL_FOLDER, 'gui-dna-core.js');
const BUILDS_GENES = /from\s+['"][^'"]*settings-panel\/index\.js['"]/;
const BUILDER_KEY = /\b(?:text|title|placeholder)\s*:\s*(['"])((?:(?!\1)[^\\\n])+)\1/g;
// A fixed word in the { text: '…' } shape — a dialog line (sillytavern/popup-core.js), or a pill or row line a core
// hands its renderer — and a dialog button's label are keys wherever they are written: a question or a status is
// often built in a core file that renders nothing itself.
const DIALOG_LINE_KEY = /\{\s*text\s*:\s*(['"])((?:(?!\1)[^\\\n])+)\1/g;
const DIALOG_BUTTON_KEY = /\b(?:okButton|cancelButton)\s*:\s*(['"])((?:(?!\1)[^\\\n])+)\1/g;
// A fixed word written with an escape (`'the card\'s'`) cannot be read by the scans above, so its key would go
// unchecked: it is refused, and written in the other quotes instead. Same shapes, same scope as the scans.
const ESCAPED = String.raw`(['"])(?:(?!\1)[^\\\n]|\\.)*\\.(?:(?!\1)[^\\\n]|\\.)*\1`;
const ESCAPED_DIALOG_WORD = new RegExp(String.raw`(?:\{\s*text|\b(?:okButton|cancelButton))\s*:\s*` + ESCAPED, 'g');
const ESCAPED_BUILDER_WORD = new RegExp(String.raw`\b(?:text|title|placeholder)\s*:\s*` + ESCAPED, 'g');

function literalI18nKeys() {
    const keys = [];
    for (const match of withoutHtmlComments(read(SETTINGS_HTML)).matchAll(I18N_KEY)) {
        keys.push({ where: relative(SETTINGS_HTML), key: decodeEntities(match[1]) });
    }
    for (const file of jsFilesUnder(SRC)) {
        const text = read(file);
        const buildsGenes = file === GUI_DNA_CORE || BUILDS_GENES.test(text);
        text.split(/\r?\n/).forEach((line) => {
            if (isCommentLine(line)) return;
            for (const match of line.matchAll(I18N_KEY)) {
                // A key built at runtime (concatenated or interpolated) is not a literal to look up.
                if (!match[1] || /['"+`\\]|\$\{/.test(match[1])) continue;
                keys.push({ where: relative(file), key: decodeEntities(match[1]) });
            }
            for (const match of line.matchAll(DIALOG_LINE_KEY)) keys.push({ where: relative(file), key: match[2] });
            for (const match of line.matchAll(DIALOG_BUTTON_KEY)) keys.push({ where: relative(file), key: match[2] });
            if (!buildsGenes) return;
            for (const match of line.matchAll(BUILDER_KEY)) keys.push({ where: relative(file), key: match[2] });
        });
    }
    return keys;
}

function escapedFixedWords() {
    const found = [];
    for (const file of jsFilesUnder(SRC)) {
        const text = read(file);
        const buildsGenes = file === GUI_DNA_CORE || BUILDS_GENES.test(text);
        text.split(/\r?\n/).forEach((line, index) => {
            if (isCommentLine(line)) return;
            const shapes = buildsGenes ? [ESCAPED_DIALOG_WORD, ESCAPED_BUILDER_WORD] : [ESCAPED_DIALOG_WORD];
            for (const shape of shapes) {
                for (const match of line.matchAll(shape)) found.push(`${relative(file)}:${index + 1} ${match[0]}`);
            }
        });
    }
    return [...new Set(found)];
}

// ── G2 ─────────────────────────────────────────────────────────────────────────────────────────────
const ONE_LINE_MAX = 90;
const ONE_LINE_ELEMENT = /<(p|span|div|small)\b[^>]*\bclass="[^"]*\b(mvuh-hint|mvuh-card-desc|mvuh-switch-desc|mvuh-page-subtitle)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;

// A hint a renderer builds: hint({ text: '…' }) in a file that builds with the gene builders.
const BUILT_HINT = /\bhint\(\{\s*text\s*:\s*(['"])((?:(?!\1)[^\\\n])+)\1/g;

function oneLineTexts() {
    const texts = [...withoutHtmlComments(read(SETTINGS_HTML)).matchAll(ONE_LINE_ELEMENT)].map((match) => ({
        kind: match[2],
        text: decodeEntities(match[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
    }));
    for (const file of jsFilesUnder(SRC)) {
        const text = read(file);
        if (!BUILDS_GENES.test(text)) continue;
        for (const match of text.matchAll(BUILT_HINT)) texts.push({ kind: `mvuh-hint (${relative(file)})`, text: match[2] });
    }
    return texts;
}

// ── G3 ─────────────────────────────────────────────────────────────────────────────────────────────
function inlineStyleCount(text) {
    const styles = (text.match(/\bstyle\s*=/g) || []).length;
    const hidden = (text.match(/\bstyle\s*=\s*["']\s*display\s*:\s*none\s*;?\s*["']/g) || []).length;
    const jqueryCss = (text.match(/\.css\(/g) || []).length;
    return styles - hidden + jqueryCss;
}

// ── G4 ─────────────────────────────────────────────────────────────────────────────────────────────
const SELECTOR_CALL = /(?:\$|\.find|\.closest|\.children|\.parents?|\.filter|\.is|\.not|\.has|querySelector(?:All)?)\(\s*(['"`])((?:(?!\1)[^\n])*)\1/g;
const CLASS_TOKEN = /\.(mvuh-[\w-]+)/g;
const mentions = (text, token) => new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text);

function selectorClassesAndEmittedText() {
    const selectorClasses = new Map();   // class → first file that looks it up
    const emitted = [withoutHtmlComments(read(SETTINGS_HTML)), read(GUI_DNA_CSS)];   // markup + the DNA's genes
    for (const file of jsFilesUnder(SRC)) {
        const text = read(file);
        for (const match of text.matchAll(SELECTOR_CALL)) {
            for (const token of match[2].matchAll(CLASS_TOKEN)) {
                if (!selectorClasses.has(token[1])) selectorClasses.set(token[1], relative(file));
            }
        }
        emitted.push(text.replace(SELECTOR_CALL, ''));   // a class counts as emitted only OUTSIDE a lookup
    }
    return { selectorClasses, emitted };
}

// ── G5 ─────────────────────────────────────────────────────────────────────────────────────────────
// A hex colour (not an HTML entity such as &#039;), or an rgb/hsl call.
const COLOUR = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|\b(?:rgba?|hsla?)\(/g;
const TOKEN_DECLARATION = /^\s*--mvuh-[\w-]+\s*:/;

function colourCount(text) {
    return text.split(/\r?\n/).filter((line) => !isCommentLine(line))
        .reduce((count, line) => count + (line.match(COLOUR) || []).length, 0);
}

// The palette's two themes: the dark default on the root class, the light one under the attribute settings-panel.js
// writes on <html>. A role one block leaves out silently keeps the other theme's colour, so both name the same roles.
const DARK_THEME_SELECTOR = '.mvuh-ui';
const LIGHT_THEME_SELECTOR = 'html[data-mvuh-theme="light"] .mvuh-ui';

function themeRoles(css) {
    const roles = new Map();
    for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^{}\s][^{}]*?)\s*\{([^{}]*)\}/gm)) {
        roles.set(match[1].trim(), new Set([...match[2].matchAll(/^\s*(--mvuh-[\w-]+)\s*:/gm)].map((role) => role[1])));
    }
    return roles;
}

// ── G6 ─────────────────────────────────────────────────────────────────────────────────────────────
// Every class mvu-helper writes is its own: the prefix (mvuh-), a state (is-) or a Font Awesome icon (fa-), the icon
// set SillyTavern bundles. Any other name reaches into a stylesheet that is not ours: a SillyTavern style class
// (menu_button, text_pole, flex-container, …) repaints the panel in the user's theme, and a bare name can meet another
// extension's rule on the same page. The scan reads every class attribute (markup, a template, .className) and every
// class call (addClass, toggleClass, classList.add, …) in src, and a ${…} part by its quoted words. It leaves out what
// is written on surfaces the DNA does not style: settings.html before the panel holder (SillyTavern's drawer frame and
// the launcher in it), and these files.
const OWN_CLASS = /^(?:mvuh|is|fa)-(?:[\w-]+|[\w-]*\*)$/;
const PANEL_HOLDER = 'id="mvuh_panel_holder"';
const OUTSIDE_THE_DNA = new Map([
    ['src/index.js', "the wand item and the drawer's container, in SillyTavern's own menus"],
    ['src/features/imagegen/image-gen.js', 'the picture markup, saved inside chat messages: renaming it needs a migration'],
    ['src/features/imagegen/image-splice-core.js', 'the picture markup, saved inside chat messages: renaming it needs a migration'],
]);
const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*=\s*(["'`])([^\n]*?)\1/g;
const CLASS_CALL = /\.(?:addClass|removeClass|toggleClass)\(\s*(["'`])([^"'`\n]*)\1|\.classList\.(?:add|remove|toggle|replace)\(([^)\n]*)\)/g;
const quotedWords = (code) => [...code.matchAll(/(["'`])([^"'`]*)\1/g)].map((match) => match[2]).join(' ');

// The class names in an attribute's value: its words, and the quoted words in each ${…}. A word glued to a ${…}
// (`is-${status}`) is judged by the part written out, kept as `is-*`; a word that starts with one has nothing to judge.
function classNames(value) {
    const names = [];
    const literal = value.replace(/\$\{([^}]*)\}/g, (_, expression) => {
        names.push(...quotedWords(expression).split(/\s+/));
        return '*';
    });
    for (const word of literal.split(/\s+/)) {
        const writtenPart = word.split('*')[0];
        if (writtenPart) names.push(word.includes('*') ? `${writtenPart}*` : writtenPart);
    }
    return names.filter((name) => /^[\w-]+\*?$/.test(name));
}

function writtenClasses() {
    const written = new Set();
    const foreign = [];
    const scan = (file, lines, firstLine) => lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        const names = [
            ...[...line.matchAll(CLASS_ATTRIBUTE)].flatMap((match) => classNames(match[2])),
            ...[...line.matchAll(CLASS_CALL)].flatMap((match) => classNames(match[2] ?? quotedWords(match[3]))),
        ];
        for (const name of names) {
            written.add(name);
            if (!OWN_CLASS.test(name)) foreign.push(`${relative(file)}:${firstLine + index} "${name}"`);
        }
    });
    const html = read(SETTINGS_HTML);
    const holderAt = html.indexOf(PANEL_HOLDER);
    const panelMarkup = html.slice(holderAt).replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''));
    scan(SETTINGS_HTML, panelMarkup.split(/\r?\n/), html.slice(0, holderAt).split(/\r?\n/).length);
    for (const file of jsFilesUnder(SRC)) {
        if (!OUTSIDE_THE_DNA.has(relative(file))) scan(file, read(file).split(/\r?\n/), 1);
    }
    return { written, foreign };
}

// ── G7 ─────────────────────────────────────────────────────────────────────────────────────────────
const PAINT_CALL = String.raw`\.(?:html|text|append|prepend)\(\s*[^)\s]|\.empty\(`;
const ID_LOOKUP = /\$\(\s*(['"])#([\w-]+)\1\s*\)/g;
const ID_VARIABLE = /(?:const|let|var)\s+(\$?\w+)\s*=\s*\$\(\s*(['"])#([\w-]+)\2\s*\)/g;

function paintedIds() {
    const painted = new Set();
    for (const file of jsFilesUnder(SRC)) {
        const text = read(file);
        for (const line of text.split(/\r?\n/)) {
            for (const match of line.matchAll(ID_LOOKUP)) {
                const rest = line.slice(match.index + match[0].length).split(';')[0];
                if (new RegExp(`^\\s*(?:\\.\\w+\\([^)]*\\)\\s*)*?(?:${PAINT_CALL})`).test(rest)) painted.add(match[2]);
            }
        }
        for (const match of text.matchAll(ID_VARIABLE)) {
            const variable = match[1].replace(/\$/g, '\\$');
            if (new RegExp(`(?<![\\w$])${variable}(?:${PAINT_CALL})`).test(text)) painted.add(match[3]);
        }
    }
    return painted;
}

function openingTagOf(html, id) {
    const match = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    return match ? match[0] : '';
}

describe('GUI-DNA guards', () => {
    it('G1 — every translation key the panel uses has a zh-cn entry', () => {
        const dictionary = JSON.parse(read(path.join(ROOT, 'i18n', 'zh-cn.json')));
        const keys = literalI18nKeys();
        expect(keys.length).toBeGreaterThan(100);   // a scan that found nothing would pass anything
        const missing = keys.filter(({ key }) => !(key in dictionary)).map(({ where, key }) => `${where}: "${key}"`);
        expect([...new Set(missing)]).toEqual([]);
        // The scan sees a dialog's line and its button, written outside any settings-panel file.
        expect(keys.some(({ where }) => where === 'src/sillytavern/card-access.js')).toBe(true);
        expect(escapedFixedWords()).toEqual([]);
    });

    it(`G2 — a hint, card description, switch description or page subtitle is one line (≤ ${ONE_LINE_MAX} characters)`, () => {
        const texts = oneLineTexts();
        expect(texts.filter((t) => t.kind === 'mvuh-page-subtitle').length).toBeGreaterThanOrEqual(7);
        expect(texts.some((t) => t.kind.startsWith('mvuh-hint (src/'))).toBe(true);   // the scan sees a built hint
        const tooLong = texts.filter((t) => t.text.length > ONE_LINE_MAX).map((t) => `${t.kind} (${t.text.length}): ${t.text}`);
        expect(tooLong).toEqual([]);
    });

    it('G3 — no inline style (display:none excepted)', () => {
        const styled = PANEL_FILES.map((file) => [relative(file), inlineStyleCount(read(file))]).filter(([, count]) => count)
            .map(([file, count]) => `${file}: ${count} inline style(s) — use a GUI-DNA class instead`);
        expect(styled).toEqual([]);
    });

    it('G4 — every class a JS selector looks for is still emitted somewhere', () => {
        const { selectorClasses, emitted } = selectorClassesAndEmittedText();
        // The scan sees the shell's own lookup — a scan that found nothing would pass anything.
        expect(selectorClasses.get('mvuh-range')).toBe('src/features/settings-panel/settings-panel.js');
        const orphaned = [...selectorClasses].filter(([token]) => !emitted.some((text) => mentions(text, token)))
            .map(([token, file]) => `${file} looks for .${token}, which nothing emits`);
        expect(orphaned).toEqual([]);
    });

    it('G5 — colours live only in palette.css', () => {
        const drift = PANEL_FILES.map((file) => [relative(file), colourCount(read(file))]).filter(([, count]) => count)
            .map(([file, count]) => `${file}: ${count} colour(s) — use a --mvuh- token instead`);
        expect(colourCount(read(PALETTE_CSS))).toBeGreaterThan(20);   // a palette that moved would pass anything
        for (const file of filesUnder(PANEL_FOLDER, ['.css'])) {
            const isPalette = file === PALETTE_CSS;
            read(file).split(/\r?\n/).forEach((line, index) => {
                if (!(line.match(COLOUR) || []).length || (isPalette && TOKEN_DECLARATION.test(line))) return;
                drift.push(`${relative(file)}:${index + 1} a colour outside palette.css's token block: ${line.trim()}`);
            });
        }
        expect(drift).toEqual([]);
    });

    it('G5 — the dark and the light theme name the same colour roles', () => {
        const themes = themeRoles(read(PALETTE_CSS));
        expect([...themes.keys()]).toEqual([DARK_THEME_SELECTOR, LIGHT_THEME_SELECTOR]);
        const [dark, light] = [themes.get(DARK_THEME_SELECTOR), themes.get(LIGHT_THEME_SELECTOR)];
        expect(dark.size).toBeGreaterThan(40);   // a parse that found nothing would pass anything
        expect([...dark].filter((role) => !light.has(role)).map((role) => `${role}: dark only`)).toEqual([]);
        expect([...light].filter((role) => !dark.has(role)).map((role) => `${role}: light only`)).toEqual([]);
        // The light block's attribute is the one the shell writes.
        expect(read(path.join(PANEL_FOLDER, 'settings-panel.js'))).toContain('document.documentElement.dataset.mvuhTheme = theme');
    });

    it('G6 — every class mvu-helper writes is its own: no SillyTavern style class', () => {
        expect(classNames("mvuh-row is-${status} ${isPair ? 'mvuh-grid-pair' : ''}${extraClass} fa-solid"))
            .toEqual(['mvuh-grid-pair', 'mvuh-row', 'is-*', 'fa-solid']);
        const { written, foreign } = writtenClasses();
        // The scan sees the markup, a dialog's .className, a class call and a classList call — a scan that found
        // nothing would pass anything — and not the launcher, which sits before the panel holder.
        expect(written.has('mvuh-shell')).toBe(true);
        expect(written.has('mvuh-dialog-text')).toBe(true);
        expect(written.has('is-active')).toBe(true);
        expect(written.has('mvuh-popup')).toBe(true);
        expect(written.has('menu_button')).toBe(false);
        expect(foreign.map((where) => `${where} — not mvuh-, is- or fa-: use a GUI-DNA class`)).toEqual([]);
    });

    it('G7 — an element the code paints into carries no translation key', () => {
        const painted = paintedIds();
        expect(painted.has('mvuh_devloop_status')).toBe(true);   // the scan sees a paint through a variable
        expect(painted.has('mvuh_gp_state')).toBe(true);
        const html = withoutHtmlComments(read(SETTINGS_HTML));
        const clashes = [...painted].filter((id) => /\bdata-i18n="/.test(openingTagOf(html, id)))
            .map((id) => `#${id} is painted by code and carries data-i18n — the next locale pass overwrites the paint`);
        expect(clashes).toEqual([]);
    });
});
