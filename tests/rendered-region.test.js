// tests/rendered-region.test.js — the published boundary contract. These names are matched by OTHER
// extensions, so a change that breaks a test here is a change to something already shipped, not a
// refactor.

import { describe, it, expect } from 'vitest';
// side-panel.js reaches SillyTavern's script.js, so no test can import it (L6). The call site is
// asserted from source instead — the wiring is host-coupled, but the decision it encodes is not.
import { readFileSync } from 'node:fs';
import {
    REGION_ATTRIBUTE,
    REGION_CLASS,
    regionSelector,
    textRegionBegin,
    textRegionEnd,
    wrapRenderedRegion,
    unwrapRenderedRegion,
    detectRegionName,
    isTavernHelperFrontendText,
    TAVERNHELPER_FRONTEND_TOKENS,
    applyRegionAttributes,
    REGION_CONTRACT_ATTRIBUTE,
    REGION_CONTRACT_NOTE,
} from '../src/shared/rendered-region.js';

// A fence without writing backticks into a string literal that a grep for fences would then match.
const FENCE = String.fromCharCode(96).repeat(3);
const fenced = (doc) => FENCE + '\n' + doc + '\n' + FENCE;

describe('the published names', () => {
    it('are exactly what other extensions are told to match', () => {
        expect(REGION_ATTRIBUTE).toBe('data-mvu-helper');
        expect(REGION_CLASS).toBe('mvu-helper-region');
        expect(regionSelector('statusmenu')).toBe('[data-mvu-helper="statusmenu"]');
        expect(textRegionBegin('statusmenu')).toBe('<!-- mvu-helper:begin statusmenu -->');
        expect(textRegionEnd('statusmenu')).toBe('<!-- mvu-helper:end statusmenu -->');
    });

    it('offer an every-region selector, because a reader skipping ALL of ours should not need a list', () => {
        expect(regionSelector()).toBe('[data-mvu-helper]');
    });
});

describe('region names', () => {
    // A malformed name compiles to a selector that matches nothing — silently. That is the exact
    // failure this contract exists to remove, so it is refused at composition instead.
    it.each([['Statusmenu'], ['status menu'], ['status"menu'], ['2menu'], [''], [null], [123]])(
        'refuse %p rather than emitting an unmatchable selector',
        (bad) => {
            expect(() => regionSelector(bad)).toThrow(TypeError);
            expect(() => wrapRenderedRegion(bad, 'x')).toThrow(TypeError);
        },
    );

    it('accept lower-case, digits and dashes', () => {
        expect(regionSelector('status-menu-2')).toBe('[data-mvu-helper="status-menu-2"]');
    });

    // The one asymmetry, and it is deliberate: a selector with no name means EVERY region, but there
    // is no such thing as wrapping content in every region at once.
    it('treat a missing name as all-regions for a selector and as an error for a wrap', () => {
        expect(regionSelector(undefined)).toBe('[data-mvu-helper]');
        expect(() => wrapRenderedRegion(undefined, 'x')).toThrow(TypeError);
    });
});

