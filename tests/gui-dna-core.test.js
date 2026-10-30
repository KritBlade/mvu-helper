/**
 * MVU Helper — settings-panel/gui-dna-core.js, the gene builders (devdoc/gui-dna.md §5).
 *
 * Each builder returns one gene's markup. What every one must hold: data is escaped, a fixed word (`text`,
 * `title`, `placeholder`) comes out keyed for the locale pass, and a value (`name`) comes out as written and never keyed.
 */
import { describe, it, expect } from 'vitest';
import {
    iconButton, button, statusPill, listRow, recordCard, grid, stack, field, fieldLabel, controlRow, hint, detail, codeChip, input,
    textarea, select, selectOption, switchInput, checkList, emptyState, notice, groupTitle, resultList, pager,
    isNeedUnmet, panelThemeOf,
} from '../src/features/settings-panel/gui-dna-core.js';

const HOSTILE = '<b>"Mia" & \'co\'</b>';
const HOSTILE_ESCAPED = '&lt;b&gt;&quot;Mia&quot; &amp; &#39;co&#39;&lt;/b&gt;';

describe('iconButton', () => {
    it('is a 32px icon button whose translated title is its accessible name', () => {
        const html = iconButton({ icon: 'fa-pen', title: 'Edit entry' });
        expect(html).toBe('<button type="button" class="mvuh-btn mvuh-btn-icon" data-i18n-title="Edit entry" title="Edit entry"><i class="fa-solid fa-pen"></i></button>');
    });

    it('a toggle carries aria-pressed, and .is-on only while pressed', () => {
        expect(iconButton({ icon: 'fa-shirt', title: 'T', isPressed: true })).toContain('class="mvuh-btn mvuh-btn-icon is-on"');
        expect(iconButton({ icon: 'fa-shirt', title: 'T', isPressed: true })).toContain('aria-pressed="true"');
        const off = iconButton({ icon: 'fa-lock', title: 'T', isPressed: false });
        expect(off).toContain('aria-pressed="false"');
        expect(off).not.toContain('is-on');
        expect(iconButton({ icon: 'fa-pen', title: 'T' })).not.toContain('aria-pressed');
    });

    it('marks danger, sets disabled, and writes data attributes escaped', () => {
        const html = iconButton({ icon: 'fa-trash', title: 'Delete entry', isDanger: true, isDisabled: true, data: { 'roster-action': 'delete', key: HOSTILE, uid: 7, skipped: null } });
        expect(html).toContain('class="mvuh-btn mvuh-btn-icon mvuh-btn-danger"');
        expect(html).toContain(' disabled');
        expect(html).toContain(`data-roster-action="delete" data-key="${HOSTILE_ESCAPED}" data-uid="7"`);
        expect(html).not.toContain('data-skipped');
    });
});

describe('button', () => {
    it('keys its text and puts the icon first', () => {
        expect(button({ text: 'Save', icon: 'fa-floppy-disk', kind: 'primary', data: { 'roster-action': 'edit-save' } }))
            .toBe('<button type="button" class="mvuh-btn mvuh-btn-primary" data-roster-action="edit-save"><i class="fa-solid fa-floppy-disk"></i><span data-i18n="Save">Save</span></button>');
    });

    it('defaults to secondary; danger and quiet have their classes; an unknown kind falls back to secondary', () => {
        expect(button({ text: 'Cancel' })).toContain('class="mvuh-btn"');
        expect(button({ text: 'Merge', kind: 'danger' })).toContain('class="mvuh-btn mvuh-btn-danger"');
        expect(button({ text: 'Reset', kind: 'quiet' })).toContain('class="mvuh-btn mvuh-btn-quiet"');
        expect(button({ text: 'X', kind: 'loud' })).toContain('class="mvuh-btn"');
    });

    it('a button that cannot act now is disabled', () => {
        expect(button({ text: 'Install to this card', isDisabled: true })).toMatch(/^<button type="button" class="mvuh-btn" disabled>/);
        expect(button({ text: 'Install to this card' })).not.toContain('disabled');
    });

    // A button acting on the card from a region that does not (a library row) carries its own declaration; its own
    // disabled state stays a separate thing underneath.
    it('declares what it needs, beside its own disabled state', () => {
        expect(button({ text: 'Install to this card', needs: 'chat', data: { 'gp-action': 'install' } }))
            .toBe('<button type="button" class="mvuh-btn" data-mvuh-needs="chat" data-gp-action="install"><span data-i18n="Install to this card">Install to this card</span></button>');
        expect(button({ text: 'Install to this card', needs: 'chat', isDisabled: true })).toContain(' disabled data-mvuh-needs="chat"');
        expect(button({ text: 'Remove' })).not.toContain('data-mvuh-needs');
    });
});

