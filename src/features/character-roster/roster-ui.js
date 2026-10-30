// character-roster/roster-ui.js — the Roster tab: the character registry (one row per character in this chat's state,
// ten to a page) and the roster's own settings on the tab (Appearance route, Roster collection, Present flag). Harvest
// via also sits on this tab but belongs to imagegen, which wires it (imagegen/image-settings-ui.js).
//
// Rows are built from the gene builders (features/settings-panel), which key every fixed word; renderRoster
// re-applies the locale after each paint. A row's buttons carry data-roster-action and the entry's key. Edit opens the
// character's record in a dialog — its Outfit section: body, bust, aliases, one name and clothes pair per outfit (× takes
// one out, Add outfit adds one), the story-update switch and "Wearing now", what the worn-outfit store says they wear
// (worn-outfit-edits.js) (a tab bar joins it with the second section); Merge opens a record card under its row.
//
// Re-harvest = DELETE the entry: auto-harvest's on-file list is rebuilt from the entries, so the character drops
// off it and the story re-describes them on their next appearance. A character the card seeds comes back from the
// card instead (card-sync's re-seed), on the next load or Re-import; "Reset to the card's look" does that at once.

import { listCharEntries, listOutfitVariants, listAliases, upsertCharDna, deleteCharDna, renameCharDna, mergeCharDna, seedStatusOf, seededOutfitsOf, resetCharToSeed } from './character-registry.js';
import { recordFromContent, contentFromRecord, recordFromEditorFields, editorFieldsFromRecord } from './character-registry-core.js';
import { allowsClothesUpdate, setAllowUpdate, wearingNowFromEditorFields, wearingNowChoices, wearingNowSelection, OUTFIT_NEW_CLOTHES } from './dna-core.js';
import { readWearingNow, setWearingNow } from './worn-outfit-edits.js';
import { getRosterProfile, notifyRouteChanged } from './roster-settings.js';
import { saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { openCardName } from '../../sillytavern/card-access.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { confirmPopup, inputPopup, formPopup, noticePopup } from '../../sillytavern/popup.js';
import {
    iconButton, button, statusPill, listRow, recordCard, field, fieldLabel, controlRow, hint, detail, codeChip, input, textarea, select, selectOption, switchInput,
    stack, groupTitle, emptyState, pager,
} from '../settings-panel/index.js';
import { toast } from '../../sillytavern/mvu-bridge.js';

const log = createModuleLog('character-roster');

const PAGE_SIZE = 10;
let currentPage = 0;
let mergingKey = null;   // the entry whose merge panel is open (one at a time)

// Every write the tab makes is a Roster-tab edit: written into the state the newest reply started from as well, and
// refused while a reply is being generated (character-registry.js).
const USER_EDIT = { isUserEdit: true };

// ── rendering ─────────────────────────────────────────────────────────────────
async function renderRoster() {
    const $list = $('#mvuh_img_roster_list');
    if (!$list.length) return;
    // No card open, no registry: say so rather than count an empty one.
    if (!openCardName()) {
        $('#mvuh_roster_count_pill').hide();
        $list.html(emptyState({ icon: 'fa-comment-slash', text: 'No chat open' }));
        $('#mvuh_img_roster_pager').empty();
        void applyHelperLocale();
        return;
    }
    const entries = await listCharEntries();   // never throws: a record of the wrong shape is warned in character-registry.js and read as far as it goes
    const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    if (currentPage >= pageCount) currentPage = pageCount - 1;

    $('#mvuh_roster_count').text(String(entries.length));
    $('#mvuh_roster_count_pill').show();
    $list.html(entries.length
        ? entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((entry) => rosterRow(entry, entries)).join('')
        : emptyState({ icon: 'fa-user-plus', text: 'No characters on file yet. Auto-harvest adds them as they appear in the story.' }));
    $('#mvuh_img_roster_pager').html(pageCount > 1
        ? pager({ page: currentPage, pageCount, previousData: { 'roster-action': 'page-previous' }, nextData: { 'roster-action': 'page-next' } })
        : '');
    void applyHelperLocale();   // the rows are new nodes — translate their keys
}

// One entry's row, then its editor or merge panel while that is open.
function rosterRow(entry, entries) {
    // [AllowUpdate] — may the story replace clothes already on file for this character? Absent reads as off. An
    // unreadable value also shows as off (the reader warns); the toggle then writes a clean value over it.
    const isUpdatable = allowsClothesUpdate(entry.content).allowed;
    // Aliases are on the row because they are otherwise invisible: why a spelling stopped creating new entries,
    // and a wrong one (two people merged by mistake), can only be found on screen.
    const aliases = listAliases(entry.content);
    const forKey = (action) => ({ 'roster-action': action, key: entry.key });
    // A character the card seeds and this chat changed can go back to the card's look.
    const seed = seedStatusOf(entry.key);
    const row = listRow({
        icon: 'fa-user',
        name: entry.key,
        sub: aliases.length ? { text: 'Also known as', name: aliases.join(' · ') } : null,
        pills: listOutfitVariants(entry.content).map((variant) => statusPill({ name: variant, status: 'accent' })),
        actions: [
            iconButton({ icon: isUpdatable ? 'fa-shirt' : 'fa-lock', title: 'Allow story clothes updates', isPressed: isUpdatable, data: forKey('allow-update') }),
            iconButton({ icon: 'fa-pen', title: 'Edit entry', data: forKey('edit') }),
            ...(seed.isChanged ? [iconButton({ icon: 'fa-clock-rotate-left', title: "Reset to the card's look", data: forKey('reset-to-card') })] : []),
            iconButton({ icon: 'fa-i-cursor', title: 'Rename entry', data: forKey('rename') }),
            iconButton({ icon: 'fa-code-merge', title: 'Merge into another entry', data: forKey('merge') }),
            iconButton({ icon: 'fa-rotate-right', title: 'Re-harvest: delete it so the story describes them again', isDanger: true, data: forKey('reharvest') }),
            iconButton({ icon: 'fa-trash', title: 'Delete entry', isDanger: true, data: forKey('delete') }),
        ],
    });
    if (mergingKey === entry.key) return row + mergePanel(entry, entries);
    return row;
}

// ── the editor dialog ──────────────────────────────────────────────────────────
// "Wearing now" as editor values, from her entry in the worn-outfit store (readWearingNow): { wearing, wearingClothes }.
function wearingValuesOf(held) {
    return {
        wearing: held ? held.outfit : '',
        wearingClothes: held && held.outfit === OUTFIT_NEW_CLOTHES ? held.clothes : '',
    };
}

const editorId = (part) => `mvuh_roster_editor_${part}`;
const EDITOR_ROWS = 3;

// The "Wearing now" field (D38, plans/reply-cast.md §11.2): nothing recorded, one of her outfits — the pairs the dialog
// holds (wearingNowChoices), kept in step while it is open — or one-off clothes, whose box shows only while that is
// picked.
function wearingNowOptions(choices, wearing) {
    return [
        selectOption({ value: '', text: 'Nothing recorded', isSelected: !wearing }),
        ...choices.map((name) => selectOption({ value: name, name, isSelected: wearing === name })),
        selectOption({ value: OUTFIT_NEW_CLOTHES, text: 'One-off clothes', isSelected: wearing === OUTFIT_NEW_CLOTHES }),
    ];
}

function wearingNowField(values, held) {
    const choices = wearingNowChoices(values.outfits.map((outfit) => outfit.name), held);
    return field([
        fieldLabel({ text: 'Wearing now', forId: editorId('wearing') }),
        select({ id: editorId('wearing'), title: 'Wearing now', options: wearingNowOptions(choices, String(values.wearing || '')) }),
        textarea({ id: editorId('wearing_clothes'), value: values.wearingClothes, rows: EDITOR_ROWS, title: 'One-off clothes' }),
        hint({ text: 'What their last picture shows, and what their next picture starts from.' }),
        hint({ text: 'Regenerate that picture to see a change.' }),
        ...(held && held.lastPictureMessage !== null ? [hint({ text: 'Their last picture is in message', chip: codeChip({ name: String(held.lastPictureMessage) }) })] : []),
    ]);
}

// Show the one-off box only while "One-off clothes" is picked, and offer the outfits the pairs above hold: a typed name
// refreshes the list here, and Add outfit and × call the refresh this returns.
function wireWearingNowField(form, held) {
    const picker = form.querySelector(`#${editorId('wearing')}`);
    const box = form.querySelector(`#${editorId('wearing_clothes')}`);
    if (!picker || !box) return () => {};
    const showBox = () => { box.style.display = picker.value === OUTFIT_NEW_CLOTHES ? '' : 'none'; };
    const refreshChoices = () => {
        const choices = wearingNowChoices([...form.querySelectorAll('[data-roster-outfit-name]')].map((nameInput) => nameInput.value), held);
        picker.innerHTML = wearingNowOptions(choices, wearingNowSelection(picker.value, choices, held)).join('');
        void applyHelperLocale(picker);   // new option nodes: translate their keys
        showBox();
    };
    picker.addEventListener('change', showBox);
    form.addEventListener('input', (event) => {
        if (event.target instanceof Element && event.target.matches('[data-roster-outfit-name]')) refreshChoices();
    });
    showBox();
    return refreshChoices;
}

// The (?) beside an outfit's name: how to name one. Its English text is its zh-cn key.
const OUTFIT_NAME_DETAIL = 'Write it as place-outfit: where it is worn, then what it is, such as school-uniform or beach-swimsuit. '
    + 'The story picks an outfit by this name, so the place tells it when the outfit fits. '
    + 'Letters, digits, - and _ only; default is drawn when no outfit is named.';

// One outfit's pair: its name with the × that takes the pair out of the dialog, then its clothes. `index` only keeps
// the ids apart; Save reads the pairs in the order they stand (readEditorForm).
function outfitPair(outfit, index) {
    return field([
        fieldLabel({ text: 'Outfit name', forId: editorId(`outfit_name_${index}`), hasHelp: true }),
        controlRow([
            input({ id: editorId(`outfit_name_${index}`), value: outfit.name, placeholder: 'school-uniform', data: { 'roster-outfit-name': 'true' } }),
            iconButton({ icon: 'fa-xmark', title: 'Remove outfit', isDanger: true, data: { 'roster-editor': 'remove-outfit' } }),
        ]),
        textarea({ id: editorId(`outfit_clothes_${index}`), value: outfit.clothes, rows: EDITOR_ROWS, title: 'Clothes' }),
        detail({ text: OUTFIT_NAME_DETAIL }),
    ]);
}

// Add outfit puts an empty pair above its button; × takes its own pair out; either way `onPairsChanged` runs ("Wearing
// now" follows). Nothing is written until Save, so Cancel leaves the record as it was.
function wireOutfitPairs(form, firstFreeIndex, onPairsChanged) {
    let nextIndex = firstFreeIndex;
    form.addEventListener('click', (event) => {
        const control = event.target instanceof Element ? event.target.closest('[data-roster-editor]') : null;
        const action = control ? control.dataset.rosterEditor : '';
        if (action === 'remove-outfit') {
            control.closest('.mvuh-field').remove();
            onPairsChanged();
        } else if (action === 'add-outfit') {
            const holder = document.createElement('div');
            holder.innerHTML = outfitPair({ name: '', clothes: '' }, nextIndex++);
            const pair = holder.firstElementChild;
            control.closest('.mvuh-control-row').before(pair);
            void applyHelperLocale(pair);   // a new node: translate its keys
            pair.querySelector('input').focus();
            onPairsChanged();
        }
    });
}

function editorForm(values, held, seededOutfits) {
    const form = document.createElement('div');
    form.innerHTML = stack([
        groupTitle({ icon: 'fa-shirt', text: 'Outfit' }),
        field([
            fieldLabel({ text: 'Body', forId: editorId('body') }),
            textarea({ id: editorId('body'), value: values.body, rows: EDITOR_ROWS }),
        ]),
        field([
            fieldLabel({ text: 'Bust', forId: editorId('bust') }),
            input({ id: editorId('bust'), value: values.bust, placeholder: '1.0' }),
            hint({ text: 'A number for the bust LoRA, such as 1.2. Blank uses the default.' }),
        ]),
        field([
            fieldLabel({ text: 'Aliases', forId: editorId('aliases') }),
            textarea({ id: editorId('aliases'), value: values.aliasesText, rows: EDITOR_ROWS }),
            hint({ text: 'One name per line: other spellings that mean this character.' }),
        ]),
        ...values.outfits.map((outfit, index) => outfitPair(outfit, index)),
        controlRow([button({ text: 'Add outfit', icon: 'fa-plus', data: { 'roster-editor': 'add-outfit' } })]),
        ...(seededOutfits.length
            ? [hint({ text: 'The card seeds these, so removed they come back on the next load or Re-import:', chip: codeChip({ name: seededOutfits.join(', ') }) })]
            : []),
        field([
            fieldLabel({ text: 'Allow story clothes updates' }),
            controlRow([switchInput({ title: 'Allow story clothes updates', isChecked: values.allowUpdate, data: { 'roster-editor': 'allow-update' } })]),
            hint({ text: 'On: a reply may replace clothes on file for this character.' }),
        ]),
        wearingNowField(values, held),
    ]);
    wireOutfitPairs(form, values.outfits.length, wireWearingNowField(form, held));
    return form;
}

function readEditorForm(form) {
    const valueOf = (part) => String((form.querySelector(`#${editorId(part)}`) || {}).value || '');
    // The pairs the dialog holds as Save is pressed, in their order: × and Add outfit change them while it is open.
    const outfits = [...form.querySelectorAll('[data-roster-outfit-name]')].map((nameInput) => ({
        name: String(nameInput.value || ''),
        clothes: String(nameInput.closest('.mvuh-field').querySelector('textarea').value || ''),
    }));
    const allowSwitch = form.querySelector('[data-roster-editor="allow-update"]');
    return {
        body: valueOf('body'), bust: valueOf('bust'), aliasesText: valueOf('aliases'), allowUpdate: Boolean(allowSwitch && allowSwitch.checked), outfits,
        wearing: valueOf('wearing'), wearingClothes: valueOf('wearing_clothes'),
    };
}

// Open the editor for `key`; Save writes the record as a Roster-tab edit, then "Wearing now" when it changed. A record
// or a "Wearing now" line with problems is not saved: the problems are named, and the dialog opens again with what was
// typed.
async function openEntryEditor(key) {
    const entry = (await listCharEntries()).find((e) => e.key === key);
    if (!entry) { log.warn(`"${key}" vanished before its editor opened — refreshing the list.`); await renderRoster(); return; }
    const current = recordFromContent(entry.content);
    const held = readWearingNow(key);
    let values = { ...editorFieldsFromRecord(current), ...wearingValuesOf(held) };
    const seededOutfits = seededOutfitsOf(key);
    for (;;) {
        const form = editorForm(values, held, seededOutfits);
        if (!await formPopup(form, { okButton: 'Save', isWide: true })) return;
        values = readEditorForm(form);
        const { record, problems } = recordFromEditorFields(values, current);
        const wear = wearingNowFromEditorFields({ wearing: values.wearing, oneOffClothes: values.wearingClothes }, Object.keys(record.clothes || {}), held);
        const allProblems = [...problems, ...wear.problems];
        if (!allProblems.length) {
            if (!await upsertCharDna(key, contentFromRecord(record), USER_EDIT)) {
                toast('error', `Could not save "${key}" — see console`);
            } else if (wear.isChanged) {
                const worn = await setWearingNow(key, wear.value);
                if (worn.ok) toast('success', `Saved "${key}"`);
                else toast('error', `Saved "${key}", but not what they wear now: ${worn.reason}`);
            } else {
                toast('success', `Saved "${key}"`);
            }
            await renderRoster();
            return;
        }
        await noticePopup([{ text: 'The entry was not saved:', name: key }, ...allProblems.map((problem) => ({ name: problem }))]);
    }
}

// The line a seeded character's Delete and Re-harvest add: the card's look comes back.
const SEEDED_RETURN_LINE = { text: "The card seeds this character: its look comes back from the card on the next load or Re-import." };

// A dropdown of the OTHER entries rather than a typed key: the target is an existing name, and typing a name in
// another script by hand is the very mistake Merge repairs. Built from the full list, so the target need not be
// on this page.
function mergePanel(entry, entries) {
    const targets = entries.filter((other) => other.key !== entry.key);
    return recordCard({
        icon: 'fa-code-merge',
        text: 'Merge into another entry',
        body: field([
            controlRow([
                select({ id: 'mvuh_roster_merge_target', title: 'Merge into another entry', options: targets.map((other) => selectOption({ value: other.key, name: other.key })) }),
                button({ text: 'Merge', icon: 'fa-code-merge', kind: 'danger', data: { 'roster-action': 'merge-confirm', key: entry.key } }),
                button({ text: 'Cancel', data: { 'roster-action': 'merge-cancel' } }),
            ]),
            hint({ text: 'Pick the entry this one duplicates. Its look is discarded; its name becomes an alias.' }),
        ]),
    });
}

// ── roster-owned settings on the tab ─────────────────────────────────────────
// How new members are registered (route) and where the roster lives in stat_data (charCollection, presenceField —
// read by roster-scan-core). Stored in profile.roster.* — see roster-settings.js.

// Repaint the inputs from the active profile (index.js calls this from updateUI()).
export function updateRosterUI() {
    const roster = getRosterProfile();
    $('#mvuh_img_route').val(roster.route);
    $('#mvuh_img_collection').val(roster.charCollection || '');
    $('#mvuh_img_present_field').val(roster.presenceField || '');
}

// ── wiring (delegated — the list re-renders) ──────────────────────────────────
export function wireRoster() {
    // Every row action, the editor's and the merge panel's buttons and the pager sit in the registry card, which needs
    // a card (the card gate): the actions are delegated from there.
    const $registry = $('#mvuh_roster_registry');
    const onAction = (action, handler) => $registry.on('click', `[data-roster-action="${action}"]`, handler);

    // How new characters enter the registry. Drawing reacts through notifyRouteChanged() (it re-points the
    // registration routing entry); roster-ui never imports imagegen to do that.
    $('#mvuh_img_route').on('change', function () {
        getRosterProfile().route = String($(this).val()) === 'harvest' ? 'harvest' : 'predefined';
        saveSettingsDebounced();
        notifyRouteChanged();
    });
    $('#mvuh_img_collection').on('input', function () {
        getRosterProfile().charCollection = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });
    $('#mvuh_img_present_field').on('input', function () {
        getRosterProfile().presenceField = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });

    onAction('page-previous', async () => { if (currentPage > 0) { currentPage--; await renderRoster(); } });
    onAction('page-next', async () => { currentPage++; await renderRoster(); });

    // Flip [AllowUpdate] on one entry. The setter REPLACES the value in place rather than appending, which is why
    // turning it off needs no section-removal helper — see setAllowUpdate.
    onAction('allow-update', async function () {
        const key = this.dataset.key;
        const entry = (await listCharEntries()).find((e) => e.key === key);
        if (!entry) { log.warn(`"${key}" vanished before its update switch could be set — refreshing the list.`); await renderRoster(); return; }
        const next = !allowsClothesUpdate(entry.content).allowed;
        const res = setAllowUpdate(entry.content, next);
        if (res.changed && !await upsertCharDna(key, res.content, USER_EDIT)) return;   // write failed (warned in character-registry.js)
        log.lifecycle(`"${key}" story clothes-updates ${next ? 'ALLOWED' : 'BLOCKED'}.`);
        await renderRoster();
    });

    onAction('edit', async function () {
        mergingKey = null;
        await openEntryEditor(this.dataset.key);
    });

    // Put a seeded character back to the card's record. It overwrites what this chat changed, so it asks first.
    onAction('reset-to-card', async function () {
        const key = this.dataset.key;
        if (!(await confirmPopup([
            { text: "Reset this character to the card's look?" },
            { name: key },
            { text: "What this chat changed in its look is replaced by the card's record." },
        ], { okButton: 'Reset', isDestructive: true }))) return;
        const res = await resetCharToSeed(key);
        if (res.ok) toast('success', `"${key}" is back to the card's look`);
        else toast('error', `Could not reset "${key}": ${res.reason}`);
        await renderRoster();
    });

    // ── RENAME — the look is right, the key is wrong ──────────────────────────
    // A key captured in the wrong script ("Amand" for a character the story calls 阿曼德·布劳尔) still has good
    // English body and clothes tags; deleting the entry would throw them away and make the story re-describe
    // the character from scratch.
    onAction('rename', async function () {
        const key = this.dataset.key;
        const next = await inputPopup([
            { text: 'Rename this entry.' },
            { name: key },
            { text: "Use the character's name exactly as the story writes it, in the story's own script." },
            { text: 'The look is kept, and the old name keeps finding this entry.' },
        ], { okButton: 'Rename', defaultValue: key });
        if (!next || next === key) return;        // '' = cancelled / failed to open — do nothing
        const res = await renameCharDna(key, next, USER_EDIT);
        if (res.ok) toast('success', `Renamed to "${next}" — "${key}" now resolves as an alias`);
        else toast('error', `Could not rename "${key}": ${res.reason}`);
        await renderRoster();
    });

    // ── MERGE — two entries, one character ────────────────────────────────────
    onAction('merge', async function () {
        const key = this.dataset.key;
        // Nothing to merge into. Say why rather than opening an empty dropdown.
        if ((await listCharEntries()).length < 2) {
            toast('info', 'Merge needs a second registered character to merge into.');
            return;
        }
        mergingKey = mergingKey === key ? null : key;
        await renderRoster();
    });
    onAction('merge-cancel', async () => { mergingKey = null; await renderRoster(); });
    onAction('merge-confirm', async function () {
        const key = this.dataset.key;
        const target = String($('#mvuh_roster_merge_target').val() || '').trim();
        if (!target) return;
        // Confirm names what is LOST — this entry's appearance text — not just what is clicked.
        if (!(await confirmPopup([
            { text: 'Merge these entries?' },
            { text: 'Kept:', name: target },
            { text: 'Merged in and deleted:', name: key },
            { text: 'The kept entry keeps its look; the other look is discarded.' },
            { text: 'The deleted name becomes an alias, so either spelling finds the same character.' },
        ], { okButton: 'Merge', isDestructive: true }))) return;
        const res = await mergeCharDna(key, target, USER_EDIT);
        if (res.ok) toast('success', `Merged "${key}" into "${target}"`);
        else toast('error', `Could not merge "${key}": ${res.reason}`);
        mergingKey = null;
        await renderRoster();
    });

    onAction('delete', async function () {
        const key = this.dataset.key;
        const lines = [{ text: 'Delete this entry and its look?' }, { name: key }];
        if (seedStatusOf(key).isSeeded) lines.push(SEEDED_RETURN_LINE);
        if (!(await confirmPopup(lines, { okButton: 'Delete', isDestructive: true }))) return;
        const ok = await deleteCharDna(key, USER_EDIT);
        if (ok) toast('success', `Deleted "${key}"`);
        else toast('error', `Could not delete "${key}" — see console`);
        await renderRoster();
    });

    onAction('reharvest', async function () {
        const key = this.dataset.key;
        const route = getRosterProfile().route;
        const next = seedStatusOf(key).isSeeded ? SEEDED_RETURN_LINE
            : route === 'harvest'
                ? { text: 'The story describes them again the next time they appear.' }
                : { text: 'Appearance route is Predefined only: switch it to auto-harvest, or they stay unregistered.' };
        if (!(await confirmPopup([
            { text: 'Re-harvest this character?' },
            { name: key },
            { text: 'Its entry is deleted.' },
            next,
        ], { okButton: 'Re-harvest', isDestructive: true }))) return;
        const ok = await deleteCharDna(key, USER_EDIT);
        if (ok) toast('success', `"${key}" cleared — will be re-captured on next appearance`);
        else toast('error', `Could not clear "${key}" — see console`);
        await renderRoster();
    });

    $('#mvuh_img_roster_refresh').on('click', async () => { await renderRoster(); });
}

// Re-render on card/chat switch (different primary lorebook + different profile).
export async function refreshRosterUI() {
    currentPage = 0;
    mergingKey = null;
    updateRosterUI();
    await renderRoster();
}
