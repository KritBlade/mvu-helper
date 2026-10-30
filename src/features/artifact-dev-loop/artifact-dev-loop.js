// artifact-dev-loop/artifact-dev-loop.js — the browser half of `npm run dev` (workflow plan W3). v0.3
//
// While the toggle is ON, an EventSource watches the local dev server (tools/dev-server.mjs); every
// change — and the moment the connection opens — pulls /workspace and re-applies each artifact
// through the SAME lane a library install uses: installPackToLibrary → the type's activate. That is
// the whole point (§4.1): the dev loop ships zero install code of its own, so the artifact a
// developer debugs IS the artifact a player installs.
//
// D-E: the EventSource exists only while the toggle is on — a regular user's session opens no
// connection at all, polls nothing, and pays nothing. D-F: applying overwrites the card freely;
// this is a development cycle, and the release path is the export button, not this.
//
// Activation lanes arrive by REGISTRATION from src/index.js (the house pattern — P5): this feature
// imports no sibling feature and learns nothing about what a pack or a plugin is.

import { toast } from '../../sillytavern/mvu-bridge.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { withChatReloadsCoalesced } from '../../sillytavern/chat-reload.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { openCardKey, openCardName } from '../../sillytavern/card-access.js';
import { hasActiveCharacter } from '../../sillytavern/lorebook.js';
import { REGEX_SCOPE_CHARACTER, listRegexNames } from '../../sillytavern/tavern-regex.js';
import { readWorkspacePayload, planDevApply, capturedRegexOrder, declaredRegexOrderOf, devApplyLogLine, isBootOrderRefusal, isBootOrderAction, planSectionApply, isSetupRefusal, devLoopStatus, devApplyOutcome, cardFencePlan, shouldAskAgainThisBoot, pruneBootScopedDeclines, pruneBootScopedAnswers, devCardAnswer, devLoopAdoptQuestion, devCardDisposition, devCardQuestion, DEV_CARD_QUESTION_BUTTONS, mergeQueuedChanges } from './artifact-dev-loop-core.js';
import { ADOPT_QUESTION_BUTTONS } from '../../shared/card-artifact-store.js';
import { listRow, statusPill } from '../settings-panel/index.js';

const log = createModuleLog('artifact-dev-loop');

export const devLoopDefaults = {
    // `adoptDeclined` maps "<card avatar>::<pack id>" to the dev-server bootId the developer said NO
    // under. PERSISTED, not in memory: a page reload must not re-ask, and the page cannot tell a reload
    // from a deliberate restart (the server's bootId can — see its comment).
    // `devCardAnswers` is the FENCE: one `{ bootId, allowed }` per avatar key. Persisted for the same
    // reason as adoptDeclined — a page reload must not re-ask — but scoped to the SERVER's boot, so
    // both a yes and a no expire when the dev server restarts. That restart is the only revoke there
    // is, which is why neither answer may outlive it (user, 2026-09-01). The retired `devCards` /
    // `devCardDeclined` keys are never read; a stored `true` matches no bootId.
    artifactDevLoop: { enabled: false, url: 'http://127.0.0.1:6620', adoptDeclined: {}, devCardAnswers: {} },
};

const settings = () => getGlobal().artifactDevLoop;

// packType -> { install(text), activate(pack), needsSetup?(pack), onCard?(pack) } — registered from the
// composition root. `needsSetup` is OPTIONAL and must be a pure READ: it answers "is there still a
// one-time step this artifact is waiting on?", returning that step's instruction or '' for nothing.
// A lane that omits it never needs setup. `onCard` is the fence's read — "does this card already
// carry this artifact?" — and a lane that omits it is treated as NOT carrying it, so the question is
// asked rather than assumed. It exists because the standing answer changes through the
// artifact TABS (install, uninstall, library Remove), which no dev-server event will ever announce — and
// re-running activation to find out would rewrite regexes and reload the chat for a label.
const lanes = new Map();
export function registerDevLane(packType, lane) {
    lanes.set(packType, lane);
}