// The card gate's one decision: which declared regions wait. The shell applies it; every lobby check rides on it.
describe('isNeedUnmet', () => {
    it('MUTATION TARGET — no card: a card region and a chat region both wait', () => {
        expect(isNeedUnmet('card', { isCardOpen: false, isChatStarted: false })).toBe(true);
        expect(isNeedUnmet('chat', { isCardOpen: false, isChatStarted: false })).toBe(true);
    });

    it('MUTATION TARGET — a card whose chat has not started: only a chat region waits', () => {
        expect(isNeedUnmet('card', { isCardOpen: true, isChatStarted: false })).toBe(false);
        expect(isNeedUnmet('chat', { isCardOpen: true, isChatStarted: false })).toBe(true);
    });

    it('a card with its chat started: nothing waits', () => {
        expect(isNeedUnmet('card', { isCardOpen: true, isChatStarted: true })).toBe(false);
        expect(isNeedUnmet('chat', { isCardOpen: true, isChatStarted: true })).toBe(false);
    });

    it('a chat never counts as started without its card', () => {
        expect(isNeedUnmet('chat', { isCardOpen: false, isChatStarted: true })).toBe(true);
    });

    it('MUTATION TARGET — a need this build does not know always waits, so a misspelt region is greyed, not left open', () => {
        expect(isNeedUnmet('chta', { isCardOpen: true, isChatStarted: true })).toBe(true);
        expect(isNeedUnmet('', { isCardOpen: true, isChatStarted: true })).toBe(true);
    });
});

describe('statusPill', () => {
    it('a fixed word is keyed', () => {
        expect(statusPill({ text: 'Installed', status: 'success' })).toBe('<span class="mvuh-pill is-success"><span data-i18n="Installed">Installed</span></span>');
    });

    it('a value is escaped and never keyed', () => {
        const html = statusPill({ name: HOSTILE, status: 'accent' });
        expect(html).toBe(`<span class="mvuh-pill is-accent">${HOSTILE_ESCAPED}</span>`);
        expect(html).not.toContain('data-i18n');
    });

    it('an unknown status reads as neutral', () => {
        expect(statusPill({ name: 'x', status: 'purple' })).toContain('mvuh-pill is-neutral');
    });

    it('a pill its renderer shows later starts hidden, and carries its hook', () => {
        expect(statusPill({ text: 'No connection', status: 'warning', isHidden: true, data: { 'call-live': 'no-connection' } }))
            .toBe('<span class="mvuh-pill is-warning" style="display:none;" data-call-live="no-connection"><span data-i18n="No connection">No connection</span></span>');
        expect(statusPill({ name: 'PRE', status: 'accent' })).not.toContain('display:none');
    });
});

