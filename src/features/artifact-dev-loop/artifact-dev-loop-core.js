// artifact-dev-loop/artifact-dev-loop-core.js — the dev loop's decisions, pure (L6). v0.3
//
// The host file (artifact-dev-loop.js) owns EventSource, fetch, settings and the DOM; every choice
// about WHAT to apply is here where a test can reach it. No host imports, no logging — refusals
// return as data with the reason spelled out, because a dev loop that silently skips an artifact is
// a developer hunting a bug that is actually a skip.

import { adoptQuestion } from '../../shared/card-artifact-store.js';

// The /workspace payload, shape-checked. Returns { ok, version, artifacts, bootId, error }.
//
// `bootId` identifies the SERVER PROCESS and is '' on a server too old to send one, which reads as
// "no session identity" — the adopt question then asks once per apply rather than once per restart,
// which is the direction that cannot silently overwrite a card.
export function readWorkspacePayload(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.artifacts)) {
        return { ok: false, version: 0, artifacts: [], bootId: '', error: 'the dev server answered with something other than a workspace payload' };
    }
    return { ok: true, version: Number(obj.version) || 0, artifacts: obj.artifacts, bootId: String(obj.bootId || ''), error: '' };
}

// Which artifacts to apply and which to skip, each skip carrying its reason. `laneTypes` is the set
// of packTypes the composition root registered an activation lane for. `changedFiles` (workspace-
// relative, from the change event) narrows the apply to the artifacts actually touched: applying an
// UNTOUCHED artifact is not just waste — a full activation rewrites its regexes, and the regex apply
// reloads the chat, so an over-broad apply turns one engine save into two chat reloads. An empty
// list means the initial full apply, which takes everything.
export function planDevApply(artifacts, laneTypes, changedFiles = []) {
    const touched = new Set((Array.isArray(changedFiles) ? changedFiles : [])
        .map((f) => String(f).split('/')[0])
        .filter(Boolean));
    const apply = [];
    const skip = [];
    for (const a of Array.isArray(artifacts) ? artifacts : []) {
        const label = a.name || '(single artifact)';
        if (touched.size && a.name && !touched.has(a.name)) continue;   // untouched — not even a skip line
        if (!a.pack) { skip.push({ name: label, reason: 'did not assemble — the server console names each error' }); continue; }
        if (Array.isArray(a.errors) && a.errors.length) { skip.push({ name: label, reason: a.errors.length + ' error(s) — first: ' + a.errors[0] }); continue; }
        if (!laneTypes.has(a.pack.packType)) { skip.push({ name: label, reason: 'no activation lane for packType "' + a.pack.packType + '"' }); continue; }
        apply.push(a);
    }
    return { apply, skip };
}

// One §6 log line per apply: WHICH artifact, WHICH files, and what activation did. The time comes
// from the logger; the files come from the change event ('' on the initial full apply).
export function devApplyLogLine(pack, changedFiles, actionSummary) {
    const files = (changedFiles && changedFiles.length)
        ? changedFiles.slice(0, 3).join(', ') + (changedFiles.length > 3 ? ' (+' + (changedFiles.length - 3) + ')' : '')
        : 'initial full apply';
    return pack.packType + ' "' + pack.id + '" v' + (pack.version || '?')
        + ' — ' + files + ' — ' + actionSummary;
}

// The boot-order refusal class: the extension loads BEFORE a chat is open and before TavernHelper's
// lorebook/script/regex APIs attach, so an apply that runs at connect time is refused for reasons
// that cure themselves the moment a chat loads. Both halves of an apply can hit it — the LIBRARY
// write (lorebook API unavailable) and the ACTIVATION (no chat/card yet) — and both must retry on
// CHAT_CHANGED rather than toast a failure the developer cannot act on.
export function isBootOrderRefusal(reasons) {
    const first = Array.isArray(reasons) ? reasons[0] : reasons;
    return /no chat|no card|not attached|api unavailable|still loading/i.test(String(first || ''));
}