let source = null;            // the live EventSource, null while off
let applying = false;         // single-flight: a save burst mid-apply queues, never overlaps
let queued = null;            // every file saved since the running apply began, merged — [] = full, null = nothing waits
let needsCard = false;        // the last apply was refused for a not-ready card — retry on CHAT_CHANGED
let serverBootId = '';        // THIS dev-server process's id — what "the loop restarted" actually means
// Every artifact the workspace currently holds that HAS a lane and assembled cleanly, each kept as
// { name, pack } — the subjects of a setup re-probe. `name` is the workspace FOLDER, and it rides
// along because the status line has to name it: the loop watches the workspace, so the workspace is
// the only place a developer can actually stop an artifact from being applied. Deliberately NOT
// "what this burst applied": a save under gamelogic/ narrows the apply to one artifact, and
// rebuilding the standing condition from that narrow set would report every other artifact as fine
// because it was never looked at.
let probeSubjects = [];

// The status row: the dev server, its pill and the lines devLoopStatus decides — the pill answers ONE
// question, connected or not, and the line carries everything about the last apply.
function paintStatus(facts) {
    const $status = $('#mvuh_devloop_status');
    if (!$status.length) return;
    const view = devLoopStatus({ ...facts, openCardKey: openCardKey() });
    $status.html(listRow({ icon: 'fa-plug', text: 'Dev server', sub: [view.message, view.counts], pills: [statusPill(view.pill)] }));
    void applyHelperLocale();
}

// Everything the status row needs, kept as FACTS rather than a verdict — the verdict is
// devLoopStatus's to make, once, where a test can reach it.
// `appliedCardKey` is the card the last apply ran on: its applied, failed and fencedOut are about that card alone.
let statusFacts = { enabled: false, connected: false, version: 0, applied: 0, skipped: [], setupNeeded: [], waitingForCard: false, fencedOut: [], failed: 0, transportProblem: '', appliedCardKey: '', isApplying: false };
function setStatus(patch) {
    statusFacts = { ...statusFacts, ...patch };
    paintStatus(statusFacts);
}

// Ask each lane what it is still waiting on. Reads only — nothing here writes to the card, so it is
// safe on a tab repaint; a lane without needsSetup contributes nothing.
async function probeSetupNeeded(subjects) {
    const out = [];
    for (const { name, pack } of subjects) {
        const lane = lanes.get(pack.packType);
        if (!lane || typeof lane.needsSetup !== 'function') continue;
        try {
            const hint = await lane.needsSetup(pack);
            if (hint) out.push({ id: pack.id, source: name || '', hint: String(hint) });
        } catch (e) {
            log.warn('setup probe failed for "' + pack.id + '":', e);
        }
    }
    return out;
}

// Re-ask the standing questions and repaint. Called when the Development tab opens and on every chat change
// (the tab table in src/index.js): every gesture that can change the answer — an install, an uninstall, a
// library Remove — happens on another tab, so the answer is re-asked when this one shows again. Applies NOTHING:
// re-applying on a repaint is the feedback loop that reloaded SillyTavern forever (2026-08-27).
export async function refreshDevLoopStatus() {
    if (!statusFacts.enabled || !statusFacts.connected) { paintStatus(statusFacts); return; }
    // The lobby: every probe reads a card, and with none open each would answer about nothing — a plugin
    // "not on this card", and one "[tavern-regex] no character open" per artifact on the way.
    if (!hasActiveCharacter()) { setStatus({ setupNeeded: [] }); return; }
    setStatus({ setupNeeded: await probeSetupNeeded(probeSubjects) });
}

