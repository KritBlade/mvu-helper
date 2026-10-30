// statusmenu-pack — the menu marker is the LAST thing in the displayed message. v0.3
import { describe, it, expect } from 'vitest';
import {
    MARKER_LAST_REGEX, withMarkerLastRow,
} from '../src/features/statusmenu-pack/statusmenu-pack-marker-last.js';
import { MENU_PLACEHOLDER } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { placePostRelayBlock } from '../src/features/small-llm/extra-llm-calls-core.js';
import { TURN_AUDIT_TAG, REPLY_TAIL_ANCHORS, placeLeadAndEndText } from '../src/features/logic-engine/turn-runner-core.js';

// Megumin V10's own regex, copied from the shipped preset so the test fails if the shim is aimed at a
// contract that no longer looks like this.
const MEGUMIN_MARKER_RE = /<Blocks>([\s\S]*?)(?:<\/Blocks\s*>|$)/gi;
const MEGUMIN_REPLACE = '<details class="meg-blocks-src" open><summary><b>Blocks</b></summary>$1</details>';
const applyMegumin = (t) => t.replace(MEGUMIN_MARKER_RE, MEGUMIN_REPLACE);

// The shipped row, compiled and applied the way SillyTavern does (public/scripts/utils.js regexFromString:
// /pattern/flags), so every case below runs the row the card actually carries.
const [, , ROW_PATTERN, ROW_FLAGS] = MARKER_LAST_REGEX.find_regex.match(/(\/?)(.+)\1([a-z]*)/i);
const applyMarkerLastRow = (text) => text.replace(new RegExp(ROW_PATTERN, ROW_FLAGS), MARKER_LAST_REGEX.replace_string);

// ST runs GLOBAL -> PRESET -> SCOPED, so Megumin's row lands first and ours edits its output.
const displayPipeline = (raw) => applyMarkerLastRow(applyMegumin(raw));

const insideEnvelope = (html) => {
    const at = html.indexOf(MENU_PLACEHOLDER);
    const close = html.lastIndexOf('</details>');
    return at > -1 && close > -1 && at < close;
};

describe('the menu marker ends the displayed message', () => {
    // The live 2026-09-02 failure: <Blocks> near the end, never closed, our marker after it.
    const unclosed = 'prose here\n\n<Blocks>\n<World_State>weather: clear\n\n' + MENU_PLACEHOLDER;

    it('reproduces the failure WITHOUT the shim — the marker is swallowed by the runaway |$ branch', () => {
        expect(insideEnvelope(applyMegumin(unclosed))).toBe(true);
    });

    it('and the shim puts the marker back outside', () => {
        const out = displayPipeline(unclosed);
        expect(insideEnvelope(out)).toBe(false);
        expect(out.endsWith(MENU_PLACEHOLDER)).toBe(true);
    });

    it('a properly CLOSED envelope is unaffected either way', () => {
        const closed = 'prose\n<Blocks>\n<World_State>x\n</Blocks>\n' + MENU_PLACEHOLDER;
        expect(insideEnvelope(applyMegumin(closed))).toBe(false);
        expect(displayPipeline(closed).endsWith(MENU_PLACEHOLDER)).toBe(true);
    });

    it('works with no Megumin at all — the shim is not conditional on them', () => {
        const plain = 'prose\n<combat_log>x</combat_log>\n' + MENU_PLACEHOLDER + '\ntrailing note';
        const out = applyMarkerLastRow(plain);
        expect(out.endsWith(MENU_PLACEHOLDER)).toBe(true);
        expect(out).toContain('trailing note');
    });

    it('leaves a message with no menu marker byte-identical', () => {
        const none = 'just prose\n<Blocks>\n<World_State>x';
        expect(applyMarkerLastRow(none)).toBe(none);
        expect(applyMarkerLastRow('')).toBe('');
    });

    it('moves only the FIRST marker, never duplicates one', () => {
        const out = applyMarkerLastRow('a' + MENU_PLACEHOLDER + 'b');
        expect(out.split(MENU_PLACEHOLDER).length - 1).toBe(1);
        expect(out).toBe('ab' + MENU_PLACEHOLDER);
    });

    it('is idempotent — a marker already last does not move', () => {
        const once = applyMarkerLastRow('prose ' + MENU_PLACEHOLDER);
        expect(applyMarkerLastRow(once)).toBe(once);
    });

    it('the shipped pattern actually contains the marker the menu pack triggers on', () => {
        // The row is built by escaping MENU_PLACEHOLDER into a /pattern/flags string; a bad escape still
        // parses, so this pins that the compiled pattern still matches the marker the menu pack triggers on.
        const m = MARKER_LAST_REGEX.find_regex.match(/(\/?)(.+)\1([a-z]*)/i);
        expect(new RegExp(m[2], m[3]).test(MENU_PLACEHOLDER)).toBe(true);
        expect(MARKER_LAST_REGEX.replace_string.endsWith(MENU_PLACEHOLDER)).toBe(true);
    });

    it('the shipped row is ordered AHEAD of the menu regex, or it consumes the marker first', () => {
        const c = withMarkerLastRow([{ script_name: 'StatusMenu' }], ['StatusMenu']);
        expect(c.regexes[0].script_name).toBe(MARKER_LAST_REGEX.script_name);
        expect(c.declaredOrder[0]).toBe(MARKER_LAST_REGEX.script_name);
        expect(c.declaredOrder).toContain('StatusMenu');
    });

    it('does not mutate the pack it was handed — the drift guard compares those bytes', () => {
        const packRegex = [{ script_name: 'StatusMenu' }];
        const order = ['StatusMenu'];
        withMarkerLastRow(packRegex, order);
        expect(packRegex).toEqual([{ script_name: 'StatusMenu' }]);
        expect(order).toEqual(['StatusMenu']);
    });

    it('a re-apply keeps exactly one copy of the row', () => {
        const once = withMarkerLastRow([{ script_name: 'StatusMenu' }], ['StatusMenu']);
        const twice = withMarkerLastRow(once.regexes, once.declaredOrder);
        const names = twice.regexes.map((r) => r.script_name);
        expect(names.filter((n) => n === MARKER_LAST_REGEX.script_name).length).toBe(1);
        expect(twice.declaredOrder.filter((n) => n === MARKER_LAST_REGEX.script_name).length).toBe(1);
    });

    it('the row fires on AI output at display time only, like the menu row it guards', () => {
        expect(MARKER_LAST_REGEX.source.ai_output).toBe(true);
        expect(MARKER_LAST_REGEX.destination.display).toBe(true);
        expect(MARKER_LAST_REGEX.destination.prompt).toBe(false);
    });
});