// The ACTIVATION half of the same class, read as an ENUM instead of grepped out of prose — because
// grepping the prose did not work and could not have. Every lane's no-chat refusal reads "open a chat
// first — …", which contains none of the words above, so isBootOrderRefusal answered FALSE for every
// real activation refusal and the loop toasted a failure the developer could not act on (live
// 2026-09-04: close a chat to the lobby, "1 artifact(s) failed to apply"). The library half kept
// working, which is why the gap survived: its reasons DO say "lorebook API unavailable".
//
// ▲ AND ITS TEST PASSED THROUGHOUT, on a string no lane emits — `'no chat is open'`, typed by hand
// into the suite. Same shape as the engine-marker miss this repo already paid for: a test that
// re-spells its subject is not testing its subject. The cases below are now built FROM the lanes'
// own decide*Activation output, so a reworded reason cannot quietly un-guard this again.
//
// `action` is the right field for it: it is a fixed vocabulary the three lanes already agree on,
// where a reason is a sentence written for a human. Note `/no chat/` would not match `no-chat`
// anyway — the hyphen is exactly the kind of near-miss prose matching invites.
export const BOOT_ORDER_ACTIONS = ['no-chat', 'card-unreadable'];

export function isBootOrderAction(action) {
    return BOOT_ORDER_ACTIONS.includes(String(action || ''));
}

// A refusal that is a SETUP STEP, not a fault. A plugin's call bindings are the user's own
// first-install answers; the dev loop reuses them and never invents them, so a plugin that has
// never been installed on this card refuses with 'not-installed' — correct, and nothing is wrong
// with the workspace, the server or the connection. Live 2026-08-28: a workspace whose gamelogic
// and statusmenu both applied cleanly still reported "apply failed — see console" with an error
// toast, because ONE artifact wanted a one-time click. That reads as a broken loop.
export function isSetupRefusal(action) {
    return /^(not-installed|needs-adopt)$/i.test(String(action || ''));
}

// May the loop ASK this card-scoped question again? Shared by the two questions the loop can raise —
// the adopt question (this card owns a surface the pack writes differently) and the dev-card fence
// (this is not a card the loop has been told to write to).
//
// The rule is once per server process per key — never once per apply. Applies fire on every file
// save, and saves are frequent and unattended (autosave, format-on-save, git touching mtimes), so a
// question on that trigger is a question asked while the developer is typing. Answered NO, it stays
// answered until the dev server is stopped and started again — which is the gesture that means "I am
// setting this up differently now", and the only one the browser can actually detect (see the server's
// bootId for why a page reload cannot be it).
//
// `declinedBootId` is what the settings recorded for this card+pack. Asking again requires a DIFFERENT
// live bootId, so a reload, a reconnect and a toggle all stay quiet.
//
// With no live bootId (a server too old to send one) the answer is ASK: an un-suppressible question is
// annoying, a suppressed one that never returns silently leaves the artifact unapplied forever.
export function shouldAskAgainThisBoot({ declinedBootId, currentBootId } = {}) {
    if (!currentBootId) return true;
    return String(declinedBootId || '') !== String(currentBootId);
}

// The adopt question the dev loop asks — the shared shape every lane uses (adoptQuestion, with its buttons
// ADOPT_QUESTION_BUTTONS), with the dev loop's own Cancel: declining changes nothing and is remembered until
// the dev server restarts.
export function devLoopAdoptQuestion(pack, adoptable) {
    return adoptQuestion({
        artifactName: (pack && (pack.name || pack.id)) || '?',
        version: pack && pack.version,
        surfaces: adoptable,
        answers: [
            { text: 'Replace: the artifact owns them from then on, and its uninstall removes them.' },
            { text: 'Cancel: nothing changes, and the loop does not ask again until the dev server restarts. Install to this card, on its library row, asks any time.' },
        ],
    });
}