// THE DEV-CARD FENCE (user, 2026-08-31). May this apply write to the card that is open?
//
// It used to be unconditional: the loop applied its workspace to whatever card the developer had
// clicked into, so browsing one's own collection with the loop on installed the genre pack into every
// card whose worldbook was readable — with no dialog, because a clean card returns 'activate' and asks
// nothing. The refusals that WERE visible came from unreadable books, which is luck, not a guard.
//
// Asked at most once per dev-server process per card, on the SAME boot-scoped rule as the adopt
// question: applies fire on every file save, so anything asked per-apply is asked while typing.
// BOTH answers expire with the server process — restarting it is the revoke, and a grant that
// outlived one had no revoke at all.
//
// Returns the plan for THIS apply: 'apply-all' | 'updates-only' | 'no-card'.
// `newToCard` names the artifacts this card does not carry — the only thing the question gates.
async function cardFenceVerdict(newToCard) {
    const cardKey = openCardKey();
    const answers = (settings().devCardAnswers && typeof settings().devCardAnswers === 'object') ? settings().devCardAnswers : {};
    const disposition = devCardDisposition({ cardKey, answers, currentBootId: serverBootId });
    const plan = cardFencePlan({ disposition, newCount: newToCard.length });
    // The LOBBY is a boot-order state, not an answer: mark it so CHAT_CHANGED retries, exactly as an
    // unreadable book does. Without this the loop connects in the lobby, fences, and then never looks
    // at any card the developer opens until the next file save.
    if (plan === 'no-card') { needsCard = true; return 'no-card'; }
    if (plan !== 'ask') return plan;

    // Both answers are FILED THE SAME WAY, into the same map, pruned to this boot on every write —
    // the yes branch used to write a different key with a different shape, which is how it acquired a
    // lifetime nobody chose.
    // The question lists only what would be INSTALLED. Listing an artifact already on the card would
    // ask the developer to authorise something their own earlier install already settled.
    const said = await confirmPopup(devCardQuestion({ cardName: openCardName(), artifacts: newToCard, url: settings().url }), DEV_CARD_QUESTION_BUTTONS);
    const next = pruneBootScopedAnswers(answers, serverBootId);
    next[cardKey] = devCardAnswer({ bootId: serverBootId, allowed: said });
    settings().devCardAnswers = next;
    saveSettingsDebounced();
    log.lifecycle(said
        ? '"' + openCardName() + '" is a dev card for this server process — the loop installs'
            + ' the whole workspace here on every save. Restart the dev server to be asked again.'
        : 'not INSTALLING anything new on "' + openCardName() + '" — what this card already'
            + ' carries still hot-reloads on every save. Not asked again until the dev server is restarted.');
    return said ? 'apply-all' : 'updates-only';
}

// Which of this apply's artifacts are ALREADY on the open card. A lane without `onCard` cannot say,
// and "cannot say" is treated as NOT present — the fence asks rather than assumes.
async function artifactsOnCard(subjects) {
    const present = new Set();
    for (const { pack } of subjects) {
        const lane = lanes.get(pack.packType);
        if (!lane || typeof lane.onCard !== 'function') continue;
        try { if (await lane.onCard(pack)) present.add(pack.id); }
        catch (e) { log.warn('card-presence probe failed for "' + pack.id + '":', e); }
    }
    return present;
}

// A lane refused because the CARD owns a surface this pack writes differently (§8/§13/§11). Ask —
// at most once per dev-server process per card+pack — and re-run the activation with adoption allowed
// when the answer is yes.
//
// Returns the lane's new result, or the original refusal unchanged. The refusal is NOT a failure either
// way: isSetupRefusal already classes it with the plugin lane's one-time install, so a decline leaves an
// amber status line naming the artifact and no error toast.
async function resolveAdopt(artifact, lane, refusal, sink) {
    if (typeof lane.adopt !== 'function') return refusal;
    // No card open means no card to file an answer against, and an answer filed under "no card" would
    // be handed to whatever opens next. The refusal stands; the next apply with a card asks properly.
    const cardKey = openCardKey();
    if (!cardKey) return refusal;
    const key = cardKey + '::' + artifact.pack.id;
    const declines = (settings().adoptDeclined && typeof settings().adoptDeclined === 'object') ? settings().adoptDeclined : {};
    if (!shouldAskAgainThisBoot({ declinedBootId: declines[key], currentBootId: serverBootId })) return refusal;

    if (!await confirmPopup(devLoopAdoptQuestion(artifact.pack, refusal.adoptable || []), ADOPT_QUESTION_BUTTONS)) {
        // Prune on write: the map is keyed per card, and without this it grows one dead entry per card
        // the developer ever refused on, forever.
        const next = pruneBootScopedDeclines(declines, serverBootId);
        next[key] = serverBootId;
        settings().adoptDeclined = next;
        saveSettingsDebounced();
        log.lifecycle('adoption DECLINED for "' + artifact.pack.id + '" on this card — nothing was touched.'
            + ' Not asked again until the dev server is restarted; Install to this card, on its library row, does it any time.');
        return refusal;
    }
    return lane.adopt(artifact.pack, sink.full ? {} : { sections: sink.sections });
}

