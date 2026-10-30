// devdoc/statbox-guide.md is what a card author copies from, so its examples are held to the code: every
// JSON block is either a `statBox` config that imports with nothing reported, or a regex script that
// actually removes / dresses a box built from the guide's own config. And the console wording the guide
// tells authors to search for is the wording statbox.js prints.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStatBoxSection, renderStatBox } from '../src/features/statbox/statbox-core.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Read with LF line endings: a checkout with core.autocrlf=true hands the files over with CRLF, and the
// block pattern below would then match nothing.
const readLf = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const guide = readLf('devdoc', 'statbox-guide.md');
const hostSource = readLf('src', 'features', 'statbox', 'statbox.js');

const jsonBlocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
const configs = jsonBlocks.filter((b) => b.statBox);
const scripts = jsonBlocks.filter((b) => b.script_name);
const toRegExp = (literal) => { const m = /^\/(.*)\/([a-z]*)$/s.exec(literal); return new RegExp(m[1], m[2]); };

describe('devdoc/statbox-guide.md — the examples are real', () => {
    it('every JSON block is a statBox config or a regex script', () => {
        expect(jsonBlocks.length).toBeGreaterThan(0);
        expect(configs.length + scripts.length).toBe(jsonBlocks.length);
    });
    it('every config imports with nothing reported', () => {
        expect(configs.length).toBeGreaterThanOrEqual(2);
        for (const block of configs) {
            const report = { retired: [], unknown: [], blocked: [] };
            expect(normalizeStatBoxSection(block.statBox, report)).not.toBe(null);
            expect(report).toEqual({ retired: [], unknown: [], blocked: [] });
        }
    });
    it('the regex scripts remove / dress a box built from the first config', () => {
        const section = normalizeStatBoxSection(configs[0].statBox, { retired: [], unknown: [], blocked: [] });
        const box = renderStatBox(section, { Mainchar: { Name: 'Critblade', Cha: 50 }, Classmate: {} }, { Mainchar: { Name: 'Critblade', Cha: 51 }, Classmate: {} });
        const reply = `<gametxt>\nprose\n${box}\n</gametxt>`;
        const detag = scripts.find((s) => s.destination.prompt && !s.destination.display);
        const display = scripts.find((s) => s.destination.display && !s.destination.prompt);
        expect(reply.replace(toRegExp(detag.find_regex), detag.replace_string)).toBe('<gametxt>\nprose\n</gametxt>');
        const shown = reply.replace(toRegExp(display.find_regex), display.replace_string);
        expect(shown).not.toContain(section.open);
        expect(shown).toContain('Critblade: CHA 51 (+1)');
    });
    it('the console wording the guide quotes is the wording the host prints', () => {
        for (const phrase of [
            "none of the card's placeBefore anchors",
            'is in the reply, so the box was NOT written',
            "ends without its envelope's closing tag",
            'line(s) against baseline',
            'which resolves to nothing',
            'Check its spelling against the card',
            'a [reply-integrity] TRUNCATED warning names that',
            'left out of the box',
        ]) {
            expect(guide).toContain(phrase);
            expect(hostSource).toContain(phrase);
        }
    });
});