// Drop every decline that belongs to a server process that is no longer running — these maps are keyed
// per card (or card+pack) and would otherwise grow one entry per card the developer ever refused on.
// Returns a NEW object; the input is never mutated.
export function pruneBootScopedDeclines(declines, currentBootId) {
    const out = {};
    if (!currentBootId) return out;
    for (const [key, boot] of Object.entries((declines && typeof declines === 'object') ? declines : {})) {
        if (String(boot) === String(currentBootId)) out[key] = String(boot);
    }
    return out;
}

// THE STATUS ROW, and the rule that keeps it honest: the pill's colour answers ONE question — is this loop
// CONNECTED — and the line beside it says everything about the last apply. Conflating them is what made a
// healthy loop look broken: an artifact needing a setup click turned the whole indicator red while the
// connection was perfect and two artifacts had just applied.
//
//   success — connected. The server answered and every artifact that could apply, did.
//   warning — connected, but something needs the developer: an artifact the gates REFUSED (W5 — the
//             developer's own save broke it, and that is the one thing they must see), a setup click, a
//             fenced card, a failed apply, or a boot-order wait. The pill names which; the transport is FINE.
//   danger  — NOT connected: the server does not answer, its answer is not a workspace, or no URL is set.
//   neutral — off (no connection is opened while the toggle is down, D-E), or connecting.
//
// Returns { pill, message, counts } — `message` is the line the developer must read, `counts` the build and
// apply counts; each is null when there is nothing to say. Both are the panel's line shape: the fixed words
// keyed, every artifact name, gate reason and lane hint printed as data, verbatim. Pure so the branch table
// is testable (L6); the host owns the DOM.
//
// THE OPEN CARD. What the last apply applied, what failed in it and what the fence held back are facts about
// the card it ran on (`appliedCardKey`), so they are shown only while that card is open (`openCardKey`, '' in
// the lobby). Read against another card, or none, they describe the wrong one: closing the chat left "not
// installed on this card" standing over the lobby, and the next card opened inherited the last card's
// answer. The build number and the gate's refusals are the workspace's, and stand on any card. While an apply
// runs on the open card (`isApplying`) its facts are not in yet, so the row says Applying and nothing older.
//
// `setupNeeded` is a STANDING condition, never a record of the last apply: it is re-probed whenever
// the developer may have changed the answer (refreshDevLoopStatus), because every action this message
// ASKS FOR happens on an artifact tab and none of them is a file save. Live 2026-08-28: the line went
// on naming a library entry the developer had just removed — and doing what it said (installing the
// plugin) would not have cleared it either, since only a dev-server event repainted the line.
export function devLoopStatus({
    enabled, connected, version = 0, applied = 0, skipped = [], setupNeeded = [], waitingForCard = false, fencedOut = [], failed = 0,
    transportProblem = '', openCardKey = '', appliedCardKey = '', isApplying = false,
} = {}) {
    if (!enabled) return { pill: { text: 'Off', status: 'neutral' }, message: null, counts: null };
    if (transportProblem) {
        return { pill: { text: 'Not connected', status: 'danger' }, message: TRANSPORT_PROBLEMS[transportProblem] || { name: transportProblem }, counts: null };
    }
    if (!connected) return { pill: { text: 'Connecting', status: 'neutral' }, message: null, counts: null };

    const isAboutOpenCard = Boolean(openCardKey) && appliedCardKey === openCardKey;
    // `skipped` is the list of { name, reason } the plan refused — never a bare count. A count in the
    // counts line beside a GREEN pill is how a broken engine read as "all good" (live 2026-08-28: W5's
    // gate refused the menu, the console said why, the panel said green).
    const counts = {
        parts: [{ text: 'Build' }, { name: ` #${version}` },
            ...(isAboutOpenCard && !isApplying ? [{ name: ` · ${applied} ` }, { text: 'applied' }] : []),
            ...(skipped.length ? [{ name: ` · ${skipped.length} ` }, { text: 'skipped' }] : [])],
    };

    // THE LOBBY. Every write the loop makes is card-scoped, so with no card open a save lands nowhere; one
    // that arrived meanwhile waits and applies when a chat opens (CHAT_CHANGED retries it).
    if (!openCardKey) {
        return {
            pill: { text: 'No chat open', status: 'neutral' },
            message: waitingForCard ? { text: 'The last save applies once a chat is open.' } : { text: 'Saves apply to the card that is open.' },
            counts,
        };
    }
    if (isApplying && isAboutOpenCard) return { pill: { text: 'Applying', status: 'neutral' }, message: null, counts };
    // A real failure outranks a setup step: a refusal nobody can fix with one click is the thing
    // worth surfacing, and it stays a warning rather than danger because the CONNECTION is still good.
    if (failed && isAboutOpenCard) {
        return { pill: { text: 'Apply failed', status: 'warning' }, message: { parts: [{ name: `${failed} ` }, { text: 'artifact(s) failed to apply. The console names each reason.' }] }, counts };
    }
    // A boot-order refusal: the card's lorebook did not answer yet, and the next chat change applies again.
    if (waitingForCard) return { pill: { text: 'Card not ready', status: 'warning' }, message: { text: 'The workspace applies again once the chat has loaded.' }, counts };
    // FENCED — the dev-card question was answered no, so artifacts this card does NOT carry were not
    // installed. What the card already carries still hot-reloads, and the line says so: a line reading
    // "nothing is applied here" while saves were in fact landing sent the developer hunting a bug in the
    // wrong half (live 2026-09-01). A warning, because a save will not put the NAMED artifacts on this
    // card and a green pill is how that reads as a bug.
    if (fencedOut.length && isAboutOpenCard) {
        return {
            pill: { text: 'Updates only', status: 'warning' },
            message: { parts: [
                { text: 'Not installed on this card, as you answered this session:' }, { name: ' ' + fencedOut.map((name) => `"${name}"`).join(', ') + '. ' },
                { text: 'What this card already has still updates.' },
            ] },
            counts,
        };
    }
    // A refused artifact outranks a setup step: the developer's own save caused it, and the REASON is
    // the whole point — the gate wrote it to be read, not counted.
    if (skipped.length) {
        return { pill: { text: 'Not applied', status: 'warning' }, message: { parts: joinedLines(skipped.map((s) => [{ name: `"${s.name}" ` }, { text: 'not applied' }, { name: `: ${s.reason}` }])) }, counts };
    }
    // A card the loop has not applied to since it opened: nothing to report about it yet, and the next save
    // applies here (the fence asks first for anything it does not carry).
    if (!isAboutOpenCard) {
        return { pill: { text: 'Connected', status: 'success' }, message: { text: 'Nothing applied to this card yet: the next save applies here.' }, counts };
    }
    if (setupNeeded.length) {
        // Each entry is { id, source, hint }. The HINT is the lane's, printed verbatim, because the
        // fix differs by WHY — a plugin never installed here wants a bindings click, one whose library
        // copy was removed needs the copy back first — and one sentence written HERE could only ever
        // be right for one of those states (L1: the lane is the half that knows what the artifact is).
        //
        // The SOURCE is this function's, and it is not decoration. A developer who wants the message
        // to stop looks for something to delete, finds the library row, removes it — and the loop
        // writes the copy back from the workspace on the next save, because the WORKSPACE is what it
        // watches. Twice live, 2026-08-28. A line that asks for an action must say what it is talking
        // about, or the only exit anyone finds is the wrong one.
        const where = (s) => (s.source ? [{ name: ' (' }, { text: 'workspace' }, { name: ` ${s.source}/)` }] : []);
        return {
            pill: { text: 'Setup needed', status: 'warning' },
            message: { parts: joinedLines(setupNeeded.map((s) => [{ name: `"${s.id}"` }, ...where(s), { name: ` ${s.hint}` }])) },
            counts,
        };
    }
    return { pill: { text: 'Connected', status: 'success' }, message: null, counts };
}