async function applyWorkspace(changedFiles) {
    if (applying) { queued = mergeQueuedChanges(queued, changedFiles); return; }
    applying = true;
    needsCard = false;
    let isCardChanged = false;   // the open card changed under this apply — see the finally below
    try {
        const url = String(settings().url || '').replace(/\/+$/, '');
        let payload;
        try {
            payload = readWorkspacePayload(await (await fetch(url + '/workspace')).json());
        } catch (e) {
            log.warn('/workspace fetch failed:', e);
            setStatus({ connected: false, transportProblem: 'unreachable' });
            return;
        }
        if (!payload.ok) {
            log.warn('' + payload.error);
            setStatus({ connected: false, transportProblem: 'not-a-workspace' });
            return;
        }

        // The server's own identity, refreshed on every apply — /workspace carries it as well as the
        // hello event, so a page that connected before this feature shipped still learns it.
        if (payload.bootId && payload.bootId !== serverBootId) serverBootId = payload.bootId;

        // THE LOBBY — stand down before touching the card (user, 2026-09-04: *"dev loop have no reason
        // to apply anything in lobby"*). Every write this function makes is card-scoped, so with no
        // card open there is nothing it can land and nothing it can truthfully report.
        //
        // Placed HERE, after the payload and before the first card read, for two reasons. The status
        // is honest: `connected` and `version` are known facts by now, where a guard at the very top
        // would have to claim them. And it is ahead of `artifactsOnCard`, whose reads are what made
        // the lobby loud — one "[tavern-regex] no character open" per artifact, plus a lorebook sweep
        // against `book=null`, all so the fence could ask a question about a card that is not there.
        //
        // `needsCard` is the whole point: CHAT_CHANGED retries, so a save made while sitting in the
        // lobby is applied the moment a chat opens rather than lost until the next file touch.
        //
        // The fence's own 'no-card' arm below still stands and is NOT redundant: it catches the card
        // closing during the awaits between here and there. Same for the activation's boot-order arm.
        // A guard this lane can pass on the way in can still be false by the time it writes.
        if (!hasActiveCharacter()) {
            needsCard = true;
            setStatus({
                connected: true, version: payload.version, applied: 0, failed: 0, skipped: [],
                waitingForCard: true, fencedOut: [], appliedCardKey: '',
            });
            return;
        }
        // The card this apply runs on: everything it reports below is about this card alone. Until it ends, the row
        // says Applying, not whatever the last apply or the lobby left in the facts.
        const cardKey = openCardKey();
        setStatus({ isApplying: true, appliedCardKey: cardKey, waitingForCard: false, applied: 0, failed: 0, fencedOut: [] });

        const laneTypes = new Set(lanes.keys());
        // W9 — what the capture check below compares against. Snapshotted from the same payload the
        // apply used, so the check never asks the server twice about one state.
        captureSubjects = (payload.artifacts || [])
            .filter((a) => a && a.pack && Array.isArray(a.pack.regex) && a.pack.regex.length >= 2 && !(a.errors || []).length)
            .map((a) => ({ name: a.name, declaredOrder: declaredRegexOrderOf(a.pack) }));
        // Twice, on purpose: the unnarrowed plan is the whole set of artifacts a setup probe must
        // ask about, the narrowed one is the work to do now (§5's per-sink cost).
        probeSubjects = planDevApply(payload.artifacts, laneTypes, []).apply.map((a) => ({ name: a.name, pack: a.pack }));
        const { apply, skip } = planDevApply(payload.artifacts, laneTypes, changedFiles);
        for (const s of skip) log.warn('SKIPPED ' + s.name + ' — ' + s.reason);

        // THE FENCE, once per apply. It answers ONE question — may the loop INSTALL this workspace
        // onto this card — so the only thing it gates is activating an artifact the card does not
        // already carry. Three writes deliberately pass it:
        //   — the LIBRARY write below, to the root-level library book (§4b), which belongs to no card
        //     and is what makes the Packs tab's Install button work after a 'no';
        //   — activation of an artifact ALREADY on this card: that install was the developer's own
        //     deliberate act, and hot-reloading it is the whole D-F loop (user, 2026-09-01);
        //   — W9's regex-order CAPTURE, which is why `captureSubjects` is assigned ABOVE this line and
        //     why the early return leaves it standing. A developer who installed a pack BY HAND and
        //     dragged its rows still gets regex-order.json written — the POST goes to the WORKSPACE,
        //     never to the card, and refusing auto-install is not a statement about their arrangement.
        const onCard = await artifactsOnCard(probeSubjects);
        const newToCard = probeSubjects.filter((a) => !onCard.has(a.pack.id));
        const fencePlan = await cardFenceVerdict(newToCard);
        if (fencePlan === 'no-card') {
            setStatus({
                connected: true, version: payload.version, applied: 0, failed: 0, skipped: [],
                waitingForCard: true, fencedOut: [], appliedCardKey: '', isApplying: false,
            });
            return;
        }
        // Deliberately NOT needsCard when fenced: this is an ANSWER, not a boot-order refusal, and
        // retrying it on every CHAT_CHANGED is the re-asking the boot scope exists to prevent.
        const fencedNames = fencePlan === 'updates-only' ? newToCard.map((a) => a.pack.id) : [];
        setStatus({ fencedOut: fencedNames, appliedCardKey: cardKey });

        let failed = 0;
        // COUNTED, not derived: `apply.length - failed - setupNeeded.length` printed "-1 applied" at
        // boot, because the setup probe and the failure tally can name the same artifact. A count
        // that can go negative is a label nobody can read (live 2026-08-28).
        let applied = 0;
        // ONE chat reload for the whole apply, not one per artifact: a lane asks for a reload when it
        // changed something RENDERED (its regexes, a StatusMenu layout or engine text), and inside this
        // scope those requests coalesce into a single reload after the last artifact is in place.
        await withChatReloadsCoalesced(async () => {
            for (const a of apply) {
                // The card changed under this apply (closed, or another opened). Every write below targets the
                // OPEN card, which is not the one the fence answered for, so the next artifact could land on a card
                // nobody asked about. Stop; the apply runs again on the card that is open now (the finally below,
                // or CHAT_CHANGED), where the fence asks properly.
                if (openCardKey() !== cardKey) break;
                const lane = lanes.get(a.pack.packType);
                // §5 per-sink: activation applies ONLY the sections this change touched, so an
                // engine-only save skips the regex sink's write entirely. Full on the first apply and on doubt.
                const sink = planSectionApply(changedFiles, a.name);
                const lib = await lane.install(JSON.stringify(a.pack));
                if (!lib.ok) {
                    failed++;
                    // The library write hits the same boot-order class as activation: at extension load
                    // the lorebook API is not attached yet, so the write is refused for a reason that
                    // cures itself. Marked the same way; CHAT_CHANGED retries (live, 2026-08-27 — a
                    // page reload left the loop at "apply failed" forever because only the ACTIVATION
                    // branch was marked).
                    if (isBootOrderRefusal(lib.errors)) needsCard = true;
                    log.warn('library write refused for "' + a.pack.id + '":', lib.errors);
                    continue;
                }
                // FENCED: the library copy above is written, activation is not. That is the whole
                // effect of a 'no' — the artifact is one Install click away on its library row.
                if (fencePlan === 'updates-only' && !onCard.has(a.pack.id)) {
                    log.lifecycle('"' + a.pack.id + '" is in the Pack library but NOT installed here'
                        + ' — you answered no for this card this session. Install it once from its library row and'
                        + ' every later save hot-reloads it.');
                    continue;
                }
                let act = await lane.activate(a.pack, sink.full ? {} : { sections: sink.sections });
                // §8/§13/§11 adoption — the card owns a surface this pack writes differently. One
                // question, at most once per dev-server process; a decline is a setup step, not a fault.
                if (act.action === 'needs-adopt') act = await resolveAdopt(a, lane, act, sink);
                if (act.ok) {
                    applied++;
                    log.lifecycle(devApplyLogLine(a.pack, changedFiles, (act.action || 'applied') + ' [' + sink.why + ']'));
                } else if (isSetupRefusal(act.action)) {
                    // NOT a failure: a plugin's call bindings are the user's own first-install answers,
                    // and the loop reuses them rather than inventing them (D-F stops at overwriting the
                    // CARD, never at choosing FOR the user). One click, once, and every later save
                    // hot-reloads like any other artifact.
                    // The FACT is the probe's below, not this arm's — one source, so the line reads the
                    // same whether it was painted by an apply or by a tab repaint.
                    log.lifecycle('"' + a.pack.id + '" is waiting on a one-time setup step: ' + (act.reasons || [])[0]);
                } else {
                    failed++;
                    // Boot-order refusals cure themselves — marked here; CHAT_CHANGED retries. BOTH
                    // forms are asked: the ACTION enum is what an activation returns, the reason prose
                    // is all a library write has. Reached even with the lobby guard above, because the
                    // card can close DURING an apply that legitimately started on one.
                    if (isBootOrderAction(act.action) || isBootOrderRefusal(act.reasons)) needsCard = true;
                    log.warn('activation refused for "' + a.pack.id + '" (' + (act.action || '?') + '):', act.reasons);
                }
            }
        });
        // Facts in; devApplyOutcome and devLoopStatus decide what they mean. The toast fires ONLY for a
        // real failure: a setup step is not an error, and an error toast for one is what made a working loop
        // read as broken (live 2026-08-28). A card that changed under the apply is not probed: the probe
        // reads the open card, which is not this one.
        isCardChanged = openCardKey() !== cardKey;
        const outcome = devApplyOutcome({ failed, needsCard, isCardChanged });
        needsCard = outcome.needsCard;
        const setupNeeded = isCardChanged ? [] : await probeSetupNeeded(probeSubjects);
        setStatus({
            connected: true,
            transportProblem: '',
            version: payload.version,
            applied,
            skipped: skip,
            setupNeeded,
            waitingForCard: outcome.waitingForCard,
            failed: outcome.failed,
            appliedCardKey: cardKey,
            isApplying: false,
        });
        if (outcome.shouldToast) toast('error', 'Dev loop: ' + failed + ' artifact(s) failed to apply — the console names each reason.');
    } finally {
        applying = false;
        // An apply that threw never reached its last status: the row must not say Applying forever.
        if (statusFacts.isApplying) setStatus({ isApplying: false });
        if (queued) { const files = queued; queued = null; void applyWorkspace(files); }
        // The card changed under the apply and another is open: the CHAT_CHANGED that would retry already fired
        // while this apply held the loop, so the retry runs now. In the lobby it waits for the next chat.
        else if (isCardChanged && hasActiveCharacter()) void applyWorkspace([]);
    }
}