describe('listRow', () => {
    it('escapes the name and lays out icon, main and pills (together), actions', () => {
        const html = listRow({ icon: 'fa-user', name: HOSTILE, pills: ['<P>'], actions: ['<A>'], data: { key: 'Mia' } });
        expect(html).toBe('<div class="mvuh-row" data-key="Mia"><i class="fa-solid fa-user mvuh-row-icon"></i>'
            + `<div class="mvuh-row-info"><div class="mvuh-row-main"><div class="mvuh-row-name">${HOSTILE_ESCAPED}</div></div>`
            + '<div class="mvuh-row-pills"><P></div></div><div class="mvuh-row-actions"><A></div></div>');
    });

    it('a sub-line keys its lead-in and escapes its data; no data, no sub-line', () => {
        const html = listRow({ icon: 'fa-user', name: 'Mia', sub: { text: 'Also known as', name: `${HOSTILE} · M` } });
        expect(html).toContain(`<div class="mvuh-row-sub"><span data-i18n="Also known as">Also known as</span>: ${HOSTILE_ESCAPED} · M</div>`);
        expect(listRow({ icon: 'fa-user', name: 'Mia', sub: { text: 'Also known as', name: '' } })).not.toContain('mvuh-row-sub');
        expect(listRow({ icon: 'fa-user', name: 'Mia', sub: { name: 'v1.2' } })).toContain('<div class="mvuh-row-sub">v1.2</div>');
    });

    it('a fixed word as the name is keyed', () => {
        expect(listRow({ icon: 'fa-gears', text: 'Unnamed engine' }))
            .toContain('<div class="mvuh-row-name"><span data-i18n="Unnamed engine">Unnamed engine</span></div>');
    });

    it('several sub-lines show in order, and one with nothing to show is left out', () => {
        const html = listRow({ icon: 'fa-gears', name: 'E', sub: [{ text: 'Exports', name: 'a, b' }, { text: 'Load error', name: '' }, { name: 'v1' }] });
        expect(html).toContain('<div class="mvuh-row-sub"><span data-i18n="Exports">Exports</span>: a, b</div><div class="mvuh-row-sub">v1</div></div>');
        expect(html.match(/mvuh-row-sub/g)).toHaveLength(2);
    });

    it('a fixed sentence alone is a sub-line; a code part is a code chip', () => {
        expect(listRow({ icon: 'fa-gears', name: 'E', sub: { text: 'Its entry is gone.' } }))
            .toContain('<div class="mvuh-row-sub"><span data-i18n="Its entry is gone.">Its entry is gone.</span></div>');
        expect(listRow({ icon: 'fa-gears', name: 'E', sub: { parts: [{ name: 'k ' }, { code: 'a < b' }] } }))
            .toContain('<div class="mvuh-row-sub">k <code class="mvuh-code">a &lt; b</code></div>');
    });

    it('a sub-line of parts keys its words and escapes its data, in order', () => {
        const html = listRow({ icon: 'fa-gears', name: 'E', sub: { parts: [{ text: 'Turn runner' }, { name: ': 3 ' }, { text: 'resolved' }, { name: '' }, { name: HOSTILE }] } });
        expect(html).toContain('<div class="mvuh-row-sub"><span data-i18n="Turn runner">Turn runner</span>: 3 '
            + `<span data-i18n="resolved">resolved</span>${HOSTILE_ESCAPED}</div>`);
        expect(listRow({ icon: 'fa-gears', name: 'E', sub: { parts: [{ name: '' }] } })).not.toContain('mvuh-row-sub');
    });
});