// The shim installs UNCONDITIONALLY — a regex row is data on the card and cannot detect anything at
// runtime, and deciding at install time ("is Megumin present?") bakes an answer that goes stale the
// moment the reader installs or removes it, silently restoring the bug. So the safety argument has to
// be that the row is a NO-OP when nothing else moved the marker. That is a claim about mvu-helper's own
// writers, which means it belongs in a test rather than in a comment.
describe('the row is inert on a card with no interfering extension', () => {
    it('every mvu-helper writer puts its block ABOVE the menu, so the marker is already last', () => {
        const base = 'prose\n\n' + MENU_PLACEHOLDER;
        const withReceipt = placePostRelayBlock(base, '<RES_POST_Variable>x</RES_POST_Variable>', `</${TURN_AUDIT_TAG}>`, REPLY_TAIL_ANCHORS);
        expect(withReceipt.endsWith(MENU_PLACEHOLDER)).toBe(true);
        // Already last ⇒ hoisting changes nothing at all.
        expect(applyMarkerLastRow(withReceipt)).toBe(withReceipt);
    });

    it('and stays inert after several stacked writes', () => {
        let text = 'prose\n\n' + MENU_PLACEHOLDER;
        for (const b of ['<RES_Variable>a</RES_Variable>', '<RES_POST_Variable>b</RES_POST_Variable>']) {
            text = placePostRelayBlock(text, b, `</${TURN_AUDIT_TAG}>`, REPLY_TAIL_ANCHORS);
        }
        expect(applyMarkerLastRow(text)).toBe(text);
    });

    it('and with the engine\'s end text, which sits directly above the menu while a later receipt goes above it', () => {
        let text = placeLeadAndEndText('prose\n\n' + MENU_PLACEHOLDER, { leadText: 'L', endText: 'E' }, { storyEnvelope: ['<maintext>'] }).text;
        expect(text.startsWith('<LeadText>L</LeadText>')).toBe(true);
        text = placePostRelayBlock(text, '<RES_POST_Variable>b</RES_POST_Variable>', `</${TURN_AUDIT_TAG}>`, REPLY_TAIL_ANCHORS);
        expect(text.endsWith('<EndText>E</EndText>\n\n' + MENU_PLACEHOLDER)).toBe(true);
        expect(applyMarkerLastRow(text)).toBe(text);
    });
});
