// statusmenu-pack/statusmenu-pack-activation.js — the per-CARD half of the StatusMenu Pack lifecycle:
// install / upgrade / switch / uninstall, and the LED facts the tab renders.
//
// Every DECISION is pure and lives in statusmenu-pack-core.js; this file reads state, calls the
// decision, and performs the writes it dictates — the same split the pack and plugin lifecycles use,
// kept so the three stay comparable rather than merely similar.
//
// NOT HERE: the menu's write lane — the action dispatcher and its patch apply — is
// statusmenu-dispatcher.js; the engine's running half — Worker text source, layout↔exports
// cross-check, formatter batch — is statusmenu-engine-runtime.js.

import {
    upsertLorebookEntryFields,
    deleteLorebookEntriesByNeedle,
    flushLorebookWrites,
} from '../../sillytavern/lorebook.js';
import { readCardAccess } from '../../sillytavern/card-access.js';
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
import {
    REGEX_SCOPE_CHARACTER,
    isRegexApiAvailable,
    getRegexes,
    listRegexNames,
    persistedCharacterRegexNames,
    syncRegexes,
    deleteRegexesByName,
    refreshRegexUi,
} from '../../sillytavern/tavern-regex.js';
import { regexUninstallExactness } from '../../sillytavern/tavern-regex-core.js';
import { withChatReloadsCoalesced, requestChatReload } from '../../sillytavern/chat-reload.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    findEntryByNeedle, commentsMatchingNeedle,
    installedSweepNeedle, uninstallExactness, plannedEntriesChanged, registryRemovalOutcome,
    artifactIdentityRecord, slotFingerprint,
} from '../../shared/card-artifact-store.js';
import { judgePackFile, finishArtifactExport, readLibraryPack } from '../gamelogic-pack/index.js';
import {
    STATUSMENU_TYPE, MENU_PLACEHOLDER,
    menuRegistryComment, menuRegistryMatch, parseMenuRegistry, buildMenuRegistryContent,
    planMenuEntries, decideMenuActivation, deriveMenuLed, menuOwnedSlots, menuReloadReason,
    placeholderClaimants, shellInstallDisposition,
    buildMenuExportFile, liftMenuRegexRows, menuBodyComment,
} from './statusmenu-pack-core.js';
import { readMenuBodies, writeMenuBody, clearMenuBodies } from './statusmenu-body-store.js';
import { PLACEHOLDER_SHELL_REGEX } from '../../shared/placeholder-menu-shell.js';
import { withMarkerLastRow } from './statusmenu-pack-marker-last.js';
import { isMvuPresent } from '../mvu-bootstrap/index.js';
import { readMenuEngineCode, writeMenuEngineCode, clearMenuEngineCode } from './statusmenu-engine-store.js';
import { menuEngineTextToRead } from '../../shared/artifact-source-gates.js';
import { loadLogicEngine, readMenuEngineExportsInWorker } from '../logic-engine/index.js';
import { checkMenuFormatterCoverage, checkMenuActionCoverage } from './statusmenu-engine-runtime.js';

const log = createModuleLog('statusmenu-pack');

// ── card-state reads ─────────────────────────────────────────────────────────

// The card's menu registry, or an empty one when absent. A MALFORMED registry is reported and
// returned as { error } so every caller stands down — read as "no menu installed" it would make the
// next uninstall sweep destructive off a typo.
export function readMenuRegistryFrom(entries) {
    const entry = findEntryByNeedle(entries, menuRegistryMatch());
    if (!entry) return { registry: null, error: '' };
    try { return { registry: parseMenuRegistry(entry.content), error: '' }; }
    catch (e) {
        log.error('the ' + menuRegistryComment() + ' entry is malformed — menu operations stand down:', e);
        return { registry: null, error: 'the ' + menuRegistryComment() + ' entry is malformed (see console) — fix or delete it first' };
    }
}