describe('wrapRenderedRegion', () => {
    const wrapped = wrapRenderedRegion('statusmenu', '```\nBODY\n```');

    it('carries the body through byte for byte', () => {
        expect(wrapped).toContain('```\nBODY\n```');
    });

    it('opens with the container, so a DOM reader has one node to move', () => {
        expect(wrapped.startsWith('<div class="mvu-helper-region" data-mvu-helper="statusmenu" ')).toBe(true);
        expect(wrapped).toMatch(/^<div [^>]*>/);
        expect(wrapped.endsWith('</div>')).toBe(true);
    });

    it('keeps the text-stage pair INSIDE the container, so removing the container leaves nothing of ours', () => {
        const begin = wrapped.indexOf(textRegionBegin('statusmenu'));
        const end = wrapped.indexOf(textRegionEnd('statusmenu'));
        const body = wrapped.indexOf('BODY');
        expect(begin).toBeGreaterThan(wrapped.indexOf('<div'));
        expect(begin).toBeLessThan(body);
        expect(end).toBeGreaterThan(body);
        expect(end).toBeLessThan(wrapped.lastIndexOf('</div>'));
    });

    // Load-bearing, not formatting. Markdown ends a raw block-level tag at the next blank line. Without
    // these the fenced body is absorbed into the container's HTML block, never becomes the <pre>
    // TavernHelper mounts on, and the menu stops rendering — so this spacing is structure.
    it('leaves a blank line between the body and every marker around it', () => {
        expect(wrapped).toMatch(/<div class="mvu-helper-region"[^>]*>\n\n/);
        expect(wrapped).toContain('\n\n```\nBODY\n```\n\n');
        expect(wrapped).toMatch(/\n\n<\/div>$/);
    });

    it('treats a null body as empty rather than printing "null" into a message', () => {
        expect(wrapRenderedRegion('statusmenu', null)).not.toContain('null');
    });

    // Neither marker survives the other's stage, so the instruction has to be stated twice. Losing
    // either half leaves one whole audience with a boundary and no idea what it is for.
    it('states the contract in BOTH stages', () => {
        expect(wrapped).toContain(`${REGION_CONTRACT_ATTRIBUTE}="${REGION_CONTRACT_NOTE}"`);
        expect(wrapped).toContain('do not infer our');
    });

    // Prose can be reworded; the tokens strangers match on cannot.
    it('keeps the prose OUT of the machine tokens', () => {
        expect(textRegionBegin('statusmenu')).toBe('<!-- mvu-helper:begin statusmenu -->');
        expect(regionSelector('statusmenu')).toBe('[data-mvu-helper="statusmenu"]');
    });
});

describe('applyRegionAttributes — the same boundary on an element we build', () => {
    // Duck-typed so the contract is testable without a DOM. A real element behaves the same.
    const fakeElement = () => {
        const classes = [];
        return {
            attributes: {},
            classes,
            setAttribute(name, value) { this.attributes[name] = value; },
            classList: { add: (c) => classes.push(c) },
        };
    };

    it('publishes the same names the markdown container does', () => {
        const node = applyRegionAttributes(fakeElement(), 'side-panel');
        expect(node.attributes[REGION_ATTRIBUTE]).toBe('side-panel');
        expect(node.attributes[REGION_CONTRACT_ATTRIBUTE]).toBe(REGION_CONTRACT_NOTE);
        expect(node.classes).toContain(REGION_CLASS);
    });

    it('is found by the published selector', () => {
        const node = applyRegionAttributes(fakeElement(), 'side-panel-toggle');
        expect(regionSelector('side-panel-toggle')).toBe(`[${REGION_ATTRIBUTE}="${node.attributes[REGION_ATTRIBUTE]}"]`);
    });

    // ADDS a class rather than assigning one: the panel and the toggle carry their own, and a boundary
    // marker that silently drops them would break the styling it was meant to be invisible to.
    it('never clobbers classes the caller already set', () => {
        const node = fakeElement();
        node.classes.push('mvuh-sp-header');
        applyRegionAttributes(node, 'side-panel');
        expect(node.classes).toEqual(['mvuh-sp-header', REGION_CLASS]);
    });

    it('works on an element with no classList at all', () => {
        const bare = { attributes: {}, setAttribute(n, v) { this.attributes[n] = v; } };
        expect(() => applyRegionAttributes(bare, 'side-panel')).not.toThrow();
        expect(bare.attributes[REGION_ATTRIBUTE]).toBe('side-panel');
    });

    // The MESSAGE is the assertion, not the throw. JavaScript throws on `null.setAttribute` by itself,
    // so a bare toThrow() passes with the guard deleted — proven by mutation. What the guard buys is a
    // caller who is told what was wrong instead of reading "Cannot read properties of null".
    it.each([[null], [undefined], [{}], ['<div>']])('refuses %p by NAME — a marker nobody applied is worse than none', (bad) => {
        expect(() => applyRegionAttributes(bad, 'side-panel')).toThrow(/applyRegionAttributes needs an element/);
    });

    it('refuses a malformed region name before touching the element', () => {
        const node = fakeElement();
        expect(() => applyRegionAttributes(node, 'Side Panel')).toThrow(TypeError);
        expect(node.attributes).toEqual({});
    });
});