// What a finished apply reports, from what happened during it. Two refusals are waits, not failures, and CHAT_CHANGED
// applies again after either: a boot-order refusal (`needsCard` — the card's lorebook had not answered yet), and a card
// that changed under the apply (closed, or another opened), whose refusals are a card leaving, not a fault. Neither may
// raise the error toast: one for a wait is what made a working loop read as broken.
// Returns { needsCard, waitingForCard, failed, shouldToast }.
export function devApplyOutcome({ failed = 0, needsCard = false, isCardChanged = false } = {}) {
    const isWaiting = needsCard || isCardChanged;
    return {
        needsCard: isWaiting,
        waitingForCard: Boolean((failed && needsCard) || isCardChanged),
        failed: isWaiting ? 0 : failed,
        shouldToast: Boolean(failed) && !isWaiting,
    };
}

// Why the server is not connected, by the code the host reports.
const TRANSPORT_PROBLEMS = {
    unreachable: { text: 'The dev server does not answer. Is npm run dev running?' },
    'not-a-workspace': { text: 'The server at this URL is not the dev server: its answer is not a workspace.' },
    'no-url': { text: 'Set the dev server URL first.' },
};

// Several artifacts' parts on one line, a dot between each.
function joinedLines(groups) {
    return groups.flatMap((parts, index) => [...(index ? [{ name: ' · ' }] : []), ...parts]);
}