export async function readCardMenuState() {
    const { entries, isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName } = await readCardAccess();
    const { registry, error } = entries === null ? { registry: null, error: '' } : readMenuRegistryFrom(entries);
    // READ THE CARD, NOT THE COPY OF IT (the pack lane's readCardPackState says why): the persisted
    // read is preferred, the in-memory list is the fallback, and an unreadable surface stays null so
    // the LED skips the regex half rather than reporting every name missing. With no card open (the lobby) there is
    // no card to read, and nothing is read.
    const regexApiUp = isRegexApiAvailable();
    const canReadRegexes = regexApiUp && isCardOpen;
    const persisted = canReadRegexes ? await persistedCharacterRegexNames() : null;
    const cardRegexNames = persisted !== null ? persisted : (canReadRegexes ? await listRegexNames(REGEX_SCOPE_CHARACTER) : null);
    return {
        isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName, entries,
        registry, registryError: error, regexApiUp, cardRegexNames,
    };
}

// ── the bare-card shell ──────────────────────────────────────────────────────

// Make sure the card HAS a menu body. The shell is the regex that turns MVU's appended
// placeholder into the menu; a card without one enabled claimant renders NOTHING however many packs
// are installed, and nothing else on the card says why.
//
// What lands here is the STAND-IN (shared/placeholder-menu-shell.js), never a real menu: a working
// shell is MVU Status Menu Builder's artifact, composed from its own stylesheet and the project's
// theme, and mvu-helper does not carry or compose other repos' build output. So this arm answers the
// only question it can answer alone — "this card can render nothing at all" — with a notice that says
// so and names the builder. A pack that ships a real StatusMenu.json is already a claimant and
// reaches 'present' instead, and because both use the same script_name a real export REPLACES the
// stand-in rather than colliding with it.
//
// PROMPT EMISSION is not this function's to ensure and it deliberately does not try: the placeholder
// arrives because MVU appends it to every reply, and MVU's presence is the bootstrap's standing job
// (ensureGlobalMvuImport). The check below only NAMES the gap when both halves are missing at
// once — a shell just installed onto a card where MVU is absent replaces nothing, invisibly.
//
// Returns { installed, action, reasons } and never throws; a conflict is a WARN, not a failure —
// the card's owner may have parked their own claimant there on purpose, and overwriting or shadowing
// it leaves first-in-list silently deciding which menu renders (shellInstallDisposition's header).
export async function ensureMenuShell() {
    if (!isRegexApiAvailable()) {
        return { installed: false, action: 'regex-api-down', reasons: ['the TavernHelper regex API is not attached yet — cannot read or write the card\'s menu shell'] };
    }
    const claimants = placeholderClaimants(await getRegexes(REGEX_SCOPE_CHARACTER));
    const verdict = shellInstallDisposition({ claimants, shellName: PLACEHOLDER_SHELL_REGEX.script_name });
    if (verdict.action === 'conflict') {
        log.warn('shell NOT installed — ' + verdict.reasons[0]);
        return { installed: false, action: 'conflict', reasons: verdict.reasons };
    }
    // A menu that owns the placeholder is the ORDINARY outcome for a pack that ships its own
    // shell — lifecycle, not warn: a warning on every correct install teaches the reader to skip them.
    if (verdict.action === 'owned') {
        log.lifecycle('' + verdict.reasons[0]);
        return { installed: false, action: 'owned', reasons: verdict.reasons };
    }
    if (verdict.action === 'present') return { installed: false, action: 'present', reasons: [] };

    // The shell is a menu too, so it needs the same last-place guarantee the real one gets.
    const shellRows = withMarkerLastRow([PLACEHOLDER_SHELL_REGEX], [PLACEHOLDER_SHELL_REGEX.script_name]);
    const res = await syncRegexes(REGEX_SCOPE_CHARACTER, shellRows.regexes, [], { declaredOrder: shellRows.declaredOrder });
    if (!res) return { installed: false, action: 'write-failed', reasons: ['the shell regex could not be written'] };
    log.lifecycle('PLACEHOLDER shell installed — "' + PLACEHOLDER_SHELL_REGEX.script_name
        + '" now owns ' + MENU_PLACEHOLDER + ' on this card');
    // The one moment the emission half is worth naming: a fresh shell on a card with no live MVU
    // import replaces nothing — the placeholder never arrives. The bootstrap owns fixing it; this
    // line owns saying it.
    try {
        const mvu = await isMvuPresent();
        if (!mvu.present) {
            log.warn('the shell is installed but NO enabled MVU import exists — nothing appends '
                + MENU_PLACEHOLDER + ' to replies, so the menu will not appear'
                + (mvu.disabledFound ? ' (an MVU import exists but is switched off — turn it on in TavernHelper\'s script list)'
                    : ' (install it with the "Install MVU" button in MVU Helper\'s Main tab)'));
        }
    } catch (e) {
        log.warn('could not check MVU presence after the shell install:', e);
    }
    return { installed: true, action: 'installed', reasons: [] };
}