describe('recordCard, field, controlRow, hint', () => {
    it('a record card keys a fixed heading and holds its body', () => {
        expect(recordCard({ icon: 'fa-pen', text: 'Edit entry', body: '<B>' })).toBe('<div class="mvuh-record">'
            + '<div class="mvuh-record-header"><i class="fa-solid fa-pen"></i><span class="mvuh-record-name"><span data-i18n="Edit entry">Edit entry</span></span></div>'
            + '<div class="mvuh-record-body"><B></div></div>');
    });

    it('a record card named by data escapes it and adds header actions', () => {
        const html = recordCard({ name: HOSTILE, actions: ['<A>'] });
        expect(html).toContain(`<span class="mvuh-record-name">${HOSTILE_ESCAPED}</span><A></div>`);
    });

    it('a full record header runs switch, icon, name, pills, actions, then the collapse chevron', () => {
        const html = recordCard({ icon: 'fa-message', name: 'PRE', nameData: { 'call-live': 'name' }, toggle: '<S>', pills: ['<P>'], actions: ['<A>'], isCollapsible: true, data: { 'call-id': 'c1' } });
        expect(html).toBe('<div class="mvuh-record" data-call-id="c1">'
            + '<div class="mvuh-record-header"><S><i class="fa-solid fa-message"></i><span class="mvuh-record-name" data-call-live="name">PRE</span><P><A>'
            + '<button type="button" class="mvuh-collapse" aria-expanded="true" data-i18n-title="Show or hide" title="Show or hide"><i class="fa-solid fa-chevron-up"></i></button></div>'
            + '<div class="mvuh-record-body"></div></div>');
        expect(recordCard({ name: 'x' })).not.toContain('mvuh-collapse');
    });

    it('field and control row wrap their parts; a hint is keyed', () => {
        expect(field(['<X>', '<Y>'])).toBe('<div class="mvuh-field"><X><Y></div>');
        expect(field(['<X>'], { isSpan: true })).toBe('<div class="mvuh-field mvuh-span"><X></div>');
        expect(controlRow(['<X>'])).toBe('<div class="mvuh-control-row"><X></div>');
        expect(hint({ text: 'One line.' })).toBe('<p class="mvuh-hint" data-i18n="One line.">One line.</p>');
    });

    it('a hint with a chip keys its words alone, so a locale pass keeps the chip', () => {
        expect(hint({ text: 'Reads the entries tagged', chip: '<code>[PRE]</code>' }))
            .toBe('<p class="mvuh-hint"><span data-i18n="Reads the entries tagged">Reads the entries tagged</span> <code>[PRE]</code></p>');
    });

    it('a detail is keyed', () => {
        expect(detail({ text: 'Longer.' })).toBe('<p class="mvuh-detail" data-i18n="Longer.">Longer.</p>');
    });

    it('a stack puts its fields one under another', () => {
        expect(stack(['<F>', '<G>'])).toBe('<div class="mvuh-stack"><F><G></div>');
    });

    it('a grid is two columns, a pair stays two on phone, either can span its parent', () => {
        expect(grid(['<F>'])).toBe('<div class="mvuh-grid"><F></div>');
        expect(grid(['<F>'], { isPair: true })).toBe('<div class="mvuh-grid-pair"><F></div>');
        expect(grid(['<F>'], { isPair: true, isSpan: true })).toBe('<div class="mvuh-grid-pair mvuh-span"><F></div>');
    });

    it('a field label names its control, or captions a set; (?) only when asked', () => {
        expect(fieldLabel({ text: 'Name', forId: 'mvuh_call_c1_name' }))
            .toBe('<div class="mvuh-field-label"><label for="mvuh_call_c1_name" data-i18n="Name">Name</label></div>');
        expect(fieldLabel({ text: 'Members' })).toBe('<div class="mvuh-field-label"><span data-i18n="Members">Members</span></div>');
        expect(fieldLabel({ text: 'Phase', forId: 'p', hasHelp: true }))
            .toContain('<button type="button" class="mvuh-help-toggle" aria-expanded="false" data-i18n-title="More about this" title="More about this">');
    });
});