function startDevLoop() {
    stopDevLoop();
    const url = String(settings().url || '').replace(/\/+$/, '');
    if (!url) { setStatus({ enabled: true, connected: false, transportProblem: 'no-url' }); return; }
    setStatus({ enabled: true, connected: false, transportProblem: '' });
    source = new EventSource(url + '/events');
    // CONNECTED is painted the moment the server says hello, BEFORE the apply it triggers. The pill
    // answers one question — connected or not — and answering it only as a side effect of a FINISHED
    // apply left it lying whenever the apply blocked: restart the server and the reconnect's apply
    // stops at the fence dialog, so the line kept the red "server unreachable" from the outage while
    // the socket was open and a modal was waiting for an answer (live repro 2026-09-01). Anything the
    // apply then learns overwrites this within the same pass.
    source.addEventListener('hello', () => {
        setStatus({ connected: true, transportProblem: '' });
        void applyWorkspace([]);
    });
    source.addEventListener('change', (ev) => {
        let files = [];
        try { files = JSON.parse(ev.data).files || []; } catch (e) { log.warn('unreadable change event:', e); }
        void applyWorkspace(files);
    });
    // EventSource reconnects on its own; this only keeps the status line truthful meanwhile.
    source.onerror = () => setStatus({ connected: false, transportProblem: 'unreachable' });
    log.lifecycle('watching ' + url);
}