// ── install / upgrade / switch ───────────────────────────────────────────────

// Install a library StatusMenu Pack onto the current card. Returns { ok, action, reasons }.
// `sections` (the dev loop's per-sink apply): null = write everything — every non-dev caller. A
// list of workspace section names writes only those blocks ('layout' is this pack's entry block;
// 'engine'; 'regex'); the registry still writes, inheriting the untouched sections' record. Same
// write path masked, never a second one.
export async function activateMenu(id, { confirmDowngrade = false, confirmSwitch = false, sections = null } = {}) {
    const doSection = (name) => !sections || (Array.isArray(sections) ? sections.includes(name) : sections.has(name));
    const text = await readLibraryPack(STATUSMENU_TYPE, id);
    if (text === null) return { ok: false, action: 'refused', reasons: ['"' + id + '" is not in the library (or the library book is not readable)'] };

    // Judged AGAIN — the library entry is hand-editable, so trusting the import-time judgement would let
    // an edit skip every rule.
    const file = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
    if (!file.ok) return { ok: false, action: 'invalid', reasons: file.errors };
    const pack = file.pack;

    // The LIFT decision, before any write: the rows the card gets, and the document that leaves them.
    // A pack whose rows cannot all be made TavernHelper-inert is refused WHOLE, here, while nothing
    // has been touched (devdoc/security-hardening.md §3): a warned pass-through would be the bypass the
    // containment exists to close.
    const lift = liftMenuRegexRows(pack.regex, pack.id);
    if (!lift.ok) {
        log.warn('"' + id + '" NOT installed — ' + lift.reason);
        return { ok: false, action: 'refused', reasons: [lift.reason] };
    }

    const state = await readCardMenuState();
    if (state.registryError) return { ok: false, action: 'registry-malformed', reasons: [state.registryError] };

    const decision = decideMenuActivation({
        isCardOpen: state.isCardOpen, isChatStarted: state.isChatStarted,
        areEntriesReadable: state.areEntriesReadable, bookBinding: state.bookBinding, bookName: state.bookName,
        pack, registry: state.registry, regexApiUp: state.regexApiUp,
    });
    const action = decision.action;
    if (action === 'no-chat' || action === 'card-unreadable' || action === 'invalid' || action === 'regex-api-down') {
        return { ok: false, action, reasons: decision.reasons };
    }
    if (action === 'downgrade' && !confirmDowngrade) {
        return { ok: false, action, reasons: decision.reasons, installedVersion: decision.installedVersion, libraryVersion: decision.libraryVersion };
    }
    if (action === 'switch' && !confirmSwitch) return { ok: false, action, reasons: decision.reasons, activeMenuId: decision.activeMenuId };

    const summary = [];

    // Planned BEFORE the sweep, and compared against the card as it stands NOW: an upgrade deletes the
    // previous entries and writes fresh, so after the sweep every write is a create and no later
    // comparison could tell an identical re-apply from a real edit. This is the only moment the old
    // content still exists to compare against. (`plan.entries` is pure — planning early has no effect.)
    const plan = planMenuEntries(pack);
    const layoutChanged = doSection('layout') && plannedEntriesChanged(
        state.entries, plan.entries, (state.registry && state.registry.installedComments) || []);

    // An upgrade/switch/reinstall REPLACES: delete exactly what was recorded, plus the same
    // needle sweep uninstall runs. On a SWITCH the old menu's id differs from the incoming one, so the
    // sweep uses the REGISTRY's id — sweeping the new id would miss every old entry.
    const previous = state.registry;
    if (previous && doSection('layout')) {
        let removed = 0;
        for (const comment of previous.installedComments.map((c) => c.toLowerCase())) {
            removed += await deleteLorebookEntriesByNeedle(comment);
        }
        const strays = await deleteLorebookEntriesByNeedle(installedSweepNeedle(STATUSMENU_TYPE, previous.activeMenuId));
        if (strays) {
            log.warn('' + action + ' swept ' + strays + ' entr' + (strays === 1 ? 'y' : 'ies')
                + ' carrying the previous menu\'s prefix that its registry never recorded — a hand-edited comment, or a'
                + ' crashed earlier install. Replaced, not kept.');
        }
        removed += strays;
        if (removed) summary.push('replaced ' + removed + ' prior entr' + (removed === 1 ? 'y' : 'ies'));
    }

    if (doSection('layout')) {
        for (const entry of plan.entries) {
            const wrote = await upsertLorebookEntryFields(String(entry.comment).toLowerCase(), entry);
            if (!wrote) {
                return { ok: false, action, reasons: ['entry "' + entry.comment + '" could not be written — the card book is'
                    + ' unavailable; the menu is PARTIALLY installed (re-install to repair)'] };
            }
        }
        summary.push(plan.entries.length + ' entr' + (plan.entries.length === 1 ? 'y' : 'ies'));
    }

    // The engine half: the file's text into [MVU_StatusMenuEngine], ownership and the fingerprint of the text recorded. A
    // version that ships NONE removes an owned one — leaving it would run code from a version that no
    // longer exists — and never touches an entry the user uploaded themselves (engineOwned false).
    let engineOwned = Boolean(previous && previous.engineOwned);   // inherited unless this apply decides otherwise
    let engineFingerprint = previous ? previous.engineFingerprint : '';   // likewise
    let engineChanged = false;        // this apply wrote (or cleared) engine text → reboot the Worker
    let engineTextChanged = false;    // and the text actually differs → the rendered menu is stale
    if (!doSection('engine')) {
        // masked out (dev per-sink apply) — the hosted text, its ownership and its fingerprint stand as they are
    } else if (typeof pack.engine === 'string' && pack.engine.trim()) {
        engineOwned = false;   // decided fresh by this write
        const wrote = await writeMenuEngineCode(pack.engine);
        if (!wrote) return { ok: false, action, reasons: ['the ' + '[MVU_StatusMenuEngine]' + ' entry could not be written — the menu is PARTIALLY installed (re-install to repair)'] };
        engineOwned = true;
        engineFingerprint = slotFingerprint(pack.engine);
        engineChanged = true;
        // ▲ TWO DIFFERENT QUESTIONS. `engineChanged` means "this apply wrote engine text" and drives the
        // Worker reboot, which byte-compares for itself. Whether the TEXT MOVED is what the rendered
        // frames care about, and only the upsert can say — a re-apply of identical code must not reload.
        engineTextChanged = Boolean(wrote.changed);
        summary.push('engine text hosted into the shared Worker');
    } else if (previous && previous.engineOwned) {
        const cleared = await clearMenuEngineCode();
        if (cleared) { engineOwned = false; engineFingerprint = ''; summary.push('owned engine entry removed (this version ships none)'); engineChanged = true; engineTextChanged = true; }
    } else {
        engineOwned = false;   // ships none, owned none — nothing to inherit
        engineFingerprint = '';
    }

    // The DOCUMENT half: every lifted row's text into its [MVU_StatusMenuBody:<row>] entry, the
    // set recorded in the registry like the engine's ownership. It rides with the regex section it was
    // lifted from, so a per-sink apply that masks 'regex' leaves both alone. The previous set is
    // cleared first when it differs: a version that stops shipping a document takes its entry away in
    // the same apply as its marker row, and a stale document left behind would be mounted by the next
    // marker row to land before its own body does.
    let liftedRows = previous ? previous.liftedRows : [];
    let bodyChanged = false;        // a text MOVED → every mounted frame holds the old document
    if (!doSection('regex')) {
        // masked out (dev per-sink apply) — the hosted documents and their record stand as they are
    } else {
        const incoming = lift.lifted.map((l) => l.name);
        const previousRows = previous ? previous.liftedRows : [];
        if (previousRows.length && previousRows.some((n) => !incoming.includes(n))) {
            const cleared = await clearMenuBodies();
            if (cleared) { bodyChanged = true; summary.push(cleared + ' lifted document(s) of the previous version removed'); }
        }
        for (const { name, text } of lift.lifted) {
            const wrote = await writeMenuBody(name, text);
            if (!wrote) return { ok: false, action, reasons: ['the ' + menuBodyComment(name) + ' entry could not be written — the menu is PARTIALLY installed (re-install to repair)'] };
            if (wrote.changed) bodyChanged = true;
        }
        liftedRows = incoming;
        if (incoming.length) {
            summary.push(incoming.length + ' document(s) lifted out of TavernHelper\'s reach into ' + incoming.map(menuBodyComment).join(', ') + (bodyChanged ? '' : ' (unchanged)'));
        }
    }

    // The regex half — the same shipped lane the game pack uses, with the same stale-name
    // replacement on upgrade and the same removal when a version stops shipping any. What is written
    // is the LIFTED rows: the menu row in marker form, every other row as shipped — and the
    // re-apply comparison is against these, so an unchanged pack stays byte-stable on the card.
    let installedRegexNames = previous ? previous.installedRegexNames : [];
    let regexesChanged = false;
    if (Array.isArray(pack.regex) && pack.regex.length && doSection('regex')) {
        // The marker-last row rides WITH the pack, not beside it: it must be in the same write to be ordered
        // ahead of the menu regex, and in installedRegexNames so an uninstall takes it away again.
        const shipped = withMarkerLastRow(lift.rows, pack.regexOrder);
        const res = await syncRegexes(REGEX_SCOPE_CHARACTER, shipped.regexes, installedRegexNames, { declaredOrder: shipped.declaredOrder });
        if (!res) return { ok: false, action, reasons: ['the menu\'s regexes could not be written — the menu is PARTIALLY installed (re-install to repair)'] };
        installedRegexNames = shipped.regexes.map((r) => String((r && r.script_name) || '')).filter(Boolean);
        // Changed means the CARD changed — a re-apply that finds both regexes already there byte for byte
        // writes nothing and must not pay the chat reload either.
        regexesChanged = Boolean(res.created || res.updated || res.removed || res.reordered);
        summary.push(installedRegexNames.length + ' regex' + (installedRegexNames.length === 1 ? '' : 'es')
            + (regexesChanged ? (res.removed ? ' (' + res.removed + ' stale removed)' : '') : ' (unchanged)'));
    } else if (installedRegexNames.length && doSection('regex')) {
        const removed = await deleteRegexesByName(REGEX_SCOPE_CHARACTER, installedRegexNames);
        if (removed) summary.push(removed + ' regex(es) removed (this version ships none)');
        regexesChanged = Boolean(removed);
        installedRegexNames = [];
    }

    // The bare-card shell, after this menu's own regexes are on the card: if NO enabled claimant
    // answers the placeholder (this pack shipped no shell, and the card has none), install the
    // stand-in and record the ownership so uninstall returns the card to bare. Runs on the
    // full-activation path only — a dev-loop section mask that skipped 'regex' must not suddenly write
    // a shell either.
    let shellOwned = previous ? previous.shellOwned === true : false;
    if (doSection('regex')) {
        const shell = await ensureMenuShell();
        if (shell.installed) { shellOwned = true; regexesChanged = true; summary.push('placeholder shell installed — this pack ships no menu; build one with MVU Status Menu Builder'); }
        else if (shell.action === 'conflict') summary.push('shell NOT installed — see the warning');
        else if (shell.action === 'owned') summary.push('this pack ships its own menu shell');
    }

    // Registry LAST among the book writes, so a crash mid-install leaves a sweep-recoverable card
    // rather than a registry claiming pieces that were never written.
    const registry = {
        activeMenuId: pack.id,
        ver: String(pack.version || '0'),
        installedComments: doSection('layout') ? plan.installedComments
            : (previous && Array.isArray(previous.installedComments) ? previous.installedComments : plan.installedComments),
        engineOwned,
        engineFingerprint,
        installedRegexNames,
        shellOwned,
        liftedRows,
        // Identity beside ownership: name, description, format, and builtWith/targetsPackId when the
        // pack declares them.
        ...artifactIdentityRecord(pack),
        ...(Array.isArray(pack.regexOrder) ? { regexOrder: pack.regexOrder.map(String) } : {}),
        installedAt: new Date().toISOString().slice(0, 10),
    };
    const wroteReg = await upsertLorebookEntryFields(menuRegistryMatch(), {
        comment: menuRegistryComment(),
        content: buildMenuRegistryContent(registry),
        enabled: false, type: 'constant', keys: [],
    });
    if (!wroteReg) return { ok: false, action, reasons: ['the registry entry could not be written — the menu is PARTIALLY installed (re-install to repair)'] };

    await flushLorebookWrites();          // this operation spans the card book and the library

    // The Worker text set changed — reboot so its scope answers for the NEW engine (swapping
    // any text restarts the Worker and reloads all). Install runs from a GUI click, so no generation
    // is in flight; `force` because the game text may be byte-identical while the menu text is not.
    if (engineChanged) await loadLogicEngine({ force: true });
    // The engine cross-check on every activation: a layout naming exports the engine lacks warns ONCE,
    // enumerated — whether the mismatch came from this file or from a dev upload it replaced. BOTH
    // halves: formatters are what the menu SHOWS, actions what its buttons POST, and a pack can
    // arrive short of either. A view-only menu declares no actions and hears nothing.
    await checkMenuFormatterCoverage();
    await checkMenuActionCoverage();

    // The regex list and the rendered messages refresh LAST, once the menu is completely in place:
    // this emits CHAT_CHANGED, and the passes it re-runs must see the finished state. ONE reload for the
    // whole activation — layout, engine and regexes are one operation — and this scope NESTS inside the
    // dev loop's, so a workspace apply still reloads once for all its artifacts together. A layout or
    // engine change needs it for the same reason a regex does: nothing already rendered ever updates
    // itself (chat-reload-core.js says why).
    await withChatReloadsCoalesced(async () => {
        if (regexesChanged) await refreshRegexUi();
        const reason = menuReloadReason({ layoutChanged, engineChanged: engineTextChanged, regexesChanged: false, bodyChanged });
        if (reason) await requestChatReload('[statusmenu-pack] "' + pack.id + '" — ' + reason);
    });

    log.lifecycle('' + action + ' "' + pack.id + '" v' + (pack.version || '?') + ' — ' + summary.join(' · '));
    return { ok: true, action, reasons: [] };
}