describe('codeChip, input, switchInput, checkList', () => {
    it('a code chip shows a value as written, escaped and never keyed', () => {
        const html = codeChip({ name: `[${HOSTILE}]`, data: { 'call-live': 'tag' } });
        expect(html).toBe(`<code class="mvuh-code" data-call-live="tag">[${HOSTILE_ESCAPED}]</code>`);
        expect(html).not.toContain('data-i18n');
    });

    it('an input escapes its value, so text cannot close the tag', () => {
        expect(input({ id: 'mvuh_i', value: '"><script>', data: { 'call-field': 'name' } }))
            .toBe('<input type="text" id="mvuh_i" class="mvuh-input" value="&quot;&gt;&lt;script&gt;" data-call-field="name">');
    });

    it('a number input carries its limits; a placeholder is keyed; isCode sets the pattern font', () => {
        expect(input({ id: 'n', type: 'number', value: 0.7, min: 0, step: 0.1, placeholder: 'Preset' }))
            .toBe('<input type="number" id="n" class="mvuh-input" value="0.7" min="0" step="0.1" data-i18n-placeholder="Preset" placeholder="Preset">');
        expect(input({ id: 'r', isCode: true })).toContain('class="mvuh-input is-code"');
        expect(input({ id: 'x', type: 'password' })).toContain('type="text"');
        expect(input({ id: 'v', value: null })).toContain('value=""');
        expect(input({ id: 'd', isDisabled: true })).toBe('<input type="text" id="d" class="mvuh-input" value="" disabled>');
    });

    it('a select marks a required pick not made, and carries its hook', () => {
        expect(select({ id: 's', options: ['<O>'], isMissing: true, data: { 'call-field': 'profileId' } }))
            .toBe('<select id="s" class="mvuh-select is-missing" data-call-field="profileId"><O></select>');
    });

    it('a bare switch is a role=switch checkbox with a translated title', () => {
        expect(switchInput({ title: 'Enabled', isChecked: true, data: { 'call-field': 'enabled' } }))
            .toBe('<input type="checkbox" role="switch" class="mvuh-switch" data-i18n-title="Enabled" title="Enabled" checked data-call-field="enabled">');
        expect(switchInput({ title: 'Enabled' })).not.toContain('checked');
    });

    it('a check list shows each member as written, never keyed, and keeps its hook', () => {
        const html = checkList({ items: [{ name: HOSTILE, isChecked: true, data: { 'group-member': HOSTILE } }, { name: 'POST' }] });
        expect(html).toBe('<div class="mvuh-check-list">'
            + `<label class="mvuh-check-item"><input type="checkbox" class="mvuh-check" checked data-group-member="${HOSTILE_ESCAPED}"><span>${HOSTILE_ESCAPED}</span></label>`
            + '<label class="mvuh-check-item"><input type="checkbox" class="mvuh-check"><span>POST</span></label></div>');
        expect(html).not.toContain('data-i18n');
    });
});

describe('textarea, select, selectOption', () => {
    it('a textarea escapes its value, so text cannot close it early', () => {
        const html = textarea({ id: 'mvuh_x', value: '[Body]\n</textarea><script>', rows: 8, isCode: true, title: 'Entry text' });
        expect(html).toBe('<textarea id="mvuh_x" class="mvuh-textarea is-code" rows="8" data-i18n-title="Entry text" title="Entry text">[Body]\n&lt;/textarea&gt;&lt;script&gt;</textarea>');
    });

    it('a select holds its options and its translated title', () => {
        expect(select({ id: 'mvuh_s', title: 'Merge into another entry', options: ['<O>'] }))
            .toBe('<select id="mvuh_s" class="mvuh-select" data-i18n-title="Merge into another entry" title="Merge into another entry"><O></select>');
    });

    it('an option keys a fixed word on itself, and shows a name as written', () => {
        expect(selectOption({ value: '', text: 'Off' })).toBe('<option value="" data-i18n="Off">Off</option>');
        expect(selectOption({ value: HOSTILE, name: HOSTILE, isSelected: true })).toBe(`<option value="${HOSTILE_ESCAPED}" selected>${HOSTILE_ESCAPED}</option>`);
    });
});

describe('emptyState and pager', () => {
    it('an empty state is an icon and one keyed line', () => {
        expect(emptyState({ icon: 'fa-user-plus', text: 'Nothing yet.' })).toBe('<div class="mvuh-empty"><i class="fa-solid fa-user-plus"></i><span data-i18n="Nothing yet.">Nothing yet.</span></div>');
    });

    it('the pager disables previous on the first page and next on the last, and counts pages from 1', () => {
        const first = pager({ page: 0, pageCount: 3, previousData: { 'roster-action': 'page-previous' }, nextData: { 'roster-action': 'page-next' } });
        expect(first).toMatch(/fa-chevron-left/);
        expect(first).toContain('<span>1 / 3</span>');
        expect(first).toMatch(/data-i18n-title="Previous page" title="Previous page" disabled data-roster-action="page-previous"/);
        expect(first).toMatch(/data-i18n-title="Next page" title="Next page" data-roster-action="page-next"/);
        const last = pager({ page: 2, pageCount: 3 });
        expect(last).toContain('<span>3 / 3</span>');
        expect(last).toMatch(/title="Next page" disabled/);
        expect(last).not.toMatch(/title="Previous page" disabled/);
    });
});