function stopDevLoop() {
    if (source) { source.close(); source = null; log.lifecycle('stopped'); }
    probeSubjects = [];
    setStatus({ enabled: false, connected: false, transportProblem: '', setupNeeded: [], failed: 0, waitingForCard: false, appliedCardKey: '' });
}

// ── W9: capture the developer's regex order (§2.8) ──────────────────────

// [{ name, declaredOrder }] per dev-managed artifact shipping 2+ regexes — refreshed by every apply.
let captureSubjects = [];

// A drag in ST's regex list persists to the card and ends in reloadCurrentChat(), so CHAT_CHANGED is
// the capture signal — there is no reorder event to hook. For each artifact, the card's relative
// order of ITS OWN names is compared against the source declaration; a difference POSTs the new
// order and the dev server writes regex-order.json into that artifact's regex/. From then on the
// developer's arrangement IS the declaration, surviving restarts, reinstalls and fresh cards.
//
// WHY THIS CANNOT LOOP (the W3 feedback-loop class, closed by construction): the POST triggers a
// rebuild whose apply puts declared == card, so the next CHAT_CHANGED's capturedRegexOrder returns
// null — and the merge that apply ran counted zero changes, so it asked for no reload either.
async function captureRegexOrder() {
    if (!captureSubjects.length) return;
    // The lobby again: `listRegexNames` below is a CARD read, and with no card it returns nothing,
    // which capturedRegexOrder correctly reads as "a pack regex is missing" and declines to capture.
    // Harmless, then — but it warns once per subject on the way to that non-answer, which is noise
    // charged to the developer for a question that cannot be answered here.
    if (!hasActiveCharacter()) return;
    let cardNames = null;
    for (const subject of captureSubjects) {
        if (cardNames === null) cardNames = await listRegexNames(REGEX_SCOPE_CHARACTER);
        const order = capturedRegexOrder({ declaredOrder: subject.declaredOrder, cardNames });
        if (!order) continue;
        const url = String(settings().url || '').replace(/\/+$/, '');
        try {
            const res = await fetch(url + '/regex-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ artifact: subject.name, order }),
            });
            if (!res.ok) {
                log.warn('regex order NOT captured for "' + (subject.name || '(root)') + '" — the server refused: ' + await res.text());
                continue;
            }
            // The subject's declaration is updated in place so a second CHAT_CHANGED arriving before
            // the server's rebuild round-trips cannot POST the same order twice.
            subject.declaredOrder = order;
            log.lifecycle('regex order captured — "' + (subject.name || '(root)') + '" now declares: ' + order.join(' → '));
        } catch (e) {
            log.warn('regex order capture POST failed for "' + (subject.name || '(root)') + '":', e);
        }
    }
}