// THE PER-SINK PLAN (§5's differentiation) — which SECTIONS of one artifact a change actually
// touched, so activation can apply only those. The stake is the §5 cost table: an engine-only save
// must not rewrite regexes (whose apply ends in a chat reload — live 2026-08-27, a mid-generation
// reload KILLS the in-flight turn), and an entries-only save must not restart the Worker.
//
// The vocabulary is §28's six section directories plus pack.json. Everything else is a reason to
// fall back to FULL — pack.json carries id/version/state/exposes and can retarget every section,
// and an unrecognized path means the workspace holds something this plan does not understand, where
// guessing narrower would silently not apply it. Hard cutoff on doubt, never a guess.
//
// `changedFiles` are workspace-relative; when `artifactName` is set (multi-artifact workspace) only
// that artifact's files count and the prefix is stripped. A directory event ('gamelogic/engine')
// resolves to its own section; an editor temp file under a section resolves to that section —
// harmless either way, because what gets applied is the ASSEMBLED artifact, not the named file.
//
// Returns { full, sections, why }: full=true means run the whole activation (also the initial
// apply, changedFiles []); otherwise `sections` lists what to apply, and `why` is for the log.
// Kept in step with the assembler's SECTION_DIRECTORIES: a section the assembler reads and this list
// does not know reads as "outside the known sections", and every save under it logs a line saying the
// loop could not tell what changed — true of nothing, and the kind of stale label that sends someone
// hunting the wrong bug. `events` is one sink whatever changes inside it (the eventpack lane writes
// the card's entries and its registry record together), so the mask narrows the LOG here, not the work.
export const ARTIFACT_SECTIONS = ['engine', 'entries', 'events', 'layout', 'panel', 'regex', 'schema'];
export function planSectionApply(changedFiles, artifactName) {
    const files = (Array.isArray(changedFiles) ? changedFiles : []).map(String);
    if (!files.length) return { full: true, sections: [], why: 'initial full apply' };

    const prefix = artifactName ? String(artifactName) + '/' : '';
    const own = prefix ? files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)) : files;
    if (!own.length) return { full: true, sections: [], why: 'no file under "' + (artifactName || '') + '/" — cannot tell which section' };

    const sections = new Set();
    for (const f of own) {
        const head = f.split('/')[0];
        if (head === 'pack.json') return { full: true, sections: [], why: 'pack.json changed — it can retarget every section' };
        if (!ARTIFACT_SECTIONS.includes(head)) return { full: true, sections: [], why: '"' + f + '" is outside the known sections — applying narrower would be a guess' };
        sections.add(head);
    }
    return { full: false, sections: [...sections].sort(), why: [...sections].sort().join('+') };
}

