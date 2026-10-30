// small-llm/extra-llm-calls-ui.js — the Extra LLM Calls tab: the master switches and timeout, one record card per
// call, one per shared group.
//
// All reads/writes go through getExtraLlmCallsProfile() (extra-llm-calls.js): Extra LLM Calls is PER CARD, so this tab
// always edits the active character's profile. index.js calls wireExtraLlmCalls() once to bind the (delegated) handlers, and
// refreshExtraLlmCallsUI() on CHAT_CHANGED so switching cards repaints the lists with that card's calls and groups. A
// connection profile added, removed or renamed in SillyTavern repaints the call list, whose Connection dropdowns list them.
//
// Records are built from the gene builders (features/settings-panel), which key every fixed word; each list paint
// re-applies the locale. A record carries data-call-id or data-group-id, its fields data-call-field or
// data-group-field, its buttons data-llm-action. A field edit changes the call in place and repaints nothing, so the
// field keeps its focus; what the edit changes elsewhere on the card — the header's name, phase and problem pills,
// the [name] chip — is rewritten where it stands (data-call-live, data-group-live).

import { getConnectionProfiles, onConnectionProfilesChanged } from '../../sillytavern/connection-profiles.js';
import { saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { confirmPopup, noticePopup, formPopup } from '../../sillytavern/popup.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { hasActiveCharacter } from '../../sillytavern/lorebook.js';
import { runLlmCall, callLogLabel, reportUnrunnableRoutedCalls, getExtraLlmCallsProfile } from './extra-llm-calls.js';
import { callRunBlocker, callPhase } from './extra-llm-calls-core.js';
import {
    iconButton, statusPill, recordCard, grid, stack, field, fieldLabel, hint, detail, codeChip, input, select, selectOption, switchInput,
    checkList, emptyState,
} from '../settings-panel/index.js';
// Every edit below that changes WHICH calls exist (or which are runnable targets) has to tell the
// LLM-task router, because a task's chosen target is stored by call NAME and its picker is painted
// from another tab's refresh. Without this the "Harvest via" dropdown misses a new call until F5,
// and a renamed/deleted/disabled target silently keeps routing to a call that does not answer.
import { refreshTaskTargets } from '../llm-task-router/index.js';
import { toast } from '../../sillytavern/mvu-bridge.js';

const log = createModuleLog('small-llm');

// ── new-call dialog ──────────────────────────────────────────────────────────
// "Add call" ASKS for the name and phase instead of appending a blank row.
//
// WHY: a blank row is a call that cannot work. Lorebook routing keys on `call.name` — it reads the
// `[<name>]`-prefixed entries — so an unnamed call is routed NOTHING, and enabledCalls never runs it.
// Nothing throws, so the only symptom is a call that quietly does nothing. Asking up front makes the
// one field that MUST be filled impossible to skip.
//
// Name rules enforced here, each for a concrete routing reason:
//   - non-empty          → an unnamed call routes nothing (above)
//   - no '[' or ']'      → routing wraps the name as `[name]`; a bracket inside would nest
//   - unique, case-insensitive → two calls answering the same `[tag]` both claim the same entries
async function askForNewCall(existingNames) {
    const taken = new Set((existingNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
    let name = '';
    let phase = 'pre';

    for (;;) {
        // Rebuilt each time round, prefilled with the last answer: a refused name comes back to be fixed, not retyped.
        const form = document.createElement('div');
        form.innerHTML = stack([
            field([
                fieldLabel({ text: 'Call name', forId: 'mvuh_new_call_name' }),
                input({ id: 'mvuh_new_call_name', value: name, placeholder: 'e.g. PRE2' }),
                hint({ text: 'The tag on the lorebook entries it reads, without the brackets.' }),
            ]),
            field([
                fieldLabel({ text: 'Phase', forId: 'mvuh_new_call_phase' }),
                select({
                    id: 'mvuh_new_call_phase',
                    options: [
                        selectOption({ value: 'pre', text: 'PRE (before reply)', isSelected: phase === 'pre' }),
                        selectOption({ value: 'post', text: 'POST (after reply)', isSelected: phase === 'post' }),
                    ],
                }),
            ]),
        ]);

        // Truthy only on Add; Cancel, or a dialog that cannot open, adds nothing at all.
        if (!await formPopup(form, { okButton: 'Add' })) return null;

        name = String(form.querySelector('#mvuh_new_call_name').value || '').trim();
        phase = form.querySelector('#mvuh_new_call_phase').value === 'post' ? 'post' : 'pre';

        let problem = null;
        if (!name) problem = [{ text: 'A call needs a name.' }, { text: 'An unnamed call is routed no lorebook entries and does nothing.' }];
        else if (/[[\]]/.test(name)) problem = [{ text: 'A call name cannot contain [ or ].' }, { text: 'Routing adds the brackets itself when it looks for the entries.' }];
        else if (taken.has(name.toLowerCase())) problem = [{ text: 'There is already a call with this name:', name }, { text: 'Two calls with one name would both claim the same lorebook entries.' }];
        if (!problem) return { name, phase };

        await noticePopup(problem);
    }
}

// ── rendering ─────────────────────────────────────────────────────────────────
const callTag = (name) => `[${String(name || '').trim() || 'name'}]`;
const groupTag = (tag) => `[${String(tag || '').trim() || 'tag'}]`;

// One call's record card. Its header says whether it runs — the switch, the phase, and a warning pill for what keeps
// it from running (callRunBlocker, the runtime's own rule); its body holds the fields.
function callRecord(call) {
    const fieldId = (fieldName) => `mvuh_call_${call.id}_${fieldName}`;
    const forField = (fieldName) => ({ 'call-field': fieldName });
    const blocker = callRunBlocker(call);
    const phase = callPhase(call);
    const connectionOptions = [selectOption({ value: '', text: '— none —', isSelected: !call.profileId })].concat(
        getConnectionProfiles().map((profile) => selectOption({ value: profile.id, name: profile.name || profile.id, isSelected: profile.id === call.profileId })));
    const overrideValue = (value) => (value == null ? '' : value);
    return recordCard({
        icon: 'fa-message',
        name: call.name || '',
        nameData: { 'call-live': 'name' },
        toggle: switchInput({ title: 'Enabled', isChecked: !!call.enabled, data: forField('enabled') }),
        pills: [
            statusPill({ name: phase.toUpperCase(), status: 'accent', data: { 'call-live': 'phase' } }),
            statusPill({ text: 'No name', status: 'warning', isHidden: blocker !== 'no-name', data: { 'call-live': 'no-name' } }),
            statusPill({ text: 'No connection', status: 'warning', isHidden: blocker !== 'no-connection', data: { 'call-live': 'no-connection' } }),
        ],
        actions: [
            iconButton({ icon: 'fa-play', title: 'Run this call now', data: { 'llm-action': 'call-test' } }),
            iconButton({ icon: 'fa-trash', title: 'Delete call', isDanger: true, data: { 'llm-action': 'call-delete' } }),
        ],
        body: grid([
            field([
                fieldLabel({ text: 'Name', forId: fieldId('name'), hasHelp: true }),
                input({ id: fieldId('name'), value: call.name || '', data: forField('name') }),
                hint({ text: 'Reads the lorebook entries tagged', chip: codeChip({ name: callTag(call.name), data: { 'call-live': 'tag' } }) }),
                detail({ text: "Any entry whose comment or keys hold the tag, enabled or not, sorted by its Order. Its groups' entries come first. A renamed call reads only entries with the new tag." }),
            ]),
            field([
                fieldLabel({ text: 'Phase', forId: fieldId('phase'), hasHelp: true }),
                select({
                    id: fieldId('phase'),
                    data: forField('phase'),
                    options: [
                        selectOption({ value: 'pre', text: 'PRE (before reply)', isSelected: phase === 'pre' }),
                        selectOption({ value: 'post', text: 'POST (after reply)', isSelected: phase === 'post' }),
                    ],
                }),
                hint({ text: 'When the call runs: before the reply (PRE) or after it (POST).' }),
                detail({ text: "PRE reads your last message, and its answer goes into the reply's prompt; a <JSONPatch> in it is checked and applied first. POST reads the reply." }),
            ]),
            field([
                fieldLabel({ text: 'Connection', forId: fieldId('profileId'), hasHelp: true }),
                select({ id: fieldId('profileId'), options: connectionOptions, isMissing: blocker === 'no-connection', data: forField('profileId') }),
                hint({ text: 'The connection profile this call runs on: its model and preset.' }),
                detail({ text: "Connection profiles stay on this machine; the card's config never carries them. For another model or preset, pick or make another profile in SillyTavern's Connection Manager." }),
            ]),
            field([
                grid([
                    field([
                        fieldLabel({ text: 'Max tokens', forId: fieldId('maxTokens') }),
                        input({ id: fieldId('maxTokens'), type: 'number', value: overrideValue(call.maxTokens), min: 0, placeholder: 'Preset', data: forField('maxTokens') }),
                    ]),
                    field([
                        fieldLabel({ text: 'Temperature', forId: fieldId('temperature') }),
                        input({ id: fieldId('temperature'), type: 'number', value: overrideValue(call.temperature), min: 0, step: 0.1, placeholder: 'Preset', data: forField('temperature') }),
                    ]),
                ], { isPair: true }),
                hint({ text: 'Blank: the preset decides. A value here applies to this call only.' }),
            ]),
            field([
                fieldLabel({ text: 'Input filter', forId: fieldId('inputRegex'), hasHelp: true }),
                input({ id: fieldId('inputRegex'), value: call.inputRegex || '', isCode: true, data: forField('inputRegex') }),
                hint({ text: 'A regex trimming what the call reads: group 1, or the whole match. Blank: all of it.' }),
                detail({ text: 'POST reads the reply with its patch blocks and status box already removed. A capture group sends just one tagged part.' }),
            ], { isSpan: true }),
            field([
                fieldLabel({ text: 'Output check', forId: fieldId('outputRegex'), hasHelp: true }),
                input({ id: fieldId('outputRegex'), value: call.outputRegex || '', isCode: true, data: forField('outputRegex') }),
                hint({ text: 'A regex every valid answer matches; any other answer is dropped. Blank: no check.' }),
                detail({ text: 'Only the prose is checked: <JSONPatch> and <UpdateVariable> blocks are split out first and always kept. A dropped answer raises a degraded-turn toast.' }),
            ], { isSpan: true }),
        ]),
        data: { 'call-id': call.id },
        isCollapsible: true,
    });
}

function renderCallList() {
    const $list = $('#mvuh_call_list');
    if (!$list.length) return;
    const calls = getExtraLlmCallsProfile().calls;
    $list.html(calls.length ? calls.map(callRecord).join('') : emptyState({ icon: 'fa-message', text: 'No calls yet.' }));
    void applyHelperLocale();   // the records are new nodes — translate their keys
}

// One shared group's record card. A group = { id, tag, members:[callName,…] }: its [tag] entries are read by every
// member call; an untagged group routes nothing, so its header says so.
function groupRecord(group, callNames) {
    const tag = String(group.tag || '');
    const members = Array.isArray(group.members) ? group.members : [];
    const tagId = `mvuh_group_${group.id}_tag`;
    return recordCard({
        icon: 'fa-layer-group',
        name: tag,
        nameData: { 'group-live': 'name' },
        pills: [statusPill({ text: 'No tag', status: 'warning', isHidden: !!tag.trim(), data: { 'group-live': 'no-tag' } })],
        actions: [iconButton({ icon: 'fa-trash', title: 'Delete group', isDanger: true, data: { 'llm-action': 'group-delete' } })],
        body: grid([
            field([
                fieldLabel({ text: 'Tag', forId: tagId }),
                input({ id: tagId, value: tag, data: { 'group-field': 'tag' } }),
                hint({ text: 'Members read the lorebook entries tagged', chip: codeChip({ name: groupTag(tag), data: { 'group-live': 'tag' } }) }),
            ]),
            field([
                fieldLabel({ text: 'Members' }),
                callNames.length
                    ? checkList({ items: callNames.map((name) => ({ name, isChecked: members.includes(name), data: { 'group-member': name } })) })
                    : hint({ text: 'No calls to pick yet.' }),
            ]),
        ]),
        data: { 'group-id': group.id },
        isCollapsible: true,
    });
}

function renderGroupList() {
    const $list = $('#mvuh_group_list');
    if (!$list.length) return;
    const elc = getExtraLlmCallsProfile();
    const groups = elc.groups;
    const callNames = elc.calls.map((call) => String(call.name || '').trim()).filter(Boolean);
    $list.html(groups.length
        ? groups.map((group) => groupRecord(group, callNames)).join('')
        : emptyState({ icon: 'fa-layer-group', text: 'No groups yet.' }));
    void applyHelperLocale();   // the records are new nodes — translate their keys
}

// The header pill follows the master switch. With no card open there is no card to describe, so neither shows, as on
// the other per-card pages.
function paintMasterPill(isOn) {
    const isCardOpen = hasActiveCharacter();
    $('#mvuh_llm_on_pill').toggle(isCardOpen && isOn);
    $('#mvuh_llm_off_pill').toggle(isCardOpen && !isOn);
}

// Reflect the active profile's Extra LLM Calls toggles. Dynamic lists are repainted by
// their own renderers (renderCallList/renderGroupList), NOT here — updateUI can fire
// on panel re-open, and re-rendering a list mid-edit would blow away input focus.
export function updateExtraLlmCallsUI() {
    if (!$('#mvuh_extra_llm_calls_enabled').length) return;
    const elc = getExtraLlmCallsProfile();
    $('#mvuh_extra_llm_calls_enabled').prop('checked', !!elc.enabled);
    paintMasterPill(!!elc.enabled);
    $('#mvuh_parallel').prop('checked', elc.parallel !== false);
    const sec = Number(elc.timeoutSec);
    $('#mvuh_timeout_sec').val(Number.isFinite(sec) && sec >= 5 ? sec : 60);
}

// Repaint the whole tab for the now-active card (toggles + both lists).
export function refreshExtraLlmCallsUI() {
    updateExtraLlmCallsUI();
    renderCallList();
    renderGroupList();
}

// After a field edit, bring the rest of the call's card up to date where it stands: no repaint, so the field being
// typed in keeps its focus.
function paintCallCard($record, call) {
    const blocker = callRunBlocker(call);
    $record.find('[data-call-live="name"]').text(call.name || '');
    $record.find('[data-call-live="tag"]').text(callTag(call.name));
    $record.find('[data-call-live="phase"]').text(callPhase(call).toUpperCase());
    $record.find('[data-call-live="no-name"]').toggle(blocker === 'no-name');
    $record.find('[data-call-live="no-connection"]').toggle(blocker === 'no-connection');
    $record.find('[data-call-field="profileId"]').toggleClass('is-missing', blocker === 'no-connection');
}

// Manual end-to-end test: run a call against the last user message
// (or a sample) and surface the result via toast + the `smallllm` log domain.
async function testCall(call) {
    if (!String(call.name || '').trim()) {
        toast('warning', 'Give the call a name first.');
        return;
    }
    if (!call.profileId) {
        toast('warning', 'Select a connection profile first.');
        return;
    }
    let sample = '';
    try {
        const chat = SillyTavern.getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && chat[i].is_user) { sample = chat[i].mes || ''; break; }
        }
    } catch (_e) { /* EXPECTED: no chat open yet → fall back to the sample input below */ }
    if (!sample) sample = 'Test input: the player looks around and asks what happens next.';

    toast('info', `Testing "${call.name}"…`);
    const testLog = log.child(callLogLabel(call)).child('TEST');
    try {
        const out = await runLlmCall(call, sample);
        testLog.domain('smallllm', 'test', 'output:', out);
        const preview = String(out).slice(0, 160);
        toast('success', `${preview}${String(out).length > 160 ? '…' : ''}`, `"${call.name}" OK`, { timeOut: 9000 });
    } catch (err) {
        testLog.error('the test call failed:', err);
        toast('error', `Test failed: ${err && err.message ? err.message : err}`);
    }
}

// A change to the calls or the master switch moves which calls run. The llm-task router re-applies its
// targets first (a task whose call no longer runs drops its routing entry), then the routing check reports
// what is still routed to a call that will not run.
function afterCallListChange() {
    void refreshTaskTargets()
        .then(() => reportUnrunnableRoutedCalls())
        .catch((e) => log.warn('re-applying llm-task routing or the routing check failed:', e));
}
// A group edit changes which calls read a group's entries; the router routes tasks to calls, never groups.
function afterGroupChange() {
    void reportUnrunnableRoutedCalls().catch((e) => log.warn('the routing check failed:', e));
}

// Bind the tab's events once (delegated, so records painted later are covered).
export function wireExtraLlmCalls() {
    $('#mvuh_extra_llm_calls_enabled').on('change', function () {
        const isOn = $(this).prop('checked');
        getExtraLlmCallsProfile().enabled = isOn;
        paintMasterPill(isOn);
        saveSettingsDebounced();
        // The master switch gates the router's target list (composition root): OFF ⇒ every PRE/POST
        // target vanishes and routed tasks clear their entries; ON ⇒ the persisted preferences
        // re-apply. Without this the picker keeps showing a target that can never fire.
        afterCallListChange();
    });
    $('#mvuh_parallel').on('change', function () {
        getExtraLlmCallsProfile().parallel = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mvuh_timeout_sec').on('change', function () {
        const v = parseInt($(this).val(), 10);
        const sec = Number.isFinite(v) ? Math.min(600, Math.max(5, v)) : 60;
        getExtraLlmCallsProfile().timeoutSec = sec;
        $(this).val(sec);                         // reflect the clamped value back
        saveSettingsDebounced();
    });
    // ── Groups (a [tag] block read by the calls checked into it) ──────────────
    const findGroup = (element) => {
        const id = $(element).closest('[data-group-id]').attr('data-group-id');
        return getExtraLlmCallsProfile().groups.find((group) => group.id === id);
    };
    $('#mvuh_add_group').on('click', function () {
        getExtraLlmCallsProfile().groups.push({ id: 'grp_' + Math.random().toString(36).slice(2, 9), tag: '', members: [] });
        saveSettingsDebounced();
        renderGroupList();
    });
    const $groupList = $('#mvuh_group_list');
    $groupList.on('input', '[data-group-field="tag"]', function () {
        const group = findGroup(this);
        if (!group) return;
        group.tag = $(this).val();
        const $record = $(this).closest('[data-group-id]');
        $record.find('[data-group-live="name"]').text(group.tag);
        $record.find('[data-group-live="tag"]').text(groupTag(group.tag));
        $record.find('[data-group-live="no-tag"]').toggle(!String(group.tag).trim());
        saveSettingsDebounced();
    });
    $groupList.on('change', '[data-group-member]', function () {
        const group = findGroup(this);
        if (!group) return;
        const memberName = $(this).attr('data-group-member');
        group.members = Array.isArray(group.members) ? group.members : [];
        if (this.checked) { if (!group.members.includes(memberName)) group.members.push(memberName); }
        else { group.members = group.members.filter((member) => member !== memberName); }
        saveSettingsDebounced();
        afterGroupChange();
    });
    // The tag field saves on every keystroke ('input' above); the routing check runs on the commit.
    $groupList.on('change', '[data-group-field="tag"]', afterGroupChange);
    $groupList.on('click', '[data-llm-action="group-delete"]', async function () {
        const id = $(this).closest('[data-group-id]').attr('data-group-id');
        const group = getExtraLlmCallsProfile().groups.find((x) => x.id === id);
        if (!group) return;
        // CONFIRM: the delete button sits in the group's header, so a mis-click is easy and an unconfirmed delete is silent.
        const members = group.members || [];
        if (!(await confirmPopup([
            { text: 'Delete this shared group?' },
            group.tag ? { name: group.tag } : { text: 'Untitled group' },
            members.length ? { text: 'Its entries stop reaching:', name: members.join(', ') } : { text: 'It has no member calls.' },
            { text: 'The lorebook entries themselves stay.' },
            { text: 'A group from the card comes back with Re-import from card on the Main tab.' },
        ], { okButton: 'Delete', isDestructive: true }))) return;
        // Re-find AFTER the await: the list can be re-rendered while the dialog is open, and
        // splicing a stale index would delete the WRONG group — silently, the very failure this
        // confirm exists to prevent.
        const groupsNow = getExtraLlmCallsProfile().groups;
        const j = groupsNow.findIndex((x) => x.id === id);
        if (j < 0) return;
        groupsNow.splice(j, 1);
        saveSettingsDebounced();
        renderGroupList();
        afterGroupChange();
    });

    $('#mvuh_add_call').on('click', async function () {
        const arr = getExtraLlmCallsProfile().calls;
        // Ask FIRST, append only on OK — see askForNewCall for why a blank row is a broken call.
        let answer = null;
        try {
            answer = await askForNewCall(arr.map((c) => c.name));
        } catch (e) {
            log.child('add-call').warn('name/phase dialog failed — no call added:', e);
            return;
        }
        if (!answer) return;   // cancelled
        arr.push({
            id: 'call_' + Math.random().toString(36).slice(2, 9),
            name: answer.name,
            profileId: '',
            phase: answer.phase,
            maxTokens: '',
            temperature: '',
            inputRegex: '',
            // Blank on purpose. Duplicating an existing call is the natural way to make a second one
            // and carries ITS output gate: PRE's `^\s*\{[\s\S]*\}\s*$` admits a bare JSON object only,
            // so a new call with any other output shape has its prose dropped. A new call starts ungated.
            outputRegex: '',
            enabled: true,
        });
        saveSettingsDebounced();
        renderCallList();
        renderGroupList();
        afterCallListChange();   // the new call is a routable target — offer it without an F5
    });

    // Stop ST's global hotkey/focus handlers from reacting to keys typed in our fields
    // (the classic "hard to type in an extension input" symptom).
    $('#mvuh_panel_llm').on('keydown keyup keypress', 'input[type="text"], input[type="number"], textarea', function (e) {
        e.stopPropagation();
    });

    const $callList = $('#mvuh_call_list');
    // Edit a field (mutate in place; no re-render to preserve focus).
    $callList.on('input change', '[data-call-field]', function (e) {
        const $record = $(this).closest('[data-call-id]');
        const id = $record.attr('data-call-id');
        const field = $(this).attr('data-call-field');
        const call = getExtraLlmCallsProfile().calls.find((c) => c.id === id);
        if (!call) return;
        call[field] = this.type === 'checkbox' ? this.checked : $(this).val();
        // The header's pills, name and the [name] chip describe fields any edit here can change.
        paintCallCard($record, call);
        // Refresh the group member checkboxes (labelled by call name) only on blur/commit,
        // not on every keystroke — re-rendering them live would churn the group inputs.
        if (field === 'name' && e.type === 'change') renderGroupList();
        saveSettingsDebounced();
        // The four fields that change the ROUTER's view of this call: `name` is what routing keys on,
        // `enabled` + `profileId` are both required by enabledCalls() for it to be a target at all
        // (a call added with no connection profile is not offered until one is picked), and `phase`
        // decides which done-signal captures its output.
        //
        // 'change' ONLY: this handler is bound to `input change`, so a select/checkbox fires it twice
        // and a text field once per keystroke. Routing rewrites a lorebook entry — it must run on the
        // commit, not on every character typed into the name box.
        if (e.type === 'change' && ['name', 'enabled', 'profileId', 'phase'].includes(field)) {
            afterCallListChange();
        }
    });
    $callList.on('click', '[data-llm-action="call-delete"]', async function () {
        const id = $(this).closest('[data-call-id]').attr('data-call-id');
        const call = getExtraLlmCallsProfile().calls.find((c) => c.id === id);
        if (!call) return;
        // CONFIRM: without it a mis-click deletes a configured call with no warning.
        // The recovery sentence is deliberately precise, because the obvious phrasing is WRONG in
        // both directions:
        //   • an ordinary chat load never restores it — a chat load imports only when the card's config
        //     changed since this profile imported it (card-config decideCardImport).
        //   • but a re-import DOES — the Main tab's button now, or the chat load after a card upgrade —
        //     so "re-add it by hand" is wrong for any call the card declares. It MERGES
        //     (mergeExtraLlmCallsSection): the card's calls come back, every other call keeps its
        //     connection, and a hand-added call stays — so a deleted hand-added call is the one thing it
        //     cannot restore.
        // Naming both ways back AND what they cannot restore is the only version true for every case.
        const lost = [
            ...(call.profileId ? [{ text: 'Lost: its connection.' }] : []),
            ...(call.inputRegex || call.outputRegex ? [{ text: 'Lost: its regex filters.' }] : []),
        ];
        if (!(await confirmPopup([
            { text: 'Delete this call?' },
            call.name ? { name: `${call.name} (${callPhase(call).toUpperCase()})` } : { text: 'Unnamed call' },
            ...lost,
            { text: 'Its lorebook entries stop reaching any model.' },
            { text: "A call from the card comes back when the card's config changes, or now with Re-import from card on the Main tab; your other calls keep their connections." },
            { text: 'A call you added yourself is gone for good.' },
        ], { okButton: 'Delete', isDestructive: true }))) return;
        // Re-find AFTER the await — the list can re-render while the dialog is open, and a stale
        // index would delete the WRONG call.
        const callsNow = getExtraLlmCallsProfile().calls;
        const j = callsNow.findIndex((c) => c.id === id);
        if (j < 0) return;
        callsNow.splice(j, 1);
        saveSettingsDebounced();
        renderCallList();
        renderGroupList();
        // A task routed to THIS call now points at nothing: the router clears that target and
        // removes its orphaned `[name]` data-carrier entry from the book.
        afterCallListChange();
    });
    $callList.on('click', '[data-llm-action="call-test"]', async function () {
        const id = $(this).closest('[data-call-id]').attr('data-call-id');
        const call = getExtraLlmCallsProfile().calls.find((c) => c.id === id);
        if (call) await testCall(call);
    });

    // Each call's Connection dropdown is painted from SillyTavern's profile list, so a profile made, deleted or renamed
    // over there repaints the call list here.
    onConnectionProfilesChanged(() => renderCallList());

    renderCallList();
    renderGroupList();
}