// ── uninstall ────────────────────────────────────────────────────────────────

// Remove the active menu. Removes ONLY what the install added — the prefixed entries, the owned
// [MVU_StatusMenuEngine] entry, the recorded regexes, and the registry. It never touches `stat_data`
// (a menu has no state of its own), and anything else in the card's book is the user's.
// Returns { ok, removedEntries, exactness, reasons }.
export async function uninstallActiveMenu() {
    const state = await readCardMenuState();
    const access = cardAccessProblem(state);
    if (access === 'card-unreadable') return { ok: false, reasons: [cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName, suffix: '(Removing what cannot be listed is how residue is left behind.)' })] };
    if (access) return { ok: false, reasons: ['open a chat first — uninstall edits that card\'s worldbook'] };
    if (state.registryError) return { ok: false, reasons: [state.registryError] };
    if (!state.registry) return { ok: false, reasons: ['no StatusMenu Pack is active on this card'] };
    const reg = state.registry;

    // Refuse the whole uninstall rather than leave owned regexes behind while reporting a clean
    // removal — they would keep replacing the menu placeholder on every reply with nothing on the
    // card explaining why (the pack lane's rule, same reasoning).
    if (reg.installedRegexNames.length && !isRegexApiAvailable()) {
        return { ok: false, reasons: ['this menu owns ' + reg.installedRegexNames.length + ' regex(es), and the TavernHelper regex API is not attached yet — retry in a moment so the uninstall can be exact'] };
    }

    // Exactness — the record vs the book, compared BEFORE deleting so both sides can be named.
    const sweep = installedSweepNeedle(STATUSMENU_TYPE, reg.activeMenuId);
    const swept = commentsMatchingNeedle(state.entries, sweep);
    const exactness = uninstallExactness(reg.installedComments, swept);
    if (!exactness.agree) {
        log.warn('uninstall count mismatch: recorded-but-missing: ['
            + exactness.onlyInRecord.join(', ') + '] · found-but-unrecorded: [' + exactness.onlyInSweep.join(', ') + ']'
            + ' — deleting the union; nothing is silently kept');
    }

    const removedEntries = await deleteLorebookEntriesByNeedle(sweep);

    let clearedEngine = 0;
    if (reg.engineOwned) clearedEngine = await clearMenuEngineCode();
    if (clearedEngine) await loadLogicEngine({ force: true });   // the text set shrank — reboot without it

    // The lifted documents go with the marker rows they were lifted from — only when RECORDED.
    let clearedBody = 0;
    if (reg.liftedRows.length) clearedBody = await clearMenuBodies();

    // Remove ONLY the recorded names — the record is the whole handle on this surface, and its
    // exactness is reported the same way the entry sweep's is.
    let removedRegexes = 0;
    let regexesChanged = false;
    if (reg.installedRegexNames.length) {
        const regexExactness = regexUninstallExactness(reg.installedRegexNames, state.cardRegexNames || []);
        if (!regexExactness.agree) {
            log.warn('regex uninstall: recorded-but-missing: [' + regexExactness.onlyInRecord.join(', ') + ']'
                + ' — already gone (deleted by hand, or a failed earlier write). Removing the rest.');
        }
        removedRegexes = await deleteRegexesByName(REGEX_SCOPE_CHARACTER, reg.installedRegexNames);
        regexesChanged = Boolean(removedRegexes);
    }

    // The shell this install wrote goes with it, returning the card to bare. Only when OWNED:
    // a shell that predated the menu (the dev lane's pack-shipped copy, or a card that arrived with
    // one) is never deleted as if it were ours — the same flag discipline engineOwned uses.
    if (reg.shellOwned) {
        const shellGone = await deleteRegexesByName(REGEX_SCOPE_CHARACTER, [PLACEHOLDER_SHELL_REGEX.script_name]);
        if (shellGone) { regexesChanged = true; removedRegexes += shellGone; }
    }

    // Second delete, outside the sweep — its result is checked, because a registry that survives its
    // own menu leaves the tab reading this card as having a broken install, and must be reported.
    // Presence is read BEFORE the delete so "nothing to remove" never warns.
    const registryNeedle = menuRegistryMatch();
    const registryWasPresent = commentsMatchingNeedle(state.entries, registryNeedle).length > 0;
    const registryOutcome = registryRemovalOutcome({
        wasPresent: registryWasPresent,
        removedCount: await deleteLorebookEntriesByNeedle(registryNeedle),
    });
    if (registryOutcome === 'failed') {
        log.warn('the menu registry entry could NOT be removed — it is still on this card,'
            + ' naming "' + reg.activeMenuId + '" whose entries have just been deleted. Remove "' + menuRegistryComment()
            + '" by hand, or retry the uninstall once the lorebook API is back.');
    }
    await flushLorebookWrites();
    // ONE reload, same as an install: the removed entries are the layout every rendered frame is still
    // showing, so an uninstall that skipped this leaves a live menu for a pack that no longer exists.
    await withChatReloadsCoalesced(async () => {
        if (regexesChanged) await refreshRegexUi();
        const reason = menuReloadReason({ layoutChanged: removedEntries > 0, engineChanged: clearedEngine, regexesChanged: false, bodyChanged: clearedBody > 0 });
        if (reason) await requestChatReload('[statusmenu-pack] "' + reg.activeMenuId + '" uninstalled — ' + reason);
    });

    log.lifecycle('uninstalled "' + reg.activeMenuId + '" — ' + removedEntries + ' entr'
        + (removedEntries === 1 ? 'y' : 'ies') + (clearedEngine ? ' · owned engine entry removed' : '')
        + (clearedBody ? ' · owned menu document removed' : '')
        + (removedRegexes ? ' · ' + removedRegexes + ' regex(es) removed' : '')
        + (registryOutcome === 'removed' ? ' · registry removed'
            : registryOutcome === 'failed' ? ' · REGISTRY NOT REMOVED (warned above)' : ''));
    return { ok: true, removedEntries, exactness, reasons: [] };
}