// THE WAITING LIST — what a tab still owes the card when its running apply finishes. A tab applies one
// build at a time and every save that lands meanwhile waits here; the queued apply then fetches the
// NEWEST build but applies only what the waiting file list names (planDevApply narrows the artifacts,
// planSectionApply the sections). So waiting saves must UNION: replacing the list with the latest save
// drops every earlier save's artifact or section, and the card keeps that code stale while the log
// reports "applied". The realistic trigger is a fence or adopt dialog left open in one tab while the
// developer keeps saving — the apply waits on the answer, and every save piles up behind it.
//
// An empty list means "apply everything" and absorbs whatever it is merged with. `queued` is null when
// nothing waits. Returns the merged list in first-seen order.
export function mergeQueuedChanges(queued, incoming) {
    const next = (Array.isArray(incoming) ? incoming : []).map(String);
    if (!Array.isArray(queued)) return next;
    if (!queued.length || !next.length) return [];
    return [...new Set([...queued, ...next])];
}

// ── W9: capture the developer's regex order (§2.8) ───────────────────────────

// Did the developer rearrange this artifact's regexes on the card? `declaredOrder` is what the
// source declares (pack.regexOrder, or the pack's regex names in pack order when no declaration
// exists yet — the first drag is what CREATES the file); `cardNames` is the card's full regex name
// list in apply order. Returns the order to write back, or null when there is nothing to say:
//   • the pack ships fewer than two regexes — one row has no order;
//   • a declared name is missing from the card — a partial listing would fail rule 14's completeness
//     the moment the server wrote it, so "cannot capture" is the honest answer (and is logged by the
//     caller, not silently swallowed here — pure files return, callers log);
//   • the card's relative sequence already equals the declaration — the termination case: after a
//     write-back this is what every later CHAT_CHANGED sees, so no second POST ever fires.
export function capturedRegexOrder({ declaredOrder, cardNames } = {}) {
    const declared = (Array.isArray(declaredOrder) ? declaredOrder : []).map(String).filter(Boolean);
    if (declared.length < 2) return null;
    const wanted = new Set(declared);
    const own = (Array.isArray(cardNames) ? cardNames : []).map(String).filter((n) => wanted.has(n));
    if (own.length !== declared.length) return null;           // a pack regex is missing from the card
    if (own.every((n, i) => n === declared[i])) return null;   // already in the declared order
    return own;
}

// The declared sequence for one artifact, spelled once for both the capture check and the POST body:
// the explicit section when the pack carries one, else the regex names in pack order.
export function declaredRegexOrderOf(pack) {
    if (Array.isArray(pack && pack.regexOrder) && pack.regexOrder.length) return pack.regexOrder.map(String);
    return (Array.isArray(pack && pack.regex) ? pack.regex : [])
        .map((r) => String((r && r.script_name) || '')).filter(Boolean);
}

// ── the dev-card fence (user, 2026-08-31) ────────────────────────────────────