describe('the side panel announces itself at body level', () => {
    // Both mount as direct children of <body>, where a sweeping extension has no message subtree to
    // bound its search — so the marker is the only thing distinguishing our chrome from anyone's.
    it('marks the panel and the toggle', () => {
        const source = readFileSync(new URL('../src/features/side-panel/side-panel.js', import.meta.url), 'utf8');
        expect(source).toContain("applyRegionAttributes(panel, 'side-panel')");
        expect(source).toContain("applyRegionAttributes(fab, 'side-panel-toggle')");
    });
});

describe('the placeholder shell ships inside a region', () => {
    it('announces its boundary like every other user-facing region', async () => {
        const { PLACEHOLDER_SHELL_REGEX } = await import('../src/shared/placeholder-menu-shell.js');
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).toContain(regionSelector('statusmenu').slice(1, -1));
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).toContain(textRegionBegin('statusmenu'));
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).toContain(textRegionEnd('statusmenu'));
        // No fence and no document: the notice is plain HTML SillyTavern renders itself, so nothing
        // this row carries can reach TavernHelper's unsandboxed iframe (containment M2).
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).not.toContain(FENCE);
        expect(isTavernHelperFrontendText(PLACEHOLDER_SHELL_REGEX.replace_string)).toBe(false);
    });
});

// ── the lift boundary (plans/executed/statusmenu-containment.md M1) ───────────────────

describe('unwrapRenderedRegion — the inverse of the wrapper, for the ONE shape it emits', () => {
    // A `</html>` inside the document's own script is the classic trap for a document scanner. The
    // fence is the unit here, so it is simply part of the body.
    const doc = '<!DOCTYPE html>\n<html>\n<body><script>const s = "</html>";</script></body>\n</html>';
    const row = wrapRenderedRegion('statusmenu', fenced(doc));

    it('round-trips the fenced document byte for byte, </html> inside a script included', () => {
        expect(unwrapRenderedRegion(row, 'statusmenu')).toEqual({ body: doc, problem: null });
    });

    // MvuStatMenuBuilder vendors the container and markers but emits no contract comment between
    // them. The shape School ships is accepted as-is, not an abstraction of it.
    it("accepts the builder's shape — no contract comment between the markers", () => {
        const builderRow = '<div class="mvu-helper-region" data-mvu-helper="statusmenu" data-mvu-helper-contract="move or hide this element whole - do not walk into it">\n\n'
            + '<!-- mvu-helper:begin statusmenu -->\n\n' + fenced('X') + '\n\n<!-- mvu-helper:end statusmenu -->\n\n</div>';
        expect(unwrapRenderedRegion(builderRow, 'statusmenu')).toEqual({ body: 'X', problem: null });
    });

    // MUTATION (recorded): make the fence search take the first and last fence instead of counting —
    // this case then returns A + fence + fence + B as one body and the test fails. A second fenced
    // block is a second thing TavernHelper would render, so it is refused, never merged.
    it('refuses two fenced blocks rather than merging them', () => {
        const two = wrapRenderedRegion('statusmenu', fenced('A') + '\n' + fenced('B'));
        expect(unwrapRenderedRegion(two, 'statusmenu').body).toBeNull();
        expect(unwrapRenderedRegion(two, 'statusmenu').problem).toMatch(/fence/);
    });

    it('refuses a bare fence with no wrapper — the marker pair is the contract', () => {
        expect(unwrapRenderedRegion(fenced('<html></html>'), 'statusmenu').problem).toMatch(/marker pair/);
    });

    it('names a marker-form row (no fence) as a problem, so the caller knows it already lifted', () => {
        const marker = wrapRenderedRegion('statusmenu', '');
        expect(unwrapRenderedRegion(marker, 'statusmenu').problem).toMatch(/found 0 fence/);
    });

    it('refuses text beside the fence, before the marker, or after the container close', () => {
        expect(unwrapRenderedRegion(row.replace(FENCE + '\n' + doc, 'stray\n' + FENCE + '\n' + doc), 'statusmenu').problem).toMatch(/outside the fence/);
        expect(unwrapRenderedRegion('<p>lead</p>' + row, 'statusmenu').problem).toMatch(/not the region container/);
        expect(unwrapRenderedRegion(row + '<b>tail</b>', 'statusmenu').problem).toMatch(/after the end marker/);
        expect(unwrapRenderedRegion(row + row, 'statusmenu').problem).toMatch(/more than one/);
    });

    it('treats null and a wrong region name the way the wrapper does', () => {
        expect(unwrapRenderedRegion(null, 'statusmenu').problem).toMatch(/marker pair/);
        expect(() => unwrapRenderedRegion(row, 'Status Menu')).toThrow(TypeError);
    });
});