describe('notice and resultList', () => {
    it('a notice carries its status, an icon for it, and its sentence keyed', () => {
        expect(notice({ status: 'danger', text: 'The registry is malformed.' })).toBe('<div class="mvuh-notice is-danger"><i class="fa-solid fa-circle-exclamation"></i>'
            + '<p class="mvuh-notice-text"><span data-i18n="The registry is malformed.">The registry is malformed.</span></p></div>');
    });

    it('a notice keys its lead-in and escapes its value; an unknown status reads as info', () => {
        const html = notice({ status: 'loud', text: 'Fired counts are unknown', name: HOSTILE });
        expect(html).toContain('class="mvuh-notice is-info"><i class="fa-solid fa-circle-info"></i>');
        expect(html).toContain(`<span data-i18n="Fired counts are unknown">Fired counts are unknown</span>: ${HOSTILE_ESCAPED}</p>`);
    });

    it('a notice carries its one fix after the sentence', () => {
        const action = button({ text: 'Import Card Lore', icon: 'fa-book' });
        expect(notice({ status: 'warning', text: 'No lorebook', action })).toBe('<div class="mvuh-notice is-warning"><i class="fa-solid fa-triangle-exclamation"></i>'
            + `<p class="mvuh-notice-text"><span data-i18n="No lorebook">No lorebook</span></p>${action}</div>`);
    });

    it('a result list: the heading, then each line with its status icon, its words keyed and its data escaped', () => {
        const html = resultList({
            heading: { parts: [{ name: '2 ' }, { text: 'packs in this file' }] },
            lines: [
                { icon: 'fa-calendar-days', parts: [{ name: 'p v1 · ' }, { text: 'series' }] },
                { status: 'danger', name: HOSTILE },
                { text: 'Pack is valid', status: 'success' },
                { status: 'warning', name: '' },
            ],
        });
        expect(html).toBe('<ul class="mvuh-result"><li class="mvuh-result-heading">2 <span data-i18n="packs in this file">packs in this file</span></li>'
            + '<li class="mvuh-result-line"><i class="fa-solid fa-calendar-days"></i><span>p v1 · <span data-i18n="series">series</span></span></li>'
            + `<li class="mvuh-result-line is-danger"><i class="fa-solid fa-circle-xmark"></i><span>${HOSTILE_ESCAPED}</span></li>`
            + '<li class="mvuh-result-line is-success"><i class="fa-solid fa-circle-check"></i><span><span data-i18n="Pack is valid">Pack is valid</span></span></li></ul>');
    });

    it('no heading, no heading line', () => {
        expect(resultList({ lines: [{ text: 'Pack is valid', status: 'success' }] })).not.toContain('mvuh-result-heading');
    });
});

describe('groupTitle', () => {
    it('an icon and its words as a line: fixed words keyed, values escaped', () => {
        expect(groupTitle({ icon: 'fa-cube', parts: [{ text: 'GameLogic Pack' }, { name: ` (${HOSTILE})` }] })).toBe('<div class="mvuh-group-title">'
            + `<i class="fa-solid fa-cube"></i><span><span data-i18n="GameLogic Pack">GameLogic Pack</span> (${HOSTILE_ESCAPED})</span></div>`);
    });
});

describe('panelThemeOf — the palette the panel wears', () => {
    it('MUTATION TARGET — light only when picked; anything else is the dark default', () => {
        expect(panelThemeOf('light')).toBe('light');
        for (const saved of ['dark', undefined, null, '', 'Light', 'blue']) expect(panelThemeOf(saved), String(saved)).toBe('dark');
    });
});