// ── LED facts ────────────────────────────────────────────────────────────────

// Everything the tab's LED needs, in one read. `inLibrary` is a live look — the amber state is
// precisely "installed and intact, but the library copy is gone".
export async function readMenuLed() {
    const state = await readCardMenuState();
    if (!state.registry) return { state: 'grey', missing: [], missingRegexes: [], registry: null };
    const reg = state.registry;
    const inLibrary = (await readLibraryPack(STATUSMENU_TYPE, reg.activeMenuId)) !== null;
    const engine = await readMenuEngineCode();
    const bodies = await readMenuBodies();
    const led = deriveMenuLed({
        inLibrary,
        isActive: true,
        recordedComments: reg.installedComments,
        presentComments: commentsMatchingNeedle(state.entries, installedSweepNeedle(STATUSMENU_TYPE, reg.activeMenuId)),
        recordedRegexNames: reg.installedRegexNames,
        presentRegexNames: state.cardRegexNames || [],
        regexReadable: state.cardRegexNames !== null,
        ownedSlots: menuOwnedSlots(reg, engine),
        liftedRows: reg.liftedRows,
        presentBodyRows: bodies ? Object.keys(bodies) : [],
    });
    return { ...led, registry: reg };
}

// ── release export — the active menu back off the card, as a file ────────────

