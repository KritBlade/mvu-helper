/**
 * MVU Helper — REPLACE-mode splice tests (imagegen/image-splice-core.js).
 *
 * Regression cover for the lost-image bug (live 2026-07-22): the finished image was spliced at an
 * offset captured BEFORE the await, but another pass edits the same message during that await (the
 * registration's stray-closer removal, MVU's write-back). The stale offset put the <img> in the wrong place, ate unrelated
 * prose, and left the raw <pic> for the sweep to delete — so the reply ended up with an EMPTY
 * auto-img-wrap: no <img>, no regen control, and zero <background scene> tags downstream.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRenderedImageWrap, spliceTagIntoMessage, revertRenderedImagesToPicTags, removePastPictures, buildUnrenderedTagWrap, buildTagTraceWrap, replaceTagsWithTraces, removeTagsPinpoint, disposeLeftoverPicTags, partitionDetectedTags, planImageSrcSwap, auditRenderedImages, recordsAfterImageSwap, reasoningSpans, isInsideReasoning, partitionByReasoning } from '../src/features/imagegen/image-splice-core.js';
import { escapeHtmlAttribute, unescapeHtmlAttribute } from '../src/shared/html-escape.js';

const PIC = '<pic char="Mitsuki" prompt="a clearing">';
const WRAP = '<span class="auto-img-wrap"><img src="x.png"><span class="auto-img-regen"></span></span>';

describe('spliceTagIntoMessage', () => {
    it('replaces the tag in place', () => {
        const r = spliceTagIntoMessage(`before\n${PIC}\nafter`, PIC, WRAP);
        expect(r.spliced).toBe(true);
        expect(r.text).toBe(`before\n${WRAP}\nafter`);
    });

    it('THE REGRESSION: survives an edit that shifted every offset mid-generation', () => {
        // What detectTags saw:
        const atDetection = `She walks in.</cast>\n\n${PIC}\n\nSun sets.`;
        // What another pass left behind while /sd was running (a stray closer removed):
        const afterEdit = atDetection.replace('</cast>', '');
        expect(afterEdit.indexOf(PIC)).not.toBe(atDetection.indexOf(PIC)); // offsets really moved

        const r = spliceTagIntoMessage(afterEdit, PIC, WRAP);
        expect(r.spliced).toBe(true);
        expect(r.text).toContain('<img ');
        expect(r.text).toContain('auto-img-regen');
        expect(r.text).not.toContain('<pic ');              // nothing left for the sweep
        expect(r.text).toBe(`She walks in.\n\n${WRAP}\n\nSun sets.`);  // prose intact, correct position
    });

    it('reports a vanished anchor instead of guessing an offset', () => {
        const r = spliceTagIntoMessage('the tag is gone', PIC, WRAP);
        expect(r.spliced).toBe(false);
        expect(r.text).toBe('the tag is gone');             // message left untouched
    });

    it('empty/missing inputs are a no-op, never a corrupting splice at 0', () => {
        expect(spliceTagIntoMessage('abc', '', WRAP)).toEqual({ text: 'abc', spliced: false });
        expect(spliceTagIntoMessage(null, PIC, WRAP)).toEqual({ text: '', spliced: false });
    });
});

// ── the context-swap (rendered wrap → original <pic>) — the mimic-bait fix (live 2026-07-28):
// the narrate model copied the rendered auto-img-wrap HTML from history (fabricated filenames,
// 404s) instead of emitting <pic>, because context never showed it a <pic> example.
describe('revertRenderedImagesToPicTags', () => {
    const PIC = '<pic char="Mitsuki" outfit="default" type="portrait" prompt="1girl, cafeteria, poking rice & looking down">';
    const wrapFor = (pic, src) =>
        `<span class="auto-img-wrap" data-rawtag="${escapeHtmlAttribute(pic)}">` +
        `<img src="${src}" title="t" alt="t">` +
        `<span class="auto-img-regen fa-solid fa-arrows-rotate" title="Regenerate image" role="button" tabindex="0" style="cursor:pointer;"></span>` +
        `</span>`;

    it('round-trips the exact wrap the REPLACE splice builds back to its <pic> (escape → unescape identity)', () => {
        const text = `before\n${wrapFor(PIC, '/user/images/X/a.png')}\nafter`;
        const r = revertRenderedImagesToPicTags(text, unescapeHtmlAttribute);
        expect(r.reverted).toBe(1);
        expect(r.text).toBe(`before\n${PIC}\nafter`);
    });

    it('reverts EVERY wrap in a multi-image message', () => {
        const pic2 = '<pic char="Mana" outfit="default" type="portrait" prompt="1girl, leaning forward">';
        const text = wrapFor(PIC, '/a.png') + ' prose ' + wrapFor(pic2, '/b.png');
        const r = revertRenderedImagesToPicTags(text, unescapeHtmlAttribute);
        expect(r.reverted).toBe(2);
        expect(r.text).toBe(`${PIC} prose ${pic2}`);
    });

    it('a wrap whose data-rawtag is not a <pic> tag is left intact (foreign markup, never guess)', () => {
        const foreign = `<span class="auto-img-wrap" data-rawtag="not a tag"><img src="/x.png"><span class="auto-img-regen"></span></span>`;
        const r = revertRenderedImagesToPicTags(foreign, unescapeHtmlAttribute);
        expect(r.reverted).toBe(0);
        expect(r.text).toBe(foreign);
    });

    it('text with no wraps is returned unchanged with reverted=0', () => {
        const r = revertRenderedImagesToPicTags('plain prose with <pic char="A" prompt="p">', unescapeHtmlAttribute);
        expect(r.reverted).toBe(0);
    });

    it('a model-FABRICATED wrap carrying a valid escaped <pic> also reverts (the fabrication becomes a usable tag)', () => {
        // Exactly what the narrator emitted live: full wrap markup with an invented filename but a
        // well-formed escaped <pic> in data-rawtag.
        const fabricated = wrapFor(PIC, '/user/images/ArtificKoi/ArtificKoi_2026-07-28@00h58m27s284ms.png');
        const r = revertRenderedImagesToPicTags(fabricated, unescapeHtmlAttribute);
        expect(r.reverted).toBe(1);
        expect(r.text).toBe(PIC);
    });
});

// ── strip-OFF debug lines (the visible escaped tag) also revert in outgoing context ──────────
describe('revertRenderedImagesToPicTags — strip-OFF escaped debug lines', () => {
    const PIC = '<pic char="Mana" outfit="default" type="portrait" prompt="1girl, courtyard bench">';
    const debugLine = `<code class="auto-img-pictag" style="display:block;">${escapeHtmlAttribute(PIC)}</code>`;

    it('a standalone sweep-kept debug line reverts to the raw tag', () => {
        const r = revertRenderedImagesToPicTags(`prose ${debugLine} more`, unescapeHtmlAttribute);
        expect(r.reverted).toBe(1);
        expect(r.text).toBe(`prose ${PIC} more`);
    });

    it('a wrap CONTAINING its debug line reverts as ONE tag (no duplicate)', () => {
        const wrap = `<span class="auto-img-wrap" data-rawtag="${escapeHtmlAttribute(PIC)}">` +
            `<img src="/a.png" title="t" alt="t">${debugLine}` +
            `<span class="auto-img-regen" role="button"></span></span>`;
        const r = revertRenderedImagesToPicTags(wrap, unescapeHtmlAttribute);
        expect(r.reverted).toBe(1);
        expect(r.text).toBe(PIC);
    });

    it('a debug line whose content is not an escaped <pic> is left alone', () => {
        const foreign = '<code class="auto-img-pictag">just text</code>';
        const r = revertRenderedImagesToPicTags(foreign, unescapeHtmlAttribute);
        expect(r.reverted).toBe(0);
        expect(r.text).toBe(foreign);
    });
});

describe('buildUnrenderedTagWrap — a leftover <pic> must look like image machinery, not prose', () => {
    const ESC = '&lt;pic char=&quot;Mitsuki&quot; type=&quot;portrait&quot; prompt=&quot;1girl&quot;&gt;';

    // The shape BOTH consumers key on: mvu-helper's RENDERED_WRAP_RE and galgame-companion's
    // beat-shaper RE_IMG_WRAP are written against `auto-img-wrap … </span></span>`.
    const CONSUMER_WRAP_RE = /<span class="(?:custom-)?auto-img-wrap"[^>]*>[\s\S]*?<\/span>\s*<\/span>/i;

    it('is matched by the consumer wrap shape (the bare <code> was not)', () => {
        expect(CONSUMER_WRAP_RE.test(buildUnrenderedTagWrap(ESC))).toBe(true);
        const bare = `<code class="auto-img-pictag" style="display:block">${ESC}</code>`;
        expect(CONSUMER_WRAP_RE.test(bare)).toBe(false);      // THE REGRESSION: this is what broke galgame
    });

    it('carries data-rawtag so the outgoing-prompt revert can recover the original tag', () => {
        const out = buildUnrenderedTagWrap(ESC);
        expect(out).toContain(`data-rawtag="${ESC}"`);
        const { text, reverted } = revertRenderedImagesToPicTags(out, unescapeHtmlAttribute);
        expect(reverted).toBe(1);
        expect(text).toBe('<pic char="Mitsuki" type="portrait" prompt="1girl">');
    });

    it('still shows the tag as ESCAPED text, so raw-<pic> detection cannot trip on it', () => {
        const out = buildUnrenderedTagWrap(ESC);
        expect(out).toContain('auto-img-pictag');
        expect(out).not.toMatch(/<pic\b/);                     // no raw tag anywhere in the markup
    });

    it('does NOT claim a regen affordance it cannot honour (no <img> to place a result into)', () => {
        expect(buildUnrenderedTagWrap(ESC)).not.toContain('auto-img-regen');
    });

    it('degrades on junk instead of throwing', () => {
        expect(() => buildUnrenderedTagWrap(null)).not.toThrow();
        expect(CONSUMER_WRAP_RE.test(buildUnrenderedTagWrap(null))).toBe(true);
    });
});


// ── pinpoint removal: a delete touches its own tag and the blank lines it leaves, nothing else ──────
// (review 2026-08-29, F1): every strip used to finish with a WHOLE-message `/\n{3,}/` collapse + trim.
describe('removeTagsPinpoint — the removal is scoped to its own join', () => {
    it('collapses the blank-line run the removed tag leaves, at that join only', () => {
        const r = removeTagsPinpoint(`one\n\n${PIC}\n\ntwo`, [PIC]);
        expect(r.text).toBe('one\n\ntwo');
        expect(r.removed).toEqual([PIC]);
    });

    it('THE REGRESSION: a blank-line run elsewhere in the message is NOT rewritten', () => {
        const art = 'line1\n\n\n\nline2';                          // four newlines, on purpose
        const r = removeTagsPinpoint(`${art}\n\n${PIC}\n\ntail`, [PIC]);
        expect(r.text).toBe(`${art}\n\ntail`);                      // the old whole-message collapse ate `art`
    });

    it('THE REGRESSION: the message ends are not trimmed when the tag was mid-message', () => {
        const r = removeTagsPinpoint(`\n\nlead ${PIC} trail\n\n`, [PIC]);
        expect(r.text).toBe('\n\nlead  trail\n\n');                 // inline: whitespace left as it falls
    });

    it('a tag at the very start or end drops the whitespace at that edge only', () => {
        expect(removeTagsPinpoint(`${PIC}\n\nbody`, [PIC]).text).toBe('body');
        expect(removeTagsPinpoint(`body\n\n${PIC}`, [PIC]).text).toBe('body');
        expect(removeTagsPinpoint(PIC, [PIC]).text).toBe('');
    });

    it('duplicates resolve left-to-right, one per list entry; a missing tag is reported and nothing moves', () => {
        expect(removeTagsPinpoint(`${PIC} a ${PIC} b`, [PIC]).text).toBe(`a ${PIC} b`);
        expect(removeTagsPinpoint(`${PIC} a ${PIC} b`, [PIC, PIC]).text).toBe('a  b');
        expect(removeTagsPinpoint('nothing here', [PIC])).toEqual({ text: 'nothing here', removed: [], missing: [PIC] });
    });

    it('junk input is a no-op, never a cut at 0', () => {
        expect(removeTagsPinpoint('abc', ['']).text).toBe('abc');
        expect(removeTagsPinpoint(null, [PIC]).text).toBe('');
        expect(removeTagsPinpoint('abc', null).text).toBe('abc');
    });
});

// ── the leftover sweep acts on the DETECTION LIST, never on a scan of the finished message ─────────
// (review 2026-08-29, F2/F3): it used to re-run the user-editable detection regex over the message
// after our HTML was spliced in, and delete or escape every match — including strings the pass never
// detected, and a third party's <img prompt=…>.
// A <pic> taken out of the reply leaves an invisible trace, so the reply keeps the record of whom it drew in what
// clothes in every insert mode — the history a picture that says nothing changed is drawn from.
describe('the tag trace — a <pic> taken out of the reply keeps its record', () => {
    it('MUTATION TARGET — invisible: the auto-img-wrap envelope, the tag in data-rawtag, no <img>, no text', () => {
        const trace = buildTagTraceWrap(escapeHtmlAttribute(PIC));
        expect(trace).toBe(`<span class="auto-img-wrap" data-rawtag="${escapeHtmlAttribute(PIC)}"><span class="auto-img-trace"></span></span>`);
        expect(trace).not.toMatch(/<img\b|<code\b|<pic\b/);
        expect(trace.replace(/<[^>]*>/g, '')).toBe('');
    });

    it('MUTATION TARGET — reverts to its <pic>, for the prompt and for reading what a reply drew', () => {
        const text = `a ${buildTagTraceWrap(escapeHtmlAttribute(PIC))} b`;
        expect(revertRenderedImagesToPicTags(text, unescapeHtmlAttribute)).toEqual({ text: `a ${PIC} b`, reverted: 1 });
    });

    it('replaceTagsWithTraces: each listed tag, exact and first occurrence, in its place; one already gone is reported', () => {
        const other = '<pic char="Mana" prompt="y">';
        const gone = '<pic char="Gone" prompt="g">';
        const r = replaceTagsWithTraces(`x\n\n${PIC}\n\n${other}\n\nz`, [PIC, gone], escapeHtmlAttribute);
        expect(r.text).toBe(`x\n\n${buildTagTraceWrap(escapeHtmlAttribute(PIC))}\n\n${other}\n\nz`);
        expect(r.traced).toEqual([PIC]);
        expect(r.missing).toEqual([gone]);
    });
});

describe('disposeLeftoverPicTags — only what the pass detected, only <pic>', () => {
    const over = '<pic char="Mana" prompt="over the cap">';
    const opts = (keepVisible) => ({ keepVisible, escapeAttr: escapeHtmlAttribute });
    const wrapFor = (pic) => `<span class="auto-img-wrap" data-rawtag="${escapeHtmlAttribute(pic)}"><img src="/a.png"><span class="auto-img-regen"></span></span>`;

    it('strip ON: each listed leftover becomes its invisible trace — a raw <pic> NOT in the list is untouched', () => {
        const r = disposeLeftoverPicTags(`x\n\n${PIC}\n\n${over}\n\ny`, [over], opts(false));
        expect(r.text).toBe(`x\n\n${PIC}\n\n${buildTagTraceWrap(escapeHtmlAttribute(over))}\n\ny`);
        expect(r.swept).toEqual([over]);
    });

    it('strip OFF: each listed leftover becomes the placeholder wrap, in place, no raw <pic> left', () => {
        const r = disposeLeftoverPicTags(`x ${over} y`, [over], opts(true));
        expect(r.text).toBe(`x ${buildUnrenderedTagWrap(escapeHtmlAttribute(over))} y`);
        expect(r.text).not.toMatch(/<pic\b/);
        expect(r.swept).toEqual([over]);
    });

    it('THE REGRESSION (F3): an <img prompt=…> the pass did not draw is left as written and reported', () => {
        const img = '<img prompt="somebody else\'s">';
        const r = disposeLeftoverPicTags(`a ${img} b`, [img], opts(false));
        expect(r.text).toBe(`a ${img} b`);
        expect(r.skipped).toEqual([img]);
        expect(r.swept).toEqual([]);
    });

    it('THE REGRESSION (F2): a tag already consumed (now a wrap) is reported missing — the escaped copy inside our HTML is never a target', () => {
        const wrap = wrapFor(PIC);
        const r = disposeLeftoverPicTags(`a ${wrap} b`, [PIC], opts(false));
        expect(r.text).toBe(`a ${wrap} b`);
        expect(r.missing).toEqual([PIC]);
    });

    it('duplicates as a multiset: one identical tag drawn, one over the cap — only the raw one goes', () => {
        const wrap = wrapFor(PIC);
        const r = disposeLeftoverPicTags(`${wrap}\n\n${PIC}\n\nend`, [PIC], opts(false));
        expect(r.text).toBe(`${wrap}\n\n${buildTagTraceWrap(escapeHtmlAttribute(PIC))}\n\nend`);
        expect(r.swept).toEqual([PIC]);
    });

    it('an empty list costs nothing', () => {
        expect(disposeLeftoverPicTags('keep', [], opts(false))).toEqual({ text: 'keep', swept: [], missing: [], skipped: [] });
    });
});


describe('partitionDetectedTags — drawable and disposable are different questions', () => {
    // THE REGRESSION (2026-08-29): the leftover disposition read the DRAW list, which drops a tag
    // with no prompt because there is nothing to generate from. So `<pic prompt="">` was never drawn
    // AND never removed — it survived into the finalized reply, where one raw <pic> holds
    // galgame-companion's backdrop binding forever (the 2026-07-21 blank stage, different door).
    const scanned = [
        { rawTag: '<pic char="A" prompt="a girl">', prompt: 'a girl' },
        { rawTag: '<pic char="B" prompt="">', prompt: '' },
        { rawTag: '<pic char="C" prompt="   ">', prompt: '   ' },
    ];

    it('MUTATION TARGET — an empty-prompt <pic> is DISPOSABLE even though it is not drawable', () => {
        const { drawable, disposable } = partitionDetectedTags(scanned);
        expect(drawable.map((t) => t.rawTag)).toEqual(['<pic char="A" prompt="a girl">']);
        expect(disposable).toEqual([
            '<pic char="A" prompt="a girl">',
            '<pic char="B" prompt="">',
            '<pic char="C" prompt="   ">',
        ]);
    });

    it('a whitespace-only prompt is not drawable either — trim decides, not truthiness', () => {
        expect(partitionDetectedTags([{ rawTag: '<pic prompt="  ">', prompt: '  ' }]).drawable).toEqual([]);
        expect(partitionDetectedTags([{ rawTag: '<pic prompt="  ">', prompt: '  ' }]).disposable).toHaveLength(1);
    });

    it('a missing prompt property is treated as no prompt, never as a crash', () => {
        const r = partitionDetectedTags([{ rawTag: '<pic char="A">' }, { rawTag: '<pic char="B">', prompt: null }]);
        expect(r.drawable).toEqual([]);
        expect(r.disposable).toEqual(['<pic char="A">', '<pic char="B">']);
    });

    it('junk in, nothing out — no entry without a rawTag reaches the disposal list', () => {
        expect(partitionDetectedTags(null)).toEqual({ drawable: [], disposable: [] });
        expect(partitionDetectedTags([null, { prompt: 'x' }]).disposable).toEqual([]);
    });

    it('the disposal list feeds removeTagsPinpoint directly: an undrawable tag is removed', () => {
        const text = 'a\n\n<pic char="B" prompt="">\n\nb';
        const { disposable } = partitionDetectedTags([{ rawTag: '<pic char="B" prompt="">', prompt: '' }]);
        expect(removeTagsPinpoint(text, disposable).text).toBe('a\n\nb');
    });
});


// The two rules above live in a HOST-coupled file no test can import (image-gen.js reads ST globals),
// and both were broken there by an edit that looked local and correct. So they are gated as SOURCE:
// not a substitute for the pure tests, a guard on the one line each rule is spent at.
describe('SOURCE GATE — image-gen.js may not re-acquire the habits these helpers replaced', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/imagegen/image-gen.js'), 'utf8');

    it('the leftover disposal list is the DISPOSABLE one, never the draw list', () => {
        // Reading allTags() here is the 2026-08-29 regression: an empty-prompt <pic> is undrawable,
        // so the draw list drops it, so it was never disposed of and survived into the reply.
        const line = src.split('\n').find((l) => l.includes('const detectedAtStart'));
        expect(line).toBeTruthy();
        expect(line).toContain('allTagStrings(');
        expect(line).not.toContain('allTags(');
    });

    it('no write in this file tidies the WHOLE message', () => {
        // Every removal collapses only the join it made (removeTagsPinpoint). A whole-message
        // `\n{3,}` collapse or `.trim()` rewrites blank lines and both ends of a message this
        // extension does not own.
        expect(src).not.toMatch(/\.replace\(\/\\n\{3,\}\/g/);
        expect(src).not.toMatch(/message\.mes\s*=\s*message\.mes[^\n]*\.trim\(\)/);
    });

    it('the regen swap names WHICH wrap — it never replaces a bare src= across the message', () => {
        expect(src).toContain('planImageSrcSwap(message.mes');
        expect(src).not.toMatch(/message\.mes\.replace\(`src=/);
    });

    it('no write in this file re-scans the finished message with the detection regex', () => {
        // The sweep used to do this and deleted whatever the (user-editable) regex happened to match.
        expect(src).not.toMatch(/\.replace\(\s*getDetectionRegex\(\)/);
    });
});


describe('planImageSrcSwap — the regen result goes in the wrap that was clicked', () => {
    // THE BUG (F4): the swap replaced the first `src="<old>"` in the whole message. Two images that
    // share a URL — a repeated beat, a cached generation — and the WRONG picture changed, silently.
    const wrap = (rawTag, url) => '<span class="auto-img-wrap" data-rawtag="' + rawTag
        + '"><img src="' + url + '" title="t" alt="t"><span class="auto-img-regen"></span></span>';
    const A = '&lt;pic char=&quot;A&quot; prompt=&quot;a&quot;&gt;';
    const B = '&lt;pic char=&quot;B&quot; prompt=&quot;b&quot;&gt;';

    it('MUTATION TARGET — two wraps sharing one URL: the CLICKED one changes, the other does not', () => {
        const text = 'x ' + wrap(A, '/same.png') + ' y ' + wrap(B, '/same.png') + ' z';
        const r = planImageSrcSwap(text, { rawTag: B, ordinal: 1, newSrcEscaped: '/new.png' });
        expect(r.ok).toBe(true);
        expect(r.matchedBy).toBe('rawtag');
        expect(r.text).toBe('x ' + wrap(A, '/same.png') + ' y ' + wrap(B, '/new.png') + ' z');
    });

    it('duplicate identical tags are settled by ORDINAL, not by first match', () => {
        const text = wrap(A, '/one.png') + '\n' + wrap(A, '/two.png');
        const r = planImageSrcSwap(text, { rawTag: A, ordinal: 1, newSrcEscaped: '/new.png' });
        expect(r.ok).toBe(true);
        expect(r.matchedBy).toBe('ordinal');
        expect(r.text).toBe(wrap(A, '/one.png') + '\n' + wrap(A, '/new.png'));
    });

    it('an UNRENDERED leftover wrap counts in the ordinal but holds no image to swap', () => {
        const leftover = buildUnrenderedTagWrap(A);
        const text = leftover + '\n' + wrap(B, '/b.png');
        expect(planImageSrcSwap(text, { ordinal: 1, newSrcEscaped: '/new.png' }).text)
            .toBe(leftover + '\n' + wrap(B, '/new.png'));
        const onLeftover = planImageSrcSwap(text, { ordinal: 0, newSrcEscaped: '/new.png' });
        expect(onLeftover.ok).toBe(false);
        expect(onLeftover.reason).toBe('no-image-in-wrap');
    });

    it('MUTATION TARGET — ambiguity REFUSES rather than guessing, and leaves the text alone', () => {
        const text = wrap(A, '/one.png') + wrap(A, '/two.png');
        const r = planImageSrcSwap(text, { rawTag: A, ordinal: 99, newSrcEscaped: '/new.png' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('ambiguous');
        expect(r.text).toBe(text);
    });

    it('MUTATION TARGET — a $ in the generated path is a literal, never $-syntax', () => {
        const text = wrap(A, '/old.png');
        const r = planImageSrcSwap(text, { rawTag: A, ordinal: 0, newSrcEscaped: '/img/$&$`x.png' });
        expect(r.ok).toBe(true);
        expect(r.text).toContain('src="/img/$&$`x.png"');
    });

    it('nothing to swap is reported, never invented', () => {
        expect(planImageSrcSwap('plain prose', { ordinal: 0 }).reason).toBe('no-wraps');
        expect(planImageSrcSwap(wrap(A, '/a.png'), { rawTag: B, ordinal: -1 }).reason).toBe('not-found');
    });

    it('MUTATION TARGET — a swap names the wrap it replaced and the wrap it wrote', () => {
        const text = 'x ' + wrap(A, '/a.png') + ' y ' + wrap(B, '/b.png') + ' z';
        const r = planImageSrcSwap(text, { rawTag: B, ordinal: 1, newSrcEscaped: '/new.png' });
        expect(r.wrapBefore).toBe(wrap(B, '/b.png'));
        expect(r.wrapAfter).toBe(wrap(B, '/new.png'));
        expect(planImageSrcSwap(text, { rawTag: A + 'x', ordinal: -1 }).wrapBefore).toBeUndefined();
    });
});

// The regenerate button rewrites a wrap the draw pass recorded. Its record follows the swap, or the next
// render reports mvu-helper's own regenerate as a lost picture and points at MVU.
describe('recordsAfterImageSwap — the lost-image record follows the regenerate button', () => {
    const rawTag = '<pic char="Airi" outfit="school-uniform" prompt="1girl, airi, double peace signs">';
    const escapedRawTag = escapeHtmlAttribute(rawTag);
    const drawn = (url, debugTagLine = '') => buildRenderedImageWrap({ escapedRawTag, escapedUrl: url, escapedPrompt: 'masterpiece, 1girl', debugTagLine });
    const regenerate = (text, url) => planImageSrcSwap(text, { rawTag: escapedRawTag, ordinal: 0, newSrcEscaped: url });

    it('MUTATION TARGET — THE BUG: after a regenerate, the picture the reply holds is audited as present', () => {
        for (const debugTagLine of ['', `<code class="auto-img-pictag">${escapedRawTag}</code>`]) {
            const wrap = drawn('/first.png', debugTagLine);
            const records = [{ wrap, rawTag, imageUrl: '/first.png', reported: false }];
            const plan = regenerate('story ' + wrap + ' end', '/second.png');
            expect(plan.ok).toBe(true);
            expect(auditRenderedImages(plan.text, records).vanished).toHaveLength(1);   // the record left behind
            const followed = recordsAfterImageSwap(records, { ...plan, imageUrl: '/second.png' });
            const audit = auditRenderedImages(plan.text, followed);
            expect(audit.present).toHaveLength(1);
            expect(audit.vanished).toHaveLength(0);
            expect(followed[0].imageUrl).toBe('/second.png');
        }
    });

    it('a second regenerate of the same picture is followed too', () => {
        const wrap = drawn('/first.png');
        const first = regenerate(wrap, '/second.png');
        const once = recordsAfterImageSwap([{ wrap, rawTag, imageUrl: '/first.png', reported: false }], { ...first, imageUrl: '/second.png' });
        const second = regenerate(first.text, '/third.png');
        const twice = recordsAfterImageSwap(once, { ...second, imageUrl: '/third.png' });
        expect(auditRenderedImages(second.text, twice).present).toHaveLength(1);
        expect(twice[0].imageUrl).toBe('/third.png');
    });

    it('MUTATION TARGET — the moved record is audited afresh, so a later loss of the new picture is still named', () => {
        const wrap = drawn('/first.png');
        const plan = regenerate(wrap, '/second.png');
        const followed = recordsAfterImageSwap([{ wrap, rawTag, imageUrl: '/first.png', reported: true }], { ...plan, imageUrl: '/second.png' });
        expect(followed[0].reported).toBe(false);
    });

    it('only the swapped record moves; every other record is left as it was', () => {
        const other = { wrap: '<span class="auto-img-wrap" data-rawtag="B"><img src="/b.png"></span></span>', rawTag: '<pic char="B">', imageUrl: '/b.png', reported: false };
        const wrap = drawn('/first.png');
        const plan = regenerate(other.wrap + wrap, '/second.png');
        const followed = recordsAfterImageSwap([other, { wrap, rawTag, imageUrl: '/first.png', reported: false }], { ...plan, imageUrl: '/second.png' });
        expect(followed[0]).toBe(other);
        expect(followed[1].wrap).toBe(plan.wrapAfter);
    });

    it('identical wraps: one record moves, and each copy in the text still satisfies one record', () => {
        const wrap = drawn('/same.png');
        const records = [{ wrap, rawTag, imageUrl: '/same.png', reported: false }, { wrap, rawTag, imageUrl: '/same.png', reported: false }];
        const plan = planImageSrcSwap(wrap + '\n' + wrap, { rawTag: escapedRawTag, ordinal: 1, newSrcEscaped: '/second.png' });
        const followed = recordsAfterImageSwap(records, { ...plan, imageUrl: '/second.png' });
        expect(followed.filter((r) => r.imageUrl === '/second.png')).toHaveLength(1);
        expect(auditRenderedImages(plan.text, followed).present).toHaveLength(2);
    });

    it('a wrap no record holds (drawn before this page loaded) changes nothing, and nothing passed in is changed', () => {
        const record = { wrap: drawn('/first.png'), rawTag, imageUrl: '/first.png', reported: false };
        const records = [record];
        const unrelated = regenerate(drawn('/elsewhere.png'), '/second.png');
        expect(recordsAfterImageSwap(records, { ...unrelated, imageUrl: '/second.png' })).toEqual(records);
        const plan = regenerate(record.wrap, '/second.png');
        recordsAfterImageSwap(records, { ...plan, imageUrl: '/second.png' });
        expect(records[0]).toBe(record);
        expect(record.wrap).toBe(drawn('/first.png'));
    });

    it('junk in, no throw', () => {
        expect(recordsAfterImageSwap(null, { wrapBefore: 'x', wrapAfter: 'y', imageUrl: '/y.png' })).toEqual([]);
        expect(recordsAfterImageSwap([null, {}], {})).toEqual([null, {}]);
    });
});

// MVU writes a snapshot older than the splice and announces nothing when its parse changed no
// variable, so the guard never runs. This is how the loss stops being silent.
describe('auditRenderedImages — did what we wrote survive', () => {
    const wrap = '<span class="auto-img-wrap" data-rawtag="&lt;pic char=&quot;A&quot;&gt;"><img src="/a.png"></span></span>';
    const rawTag = '<pic char="A">';
    const record = { wrap, rawTag, imageUrl: '/a.png' };

    it('MUTATION TARGET — a wrap replaced by its own raw tag is the stale-snapshot REVERT', () => {
        const res = auditRenderedImages('story ' + rawTag + ' end', [record]);
        expect(res.revertedToTag).toHaveLength(1);
        expect(res.revertedToTag[0].imageUrl).toBe('/a.png');
        expect(res.vanished).toHaveLength(0);
        expect(res.present).toHaveLength(0);
    });

    it('MUTATION TARGET — a wrap still present is NOT reported, so a healthy turn stays quiet', () => {
        const res = auditRenderedImages('story ' + wrap + ' end', [record]);
        expect(res.present).toHaveLength(1);
        expect(res.revertedToTag).toHaveLength(0);
        expect(res.vanished).toHaveLength(0);
    });

    it('a wrap gone with NO tag back is vanished, never blamed on a revert', () => {
        const res = auditRenderedImages('story with neither', [record]);
        expect(res.vanished).toHaveLength(1);
        expect(res.revertedToTag).toHaveLength(0);
    });

    it('sorts a mixed batch into its three outcomes independently', () => {
        const kept = { wrap: '<span class="auto-img-wrap" data-rawtag="B"><img src="/b.png"></span></span>', rawTag: '<pic char="B">', imageUrl: '/b.png' };
        const goneEntirely = { wrap: '<span class="auto-img-wrap" data-rawtag="C"><img src="/c.png"></span></span>', rawTag: '<pic char="C">', imageUrl: '/c.png' };
        const res = auditRenderedImages(rawTag + ' ' + kept.wrap, [record, kept, goneEntirely]);
        expect(res.revertedToTag.map((r) => r.imageUrl)).toEqual(['/a.png']);
        expect(res.present.map((r) => r.imageUrl)).toEqual(['/b.png']);
        expect(res.vanished.map((r) => r.imageUrl)).toEqual(['/c.png']);
    });

    it('junk in, no throw and nothing claimed lost', () => {
        expect(auditRenderedImages('', null).revertedToTag).toEqual([]);
        expect(auditRenderedImages(null, [record]).vanished).toHaveLength(1);
        expect(auditRenderedImages('x', [null, {}, { wrap: '' }]).vanished).toEqual([]);
    });

    it('MUTATION TARGET — a wrap that left with the thinking is found in the reasoning, never called vanished', () => {
        const res = auditRenderedImages('story with neither', [record], 'the plan … ' + wrap + ' … done');
        expect(res.inReasoning.map((r) => r.imageUrl)).toEqual(['/a.png']);
        expect(res.vanished).toHaveLength(0);
    });

    it('a wrap in neither the text nor the reasoning is still vanished', () => {
        const res = auditRenderedImages('story with neither', [record], 'the plan, no picture');
        expect(res.inReasoning).toHaveLength(0);
        expect(res.vanished).toHaveLength(1);
    });
});

// ── the narrator's thinking is never the reply (staging msg 442, 2026-10-20) ───────────────────────
// The narrator drafted `<pic>` in a <thinking_left> block, word for word the tag it then wrote in the
// prose. Detection counted both (2 over a cap of 1), the splice anchored on the draft, the prose's own tag
// was swept as over-cap, and the thinking — finished picture inside — was moved into the reasoning.
describe('reasoningSpans — where the narrator\'s thinking sits', () => {
    const at = (text, needle) => text.indexOf(needle);

    it('MUTATION TARGET — a closed <think>, <thinking> and <thinking_*> block each mask their content', () => {
        for (const [open, close] of [['<think>', '</think>'], ['<thinking>', '</thinking>'], ['<thinking_left>', '</thinking_left>'], ['<THINKING_Right>', '</THINKING_Right>']]) {
            const text = `${open}draft ${PIC}${close}\nprose ${PIC}`;
            const spans = reasoningSpans(text);
            expect(spans).toEqual([{ start: 0, end: at(text, close) + close.length }]);
            expect(isInsideReasoning(spans, at(text, PIC))).toBe(true);
            expect(isInsideReasoning(spans, text.lastIndexOf(PIC))).toBe(false);
        }
    });

    it('two thinking blocks are two spans, and the prose between them is the reply', () => {
        const text = `<thinking_left>a</thinking_left>\nmiddle ${PIC}\n<thinking_right>b</thinking_right>`;
        const spans = reasoningSpans(text);
        expect(spans).toHaveLength(2);
        expect(isInsideReasoning(spans, at(text, PIC))).toBe(false);
        expect(isInsideReasoning(spans, at(text, 'b<'))).toBe(true);
    });

    it('MUTATION TARGET — a close with no open masks everything before it, back to the previous block', () => {
        const text = `plan ${PIC}</think>\nprose ${PIC}`;
        const spans = reasoningSpans(text);
        expect(spans).toEqual([{ start: 0, end: at(text, '</think>') + '</think>'.length }]);
        expect(isInsideReasoning(spans, 5)).toBe(true);
        expect(isInsideReasoning(spans, text.lastIndexOf(PIC))).toBe(false);
        const afterBlock = `<think>a</think>\nprose\nmore plan</thinking>\nreply`;
        expect(reasoningSpans(afterBlock)[1].start).toBe(afterBlock.indexOf('</think>') + '</think>'.length);
    });

    it('MUTATION TARGET — an open never closed masks the rest only while the reply streams in', () => {
        const text = `prose ${PIC}\n<think>planning the next ${PIC}`;
        expect(reasoningSpans(text, { isTextComplete: false })).toEqual([{ start: at(text, '<think>'), end: text.length }]);
        expect(reasoningSpans(text)).toEqual([]);
    });

    it('a nested open belongs to its block, and any close of the family ends it', () => {
        const text = `<thinking><think>inner</think>still the plan`;
        expect(reasoningSpans(text)).toEqual([{ start: 0, end: at(text, '</think>') + '</think>'.length }]);
    });

    it('only the three named tags count — not <thinker>, <think_x>, <thinkingX>, nor a reasoning tag of another name', () => {
        for (const tag of ['thinker', 'think_x', 'thinkingX', 'reasoning', 'thought']) {
            expect(reasoningSpans(`<${tag}>${PIC}</${tag}>`)).toEqual([]);
        }
        expect(reasoningSpans(`<thinking_left mode="x">a</thinking_left>`)).toHaveLength(1);
    });

    it('partitionByReasoning splits detected tags by where they sit', () => {
        const text = `<thinking_left>${PIC}</thinking_left>\n${PIC}`;
        const tags = [{ rawTag: PIC, index: at(text, PIC) }, { rawTag: PIC, index: text.lastIndexOf(PIC) }];
        const { outside, inside } = partitionByReasoning(text, tags);
        expect(inside.map((t) => t.index)).toEqual([tags[0].index]);
        expect(outside.map((t) => t.index)).toEqual([tags[1].index]);
    });
});

describe('the splice and the sweep never land in the narrator\'s thinking', () => {
    // msg 442's shape: the same tag drafted in the thinking, then written in the prose.
    const reply = `<thinking_left>\n1. plan the picture: ${PIC}\n</thinking_left>\n<p>Sora looks away.</p>\n\n${PIC}\n\n<p>More prose.</p>`;
    const draftAt = reply.indexOf(PIC);

    it('MUTATION TARGET — the finished image replaces the prose\'s tag, and the draft stays as written', () => {
        const r = spliceTagIntoMessage(reply, PIC, WRAP);
        expect(r.spliced).toBe(true);
        expect(r.text.indexOf(PIC)).toBe(draftAt);
        expect(r.text.indexOf(WRAP)).toBeGreaterThan(r.text.indexOf('</thinking_left>'));
    });

    it('a tag that exists only inside the thinking is no anchor at all', () => {
        const onlyDraft = `<think>${PIC}</think>\n<p>prose with no picture</p>`;
        expect(spliceTagIntoMessage(onlyDraft, PIC, WRAP)).toEqual({ text: onlyDraft, spliced: false });
    });

    it('a trace and an over-cap sweep never touch the draft', () => {
        const traced = replaceTagsWithTraces(reply, [PIC], escapeHtmlAttribute);
        expect(traced.traced).toEqual([PIC]);
        expect(traced.text.indexOf(PIC)).toBe(draftAt);
        const swept = disposeLeftoverPicTags(reply, [PIC], { escapeAttr: escapeHtmlAttribute });
        expect(swept.swept).toEqual([PIC]);
        expect(swept.text.indexOf(PIC)).toBe(draftAt);
    });
});

describe('SOURCE GATE — image-gen.js finds every <pic> through the reasoning rule', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/imagegen/image-gen.js'), 'utf8').replace(/\r\n/g, '\n');

    it('MUTATION TARGET — the one scanner partitions its matches by reasoning, and scanTags keeps only the reply\'s', () => {
        expect(src).toMatch(/return partitionByReasoning\(text, accepted, \{ isTextComplete \}\);/);
        expect(src).toMatch(/function scanTags\(mes, opts\) \{ return scanTagsWithReasoning\(mes, opts\)\.outside; \}/);
        expect(src.match(/\.matchAll\(re\)/g)).toHaveLength(1);
    });

    it('MUTATION TARGET — streaming pre-generation scans the reply as still arriving', () => {
        expect(src).toContain('detectTags(message.mes, { isTextComplete: false })');
        expect(src).not.toMatch(/<think\(\?:ing\)\?>/);
    });

    it('the lost-image audit reads the reply\'s reasoning', () => {
        expect(src).toContain('auditRenderedImages(message.mes, pending, message.extra && message.extra.reasoning)');
    });
});

// The detector's records are keyed by a POSITIONAL index, and what drops them when that index starts
// holding another reply is two listeners in the host-coupled image-gen.js. Live 2026-09-29: a
// regenerate (which deletes first) audited the new reply against the old take's picture and warned
// "GONE" seconds before the new picture landed. Gated as SOURCE, like the gate further down.
describe('SOURCE GATE — a delete or a swipe drops the lost-image records', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/imagegen/image-gen.js'), 'utf8');
    const listenerBody = (eventName) => {
        const start = src.indexOf(`eventSource.on(event_types.${eventName},`);
        return start < 0 ? '' : src.slice(start, src.indexOf('});', start) + 3);
    };

    it('MUTATION TARGET — a delete clears every record (it may renumber every later message)', () => {
        expect(listenerBody('MESSAGE_DELETED')).toContain('renderedImagesThisTurn.clear()');
    });

    it('MUTATION TARGET — a swipe drops the swiped message\'s records', () => {
        const body = listenerBody('MESSAGE_SWIPED');
        expect(body).toMatch(/\(mesId\)\s*=>/);
        expect(body).toContain('forgetRenderedImages(mesId)');
    });
});

// The regenerate button lives in the host-coupled image-gen.js, so its hand-off to the record is gated as
// SOURCE: the record must move after the text changes and before the redraw, whose render runs the audit.
describe('SOURCE GATE — the regenerate button moves the lost-image record before its redraw', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/imagegen/image-gen.js'), 'utf8');

    it('MUTATION TARGET — the swap is followed between the text change and the redraw', () => {
        const textAt = src.indexOf('message.mes = plan.text;');
        const followAt = src.indexOf('followImageSwap(mesId, plan, result)');
        const redrawAt = src.indexOf("redrawReply(message, mesId, 'imagegen regen swap')");
        expect(textAt).toBeGreaterThan(-1);
        expect(followAt).toBeGreaterThan(textAt);
        expect(redrawAt).toBeGreaterThan(followAt);
    });

    it('MUTATION TARGET — the message\'s records are replaced by the list the record moved in', () => {
        const start = src.indexOf('function followImageSwap(');
        const body = src.slice(start, src.indexOf('\n}', start));
        expect(start).toBeGreaterThan(-1);
        expect(body).toMatch(/renderedImagesThisTurn\.set\(key, recordsAfterImageSwap\(records, \{ wrapBefore: swap\.wrapBefore, wrapAfter: swap\.wrapAfter, imageUrl \}\)\)/);
    });
});

// Every picture on a card renders at its Image type. The choice lives in the host-coupled image-gen.js,
// so it is gated as SOURCE: a reader of the tag's type= (or a latch that lets one through) would hand
// the aspect back to the narrator.
describe('SOURCE GATE — the card\'s Image type decides every picture\'s size', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/imagegen/image-gen.js'), 'utf8');

    it('MUTATION TARGET — nothing reads a <pic> tag\'s type=', () => {
        expect(src).not.toMatch(/tagAttr\([^)]*,\s*'type'\)/);
    });

    it('MUTATION TARGET — the resolution comes from the profile\'s Image type alone', () => {
        const start = src.indexOf('function resolveResolution(');
        const body = src.slice(start, src.indexOf('\n}', start));
        expect(start).toBeGreaterThan(-1);
        expect(body).toMatch(/function resolveResolution\(\)/);
        expect(body).toContain('getImagegenProfile().defaultImageType');
    });
});

describe('buildRenderedImageWrap — the image written into the message', () => {
    const args = { escapedRawTag: escapeHtmlAttribute('<pic char="Iori">'), escapedUrl: '/img/a.png', escapedPrompt: 'masterpiece, 1girl, sitting. The girl in the frame is Iori: red bob', debugTagLine: '' };

    it('MUTATION TARGET — stores the resolved prompt ONCE (title), never a second copy in alt', () => {
        const wrap = buildRenderedImageWrap(args);
        expect(wrap.split(args.escapedPrompt)).toHaveLength(2);
        expect(wrap).toContain(`title="${args.escapedPrompt}"`);
        expect(wrap).toContain('alt="generated image"');
    });

    it('stays a wrap the context swap recovers the original tag from', () => {
        const wrap = buildRenderedImageWrap(args);
        const res = revertRenderedImagesToPicTags(`before ${wrap} after`, unescapeHtmlAttribute);
        expect(res.reverted).toBe(1);
        expect(res.text).toBe('before <pic char="Iori"> after');
    });
});

// The narrator's prompt while a POST call writes the pictures (plans/executed/picture-writer-route.md D3): a picture in its
// history invites one, so every past picture is taken out of the prompt.
describe('removePastPictures — no picture left in a narrator\'s history', () => {
    const tag = '<pic char="Iori" outfit="default" camera="eye-level" prompt="1girl, sitting" mainchar="not-in-picture">';
    const escaped = escapeHtmlAttribute(tag);
    const rendered = buildRenderedImageWrap({ escapedRawTag: escaped, escapedUrl: 'img/a.png', escapedPrompt: 'p' });

    it('MUTATION TARGET — a rendered image, a trace, a failed placeholder and a kept debug line are all taken out', () => {
        const debugLine = `<code class="auto-img-pictag" style="display:block;">${escaped}</code>`;
        const text = `She sat.\n${rendered}\nShe stood.\n${buildTagTraceWrap(escaped)}\nEnd.${buildUnrenderedTagWrap(escaped)}\n${debugLine}`;
        const res = removePastPictures(text);
        expect(res.removed).toBe(4);
        expect(res.text).toBe('She sat.\n\nShe stood.\n\nEnd.\n');
    });

    it('MUTATION TARGET — a raw picture tag goes only when asked (a past reply\'s own text)', () => {
        expect(removePastPictures(`She sat.\n${tag}\nEnd.`, { removesRawTags: true })).toEqual({ text: 'She sat.\n\nEnd.', removed: 1 });
        expect(removePastPictures(`She sat.\n${tag}\nEnd.`).removed).toBe(0);
    });

    it('MUTATION TARGET — an instruction that names "<pic>" without a picture is left whole', () => {
        const instruction = 'Never write a <pic> tag; the extension adds pictures.';
        expect(removePastPictures(instruction, { removesRawTags: true })).toEqual({ text: instruction, removed: 0 });
    });
});