// MAY the loop write to the card that happens to be open? Until this existed, the answer was always
// yes: the loop applied its workspace to whatever card the developer had clicked into, so browsing
// one's own collection with the loop on installed a genre pack into every card that had a readable
// worldbook — silently, because a clean card returns 'activate' and asks nothing. The refusals the
// developer DID see were incidental (an unreadable book), not a guard.
//
// So the loop is now told, per card, once per dev-server process. `answers` maps an avatar key to
// `{ bootId, allowed }`, and a record counts only while its bootId is the one the server is serving
// now — so BOTH answers expire together when the server restarts.
//
// A YES USED TO PERSIST FOREVER, and that was wrong (user, 2026-09-01): a permanent grant has no way
// back. Nothing in the UI could revoke it, so a card said yes to by accident stayed a dev card until
// somebody hand-edited extensionSettings. Restarting the dev server is the revoke, and it is a gesture
// the developer already makes constantly. The store did not have to change for this — extensionSettings
// is fine — only the VALUE: a bootId self-expires where a bare `true` cannot. Records written by the
// old shape match no bootId, so they are ignored and the card is asked about once more.
//
//   'apply'   — said yes for this boot
//   'ask'     — no record for this boot
//   'skip'    — declined this boot: stay quiet, and do NOT retry on the next chat change
//   'no-card' — the lobby. Kept APART from 'skip' because the two need opposite follow-ups: a decline
//               is an answer that must not be re-asked, while no-card is a boot-order state that cures
//               itself the moment a chat opens (live 2026-08-31: connecting in the lobby returned
//               'skip', nothing set needsCard, and the loop then ignored every card the developer
//               opened until the next file save — a fence that fenced everything).
//
// NOTE the empty-set case is 'ask', not 'apply': a fresh install has told the loop nothing, and
// guessing "everywhere" is the behaviour this exists to end. A server whose bootId is unknown is the
// same case — an answer cannot be scoped to a boot nobody can name, so it is asked.
export function devCardDisposition({ cardKey, answers, currentBootId } = {}) {
    const key = String(cardKey || '');
    if (!key) return 'no-card';
    if (!currentBootId) return 'ask';
    const all = (answers && typeof answers === 'object') ? answers : {};
    const record = all[key];
    if (!record || typeof record !== 'object') return 'ask';
    if (String(record.bootId || '') !== String(currentBootId)) return 'ask';
    return record.allowed === true ? 'apply' : 'skip';
}

// WHAT THE FENCE ACTUALLY GATES: installing artifacts this card does not have. Nothing else.
//
// It used to gate the whole apply, so one "no" froze the card completely — an artifact the developer
// had installed BY HAND, deliberately, stopped hot-reloading too, and the loop's own status line said
// "nothing is applied here" while the developer watched a stale panel and hunted a bug that was not
// there (live 2026-09-01). That made the question mean two things at once. It asks ONE: may the loop
// put the whole workspace onto this card. Whatever is already here is the developer's own earlier
// choice, and a save updating it is the D-F loop working as designed.
//
// `newCount` is how many of this apply's artifacts are NOT on the card yet. Returns:
//   'apply-all'    — activate everything (nothing new, or the answer was yes)
//   'ask'          — put the question, then apply on yes / 'updates-only' on no
//   'updates-only' — activate what the card already carries; new artifacts get their LIBRARY copy
//                    written and nothing more, so its library row's Install button still works
//   'no-card'      — no card open; a boot-order state, not an answer
export function cardFencePlan({ disposition, newCount = 0 } = {}) {
    if (disposition === 'no-card') return 'no-card';
    if (!newCount) return 'apply-all';
    if (disposition === 'apply') return 'apply-all';
    if (disposition === 'skip') return 'updates-only';
    return 'ask';
}

// One card's answer, in the shape `devCardDisposition` reads. Built here so the host never spells the
// record out — a caller that wrote `{ allowed }` and forgot the bootId would create the permanent
// grant this design exists to remove, and it would look correct at the call site.
//
// `allowed` is TRUTHY-tested, not compared to `true`: SillyTavern's confirm popup resolves to
// POPUP_RESULT.AFFIRMATIVE, which is the NUMBER 1. A strict comparison filed every yes as a no — the
// apply still ran, because the caller returns the same truthy value, so the card was written and then
// skipped on the very next apply of that boot (live 2026-09-01). Reading stays strict: what this
// normalizes on the way in, devCardDisposition can demand exactly on the way out.
export function devCardAnswer({ bootId, allowed } = {}) {
    return { bootId: String(bootId || ''), allowed: Boolean(allowed) };
}