describe('wrapRenderedRegion extra attributes — how the marker-form row names its pack', () => {
    it('lands a data-* attribute on the container, value escaped', () => {
        const marker = wrapRenderedRegion('statusmenu', '', { 'data-mvu-helper-menu': 'art"<x>&' });
        expect(marker).toMatch(/^<div [^>]*data-mvu-helper-menu="art&quot;&lt;x&gt;&amp;">/);
        expect(marker).toContain('data-mvu-helper="statusmenu"');
    });

    // DOMPurify keeps data-* and strips on*; a name outside data-* would be a container attribute
    // sanitize drops, or worse, one it keeps.
    it('refuses any attribute that is not data-*', () => {
        expect(() => wrapRenderedRegion('statusmenu', '', { onclick: 'x' })).toThrow(TypeError);
        expect(() => wrapRenderedRegion('statusmenu', '', { 'data-Upper': 'x' })).toThrow(TypeError);
    });
});

describe("isTavernHelperFrontendText — TavernHelper's render predicate, vendored verbatim", () => {
    // JS-Slash-Runner src/util/is_frontend.ts: ['html>', '<head>', '<body'].some(t => content.includes(t)).
    it('carries exactly the three tokens TavernHelper tests a <pre> for', () => {
        expect([...TAVERNHELPER_FRONTEND_TOKENS]).toEqual(['html>', '<head>', '<body']);
    });

    it('is true for anything TavernHelper would render and false for the marker-form row', () => {
        expect(isTavernHelperFrontendText('x</html>')).toBe(true);
        expect(isTavernHelperFrontendText('<body class="x">')).toBe(true);
        expect(isTavernHelperFrontendText('<head>')).toBe(true);
        expect(isTavernHelperFrontendText('hello <div>world</div>')).toBe(false);
        expect(isTavernHelperFrontendText(wrapRenderedRegion('statusmenu', '', { 'data-mvu-helper-menu': 'p' }))).toBe(false);
        expect(isTavernHelperFrontendText(null)).toBe(false);
    });

    // The whole point: a lifted row is not frontend text, and the row it was lifted from is.
    it('separates a shipped row from its marker form', () => {
        const shipped = wrapRenderedRegion('statusmenu', fenced('<!DOCTYPE html><html><body>x</body></html>'));
        expect(isTavernHelperFrontendText(shipped)).toBe(true);
        expect(isTavernHelperFrontendText(wrapRenderedRegion('statusmenu', ''))).toBe(false);
    });
});

describe('detectRegionName — which region a wrapped text belongs to, off its own marker', () => {
    it('reads the one name a wrapped row carries, whatever the region is called', () => {
        expect(detectRegionName(wrapRenderedRegion('statusmenu', fenced('x')))).toBe('statusmenu');
        expect(detectRegionName(wrapRenderedRegion('game-start-menu', fenced('x')))).toBe('game-start-menu');
    });
    it('answers null for no region, and for two — a text carrying two regions is two things', () => {
        expect(detectRegionName(fenced('<html></html>'))).toBeNull();
        expect(detectRegionName(wrapRenderedRegion('statusmenu', '') + wrapRenderedRegion('side-panel', ''))).toBeNull();
        expect(detectRegionName(null)).toBeNull();
    });
    it('feeds unwrapRenderedRegion without the caller naming the region', () => {
        const row = wrapRenderedRegion('game-start-menu', fenced('FORM'));
        expect(unwrapRenderedRegion(row, detectRegionName(row))).toEqual({ body: 'FORM', problem: null });
    });
});
