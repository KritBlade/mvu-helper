import { describe, it, expect } from 'vitest';
import { diagnoseTruncatedReply, explain, remedy, damage, damagePlain } from '../src/sillytavern/reply-integrity-core.js';

const OPS = '[{"op":"replace","path":"/A/0","value":1}]';

describe('diagnoseTruncatedReply — a lost turn must not look like a quiet one', () => {
    it('a complete reply is not truncated (the overwhelming majority — never toast these)', () => {
        expect(diagnoseTruncatedReply(`prose <UpdateVariable><JSONPatch>${OPS}</JSONPatch></UpdateVariable>`, 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('prose only, this card writes no variables', 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('', '').truncated).toBe(false);
        expect(diagnoseTruncatedReply(null, null).truncated).toBe(false);
    });

    it('THE FALSE ALARM 2026-08-11: an UNBRACKETED op list is what MVU accepts, so nothing was lost', () => {
        // Verbatim shape of the real reply. Every op APPLIED — Thoughts written, Intent/mundane cleared
        // — yet a plain JSON.parse() called the body broken and the warn announced LOST writes.
        const naked = '<UpdateVariable>\n<JSONPatch>\n'
            + '  { "op": "replace", "path": "/Classmate/Mitsuki/Thoughts/0", "value": "為什麼……" },\n'
            + '  { "op": "replace", "path": "/Intent/mundane/0", "value": "" }\n'
            + '</JSONPatch>\n</UpdateVariable>';
        expect(diagnoseTruncatedReply(naked, undefined).truncated).toBe(false);
        expect(diagnoseTruncatedReply(naked, 'stop').truncated).toBe(false);
        // A single unbracketed object is the same story.
        expect(diagnoseTruncatedReply('<JSONPatch>{"op":"replace","path":"/A/0","value":1}</JSONPatch>', 'stop').truncated).toBe(false);
        // An empty block wrote nothing, so it lost nothing.
        expect(diagnoseTruncatedReply('<JSONPatch>\n</JSONPatch>', 'stop').truncated).toBe(false);
    });

    it('the unbracketed tolerance does NOT swallow a body cut mid-op — brackets fix neither spelling', () => {
        // Cut inside a string, closing tag somehow present: still unparseable both ways.
        expect(diagnoseTruncatedReply('<JSONPatch>\n  { "op": "replace", "path": "/A/0", "value": "half a sen</JSONPatch>', 'stop').truncated).toBe(true);
        // Cut after a comma: the dangling comma survives the bracket wrap.
        expect(diagnoseTruncatedReply('<JSONPatch>\n  { "op": "replace", "path": "/A/0", "value": 1 },\n</JSONPatch>', 'stop').truncated).toBe(true);
        // Genuinely malformed ops stay malformed.
        expect(diagnoseTruncatedReply('<JSONPatch>{"op":"replace","path":"/A/0",}</JSONPatch>', 'stop').truncated).toBe(true);
    });

    it('THE LIVE CASE 2026-08-11: cut mid-op, no finish reason ⇒ nothing reported it, NOT a filter', () => {
        // Verbatim shape of the real failure: the sexual line came through INTACT and the stream died
        // 79 chars later inside a JSON path. Blaming content here sends you rewriting prompts forever.
        const cut = diagnoseTruncatedReply(
            '<UpdateVariable>\n<JSONPatch>\n[\n  { "op": "replace", "path": "/Classmate/Mitsuki/Thoughts/0", "value": "這女生的胸部也太誇張了吧" },\n  { "op": "replace", "path": "/Intent/friends/',
            undefined,
        );
        expect(cut.truncated).toBe(true);
        expect(cut.defect).toBe('unterminated-tag');
        // NAMED for what was observed, not for the mechanism guessed at: this chat's `extra` carries no
        // finish reason on ANY reply, complete ones included, so "the stream was DROPPED" stated as fact
        // would be a label asserting more than the value behind it knows.
        expect(cut.cause).toBe('no-finish-reason');
        // WORDING, tap era (2026-08-31): with the finish-reason tap armed, a REAL content block
        // arrives labelled — so silence now points at transport, and saying so is no longer a guess.
        // The one thing the wording must still never do is send the reader to rewrite prose.
        expect(explain(cut)).toMatch(/DIED before the final chunk/);
        expect(explain(cut)).not.toMatch(/content block and a dropped stream look identical/);
        expect(remedy(cut)).toMatch(/transport/);
        expect(remedy(cut)).not.toMatch(/rewrite/);
    });

    it('a REPORTED content filter is called a filter, so the fix points at content not transport', () => {
        const body = `<UpdateVariable><JSONPatch>${OPS.slice(0, 20)}`;
        expect(diagnoseTruncatedReply(body, 'content_filter').cause).toBe('filter');
        expect(diagnoseTruncatedReply(body, 'SAFETY').cause).toBe('filter');          // Google's spelling
        expect(diagnoseTruncatedReply(body, 'blocked').cause).toBe('filter');
    });

    it('a token-cap cut is truncation but NOT a filter — same defect, different remedy', () => {
        const c = diagnoseTruncatedReply(`<UpdateVariable><JSONPatch>${OPS.slice(0, 20)}`, 'length');
        expect(c.truncated).toBe(true);
        expect(c.cause).toBe('token-cap');        // its own cause: the remedy is the cap, not the transport
    });

    it('an UNRECOGNISED finish reason is passed through verbatim, never guessed at', () => {
        const c = diagnoseTruncatedReply(`<UpdateVariable><JSONPatch>${OPS.slice(0, 20)}`, 'relay_timeout');
        expect(c.cause).toBe('reported');
        expect(c.finishReason).toBe('relay_timeout');
    });

    it('closed tags but an UNPARSEABLE body: the text arrived whole, the patch itself is broken', () => {
        const c = diagnoseTruncatedReply('<JSONPatch>[{"op":"replace","path":"/A/0",}]</JSONPatch>', 'stop');
        expect(c.truncated).toBe(true);
        expect(c.defect).toBe('unparseable-json');
        expect(c.cause).toBe('complete-but-malformed');   // a finish reason DID arrive → not a drop
    });

    it('an unterminated <JSONPatch> counts even when <UpdateVariable> is balanced', () => {
        expect(diagnoseTruncatedReply('<UpdateVariable><JSONPatch>[{"op":"add"</UpdateVariable>', 'stop').defect)
            .toBe('unterminated-tag');
    });
});

describe('cut BEFORE the update block — the damage both other checks measured as healthy', () => {
    // Verbatim shape of the live 2026-08-13 loss: the provider content-filtered mid-scene, so the reply
    // died inside <gametxt> with the update block never opened. Zero opens, zero closes, perfectly
    // balanced — the old check called this intact while the whole turn had been lost. Note the host's
    // own <StatusPlaceHolderImpl/> sitting AFTER the severed tag: that is why the scan cannot just look
    // at the end of the text.
    const LIVE_CUT = '<DateAndTime>\n[ 🗓️ 2026-04-08 ]\n</DateAndTime>\n\n<location>\n📍 School_Classroom\n</location>\n\n'
        + '<gametxt>\n陽光透過教室明亮的窗戶灑落在光亮的木質地板上。\n\n<roll/>\n\n她的臉頰迅速染上了一層淡淡的粉紅。\n\n<font color="#56B4E'
        + '\n\n<StatusPlaceHolderImpl/>';

    it('IS truncated, with its own defect and its own damage sentence', () => {
        const c = diagnoseTruncatedReply(LIVE_CUT, undefined);
        expect(c.truncated).toBe(true);
        expect(c.defect).toBe('cut-before-update-block');
        expect(damage(c)).toMatch(/NEVER REACHED/);
        expect(damagePlain(c)).toMatch(/NOTHING from this turn was saved/);
    });

    it('names the cause the provider gave, exactly as the other defects do', () => {
        expect(diagnoseTruncatedReply(LIVE_CUT, 'content_filter').cause).toBe('filter');
        expect(diagnoseTruncatedReply(LIVE_CUT, 'length').cause).toBe('token-cap');
        expect(diagnoseTruncatedReply(LIVE_CUT, undefined).cause).toBe('no-finish-reason');
    });

    it('BOTH signals are required — either alone is a false alarm this file exists to avoid', () => {
        // (2) without (1): sloppy unclosed <font>/<p> in a COMPLETE reply. Models do this constantly.
        expect(diagnoseTruncatedReply('<gametxt>she smiled <font color="#fff">warmly</gametxt>', 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('<p>a paragraph the model never closed', 'stop').truncated).toBe(false);
        // (1) without (2): a bare "<" in prose, no structure left open.
        expect(diagnoseTruncatedReply('the value a<b holds through the scene', 'stop').truncated).toBe(false);
        // Neither: the ordinary quiet turn. A card that writes no variables must NEVER be toasted.
        expect(diagnoseTruncatedReply('prose only, this card writes no variables', 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('<gametxt>a complete scene</gametxt>', 'stop').truncated).toBe(false);
    });

    it('does not fire once the update block EXISTS — those cases belong to the other two checks', () => {
        // A complete reply that also happens to carry a stray unclosed tag: still not truncated.
        const complete = `<gametxt>scene <font color="#fff">warm</gametxt><UpdateVariable><JSONPatch>${OPS}</JSONPatch></UpdateVariable>`;
        expect(diagnoseTruncatedReply(complete, 'stop').truncated).toBe(false);
        // And a half-written block keeps its OWN defect name rather than the new one.
        expect(diagnoseTruncatedReply('<gametxt>scene<UpdateVariable><JSONPatch>[{"op":', undefined).defect)
            .toBe('unterminated-tag');
    });

    it('THE PRECONDITION: a reply whose update block ARRIVED stays healthy however messy its prose markup', () => {
        // Isolates the "no update block present" guard, which the case above cannot: here BOTH signals
        // fire on the prose (an unclosed <p>, and a <font that never reaches its '>'), while the patch
        // itself parsed and every write landed. Without the precondition this reply — a turn that
        // demonstrably RECORDED — would be announced as having recorded nothing.
        const messy = `<gametxt><p>she smiled <font color="#5</gametxt><UpdateVariable><JSONPatch>${OPS}</JSONPatch></UpdateVariable>`;
        expect(diagnoseTruncatedReply(messy, 'stop').truncated).toBe(false);
    });

    it('self-closing and HTML void tags close themselves — they never look like an open block', () => {
        expect(diagnoseTruncatedReply('<gametxt>line<br>two<hr><roll/><StatusPlaceHolderImpl/></gametxt>', 'stop').truncated).toBe(false);
        // …and a genuinely open block plus a severed tag still fires through them.
        expect(diagnoseTruncatedReply('<gametxt>line<br><img src="x">text<font color="#5', undefined).truncated).toBe(true);
        // THE ALLOWLIST ITSELF: signal (1) fires here, so the verdict rests entirely on whether <br>
        // and <img> count as open blocks. They must not — a void element is closed by definition, and
        // treating one as an open structure would turn every stray '<' in ordinary prose into a toast.
        expect(diagnoseTruncatedReply('<br>line<img src="x">text a<b', undefined).truncated).toBe(false);
    });
});

describe('a tag NAMED in prose is not a tag — the reply that mentions its own instructions', () => {
    // A card's control file names the blocks it wants. A model that reprints that instruction emits
    // the same characters an opener has, so the balance count sees an extra open and calls a COMPLETE
    // reply truncated — announcing lost writes for a turn that saved everything.
    const mention = '- 必須包含 <DateAndTime>、<location>、<combat_log>、<UpdateVariable>。';
    const block = `<UpdateVariable>\n<JSONPatch>\n${OPS}\n</JSONPatch>\n</UpdateVariable>`;

    it('a complete reply whose PROSE names <UpdateVariable> is not truncated', () => {
        expect(diagnoseTruncatedReply(`${mention}\n\n${block}`, '').truncated).toBe(false);
        expect(diagnoseTruncatedReply(`prose\n${mention}\n${block}\n<StatusPlaceHolderImpl/>`, 'stop').truncated).toBe(false);
    });

    it('the mention is discounted wherever it sits — before, after, or without any block', () => {
        expect(diagnoseTruncatedReply(`${block}\n${mention}`, '').truncated).toBe(false);
        expect(diagnoseTruncatedReply('remember to emit an <UpdateVariable> block at the end.', 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('- The <JSONPatch> body MUST be a JSON array.', 'stop').truncated).toBe(false);
    });

    it('WHAT FOLLOWS decides: end of line, another tag, or the body\'s bracket is an OPENER', () => {
        expect(diagnoseTruncatedReply('<UpdateVariable>\n<JSONPatch>\n[{"op":', undefined).defect).toBe('unterminated-tag');
        expect(diagnoseTruncatedReply('<gametxt>scene<UpdateVariable><JSONPatch>[{"op":', undefined).defect).toBe('unterminated-tag');
        expect(diagnoseTruncatedReply(`<JSONPatch>${OPS.slice(0, 22)}`, undefined).defect).toBe('unterminated-tag');
        expect(diagnoseTruncatedReply('<UpdateVariable>{"op":', undefined).defect).toBe('unterminated-tag');
    });

    it('a mention must not MASK a real cut before the block ever opened', () => {
        // The precondition asks whether an update block is present. A prose mention answers "yes"
        // when the truthful answer is "none arrived", which silently retires the worst damage class.
        const cut = diagnoseTruncatedReply('must include <UpdateVariable>. then it stopped <font color="#56B4E', undefined);
        expect(cut.truncated).toBe(true);
        expect(cut.defect).toBe('cut-before-update-block');
    });

    it('an over-counted CLOSER cannot raise a false alarm, so closers are counted as written', () => {
        // Only opens-exceed-closes fires. Prose naming the closing form is therefore harmless, while
        // erasing a real closer would hide a genuine cut — which is why the rule touches openers only.
        expect(diagnoseTruncatedReply(`${block}\nclose it with </UpdateVariable> exactly.`, 'stop').truncated).toBe(false);
    });
});

describe('a provider-REPORTED cut with a clean text shape — the filter kill between paragraphs', () => {
    // MUTATION TARGET — the 2026-08-31 finding that unblocked this branch: a content_filter kill
    // whose surviving text is balanced and complete-looking. The shape tests see nothing; the
    // reason word is the whole proof. Break the reportedCut gate and the first test fails; treat
    // every finish as a cut and the 'stop' test fails.
    it('a filter reason alone marks the reply truncated, defect cut-mid-prose', () => {
        const cut = diagnoseTruncatedReply('A complete, balanced paragraph. It even ends with a period.', 'content_filter (native: PROHIBITED_CONTENT)');
        expect(cut.truncated).toBe(true);
        expect(cut.defect).toBe('cut-mid-prose');
        expect(cut.cause).toBe('filter');
    });
    it('a token-cap reason alone marks it too', () => {
        const cut = diagnoseTruncatedReply('Clean text.', 'length');
        expect(cut.truncated).toBe(true);
        expect(cut.defect).toBe('cut-mid-prose');
        expect(cut.cause).toBe('token-cap');
    });
    it('a normal stop with clean shape stays healthy', () => {
        expect(diagnoseTruncatedReply('Clean text.', 'stop').truncated).toBe(false);
        expect(diagnoseTruncatedReply('Clean text.', 'end_turn').truncated).toBe(false);
        expect(diagnoseTruncatedReply('Clean text.', '').truncated).toBe(false);
        expect(diagnoseTruncatedReply('Clean text.', undefined).truncated).toBe(false);
    });
    it('a shape defect still names ITS defect when a reason is also present', () => {
        const cut = diagnoseTruncatedReply('<UpdateVariable>' + String.fromCharCode(10) + '<JSONPatch>' + String.fromCharCode(10) + '[{ "op": "add",', 'content_filter');
        expect(cut.truncated).toBe(true);
        expect(cut.defect).toBe('unterminated-tag');
        expect(cut.cause).toBe('filter');
    });
});