// Drop every answer belonging to a dead boot. Same reason the adopt map is pruned on write: without it
// the map grows one dead record per card the developer ever answered about, forever.
export function pruneBootScopedAnswers(answers, currentBootId) {
    const out = {};
    if (!currentBootId) return out;
    for (const [key, record] of Object.entries((answers && typeof answers === 'object') ? answers : {})) {
        if (record && typeof record === 'object' && String(record.bootId || '') === String(currentBootId)) {
            out[key] = devCardAnswer(record);
        }
    }
    return out;
}

// ONE artifact's line in the fence question — what it IS and what it puts on the card, counted from the
// pack: a folder name alone ("gamelogic") reads like a category and promises none of the 50 entries an
// engine and a schema behind it. A dialog line (sillytavern/popup-core.js): the names and counts are
// values, every word of the pack format is keyed.
export function devCardArtifactLine(folderName, pack) {
    const p = pack && typeof pack === 'object' ? pack : {};
    const title = String(p.name || p.id || folderName || '?');
    const ident = [p.id && p.id !== title ? p.id : '', p.version ? 'v' + p.version : ''].filter(Boolean).join(' ');
    const weights = [];
    const entries = Array.isArray(p.entries) ? p.entries.length : 0;
    const regexes = Array.isArray(p.regex) ? p.regex.length : 0;
    if (entries) weights.push([{ name: entries + ' ' }, entries === 1 ? { text: 'entry' } : { text: 'entries' }]);
    if (regexes) weights.push([{ name: regexes + ' ' }, regexes === 1 ? { text: 'regex' } : { text: 'regexes' }]);
    if (p.engine !== undefined) weights.push([{ text: 'engine' }]);
    if (p.schema !== undefined) weights.push([{ text: 'schema' }]);
    if (p.layout !== undefined) weights.push([{ text: 'layout' }]);
    if (p.panel !== undefined) weights.push([{ text: 'panel' }]);
    const written = weights.length
        ? weights.flatMap((weight, index) => (index ? [{ name: ', ' }, ...weight] : weight))
        : [{ text: 'nothing to write' }];
    return {
        parts: [
            { name: '• ' + title + (ident ? ' (' + ident + ')' : '') + ' — ' },
            ...written,
            ...(folderName && folderName !== title ? [{ name: '   [' + folderName + '/]' }] : []),
        ],
    };
}

// The fence question's buttons: the answer lines below name them.
export const DEV_CARD_QUESTION_BUTTONS = { okButton: 'Install all', cancelButton: 'Not here' };

// The fence question: the CARD, the workspace, and every artifact that would be written, then one short
// line per answer. ALL OR NOTHING — Install all takes the whole workspace, Not here takes none of it,
// because the loop's unit IS the workspace. NOT HERE IS NOT AN UNDO: it gates future writes only, and the
// line says how removal is done (the tab's Uninstall), because a loop that uninstalled on a decline would
// delete a pack the user had installed on purpose. Dialog lines (sillytavern/popup-core.js).
export function devCardQuestion({ cardName, artifacts, url } = {}) {
    const rows = (Array.isArray(artifacts) ? artifacts : [])
        .map((a) => (a && typeof a === 'object' && ('pack' in a || 'name' in a))
            ? devCardArtifactLine(a.name, a.pack)
            : devCardArtifactLine(String(a || ''), null));
    return [
        { text: 'Install the dev workspace on this card?' },
        ...(cardName ? [{ text: 'Card:', name: String(cardName) }] : []),
        ...(url ? [{ text: 'Dev server:', name: String(url) }] : []),
        ...(rows.length ? rows : [{ text: 'Nothing to apply yet.' }]),
        { text: 'Install all: everything installs now, and every save re-applies it while this dev server runs.' },
        { text: 'Not here: nothing new installs. What the card already has keeps hot-reloading; Uninstall on its row in On this card removes one.' },
        { text: 'Either way, each artifact gets its library copy, and restarting the dev server asks again.' },
    ];
}