// Same contract as the pack lane's exportActivePack: registry list only, card bytes only, API
// guards inherited from uninstall, re-validated and re-gated before the file is offered.
export async function exportActiveMenu() {
    const state = await readCardMenuState();
    if (state.registryError) return { ok: false, errors: [state.registryError] };
    const reg = state.registry;
    if (!reg) return { ok: false, errors: ['no StatusMenu Pack is active on this card — nothing to export'] };
    const wantsRegexes = Array.isArray(reg.installedRegexNames) && reg.installedRegexNames.length > 0;
    if (wantsRegexes && !state.regexApiUp) {
        return { ok: false, errors: ['the regex API is not attached — the recorded regexes cannot be read, and a partial export is a broken artifact'] };
    }
    // readMenuEngineCode is TRI-STATE — null (book not readable yet) / { text, found }. The builder
    // takes the TEXT, so the unreadable book has to refuse here, where it can still be told apart
    // from an entry that is genuinely empty (the same guard shape the regex API gets above).
    let engineText = null;
    if (reg.engineOwned) {
        const read = await readMenuEngineCode();
        if (read === null) {
            return { ok: false, errors: ['the card worldbook is not readable yet — the recorded [MVU_StatusMenuEngine] entry cannot be read, and a partial export is a broken artifact'] };
        }
        engineText = read.text;
    }
    // The lifted documents, same tri-state and same refusal shape: a marker row on the card is
    // not the shipped row, and the export puts the shipped text back only if it can read it.
    let menuBodies = {};
    if (reg.liftedRows.length) {
        const read = await readMenuBodies();
        if (read === null) {
            return { ok: false, errors: ['the card worldbook is not readable yet — the recorded [MVU_StatusMenuBody:…] entries cannot be read, and a partial export is a broken artifact'] };
        }
        menuBodies = read;
    }
    const cardRegexes = wantsRegexes ? await getRegexes(REGEX_SCOPE_CHARACTER) : [];
    const built = buildMenuExportFile({ registry: reg, entries: state.entries, engineText, cardRegexes, menuBodies });
    if (!built.pack) return { ok: false, errors: built.errors };
    // The card's engine text may have arrived with a shared card, so it is read in the engine frame's
    // throwaway Worker, never run on the page (artifact-source-gates.js, G-C).
    const menuEngineText = menuEngineTextToRead(built.pack);
    let menuEngineExports = null;
    if (menuEngineText !== null) {
        try {
            menuEngineExports = await readMenuEngineExportsInWorker(menuEngineText);
        } catch (e) {
            log.error('export refused — the menu engine could not be checked in its Worker:', e);
            return { ok: false, errors: ['the StatusMenu Engine could not be checked (' + String(e && e.message) + ') — the export is refused rather than shipped unchecked'] };
        }
    }
    const done = finishArtifactExport(built, { menuEngineExports });
    if (done.ok) {
        log.lifecycle('exported "' + done.pack.id + '" v' + done.pack.version
            + ' — layout ' + (done.pack.layout ? 'yes' : 'no') + ' · engine ' + (done.pack.engine || '').length
            + 'ch · ' + (done.pack.regex || []).length + ' regex (' + done.fileName + ')');
    }
    return done;
}
