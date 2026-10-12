// standalone-probe engine — the plugin's resolveRelay, and the half of this plugin that does the work.
// Version: `const ENGINE_VERSION` below — the ONE place it is written. Bump it on every change.
// It is REPORTED, displayed and logged, never COMPARED: mvu-helper reads it off this module when
// the engine is loaded, and off this declaration line when validating an artifact that is not
// running yet. Nothing gates on it.
//
// WHAT IT IS FOR. The POST window hands over ONE string a model transcribed. Everything after that is
// deterministic and lives here: splitting it, naming the characters, stepping the turn, deciding
// whether this fire is a repeat. A model is asked for one observation; the numbers are never its job.
//
// WHAT IT PROVES. On a card with NO GameLogic Pack there is no game resolver to run behind: this file
// writing anything is the live proof that the plugin relay runs alone there, once per reply.
//
// THE PATCH SHAPE. Ops carry ABSOLUTE JSON Pointers built off `ownPointer`, the host hands them to
// Mvu.parseMessage, and the card's Zod judges every one — a write outside this plugin's own root is
// refused here exactly as it would be from the POST window. Nothing below aims outside it.
const ENGINE_VERSION = 'v0.9';

module.exports = {
    ENGINE_VERSION,
    resolveRelay({ ownState, snapshot, ops, exposes, engine, roster, ownRoot, ownPointer, pluginVersion, mid, swipe }) {
        const previous = (ownState && typeof ownState === 'object') ? ownState : {};
        const unwrap = (v) => (Array.isArray(v) ? v[0] : v);
        const applied = Array.isArray(ops) ? ops : [];
        const here = String(mid) + ':' + String(swipe);
        const patches = [];

        // ── the POST write, read from the APPLIED ops rather than from state ──────────────
        // `ops` is a diff of what this turn actually landed, so finding the write here proves it
        // APPLIED — where reading `ownState` alone could return a value some earlier turn wrote and
        // report a POST that never ran. Absent from ops = the POST window emitted nothing this turn.
        const postOp = applied.find((o) => String((o && o.path) || '') === ownRoot + '.PostSaid');
        const said = postOp ? String(postOp.new === undefined ? '' : postOp.new).trim() : '';

        // ── the once-fence, engine-owned ─────────────────────────────────────────────────
        // The host guards one run per generation epoch; this guards the TURN, so a second POST pass
        // over the same reply (a manual re-run, a re-fire in a new epoch) cannot step the count twice.
        // There is no dice pool to key on — a standalone plugin has no dealer — so the turn identity
        // the host already supplies is the key, which is the more honest one anyway.
        const lastAt = String(unwrap(previous.RelayAt) === undefined ? '' : unwrap(previous.RelayAt));
        const repeat = lastAt === here;
        const turn = repeat ? (Number(unwrap(previous.RelayTurn)) || 0) : (Number(unwrap(previous.RelayTurn)) || 0) + 1;

        // ── the transcription, parsed ────────────────────────────────────────────────────
        // "Name=clothing | Name=clothing", the shape the POST entry asks for. Every failure mode is
        // RECORDED rather than repaired: an unsubstituted placeholder, an unsplittable pair and an
        // empty name each name themselves in `RelaySaidNote`, because a resolver that quietly fixes a
        // broken transcription hides the window that produced it.
        const MAX_CHARACTERS = 12;
        const wrote = [];
        const skipped = [];
        let note;
        if (!postOp) {
            note = 'the POST window emitted no op this turn';
        } else if (!said || said.toLowerCase() === 'none') {
            note = 'POST reported nothing worn this turn';
        } else if (said === 'OUTFITS_HERE') {
            note = 'POST copied the block but never replaced OUTFITS_HERE — the transcription step was skipped';
        } else {
            for (const pair of said.split('|')) {
                const at = pair.indexOf('=');
                if (at < 0) { skipped.push('no "=" in "' + pair.trim().slice(0, 30) + '"'); continue; }
                const rawName = pair.slice(0, at).trim();
                const outfit = pair.slice(at + 1).trim();
                // The key drops only what the PATH MACHINERY cannot carry — '/' and '~' (a JSON
                // Pointer would have to escape them), '.' and brackets (MVU converts the pointer to a
                // lodash path, which splits on those), quotes and whitespace (runs become one '_').
                // Everything else survives VERBATIM, deliberately including CJK: a key reduced to
                // [A-Za-z0-9_] would refuse 橘美月 as "unusable name" on a card whose narrator writes
                // CJK names, and the wardrobe would never fill. A name that still reduces to nothing is
                // skipped by name, never silently dropped.
                const key = rawName.replace(/[/~.[\]"'\s]+/g, '_').replace(/^_+|_+$/g, '');
                if (!key) { skipped.push('unusable name "' + rawName.slice(0, 30) + '"'); continue; }
                if (!outfit) { skipped.push('"' + key + '" had no clothing after the "="'); continue; }
                if (wrote.length >= MAX_CHARACTERS) { skipped.push('over the ' + MAX_CHARACTERS + '-character cap'); continue; }
                // The parent is CREATED, never assumed, and each character is ONE object-valued op.
                // MVU's native json_patch (the no-Zod card) refuses a deep add through a missing
                // parent — "Cannot assign into path … holds a primitive value (undefined)" — where the
                // Zod lane creates intermediates, so per-field ops would land on one card kind and
                // vanish on the other. Ops apply in order within one parse, so the guard op below
                // makes every later character op's parent real on both card kinds. Guarded on PREVIOUS
                // state because an unconditional  add /Characters {}  is a set — it would wipe the roster.
                if (!wrote.length && !(previous.Characters && typeof previous.Characters === 'object')) {
                    patches.push({ op: 'add', path: ownPointer + '/Characters', value: {} });
                }
                patches.push({ op: 'add', path: ownPointer + '/Characters/' + key, value: { Outfit: outfit, RecordedAt: here } });
                wrote.push(key);
            }
            note = wrote.length
                ? 'recorded ' + wrote.join(', ') + (skipped.length ? ' · skipped: ' + skipped.join('; ') : '')
                : 'nothing usable in the transcription · ' + skipped.join('; ');
        }

        // ── the lane facts ───────────────────────────────────────────────────────────────
        // What this plugin can see of the card it landed on, recorded rather than asserted. On a
        // standalone card `engine.name` is null and the roster is this plugin alone; both are the
        // honest values, and reading them back is how "it ran with no game" stops being a claim.
        const neighbours = Object.keys(roster || {}).filter((id) => id !== 'standalone-probe');
        const castPath = (exposes && typeof exposes === 'object') ? exposes['cast@1'] : undefined;
        // ── WORKED EXAMPLE: reading state that is NOT ours ───────────────────────────────
        // Kept here on purpose as the reference for plugin authors. A plugin is fenced on WRITES by
        // the card's schema, never on reads: `snapshot` is the whole stat_data as it stands this
        // turn, and `exposes` is this plugin's own declared interfaces resolved to the game's paths
        // ({"cast@1": "Classmate"} on a School card, {} when no pack answered).
        //
        // TWO LANES REACH FOREIGN STATE, and they are not rivals:
        //   ENGINE (here)      — pick it when the value must be COMPUTED: joined, counted, compared,
        //                        or found by ENUMERATING keys nobody can name in advance.
        //   DECLARATION (panel/panel.json) — pick it for a plain read. `$.World.Time` and
        //                        `{cast@1}.Mitsuki.Hobbies` bind straight to the panel with no code,
        //                        so nothing can go stale. That file is the other half of this example.
        //
        // PORTABILITY IS THE WHOLE POINT OF THE TOKEN. `exposes['cast@1']` is why nothing below
        // spells "Classmate": swap the pack and the same code reads the new one's cast. A raw
        // `snapshot.World.Time` has no such indirection — it is the author stating they know THIS
        // card's shape, which is legitimate and is why it stays available.
        const readPath = (root, dotted) => String(dotted || '').split('.').filter(Boolean)
            .reduce((node, key) => ((node && typeof node === 'object') ? node[key] : undefined), root);

        // 1. ONE RAW ABSOLUTE READ — stat_data.World.Time. MVU stores most leaves as a
        //    [value, "Label"] tuple, so `unwrap` is what turns ["07:30","Time"] into "07:30".
        const worldTime = unwrap(readPath(snapshot, 'World.Time'));

        // 2. ONE COLLECTION LOOP through an exposed interface. The cast member is CHOSEN rather than
        //    named — a hardcoded "Mitsuki" would tie this example to one card, and enumerating is
        //    the thing a declaration cannot do. Hobbies is a map { Baking: { Desc }, ... }, so its
        //    KEYS are the hobby names.
        const cast = castPath ? readPath(snapshot, castPath) : undefined;
        const castNames = (cast && typeof cast === 'object') ? Object.keys(cast) : [];
        const hobbies = castNames.length ? readPath(cast[castNames[0]], 'Hobbies') : undefined;
        const hobbyNames = (hobbies && typeof hobbies === 'object' && !Array.isArray(hobbies)) ? Object.keys(hobbies) : [];
        const hobbyNote = !castPath ? 'cast@1 not exposed — no pack to read'
            : !castNames.length ? 'cast@1 resolved to "' + castPath + '" but it holds nobody'
                : hobbyNames.length ? castNames[0] + ': ' + hobbyNames.join(', ')
                    : castNames[0] + ' has no Hobbies map';

        const log = (Array.isArray(previous.RelayLog) ? previous.RelayLog : []).slice();
        log.push('t' + turn + ' @' + here + (repeat ? ' REPEAT' : '')
            + ' ops=' + applied.length + ' wrote=' + wrote.length
            + ' engine=' + ((engine && engine.name) || 'none'));

        patches.push(
            { op: 'add', path: ownPointer + '/RelayTurn', value: turn },
            { op: 'add', path: ownPointer + '/RelayAt', value: here },
            { op: 'add', path: ownPointer + '/RelayRepeat', value: repeat },
            { op: 'add', path: ownPointer + '/RelaySaidNote', value: note },
            { op: 'add', path: ownPointer + '/RelayOps', value: applied.length },
            { op: 'add', path: ownPointer + '/RelayEngine', value: (engine && engine.name) ? (engine.name + ' ' + (engine.version || '(no version)')) : 'none — running standalone' },
            { op: 'add', path: ownPointer + '/RelayCast', value: castPath ? ('cast@1 -> ' + castPath) : 'cast@1 not exposed — degraded, as declared' },
            { op: 'add', path: ownPointer + '/RelayNeighbours', value: neighbours.length ? neighbours.join(', ') : 'none' },
            { op: 'add', path: ownPointer + '/RelayVersion', value: String(pluginVersion || '?') },
            // the worked example's results, so the panel can show the ENGINE lane's reads beside
            // the DECLARATION lane's bindings of the same two values
            { op: 'add', path: ownPointer + '/ExampleWorldTime', value: worldTime === undefined ? 'World.Time not on this card' : String(worldTime) },
            { op: 'add', path: ownPointer + '/ExampleHobbies', value: hobbyNote },
            { op: 'add', path: ownPointer + '/RelayLog', value: log.slice(-10) },
        );

        return {
            patches,
            log: ['standalone-probe: relay ' + turn + ' at ' + here + (repeat ? ' (repeat fire — turn not stepped)' : '')
                + ' — saw ' + applied.length + ' applied op(s), ' + note + ', sending ' + patches.length + ' op(s)'],
        };
    },
};