// CHAT_CHANGED hook, called from src/index.js's one listener — and it retries ONLY while a
// boot-order refusal is pending. It must NOT fire on every chat change while enabled: a successful
// apply rewrites regexes, the regex apply ends in reloadCurrentChat(), the reload fires
// CHAT_CHANGED — so "re-apply whenever enabled" is a feedback loop that reloads SillyTavern forever
// (live, 2026-08-27). A boot-order refusal happens BEFORE any write, so its retry cannot re-trigger
// the event, and the loop terminates by construction. The W9 capture check rides the same event and
// terminates by its own construction (captureRegexOrder's header).
export function devLoopChatChanged() {
    if (source && needsCard && !applying) void applyWorkspace([]);
    if (source && !applying) void captureRegexOrder();
}

// Wire the toggle + URL field, and resume watching if the setting was left on last session.
export function wireArtifactDevLoopUI() {
    const s = settings();
    $('#mvuh_devloop_enabled').prop('checked', !!s.enabled).on('change', function () {
        s.enabled = this.checked;
        saveSettingsDebounced();
        if (s.enabled) startDevLoop(); else stopDevLoop();
    });
    $('#mvuh_devloop_url').val(s.url).on('change', function () {
        s.url = String($(this).val() || '').trim();
        saveSettingsDebounced();
        if (s.enabled) startDevLoop();   // reconnect against the new URL
    });
    if (s.enabled) startDevLoop(); else setStatus({ enabled: false, connected: false });
}
