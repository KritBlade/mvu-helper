// COPY — do not edit here. Source: GameLogic/_engine/eventpack.cjs; refresh with Tools/build_workspace.cjs.
/* ============================================================================
 * eventpack.cjs — the GENRE-NEUTRAL event engine (Cluster 6C).  v1.0.4  (WHEN-DSL grammar v1.7.0)
 *
 * ⚠ GENRE WORKSPACES HOLD COPIES OF THIS WHOLE FILE. It is a LIBRARY member of an artifact's
 * `engine/` folder (mvu-helper/plans/executed/artifact-development-workflow.md §2.3): a creator drops it in,
 * names it in `engineOrder`, and ships — so the artifact folder stays self-contained and no genre
 * can break another by editing it. THIS file is the source of truth. After changing it, re-run each
 * genre's workspace build (School: `node Tools/build_workspace.cjs`) or that genre keeps shipping
 * the old engine while its sources say otherwise. Its verifier fails on a stale copy.
 *
 * ⚠ THE COMPATIBILITY PROMISE — what a creator on an OLDER copy may rely on. This file is meant to be
 * taken AS-IS to build a new genre, so three rules bind every change to it (GENRE_FILE_CONVENTION §12):
 *   1. GRAMMAR FROZEN. A new token kind or LHS form bumps FORMAT, needs the three-file grammar sync
 *      (this file · mvu-helper · MvuStatMenuBuilder) and makes every ALREADY-SHIPPED card refuse packs
 *      that use it. Ration these hard.
 *   2. EVERY NEW ADAPTER HOOK IS OPTIONAL. A newly REQUIRED hook is worse than a grammar bump: a
 *      grammar bump fails loudly at install time, a missing hook is a TypeError mid-story on someone's
 *      card. Guard it (`typeof adapter.x === 'function'`) and degrade with a NAMED warning, never
 *      silently.
 *   3. EXISTING BEHAVIOUR IS FROZEN. The rule that gets forgotten, because it trips neither of the
 *      others. Making isEligible block on ANY closed marker state rather than only 'done' adds no
 *      grammar, no field and no hook — and silently changes eligibility for every genre already
 *      shipping. That is a MAJOR however small the diff looks.
 * What the version segments tell a creator to DO: major = re-read the contract (behaviour changed, or a
 * hook became required) · minor = grammar/FORMAT moved, re-check packs and the builder · patch =
 * nothing, a new OPTIONAL capability or a fix. Required core, unchanged since the library split:
 * triggerRoot · get · getArmed · setArmed · warn (the only one that throws by name); daysSince,
 * nowStamp, resolveScalar and getStepDone/setStepDone all degrade with a warning when absent.
 *
 * ⚠ MEMBERSHIP TEST for anything added here: can the capability be described WITHOUT naming a genre?
 * Yes = it belongs; no = it belongs in that genre's globalLogic.cjs. Note what the test is NOT —
 * whether MvuStatMenuBuilder needs it. The builder never loads this file (its whole shared surface is
 * the vendored grammar twin plus whatever a genre's adapter declares), so that test would evacuate
 * applyEventFire too. And a pack is DATA: it cannot call a function, so no runtime capability added
 * here can ever make a pack more or less portable.
 *
 * ⚠⚠⚠ THREE-FILE GRAMMAR SYNC — MANDATORY ⚠⚠⚠
 * The WHEN-DSL grammar in this file (parseToken · formatToken · formatTokenChain · formatWhenAny,
 * plus their helper predicates, regexes and the quoted-argument codec) is hand-vendored into TWO
 * other repos. ANY grammar change here MUST land in all three files in the same pass, and all
 * three carry the SAME grammar version — now v1.7.0:
 *   1. MvuGameMaker        maker-app/GameLogic/_engine/eventpack.cjs        ← SOURCE OF TRUTH (this file)
 *   2. mvu-helper          src/features/event-pack/when-dsl-grammar.js      (install-side validator/lint)
 *   3. MvuStatMenuBuilder  landing-app/src/utils/when-dsl-grammar.js        (event-builder GUI, parse+emit)
 * Copies 2 and 3 are BYTE-IDENTICAL twins (byte-compare is their drift guard); mvu-helper's drift
 * suite EXECUTES this file against copy 2 over a token corpus. Do NOT "improve" one copy alone.
 *
 * WHAT THIS IS: the ONE implementation of everything an event pack needs to run. A pack exported by
 * MvuStatMenuBuilder runs on any card whose engine loads this file and declares an adapter — no
 * per-pack code anywhere. See mvu-helper doc/event-pack-engine.md and
 * MvuStatMenuBuilder plans/executed/eventpack_revisit.md.
 *
 * WHAT LIVES HERE (write-once, all genres): materialize the trigger table · the WHEN/PREREQ
 * grammar (in{} · Present() · flag: · LHS OP RHS · raw dotted path · `!` · contains() · has() ·
 * `*` paths · whenAny OR) + &-split + num/str compare · the parse↔emit grammar pair · LHS
 * resolution (DaysSince(path) · the genre's ALIASES expanded to raw paths · the raw-path read) ·
 * scanEvents (TIME>TRG priority · most-specific-WHEN by token count · declaration-order tie-break ·
 * one-shot/series eligibility · arm) · the P8 sweep (candidates one condition from firing) ·
 * readyEvent (zero-away offer for same-reply play) · applyEventFire (verify-at-fire, on the reply's end
 * state or, when the genre passes it, the state the reply began on · applyWrites —
 * the pack's declared writes under the genre's declared RULES · done-marker · clear armed) ·
 * applyStepDone (the numbered-beat CURSOR inside one event body — narrator-reported, monotonic).
 *
 * WHAT STAYS PER-GENRE — the `adapter` (School's EVENT_PACK_ADAPTER in globalLogic.cjs). Every entry
 * DECLARES a genre fact: a path, a rule, a clock, a recorder. None is per-pack, none is an applier.
 *   adapter.triggerRoot / armedPath   dotted paths, read straight off the adapter. The
 *                    library keeps its OWN stores beside the trigger table: <root>.installed (the
 *                    installer's watermark, read by the owner gate) and <root>.fired (the done-marker).
 *   adapter.writes   [{ path, ownerStamp, fixed, stamp, locked, monotonic, fillOnly, add, clamp,
 *                       removable, removeAtZero, capacity }]  WHERE a pack may write and under which RULES
 *                    (see applyWrites)
 *   adapter.rewards  OPTIONAL [{ name, path, keyed, fields, clamp, max } | { …, text, maxLength }]
 *                    WHAT a row may PAY when it fires (see applyRewards). `keyed: true` makes the path a
 *                    COLLECTION and the row names the member; `text: true` makes the kind pay PROSE,
 *                    written over the field and bounded by `maxLength` instead of a ceiling. Absent =
 *                    this genre pays nothing through events, and a row asking is told so by name.
 *                    A reward editor reads this array to know which kinds exist and their ceilings.
 *   adapter.nowStamp(sd)           the clock — the string a `stamp` field receives on every write
 *   adapter.daysSince(sd, stamp)   whole days from a stamp to "today" (null = not a stamp). The genre
 *                                  owns both ends: only it knows which day is being PLAYED. A plain
 *                                  civil clock points at civilDaysSince (exported here) in one line.
 *   adapter.aliases  { 'Loc': 'World.Location', 'Aff(*)': 'Classmate.*.Affection', … }  the LHS
 *                    sugar as DATA: `*` captures a segment or paren argument, in order, and is
 *                    substituted into the path; a pack builder offers the KEYS beside LIBRARY_SUGAR
 *   adapter.presence 'Classmate.*.Is_present'  the path Present(Name) tests (=== true after unwrap)
 *   adapter.resolveScalar(sd, lhs)  OPTIONAL — a genuinely COMPUTED form the aliases cannot express;
 *                                   returns lhs unchanged when it does not claim it
 *   adapter.sugar    the computed forms resolveScalar claims (offered beside the alias keys); [] if none
 *   adapter.scopes   the scope VALUES a row may declare. Stored VERBATIM on the done-marker and never
 *                    interpreted here — the genre's own reset reads it to decide what a new arc clears
 *   adapter.get(t, d)    unwrap a stored value (MVU tuples [value,"Label"] → value; default d)
 *   adapter.getArmed(sd) / setArmed(sd, v)         the armed-event pointer (String '@key' | '')
 *   adapter.getStepDone(sd) / setStepDone(sd, v)   OPTIONAL — the "<phase>.<step>" cursor string;
 *                    only a genre whose event bodies carry numbered beats (applyStepDone)
 *   adapter.warn(message)   the genre's warn channel — a DaysSince path that resolves to nothing, a
 *                           hook the adapter forgot to declare. Never silent.
 *
 * GENERIC RAW-PATH RESOLVE: an LHS that is a stat_data path is read straight from stat_data (via
 * adapter.get, so a tuple unwraps). A builder-emitted `Mainchar.Money` resolves on ANY card with zero
 * genre code; an alias (`Aff(X)`) is a spelling on top of the same read.
 *
 * Dual-mode delivery (mirrors engine/i18n.cjs verbatim):
 *   • Node/tests: module.exports — unit-tested standalone via each genre's Tools/test_resolver.cjs.
 *   • In a card: sets root.__EVENTPACK__; the genre's globalLogic reads that when `require` is absent.
 *     The genre's pack lists this file in engineOrder before its globalLogic, so it runs first in the
 *     same engine script.
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node (globalLogic + tests)
  if (root && typeof root === 'object') root.__EVENTPACK__ = api;              // in a card's engine script
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- the format contract -------------------------------------------------------
  // The pack-format level THIS file's grammar + write handling implement. Bump the MAJOR when a new
  // PREDICATE lands (an older engine returns false for it, so the event never fires — broken, not
  // graceful); bump the MINOR for a new write rule or optional field (an older engine ignores it and
  // the event still fires, minus the extra). That split is what lets an installer tell "cannot run
  // this" from "runs it, minus some extras". 1.0 is the first released format: everything this
  // grammar knows (`!` · contains · has · `*` · whenAny · fx.writes) is 1.0; 1.1 adds fx.reward; 1.2 lets a
  // keyed reward name its member by a selector (`<path>.*.<field>`).
  //
  // ⚠ SINGLE SOURCE. A genre surfaces this constant by re-exporting it as `EVENT_PACK_FORMAT`, and
  // every reader takes the level from there. Never restate it as a literal — a second copy is a copy
  // that can disagree, and a gate that disagrees with its own engine waves through packs that cannot run.
  var FORMAT = '1.2';

  // The row-fx keys the FORMAT owns. `summary` is the row's human LABEL (the pack tab shows it; nothing
  // in this file writes it anywhere), `scope` is stored verbatim on the done-marker, `writes` is the list
  // applyWrites runs and `reward` the payout applyRewards pays. Any other key under `fx` is unknown to
  // this format and is REPORTED, never silently dropped.
  var FX_META = ['summary', 'scope', 'writes', 'reward'];

  // The WHEN-DSL LHS forms THIS file resolves for every genre, with no adapter code beyond the hooks
  // named in the header. The pack builder joins them with the genre's alias keys and its computed
  // forms, read off the running bundle, so they are offered on every card. `*` = the free part.
  var LIBRARY_SUGAR = ['DaysSince(*)'];

  // ---- neutral helpers ---------------------------------------------------------
  // Plain dotted read (the trigger table is a PLAIN record, not tuples — no unwrap here).
  function getByPath(obj, dotted) {
    var cur = obj;
    var segs = String(dotted).split('.');
    for (var i = 0; i < segs.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[segs[i]];
    }
    return cur;
  }

  // Materialise adapter.triggerRoot's record into the array shape the scan/fire code expects — injecting
  // the record KEY as `key` and preserving insertion order (JSON string keys) for the declaration-order
  // tie-break. No rows ⇒ [] ⇒ nothing ever arms/fires (safe no-op).
  function eventTriggers(sd, adapter) {
    var t = getByPath(sd, adapter.triggerRoot) || {};
    return Object.keys(t).map(function (k) { return Object.assign({ key: k }, t[k]); });
  }

  // Specificity for the most-specific-WHEN tie-break in eligibleWinner: count of real (non '-'/'')
  // &-tokens across prereq+when. For a `whenAny` row the honest count is the alternative that
  // ACTUALLY HOLDS (only ELIGIBLE rows are ranked, so one does) — summing or maxing across
  // alternatives would let a row outrank a genuinely specific one on the strength of a branch that
  // did not fire. sd/adapter are optional: without them (a pure caller, e.g. a lint) it falls back to
  // the SHORTEST alternative, the most conservative claim a row can make about itself.
  function tokCount(t, sd, adapter) {
    var count = function (s) { return String(s || '').split('&').filter(function (x) { return x.trim() && x.trim() !== '-'; }).length; };
    var alts = whenAlternatives(t), whenCount = null;
    if (sd && adapter) {
      for (var i = 0; i < alts.length; i++) {
        if (evalTokens(sd, alts[i], adapter)) { whenCount = count(alts[i]); break; }
      }
    }
    if (whenCount === null) {
      for (var j = 0; j < alts.length; j++) {
        var c = count(alts[j]);
        if (whenCount === null || c < whenCount) whenCount = c;
      }
    }
    return count(t.prereq) + (whenCount || 0);
  }

  var cmpNum = function (op, a, b) { a = Number(a) || 0; b = Number(b) || 0; return op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b; };
  var cmpStr = function (op, a, b) { a = String(a); b = String(b); return op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b; };

  // ---- WHEN / PREREQ predicate DSL — evaluate one &-joined predicate string against live stat_data
  // (READ-ONLY, no side effects). Returns true iff EVERY token holds; '' / '-' = no constraint = true.
  // Tokens: LHS in {a,b} · Present(Name) · flag:key[=state] · LHS OP RHS (OP >= <= == = > <) ·
  // `!TOKEN` · contains(LHS, "s") · has(LHS, "e") · `*` path segments — all pack format 1.0.
  // RHS numeric ⇒ numeric compare, else string. Unparseable token ⇒ false (fail-safe). LHS vocabulary +
  // the raw-path fallback resolve via resolveLHS (adapter.resolveScalar + the generic dotted-path read).
  //
  // RAW_PATH: a raw dotted path, RELATIVE to stat_data (never `stat_data.`-prefixed) — matching every
  // shipped token and MvuStatMenuBuilder's own `collectionPaths`. Lowercase roots and a SINGLE segment
  // are legal (the builder's picker is Object.keys() over the author's own stat_data and capitalises
  // nothing). `*` segments fan out (ANY-match).
  // SAFE because the read passes the path as the DEFAULT — a path that does not exist returns the
  // path string, i.e. plain literal behaviour (`Happy=Happy` stays true, and a NUMERIC compare reads
  // the string as 0). Single-segment resolution only changes anything when stat_data genuinely HAS
  // that key, which is the case you want it to work.
  var RAW_PATH = /^[A-Za-z_$][\w$]*((\.(\w+|\*))+)?$/;
  var DAYS_SINCE = /^DaysSince\((.+)\)$/i;

  // LHS RESOLUTION ORDER — load-bearing, so it is written once, here:
  //   1. DaysSince(<path>)          a LIBRARY form (LIBRARY_SUGAR); needs adapter.daysSince
  //   2. an alias the adapter declares   expanded to a raw path, then read like 3
  //   3. adapter.resolveScalar      OPTIONAL: a computed form; returns lhs unchanged when unclaimed
  //   4. a raw dotted path          read straight from stat_data through adapter.get
  //   5. anything else              the literal itself
  function resolveLHS(sd, lhs, adapter) {
    var m = String(lhs).match(DAYS_SINCE);
    if (m) return daysSinceAtPath(sd, m[1].trim(), lhs, adapter);
    var expanded = expandAlias(lhs, adapter);
    if (expanded !== null) return adapter.get(getByPath(sd, expanded), expanded);
    if (typeof adapter.resolveScalar === 'function') {
      var v = adapter.resolveScalar(sd, lhs);
      if (v !== lhs) return v;
    }
    if (RAW_PATH.test(lhs)) return adapter.get(getByPath(sd, lhs), lhs);
    return lhs;
  }

  // ALIASES AS DATA. An alias key is a template: every `*` captures one segment or one paren
  // argument (lazy, so the literal text around it — parens, dots — bounds the capture); the captures
  // are substituted, in order, into the `*` slots of the value. `'Aff(*)': 'Classmate.*.Affection'`
  // turns `Aff(Mitsuki)` into `Classmate.Mitsuki.Affection`; `'Trait(*).*': 'Classmate.*.*'` carries
  // two captures. Matching is case-insensitive, like the sugar branches it replaced. Returns null when
  // no alias matches, so a genre declaring none costs nothing.
  function expandAlias(lhs, adapter) {
    var table = adapter.aliases;
    if (!table || typeof table !== 'object') return null;
    var keys = Object.keys(table);
    for (var i = 0; i < keys.length; i++) {
      var re = aliasRegex(keys[i]);
      var m = String(lhs).match(re);
      if (!m) continue;
      var captures = m.slice(1), n = 0;
      return String(table[keys[i]]).replace(/\*/g, function () { return n < captures.length ? captures[n++] : '*'; });
    }
    return null;
  }
  var aliasRegexCache = {};
  function aliasRegex(key) {
    if (!aliasRegexCache[key]) {
      var src = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '(.+?)');
      aliasRegexCache[key] = new RegExp('^' + src + '$', 'i');
    }
    return aliasRegexCache[key];
  }

  // DaysSince(<dotted stat_data path>) — whole days from the stamp that path holds to the day being
  // played. The library owns the outcome table; the genre owns the subtraction (adapter.daysSince):
  //   path resolves to nothing   ⇒ WARNED (a misspelled path would otherwise silently un-gate the
  //                                 event), reads Infinity — so put DaysSince AFTER the token that
  //                                 proves the record exists (`Quest(X).Step==1 & DaysSince(…)>=1`)
  //   empty stamp                ⇒ Infinity ("never"): a cooldown `>=N` opens, a recency `<=N` stays shut
  //   adapter.daysSince returns null ⇒ WARNED (not a datetime stamp), Infinity
  //   no adapter.daysSince at all    ⇒ WARNED once per adapter, Infinity — never a silent civil-day default
  function daysSinceAtPath(sd, dotted, token, adapter) {
    var raw = getByPath(sd, dotted);
    if (raw === undefined) { warn(adapter, 'WHEN-DSL ' + token + ': the path resolves to nothing — reads as never (Infinity); check the spelling'); return Infinity; }
    var stamp = String(adapter.get(raw, '')).trim();
    if (!stamp) return Infinity;
    if (typeof adapter.daysSince !== 'function') {
      warnOnce(adapter, 'daysSince', 'WHEN-DSL DaysSince unavailable: the adapter declares no daysSince(sd, stamp) — every DaysSince() reads never (Infinity)');
      return Infinity;
    }
    var n = adapter.daysSince(sd, stamp);
    if (n === null || n === undefined || typeof n !== 'number' || isNaN(n)) {
      warn(adapter, 'WHEN-DSL ' + token + ': "' + stamp + '" is not a datetime stamp — reads as never (Infinity)');
      return Infinity;
    }
    return n;
  }
  // The civil-clock subtraction, for a genre whose "today" IS the civil date: `YYYY-MM-DD[ HH:MM]`
  // in, whole days out, null when either side is not a date. A genre points at it in one line —
  // `daysSince: function (sd, stamp) { return EVENTPACK_API.civilDaysSince(nowStamp(sd), stamp); }` —
  // rather than the library guessing that its clock is civil.
  function civilDayNumber(stamp) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp == null ? '' : stamp).trim());
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return isNaN(ms) ? null : Math.floor(ms / 86400000);
  }
  function civilDaysSince(nowStamp, stamp) {
    var a = civilDayNumber(stamp), b = civilDayNumber(nowStamp);
    return (a === null || b === null) ? null : b - a;
  }

  // Present(Name) — the declared presence path with its ONE `*` replaced by the name, unwrapped,
  // tested === true. No path declared ⇒ warned once per adapter, false (an event must not fire on a
  // presence nobody can see).
  function isPresentAt(sd, name, adapter) {
    var path = adapter.presence;
    if (typeof path !== 'string' || !path) {
      warnOnce(adapter, 'presence', 'WHEN-DSL Present() unavailable: the adapter declares no presence path — reads false');
      return false;
    }
    return adapter.get(getByPath(sd, path.replace('*', name)), false) === true;
  }
  // THE DONE-MARKER — the library's OWN bookkeeping, at <trigger root>.fired.<key>:
  //     { state: 'done', scope: <the row's fx.scope verbatim>, at: <adapter.nowStamp(sd) | ''> }
  // It sits in the platform's own root, never in a genre store the player edits as prose: a world log
  // is prunable by design, and a flag living inside one un-fires itself when the player tidies it.
  // EVERY row is a one-shot by this marker, series included — a chain stays closed even after the quest
  // record its steps gated on is deleted. `scope` is stored, never read here: the genre's arc reset
  // decides which markers a new loop clears. Read by isEligible/sweep and the `flag:` predicate.
  function firedState(sd, key, adapter) {
    var path = siblingRoot(adapter, 'fired');
    var table = path ? getByPath(sd, path) : undefined;
    var rec = (table && typeof table === 'object') ? table[key] : undefined;
    return rec ? String(adapter.get(rec.state, '')) : '';
  }
  function markFired(sd, key, scope, adapter) {
    var path = siblingRoot(adapter, 'fired');
    var table = path ? ensurePath(sd, path) : null;
    if (!table) { warn(adapter, 'adapter.triggerRoot must be a dotted path with room for a sibling store — ' + key + ' cannot be marked fired, so it can fire again'); return; }
    table[key] = {
      state: 'done',
      scope: String(scope || ''),
      at: typeof adapter.nowStamp === 'function' ? String(adapter.nowStamp(sd)) : '',
    };
  }
  // The library's own stores sit BESIDE the genre's trigger table, in the root the installer owns:
  // <root>.installed (packOwnerOf) and <root>.fired (the marker above). One derivation, two readers.
  function siblingRoot(adapter, name) {
    var root = String(adapter.triggerRoot || '');
    return root.indexOf('.') >= 0 ? root.replace(/\.[^.]+$/, '.' + name) : '';
  }

  // The warn channel is the adapter's; a library that printed on its own would bypass the genre's
  // logger. A missing warn is itself an error — the one thing that cannot be warned about is thrown.
  function warn(adapter, message) {
    if (typeof adapter.warn !== 'function') throw new Error('eventpack: adapter.warn(message) is required — ' + message);
    adapter.warn(message);
  }
  var warnedOnce = typeof WeakMap === 'function' ? new WeakMap() : null;
  function warnOnce(adapter, topic, message) {
    if (warnedOnce) {
      var seen = warnedOnce.get(adapter) || {};
      if (seen[topic]) return;
      seen[topic] = true;
      warnedOnce.set(adapter, seen);
    }
    warn(adapter, message);
  }

  // ---- contains()/has() and wildcard-path helpers ---------------------------------------------
  // The quoted-argument codec. `\"` and `\\` only — a deliberately tiny escape set, because every
  // escape is a spelling the GUI builder and the validator must both agree on forever.
  function unescapeArg(s) { return String(s).replace(/\\(["\\])/g, '$1'); }
  function escapeArg(s) { return String(s).replace(/([\\"])/g, '\\$1'); }

  // Expand a dotted path into EVERY node it names. Without `*` that is one node (or none); with `*`
  // it fans out over an array's items or a record's own values. Returns [] when nothing matches —
  // which is why ANY-match semantics can never be vacuously true (zero matches ⇒ false).
  function nodesAtPath(sd, dotted) {
    var segs = String(dotted).split('.');
    var cur = [sd];
    for (var i = 0; i < segs.length && cur.length; i++) {
      var seg = segs[i], next = [];
      for (var j = 0; j < cur.length; j++) {
        var node = cur[j];
        if (node === null || typeof node !== 'object') continue;
        if (seg === '*') {
          // Fan out one level. An MVU tuple [value, label] is a LEAF, not a collection — descending
          // into it would yield the label as if it were a sibling entry (the same shape
          // MvuStatMenuBuilder's isCollection guards against).
          if (isTuple(node)) continue;
          var keys = Object.keys(node);
          for (var k = 0; k < keys.length; k++) next.push(node[keys[k]]);
        } else if (Object.prototype.hasOwnProperty.call(node, seg)) {
          next.push(node[seg]);
        }
      }
      cur = next;
    }
    return cur;
  }
  function isTuple(v) { return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string'; }

  // The membership test for ONE node. Records answer over their KEYS (so `has(Mainchar.Inventory,
  // "camera")` matches the `camera` key), arrays/lists over their VALUES — the split
  // MvuStatMenuBuilder already encodes. A tuple is unwrapped first, so a list stored as
  // [["pen","camera"], "carried"] behaves the same as a bare list.
  function nodeHas(node, needle, adapter, path) {
    var v = isTuple(node) ? adapter.get(node, path) : node;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) if (String(isTuple(v[i]) ? adapter.get(v[i], path) : v[i]) === needle) return true;
      return false;
    }
    if (v && typeof v === 'object') return Object.prototype.hasOwnProperty.call(v, needle);
    return false;
  }
  // ---- parseToken — THE ONE GRAMMAR SOURCE (⚠ three-file sync, see header) ------------------------
  // PURE: token string in, descriptor out. No stat_data, no adapter, no side effects — which is exactly why
  // it can be shared with a VALIDATOR, where `evalOne` cannot: evalOne answers "is this TRUE right now"
  // and needs live state + the genre adapter, while a lint needs "does this PARSE" and has neither.
  //
  // Returns one of:
  //   { kind: 'none' }                        '' / '-'  — no constraint
  //   { kind: 'in',      lhs, set: [...] }    LHS in {a,b,c}
  //   { kind: 'present', name }               Present(Name)
  //   { kind: 'flag',    flag, state }        flag:key[=state]   (state defaults to 'done')
  //   { kind: 'cmp',     lhs, op, rhs }       LHS (>=|<=|==|=|>|<) RHS
  //   { kind: 'contains'|'has', lhs, arg }    contains(LHS, "s") / has(LHS, "e")
  //   …any of the above + `neg: true`         a leading `!`
  //   null                                    unparseable ⇒ callers fail SAFE (evaluate false / lint warns)
  //
  // Every form above is pack format 1.0, the format's first release; so are `*` paths and `whenAny`.
  //
  // BRANCH ORDER IS LOAD-BEARING: `in {}` and `flag:` are tried before the comparison branch
  // (otherwise `Mood in {a,b}` never reaches its own branch). Reordering changes which shape an
  // ambiguous token takes, i.e. changes semantics silently.
  function parseToken(tok) {
    var t = String(tok == null ? '' : tok).trim();
    if (t === '' || t === '-') return { kind: 'none' };
    // `!` NEGATION. ⚠ THE RULE THAT MAKES IT SAFE: negate only a SUCCESSFULLY parsed inner
    // token. A parse failure must stay `null` (⇒ evaluates false), never flip to true — otherwise a
    // TYPO becomes an always-true gate and silently UN-gates the event. `!` + garbage is garbage,
    // not "not garbage".
    if (t.charAt(0) === '!') {
      var inner = parseToken(t.slice(1).trim());
      if (!inner) return null;                       // unparseable inner ⇒ still unparseable (never true)
      if (inner.kind === 'none') return null;        // `!` / `!-` — "not no-constraint" is meaningless
      if (inner.neg) return null;                    // `!!x` — no canonical spelling, so no round-trip
      inner.neg = true;
      return inner;
    }
    var m;
    // contains() / has(). Three NON-OVERLAPPING membership verbs, so no reading is ambiguous:
    //   `in {a,b}`  scalar ∈ the AUTHOR's literal set
    //   contains()  string ⊃ substring, case-sensitive
    //   has()       collection ∋ element — over KEYS for a record, VALUES for an array/list
    // The argument is ALWAYS double-quoted with `\"` and `\\` escapes, so a value containing a quote,
    // comma or paren is expressible. LHS carries no commas — that is what lets the split be
    // unambiguous without a real parser.
    if ((m = t.match(/^(contains|has)\(\s*([^,]+?)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)$/i))) {
      return { kind: m[1].toLowerCase(), lhs: m[2].trim(), arg: unescapeArg(m[3]) };
    }
    if ((m = t.match(/^(.+?)\s+in\s+\{([^{}]*)\}$/i))) {
      return { kind: 'in', lhs: m[1].trim(), set: m[2].split(',').map(function (x) { return x.trim(); }) };
    }
    if ((m = t.match(/^Present\(([^()]+)\)$/i))) return { kind: 'present', name: m[1].trim() };
    if ((m = t.match(/^flag:([A-Za-z0-9_]+)(?:=(\w+))?$/i))) return { kind: 'flag', flag: m[1], state: m[2] || 'done' };
    if ((m = t.match(/^(.+?)(>=|<=|==|=|>|<)(.+)$/))) {
      var lhs = m[1].trim(), rhs = m[3].trim();
      // An operator character on EITHER side means the token is malformed, not a comparison.
      //   LHS (`>=40`)            — the token never had a left side.
      //   RHS (`Loc=Home=School`) — a second operator riding in the RHS compares against a literal
      //                             ("Home=School"): harmlessly always FALSE bare, but always TRUE
      //                             under `!` — a typo silently UN-GATING an event. formatToken
      //                             refuses to emit it; the parser must refuse to read it.
      if (lhs && rhs && !/[<>=]/.test(lhs) && !/[<>=]/.test(rhs)) return { kind: 'cmp', lhs: lhs, op: m[2], rhs: rhs };
    }
    return null;
  }

  // ---- formatToken — THE EMIT DIRECTION -----------------------------------------------------------
  // The inverse of parseToken: descriptor in, canonical token text out. A visual builder holds
  // descriptors (LHS dropdown · operator dropdown · RHS field) and turns them into the string a pack
  // stores, WITHOUT the author ever typing syntax. Lives beside parseToken deliberately — split the
  // two halves across files and they drift.
  //
  // THE CONTRACT: whenever it returns a string, parseToken(formatToken(d)) reads back EXACTLY d;
  // when d cannot be expressed, it returns null — it NEVER emits a token that would be misread.
  // null means "the GUI must reject this input" (disable Save), mirroring parseToken's null. One
  // convention, both directions.
  //
  // CANONICAL SPELLING is taken from shipped content, not taste — every `when`/`prereq` in the repo
  // reads `gf>=0 & Loc=Outskirts.AncientRuins & T>=16:00`: NO spaces around operators, spaces around
  // '&'. Also fewer prompt tokens, and these strings render into the [PRE] candidate lines.
  //
  // ONE-DIRECTION PROPERTY: parseToken(formatToken(d)) === d holds. formatToken(parseToken(s)) === s
  // does NOT and must not be attempted — 'A>=1', 'A >= 1' and '  A >= 1 ' all parse to the same
  // descriptor, so emitting can only produce one spelling.
  var RE_FLAG_KEY = /^[A-Za-z0-9_]+$/;
  var RE_FLAG_STATE = /^\w+$/;
  var CMP_OPS = ['>=', '<=', '==', '=', '>', '<'];

  // A value is emittable only if it survives the round trip untouched. Rejects, in order: non-strings ·
  // anything parseToken would TRIM away (a descriptor carrying ' x ' cannot round-trip, and silently
  // trimming would emit a token meaning something other than what the caller passed) · empty ·
  // newlines (a predicate is one line) · a leading '!' · and '&', which would SPLIT the token when it
  // is joined into a chain. That last one cannot be caught by a token-level round-trip test — the
  // token parses fine alone and only breaks in the chain — so it is enforced here.
  function emittable(v) {
    if (typeof v !== 'string') return false;
    if (v !== v.trim() || v === '') return false;
    if (/[\r\n]/.test(v)) return false;
    if (v.charAt(0) === '!') return false;
    return v.indexOf('&') === -1;
  }
  // An LHS additionally may not carry an operator character (it would re-parse as a different
  // comparison, or be rejected by the malformed-token guard), the ' in ' keyword (ambiguous against
  // the set branch), or brace characters that belong to the other branches' syntax.
  function emittableLhs(v) {
    if (!emittable(v)) return false;
    if (/[<>=]/.test(v)) return false;
    if (/\s+in\s+/i.test(v)) return false;
    return !/[{}]/.test(v);
  }

  function formatToken(d) {
    if (!d || typeof d !== 'object') return null;
    // NEGATION: emit the inner token and prefix '!'. Refused on `none` and on an already-negated
    // descriptor, mirroring parseToken exactly — the two halves must agree on what is unspellable or
    // the round-trip stops being a proof.
    if (d.neg) {
      if (d.kind === 'none') return null;
      var bare = {};
      for (var kk in d) if (Object.prototype.hasOwnProperty.call(d, kk) && kk !== 'neg') bare[kk] = d[kk];
      var innerStr = formatToken(bare);
      return innerStr === null || innerStr === '' ? null : '!' + innerStr;
    }
    switch (d.kind) {
      case 'none': return '';
      // contains()/has(). The arg is ESCAPED rather than screened: quotes, commas and parens are
      // all legal inside it, which is the whole reason the quoted form was chosen over a bareword.
      case 'contains':
      case 'has': {
        if (!emittableLhs(d.lhs) || typeof d.arg !== 'string') return null;
        if (/[,]/.test(d.lhs)) return null;              // a comma in the LHS would re-split the call
        return d.kind + '(' + d.lhs + ', "' + escapeArg(d.arg) + '")';
      }
      case 'cmp': {
        if (!emittableLhs(d.lhs) || !emittable(d.rhs)) return null;
        if (CMP_OPS.indexOf(d.op) === -1) return null;
        if (/[<>=]/.test(d.rhs)) return null;          // a second operator would re-split the token
        if (/[{}()]/.test(d.rhs)) return null;
        return d.lhs + d.op + d.rhs;
      }
      case 'in': {
        if (!emittableLhs(d.lhs) || !Array.isArray(d.set) || d.set.length === 0) return null;
        // An EMPTY array is refused deliberately: it would emit `X in {}`, which parses back to a
        // ONE-element set [''] — a silent meaning change the round-trip test would catch.
        for (var i = 0; i < d.set.length; i++) {
          var el = d.set[i];
          if (!emittable(el) || /[,{}]/.test(el)) return null;   // ',' splits the set, braces end it
        }
        return d.lhs + ' in {' + d.set.join(',') + '}';
      }
      case 'present':
        if (!emittable(d.name) || /[()]/.test(d.name)) return null;
        return 'Present(' + d.name + ')';
      case 'flag':
        if (typeof d.flag !== 'string' || !RE_FLAG_KEY.test(d.flag)) return null;
        if (typeof d.state !== 'string' || !RE_FLAG_STATE.test(d.state)) return null;
        // 'done' is parseToken's default, so omitting it round-trips and is shorter.
        return d.state === 'done' ? 'flag:' + d.flag : 'flag:' + d.flag + '=' + d.state;
      default: return null;
    }
  }

  // The ROW-level writer for OR: descriptor-lists → the `whenAny` array. One alternative per inner
  // list, each an AND-chain via formatTokenChain. ALL-OR-NOTHING, like formatTokenChain itself: if
  // any alternative is unemittable the whole row is refused, because emitting the survivors would
  // silently WIDEN the gate (fewer alternatives to fail ⇒ an event that fires when it should not).
  // Refuses an empty list too — `whenAny: []` would read as "no alternative can hold", i.e. never.
  function formatWhenAny(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      var chain = formatTokenChain(groups[i]);
      if (chain === null) return null;
      out.push(chain);
    }
    return out;
  }

  // Descriptors → one &-joined predicate string, the form `when`/`prereq` store. 'none' descriptors
  // are DROPPED rather than emitted as empty tokens (a stray ' & ' would leave a blank token in the
  // chain). All-none, or an empty list, yields '' — which evalTokens already reads as "no
  // constraint". Returns null if ANY token is unemittable: a partial chain is a DIFFERENT predicate,
  // and silently dropping one condition is how an event fires when it should not.
  function formatTokenChain(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d && d.kind === 'none') continue;
      var t = formatToken(d);
      if (t === null) return null;
      out.push(t);
    }
    return out.join(' & ');
  }

  function evalOne(sd, tok, adapter) {
    var p = parseToken(tok);
    if (!p) return false;                                                      // unparseable ⇒ fail-safe
    var v = evalParsed(sd, p, adapter);
    // NEGATION IS APPLIED HERE, after a SUCCESSFUL parse — never above the `if (!p)`. An unparseable
    // token must stay false whether or not it carried a '!', so a typo can only ever fail CLOSED.
    return p.neg ? !v : v;
  }
  function evalParsed(sd, p, adapter) {
    switch (p.kind) {
      case 'none': return true;
      case 'in': return p.set.indexOf(String(resolveLHS(sd, p.lhs, adapter))) >= 0;
      case 'present': return isPresentAt(sd, p.name, adapter);
      case 'flag': return firedState(sd, p.flag, adapter) === p.state;
      case 'cmp': {
        var L = resolveLHS(sd, p.lhs, adapter);
        return /^-?\d+(\.\d+)?$/.test(p.rhs) ? cmpNum(p.op, L, p.rhs) : cmpStr(p.op, L, p.rhs);
      }
      // ANY-match over a wildcard path: true when AT LEAST ONE named node satisfies it. Zero
      // matching nodes ⇒ false, never vacuously true — an event must not fire in an empty room.
      case 'contains': {
        if (RAW_PATH.test(p.lhs)) {
          var nodes = nodesAtPath(sd, p.lhs);
          for (var i = 0; i < nodes.length; i++) {
            if (String(adapter.get(nodes[i], p.lhs)).indexOf(p.arg) >= 0) return true;   // case-SENSITIVE
          }
          return false;
        }
        return String(resolveLHS(sd, p.lhs, adapter)).indexOf(p.arg) >= 0;          // a genre scalar (Aff(X), Loc, …)
      }
      case 'has': {
        var hs = RAW_PATH.test(p.lhs) ? nodesAtPath(sd, p.lhs) : [];
        for (var h = 0; h < hs.length; h++) if (nodeHas(hs[h], p.arg, adapter, p.lhs)) return true;
        return false;                                                            // non-path LHS ⇒ no collection to test
      }
      default: return false;
    }
  }
  function evalTokens(sd, str, adapter) {
    var s = String(str || '').trim();
    return (!s || s === '-') ? true : s.split('&').every(function (raw) { return evalOne(sd, raw.trim(), adapter); });
  }

  // ---- sweep helpers -----------------------------------------------------------------------------
  // Partition an &-joined predicate string into passing/failing tokens (READ-ONLY). '' / '-' tokens are
  // skipped (no constraint). evalTokens(...) === splitTokens(...).fail.length === 0, so grammar semantics
  // are UNCHANGED — this only reports WHICH token failed, a partition, not a parser change.
  function splitTokens(sd, str, adapter) {
    var s = String(str || '').trim(), pass = [], fail = [];
    if (!s || s === '-') return { pass: pass, fail: fail };
    s.split('&').forEach(function (raw) {
      var t = raw.trim();
      if (!t || t === '-') return;
      (evalOne(sd, t, adapter) ? pass : fail).push(t);
    });
    return { pass: pass, fail: fail };
  }

  // ---- OR, as ONE level of OR-of-ANDs (DNF) ---------------------------------------------------
  // `whenAny: ["a & b", "c"]` — AND inside a group, OR between groups. DNF is COMPLETE (every boolean
  // formula has one) and there is NO PRECEDENCE TO LEARN — the shape carries it. It also keeps the
  // sweep's question answerable: each alternative is still a flat AND-chain, so splitTokens runs PER
  // ALTERNATIVE and the row reports its CLOSEST one. `prereq` stays AND-only.
  // A row carrying BOTH `when` and `whenAny` is REJECTED by the validator; here whenAny wins, because
  // an engine that silently evaluated the other one would disagree with the lint.
  function whenAlternatives(t) {
    var any = t && t.whenAny;
    if (Array.isArray(any) && any.length) return any;
    return [t ? t.when : ''];
  }
  function evalWhen(sd, t, adapter) {
    var alts = whenAlternatives(t);
    for (var i = 0; i < alts.length; i++) if (evalTokens(sd, alts[i], adapter)) return true;
    return false;
  }
  // The alternative a row is CLOSEST to satisfying — fewest failing tokens. This is what keeps the
  // candidate line literally true: it names the branch nearest to firing, not an average.
  function splitWhen(sd, t, adapter) {
    var alts = whenAlternatives(t), best = null;
    for (var i = 0; i < alts.length; i++) {
      var s = splitTokens(sd, alts[i], adapter);
      if (!best || s.fail.length < best.fail.length) best = s;
      if (best.fail.length === 0) break;
    }
    return best || { pass: [], fail: [] };
  }

  // Full eligibility predicate — the SINGLE source shared by scanEvents (arm) and applyEventFire (verify):
  // not already fired, prereq must hold, when must hold. EVERY row is a one-shot, series included: a
  // series' prereq ORDERS its chain, but the done-marker is what keeps a fired step closed — so the
  // genre is free to delete the quest record the chain gated on. `prereq` stays AND-only by decision:
  // OR lands on `when` alone, so there is one new row field, not two.
  function isEligible(sd, t, adapter) {
    if (firedState(sd, t.key, adapter) === 'done') return false;
    return evalTokens(sd, t.prereq, adapter) && evalWhen(sd, t, adapter);
  }

  // Extract a token's scalar LHS (for the "now <value>" hint). Present()/flag: are self-describing → ''.
  // Reads the ONE grammar (parseToken) rather than re-matching.
  function tokenLhs(tok) {
    var p = parseToken(tok);
    return (p && (p.kind === 'in' || p.kind === 'cmp')) ? p.lhs : '';
  }

  // ---- THE EJS1 SWEEP — the candidate list [PRE] matches the user's input against.
  // A CANDIDATE = an eligible-EXCEPT-`when` trigger: not a done one-shot, prereq HOLDS (it is on the
  // table), but `when` is NOT fully satisfied. Each carries its UNMET `when` token and, where the token
  // has a scalar LHS, the current value — the human-readable "one condition away" line. Fully-ready rows
  // (when holds) are NOT candidates: the armed path (scanEvents) already surfaces those. KEYS +
  // conditions ONLY — never fx bodies. Sorted fewest-unmet first. Generic over ANY WHEN-DSL token type.
  function sweepCandidates(sd, adapter) {
    var out = [];
    eventTriggers(sd, adapter).forEach(function (t) {
      if (firedState(sd, t.key, adapter) === 'done') return;                // already fired: off the table
      if (!evalTokens(sd, t.prereq, adapter)) return;                                   // prereq must hold (on the table)
      var split = splitWhen(sd, t, adapter);                                          // the CLOSEST alternative
      if (!split.fail.length) return;                                              // when fully holds ⇒ already READY, not a candidate
      if (split.fail.length > 1) return;                                           // >1 condition away — a single reply can't fire it; wait until it's 1-away (bounded 1-reply-lag). Keeps candidates same-round-fireable + the "one condition away" label truthful.
      var unmet = split.fail.map(function (tok) {
        var lhs = tokenLhs(tok);
        if (!lhs) return { token: tok };
        return { token: tok, lhs: lhs, now: resolveLHS(sd, lhs, adapter) };
      });
      out.push({ key: t.key, series: t.series || '', cat: t.cat || 'TRG', unmet: unmet });
    });
    out.sort(function (a, b) { return a.unmet.length - b.unmet.length; });          // closest-to-firing first
    return out;
  }

  // The PRE-facing render: turn sweepCandidates into human-readable lines the small model matches the
  // user's input against. Every candidate is EXACTLY one condition from firing, so each line names that
  // single unmet token + (for a threshold) its current value: `<key> · need <tok>[ · now <val>]`. The
  // exact contract the card's [PRE] block injects; kept in the lib so it never drifts across genres.
  //   leila_1 · need Loc=Outskirts.AncientRuins
  //   example_3 · need Aff(Someone)>=30 · now 25
  function sweepCandidateLines(sd, adapter) {
    return sweepCandidates(sd, adapter).map(function (c) {
      var u = c.unmet[0];   // sweepCandidates guarantees exactly one unmet token (same-round-fireable)
      return c.key + ' · need ' + u.token + (u.now !== undefined ? ' · now ' + u.now : '');
    });
  }

  // ---- APPLY EVENT FIRE — the narrator played the armed @KEY and declared
  // /Intent/eventFire "<key>[:<Outcome>]". Verify, run the row's declared writes, write the fired
  // record, clear the armed pointer. Returns true if a known event fired (caller skips the re-scan
  // this turn so a chained series step waits one reply).
  //
  // VERIFY-AT-FIRE — the narrator only PROPOSES; code disposes. The row's FULL eligibility is checked on
  // the genre's state, so a hallucinated or state-unbacked fire cannot register writes for a beat that did
  // not happen. LOUD reject — never silently drop.
  // `startState` (OPTIONAL) is the state as the reply BEGAN, before the genre applied this reply's moves.
  // Given, the fire also passes when the row held THERE: an event armed (or offered ripe) at the start of a
  // reply is handed to the narrator before the player's line is played out, so a line that walks out of the
  // venue must not void a beat already written. An event is delivered one reply after it ripens; accepting
  // either end of the reply keeps that lag at one reply instead of losing the beat. Omitted, only `statData`
  // is checked.
  function applyEventFire(statData, fireStr, log, adapter, startState) {
    var parts = String(fireStr).split(':');
    var key = (parts[0] || '').trim();
    var outcome = (parts[1] || '').trim();
    var t = eventTriggers(statData, adapter).find(function (x) { return x.key === key; });
    if (!t) { log.push('eventFire ignored (unknown event): ' + fireStr); return false; }
    if (!isEligible(statData, t, adapter)) {
      if (!startState || !isEligible(startState, t, adapter)) {
        log.push('EVENT FIRE REJECTED (verify-at-fire: prereq/when not backed by current state' + (startState ? ', nor by the state this reply began on' : '') + '): ' + key);
        return false;
      }
      log.push('EVENT FIRE verified on the state this reply began on (its prereq/when held there; this reply\'s moves left them): ' + key);
    }
    var fx = t.fx || {};
    var k;
    for (k in fx) {
      if (!Object.prototype.hasOwnProperty.call(fx, k) || FX_META.indexOf(k) >= 0) continue;
      log.push('EVENT FX IGNORED: fx.' + k + ' — format ' + FORMAT + ' knows only ' + FX_META.join(', '));
    }
    if (fx.writes !== undefined) applyWrites(statData, t.key, fx.writes, log, adapter);
    // The payout LAST: the structural consequence of the beat lands first, then what it paid, so the log
    // reads in the order the story did and a reward can clamp against a field the writes just set.
    if (fx.reward !== undefined) applyRewards(statData, t.key, fx.reward, log, adapter);
    // The done-marker — the library's own, in the library's own root. PROSE IS NOT WRITTEN HERE: a
    // world log is the narrator's memory of what mattered, so a row worth remembering says so in its
    // BODY (the genre's own record intent), and `fx.summary` stays what it reads as — the row's label.
    markFired(statData, t.key, fx.scope || '', adapter);
    if (adapter.getArmed(statData) === '@' + key) adapter.setArmed(statData, '');      // consumed
    log.push('EVENT FIRED: ' + key + (outcome ? ' (' + outcome + ')' : ''));
    return true;
  }

  // ---- APPLY REWARDS — the row's PAYOUT, under the genre's declared reward kinds. -------------------
  // A reward is { <kind>: { <field>: <delta>, … } }, or for a KEYED kind { <kind>: { <memberKey>:
  // { <field>: <delta> } } } — bounded numeric changes paid when the row fires. Every step of a series
  // states its own, which is the point: a series is many beats and each one pays for itself.
  //
  // IT IS DELIBERATELY NOT A `writes` ENTRY. A write is structural bookkeeping on a keyed record and
  // carries the applyWrites rules, none of them a ceiling; worse, the owner gate is guarded on the
  // record key, so a KEYLESS write is outside it entirely. A payout spelled as a write could therefore
  // grant any amount an installed pack liked. A reward's whole rule is the ceiling, so it gets its own
  // section.
  //
  // The genre declares the kinds in adapter.rewards:
  //   { name, path, keyed, fields, clamp, max }
  //   name    what a row asks for
  //   path    the object whose fields it pays; with `keyed: true` it is the COLLECTION and the row names
  //           the member (see below)
  //   fields  the allow-list — nothing outside it is ever paid
  //   clamp   { field: [lo, hi] } applied to the RESULT; each bound is a number, the name of a sibling
  //           field, or null for "no bound that way" (a floor with no ceiling is a real shape: money)
  //   max     the largest SINGLE payout — a number for the whole kind, or { field: n } per field, because
  //           one kind's fields do not share a scale. Applied to the MAGNITUDE, so a penalty is bounded
  //           exactly like a gift. An over-max amount is PAID AT THE CEILING and said so: a beat that read
  //           as generous must not land as nothing.
  //
  // A TEXT KIND (`text: true`) pays PROSE the row states, written OVER the field rather than added to it.
  // A delta has no meaning on a string — "C Cup" plus 2 is nothing — so a genre that wants a beat to
  // change a described thing declares the kind textual, and the row's value is the new text. `clamp` and
  // `max` are meaningless here and the genre's build gate refuses them; the bound is `maxLength`, and an
  // over-long value is CUT to it and said so, for the same reason an over-max number is paid at its
  // ceiling. A blank value pays nothing — clearing a field is not a reward.
  //
  // A KEYED KIND IS NOT OWNER-GATED, and that is deliberate. The owner gate exists so a pack cannot
  // overwrite a record someone else made; a reward cannot reach anything but the fields the card listed,
  // by an amount the card capped, on a member that ALREADY EXISTS — it never creates one. Gating it on
  // ownership would only make it useless, since no member of the game's own cast was ever granted by a
  // pack. The ceiling is the fence here.
  //
  // No kinds declared = a genre that pays nothing through events; a row asking anyway is named.
  function applyRewards(sd, triggerKey, reward, log, adapter) {
    if (!isPlainObject(reward)) { log.push('REWARD IGNORED (' + triggerKey + '): fx.reward is not an object'); return; }
    var kinds = Array.isArray(adapter.rewards) ? adapter.rewards : [];
    var declared = kinds.map(function (k) { return k && k.name; }).filter(Boolean).join(', ') || 'nothing';
    for (var kind in reward) {
      if (!Object.prototype.hasOwnProperty.call(reward, kind)) continue;
      var entry = null;
      for (var i = 0; i < kinds.length; i++) if (kinds[i] && kinds[i].name === kind) { entry = kinds[i]; break; }
      if (!entry) { log.push('REWARD REFUSED (kind not declared): ' + triggerKey + '.' + kind + ' — this engine pays: ' + declared); continue; }
      payReward(sd, triggerKey, kind, entry, reward[kind], log, adapter);
    }
  }

  // A member key may be a NAME, or a SELECTOR: `<the kind's path>.*.<field>`, meaning "the member whose
  // <field> is true right now". It exists because some beats are about whoever was THERE and no author
  // can know the name at write time ("bring me your girlfriend" — which girl is a fact of the save).
  //
  // The spelling is the WHEN-DSL's own `L.*.M`, so an author picks it from the same path list they build
  // conditions from. The MEANING differs and deliberately so: as a condition that form asks "does ANY
  // member match", here it asks "WHICH member matches" — a test versus a choice.
  //
  // GENRE-NEUTRAL by construction. The library learns nothing about what the field means; the ROW names
  // the field, which is the one place genre vocabulary belongs. Nothing here knows "present".
  function isMemberSelector(key, path) { return String(key).indexOf(path + '.*.') === 0; }

  // Resolve a selector to EXACTLY ONE member, or to nothing. "A payout aimed at whoever is not a payout"
  // still holds — this answers the question from state instead of from the row, it does not relax it.
  // Zero matches is nobody to pay; two or more is a question the row cannot answer, and paying both would
  // quietly double what the author wrote. Both refuse OUT LOUD: a reward that silently pays nobody reads
  // exactly like one that worked.
  function resolveMemberSelector(key, path, holder, where, log, adapter) {
    var field = String(key).slice((path + '.*.').length);
    if (!field || field.indexOf('.') >= 0) {
      log.push('REWARD REFUSED (' + where + '.' + key + '): a selector names ONE field after ' + path + '.*, not "' + field + '"');
      return '';
    }
    var hits = [];
    var keys = Object.keys(holder);
    for (var i = 0; i < keys.length; i++) {
      var member = holder[keys[i]];
      if (!isPlainObject(member)) continue;
      if (adapter.get(member[field], false) === true) hits.push(keys[i]);
    }
    if (hits.length === 1) return hits[0];
    if (!hits.length) log.push('REWARD REFUSED (' + where + '.' + key + '): no member of ' + path + ' has ' + field + ' true, so there is no one to pay');
    else log.push('REWARD REFUSED (' + where + '.' + key + '): ' + hits.length + ' match (' + hits.join(', ') + ') — name the one this beat is about, or the payout doubles');
    return '';
  }

  // Route to the object being paid: the path itself, or one member of the collection it names.
  function payReward(sd, triggerKey, kind, entry, asked, log, adapter) {
    var where = triggerKey + '.' + kind;
    var path = String(entry.path || '');
    if (!isPlainObject(asked)) { log.push('REWARD IGNORED (' + where + ' is not an object)'); return; }
    if (entry.keyed !== true) {
      var rec = ensurePath(sd, path);
      if (!rec) { log.push('REWARD REFUSED (' + path + ' is not an object): ' + where); return; }
      payFields(rec, where, path, entry, asked, log, adapter);
      return;
    }
    var holder = getByPath(sd, path);
    if (!isPlainObject(holder)) { log.push('REWARD REFUSED (' + path + ' is not a collection in this save): ' + where); return; }
    for (var rawKey in asked) {
      if (!Object.prototype.hasOwnProperty.call(asked, rawKey)) continue;
      var memberKey = rawKey;
      if (isMemberSelector(rawKey, path)) {
        memberKey = resolveMemberSelector(rawKey, path, holder, where, log, adapter);
        if (!memberKey) continue;                          // resolveMemberSelector said why
      } else if (/[./]/.test(rawKey)) {
        log.push('REWARD REFUSED (key contains "." or "/"): ' + where + '.' + rawKey); continue;
      }
      // A reward changes someone who is ALREADY HERE. Creating the member instead would let a payout
      // conjure a half-built record the rest of the genre then has to cope with — registration is its
      // own job, with its own required fields, and this is not it.
      if (!isPlainObject(holder[memberKey])) {
        log.push('REWARD REFUSED (no ' + path + '.' + memberKey + ' in this save): ' + where + '.' + memberKey + ' — a reward pays someone already here, it never creates them');
        continue;
      }
      // asked is keyed by what the ROW wrote (rawKey), which is not memberKey once a selector resolved.
      payFields(holder[memberKey], where + '.' + memberKey, path + '.' + memberKey, entry, asked[rawKey], log, adapter);
    }
  }

  // The ceiling for one field: a per-field map when the kind's fields do not share a scale, else the
  // kind's single number. 0 (or absent) means uncapped, which the genre's own build gate refuses to stamp.
  function rewardMax(entry, field) {
    if (isPlainObject(entry.max)) return Number(entry.max[field]) || 0;
    return Number(entry.max) || 0;
  }

  // A log line must stay readable, so a long value is shown as a head with a tail marker. The FIELD keeps
  // the whole value — this shortens the report, never the payout.
  function preview(text) { return text.length > 60 ? text.slice(0, 57) + '…' : text; }

  function payFields(rec, where, pathLabel, entry, asked, log, adapter) {
    if (!isPlainObject(asked)) { log.push('REWARD IGNORED (' + where + ' is not a { field: amount } object)'); return; }
    var allowed = Array.isArray(entry.fields) ? entry.fields : [];
    var clamps = isPlainObject(entry.clamp) ? entry.clamp : {};
    var trigger = where.split('.')[0];
    for (var field in asked) {
      if (!Object.prototype.hasOwnProperty.call(asked, field)) continue;
      if (allowed.indexOf(field) < 0) {
        log.push('REWARD FIELD DROPPED (' + entry.name + ' does not pay ' + field + '): ' + where + ' — it pays: ' + (allowed.join('/') || 'nothing'));
        continue;
      }
      if (entry.text === true) {
        var value = String(asked[field] === undefined || asked[field] === null ? '' : asked[field]).trim();
        if (!value) { log.push('REWARD FIELD DROPPED (' + field + ' is blank — clearing a field is not a reward): ' + where); continue; }
        var limit = Number(entry.maxLength) || 0;
        if (limit > 0 && value.length > limit) {
          log.push('REWARD ' + where + '.' + field + ' is ' + value.length + ' characters, over the ' + limit + ' one event may write — cut to ' + limit);
          value = value.slice(0, limit).trim();     // a cut lands mid-phrase; a trailing space is not part of it
        }
        put(rec, field, value);
        log.push('EVENT REWARD (' + trigger + '): ' + pathLabel + '.' + field + ' = "' + preview(value) + '"');
        continue;
      }
      var delta = Number(asked[field]);
      if (!isFinite(delta) || delta === 0) { log.push('REWARD FIELD DROPPED (' + field + ' is not a non-zero number): ' + where + ' = ' + String(asked[field])); continue; }
      var max = rewardMax(entry, field);
      if (max > 0 && Math.abs(delta) > max) {
        var capped = delta < 0 ? -max : max;
        log.push('REWARD ' + where + '.' + field + ' asked ' + delta + ', over the ' + max + ' one event may pay — paid ' + capped);
        delta = capped;
      }
      var raw = adapter.get(rec[field], 0);
      var before = Number(raw) || 0;
      var next = before + delta;
      var bounds = clamps[field];
      if (Array.isArray(bounds) && bounds.length === 2) {
        var lo = boundValue(bounds[0], rec, adapter), hi = boundValue(bounds[1], rec, adapter);
        if (lo !== null && next < lo) next = lo;
        if (hi !== null && next > hi) next = hi;
      }
      put(rec, field, typeof raw === 'string' ? String(next) : next);       // keeps the stored TYPE and label
      // The line states what LANDED. A bound that stops the change short says so, with what the row was due, so a
      // +10 on a field at 95 reads "+5 -> 100 (of +10; 100 is the bound)" and one already at 100 reads "+0".
      var paid = next - before;
      log.push('EVENT REWARD (' + trigger + '): ' + pathLabel + '.' + field + ' ' + (paid >= 0 ? '+' : '') + paid + ' -> ' + next
        + (paid !== delta ? ' (of ' + (delta >= 0 ? '+' : '') + delta + '; ' + next + ' is the bound)' : ''));
    }
  }

  // ---- APPLY WRITES — the pack's declared writes, under the genre's declared rules. -----------------
  // A write is { path, key?, set?, add?, remove? }. `path` must equal a `writes` entry of the adapter
  // (the allow-list); `key` names the record when the path is a collection; `set` fields are written
  // VERBATIM under the schema's own names; `add` fields change by a numeric delta; `remove: true`
  // deletes the record. Everything else is a RULE the entry declares, applied in this order:
  //   path fence → owner gate (§ownerStamp, lifted on a shared registry) → remove → capacity (new key) →
  //   fillOnly → monotonic → set → add → clamp → removeAtZero → fixed → stamp → one log line
  // Every drop and refusal is logged; nothing is silent.
  function applyWrites(sd, triggerKey, writes, log, adapter) {
    if (!Array.isArray(writes)) { log.push('WRITES IGNORED (' + triggerKey + '): fx.writes is not an array'); return; }
    var entries = Array.isArray(adapter.writes) ? adapter.writes : [];
    var owner = packOwnerOf(sd, triggerKey, adapter);
    for (var i = 0; i < writes.length; i++) applyOneWrite(sd, writes[i], entries, owner, log, adapter);
  }

  // WHO OWNS A ROW. The installer writes `installed.<id>.keys` beside the trigger table, so a row's
  // owner is the installed record whose `keys` holds its trigger key. A row no installed pack claims
  // was seeded by the CARD itself and owns OFFICIAL_OWNER.
  //
  // OFFICIAL_OWNER is unforgeable by construction, not by a blocklist: an installed id is
  // `slug(creator) + '.' + slug(event)` and slug() emits `[a-z0-9_]` only, so no pack can ever produce
  // a string carrying a capital. Nothing parses this value — it is compared with === and iterated
  // with Object.keys — but it keeps the two-segment shape so a reader never needs a special case.
  var OFFICIAL_OWNER = 'Official.Card';
  function packOwnerOf(sd, triggerKey, adapter) {
    var installedRoot = siblingRoot(adapter, 'installed');
    var installed = installedRoot ? getByPath(sd, installedRoot) : undefined;
    if (!installed || typeof installed !== 'object') return OFFICIAL_OWNER;
    var ids = Object.keys(installed);
    for (var i = 0; i < ids.length; i++) {
      var rec = installed[ids[i]];
      var keys = rec && rec.keys;
      if (isTuple(keys)) keys = adapter.get(keys, []);
      if (!Array.isArray(keys) || keys.indexOf(triggerKey) < 0) continue;
      return ids[i];
    }
    return OFFICIAL_OWNER;
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  // A stored MVU tuple keeps its label across a write; a bare value is written bare.
  function put(rec, field, value) {
    var cur = rec[field];
    rec[field] = isTuple(cur) ? [value, cur[1]] : value;
  }
  function isEmptyValue(v) { return v === undefined || v === null || String(v) === ''; }
  function fieldList(v) { return Array.isArray(v) ? v : (v === true ? true : []); }
  // Walk to the node at `dotted`, creating plain objects IN PLACE for missing segments (the turn
  // runner holds the root reference, so a replaced parent would be a write into nothing). A
  // non-object in the way is refused.
  function ensurePath(sd, dotted) {
    var node = sd;
    var segs = String(dotted).split('.');
    for (var i = 0; i < segs.length; i++) {
      var next = node[segs[i]];
      if (next === undefined || next === null) { next = {}; node[segs[i]] = next; }
      if (!isPlainObject(next)) return null;
      node = next;
    }
    return node;
  }

  function applyOneWrite(sd, w, entries, owner, log, adapter) {
    if (!isPlainObject(w) || typeof w.path !== 'string' || !w.path) { log.push('WRITE IGNORED: not a { path, … } object'); return; }
    var entry = null;
    for (var e = 0; e < entries.length; e++) if (entries[e] && entries[e].path === w.path) { entry = entries[e]; break; }
    if (!entry) {
      log.push('WRITE REFUSED (path not declared): ' + w.path + ' — this engine declares: ' + (entries.map(function (x) { return x && x.path; }).join(', ') || 'nothing'));
      return;
    }
    var hasKey = typeof w.key === 'string' && w.key !== '';
    var where = w.path + (hasKey ? '.' + w.key : '');
    if (hasKey && /[./]/.test(w.key)) { log.push('WRITE REFUSED (key contains "." or "/"): ' + where); return; }
    // §sharedRegistry — a path declared `fillOnly: true` is a SHARED registry: first capture wins for
    // every field, so a pack naming the world's own key can only fill blanks and can never overwrite
    // what the engine or another pack recorded. That is what lets a pack register the room the game
    // already calls `School_Cafeteria` instead of a duplicate of the same room under another name.
    // REMOVAL is never shared — deleting a record is not filling a blank — so `remove` stays gated.
    var shared = entry.fillOnly === true && w.remove !== true;
    // §ownerStamp — THE OWNER GATE. A pack may CREATE any record key nobody has claimed, and may
    // overwrite or remove only a record its own id stamped. A record carrying no stamp was made by the
    // narrator or by the player, so it belongs to neither pack and no pack may touch it. An OFFICIAL
    // row is the card itself and is never gated — that is what lets a seeded row take back an item
    // narrate created and never stamped. The stamp field is named by the path's `ownerStamp`; a path
    // declaring none refuses every keyed PACK write (fail CLOSED, so a genre cannot hand out an
    // unguarded collection by forgetting a line). ONE EXCEPTION, the same one the fence had before it
    // (§sharedRegistry): a `fillOnly` path is a shared registry where a pack names the world's own
    // key to fill blanks in it. Removal is never shared — deleting a record is not filling a blank.
    var isOfficialRow = owner === OFFICIAL_OWNER;
    var ownerField = typeof entry.ownerStamp === 'string' ? entry.ownerStamp : '';
    if (hasKey && !shared && !isOfficialRow && !ownerField) {
      log.push('WRITE REFUSED (' + w.path + ' declares no ownerStamp, so no record there can name who made it): ' + where); return;
    }
    var container = ensurePath(sd, w.path);
    if (!container) { log.push('WRITE REFUSED (' + w.path + ' is not an object): ' + where); return; }
    if (hasKey && !shared && !isOfficialRow && container[w.key] !== undefined) {
      var heldBy = isPlainObject(container[w.key]) ? String(adapter.get(container[w.key][ownerField], '')).trim() : '';
      if (heldBy !== owner) {
        log.push('WRITE REFUSED (' + where + ' belongs to ' + (heldBy || 'the story, not to any pack') + ', not to ' + owner + ')'); return;
      }
    }

    // remove — stops here
    if (w.remove === true) {
      if (!hasKey) { log.push('WRITE REFUSED (remove needs a key): ' + where); return; }
      if (entry.removable !== true) { log.push('WRITE REFUSED (not removable): ' + where); return; }
      if (container[w.key] === undefined) { log.push('WRITE remove: nothing at ' + where); return; }
      delete container[w.key];
      log.push('WRITE ' + where + ' removed');
      return;
    }

    var exists = hasKey ? isPlainObject(container[w.key]) : true;
    if (hasKey && container[w.key] !== undefined && !exists) { log.push('WRITE REFUSED (' + where + ' holds a non-record value)'); return; }

    // capacity — a NEW key that would overflow evicts the oldest first
    if (hasKey && !exists && isPlainObject(entry.capacity) && Number(entry.capacity.max) > 0) {
      var max = Number(entry.capacity.max), by = entry.capacity.evictBy;
      while (Object.keys(container).length >= max) {
        var victim = oldestKey(container, by, adapter);
        if (!victim) break;
        delete container[victim];
        log.push('WRITE ' + w.path + ' at capacity ' + max + ' — evicted ' + victim + (by ? ' (oldest ' + by + ')' : ' (first inserted)'));
      }
    }

    var set = isPlainObject(w.set) ? w.set : {};
    var add = isPlainObject(w.add) ? w.add : {};
    var locked = Array.isArray(entry.locked) ? entry.locked : [];
    var fill = fieldList(entry.fillOnly);
    var rec = exists ? (hasKey ? container[w.key] : container) : null;
    var changed = [], field;
    var setFields = {}, addFields = {};

    // locked / `_` — dropped field by field, the rest of the write lands
    for (field in set) {
      if (!Object.prototype.hasOwnProperty.call(set, field)) continue;
      if (field.charAt(0) === '_') { log.push('WRITE FIELD DROPPED (readonly _): ' + where + '.' + field); continue; }
      if (locked.indexOf(field) >= 0) { log.push('WRITE FIELD DROPPED (locked): ' + where + '.' + field); continue; }
      if (ownerField && field === ownerField) { log.push('WRITE FIELD DROPPED (the engine owns ' + ownerField + ' — a row never names its own owner): ' + where); continue; }
      setFields[field] = set[field];
    }
    for (field in add) {
      if (!Object.prototype.hasOwnProperty.call(add, field)) continue;
      if (field.charAt(0) === '_') { log.push('WRITE FIELD DROPPED (readonly _): ' + where + '.' + field); continue; }
      if (locked.indexOf(field) >= 0) { log.push('WRITE FIELD DROPPED (locked): ' + where + '.' + field); continue; }
      if (ownerField && field === ownerField) { log.push('WRITE FIELD DROPPED (the engine owns ' + ownerField + ' — a row never names its own owner): ' + where); continue; }
      if (!Array.isArray(entry.add) || entry.add.indexOf(field) < 0) { log.push('WRITE FIELD DROPPED (add not declared for ' + field + '): ' + where); continue; }
      if (typeof add[field] !== 'number' && !/^-?\d+(\.\d+)?$/.test(String(add[field]))) { log.push('WRITE FIELD DROPPED (add is not a number): ' + where + '.' + field); continue; }
      addFields[field] = Number(add[field]);
    }

    // fillOnly — an existing non-empty field is never overwritten
    if (exists && (fill === true || fill.length)) {
      var kept = [];
      for (field in setFields) {
        if (!Object.prototype.hasOwnProperty.call(setFields, field)) continue;
        var guarded = fill === true || fill.indexOf(field) >= 0;
        if (guarded && !isEmptyValue(adapter.get(rec[field], ''))) { kept.push(field); delete setFields[field]; }
      }
      for (field in addFields) {
        if (!Object.prototype.hasOwnProperty.call(addFields, field)) continue;
        if ((fill === true || fill.indexOf(field) >= 0) && !isEmptyValue(adapter.get(rec[field], ''))) { kept.push(field); delete addFields[field]; }
      }
      if (kept.length) log.push('WRITE ' + where + ' already registered — kept ' + kept.join('/'));
    }

    // monotonic — a value at or below the current one skips the WHOLE write; a negative delta is refused
    var mono = Array.isArray(entry.monotonic) ? entry.monotonic : [];
    for (var mi = 0; mi < mono.length; mi++) {
      field = mono[mi];
      if (Object.prototype.hasOwnProperty.call(setFields, field) && exists) {
        var curNum = Number(adapter.get(rec[field], 0)) || 0, incoming = Number(setFields[field]) || 0;
        if (curNum > 0 && incoming <= curNum) { log.push('WRITE ' + where + ' ' + field + ' ' + incoming + ' <= current ' + curNum + ' — no regression (skipped)'); return; }
      }
      if (Object.prototype.hasOwnProperty.call(addFields, field) && addFields[field] < 0) {
        log.push('WRITE FIELD DROPPED (negative add on monotonic ' + field + '): ' + where);
        delete addFields[field];
      }
    }

    if (!exists) { rec = {}; container[w.key] = rec; }
    // The owner is recorded ONCE, when the record is born. Never re-stamped: `GrantedBy` says who
    // granted the thing, not who touched it last, so an official row editing a pack's record leaves
    // the pack named. A shared-registry write stamps a record it just created for the same reason.
    if (hasKey && ownerField && !exists) put(rec, ownerField, owner);

    for (field in setFields) {
      if (!Object.prototype.hasOwnProperty.call(setFields, field)) continue;
      put(rec, field, setFields[field]);
      changed.push(field);
    }
    for (field in addFields) {
      if (!Object.prototype.hasOwnProperty.call(addFields, field)) continue;
      var raw = adapter.get(rec[field], 0);
      var next = (Number(raw) || 0) + addFields[field];
      put(rec, field, typeof raw === 'string' ? String(next) : next);     // keeps the stored TYPE
      changed.push(field + (addFields[field] >= 0 ? '+' : '') + addFields[field]);
    }

    // clamp — a bound is a number or the name of a sibling field
    var clamp = isPlainObject(entry.clamp) ? entry.clamp : {};
    for (field in clamp) {
      if (!Object.prototype.hasOwnProperty.call(clamp, field)) continue;
      if (!Object.prototype.hasOwnProperty.call(setFields, field) && !Object.prototype.hasOwnProperty.call(addFields, field)) continue;
      var bounds = clamp[field];
      if (!Array.isArray(bounds) || bounds.length !== 2) continue;
      var lo = boundValue(bounds[0], rec, adapter), hi = boundValue(bounds[1], rec, adapter);
      var cur = Number(adapter.get(rec[field], 0)) || 0, bounded = cur;
      if (lo !== null && bounded < lo) bounded = lo;
      if (hi !== null && bounded > hi) bounded = hi;
      if (bounded !== cur) { put(rec, field, bounded); changed.push(field + '→' + bounded + ' (clamped)'); }
    }

    // removeAtZero — the record goes when a listed field is at or below zero
    var raz = Array.isArray(entry.removeAtZero) ? entry.removeAtZero : [];
    for (var ri = 0; ri < raz.length; ri++) {
      field = raz[ri];
      if (!hasKey || rec[field] === undefined) continue;
      if ((Number(adapter.get(rec[field], 0)) || 0) <= 0) {
        delete container[w.key];
        log.push('WRITE ' + where + ' removed (' + field + ' reached 0)');
        return;
      }
    }

    // fixed — engine-owned, every write. A constant, so re-writing it says the same thing.
    var fixed = isPlainObject(entry.fixed) ? entry.fixed : {};
    for (field in fixed) {
      if (!Object.prototype.hasOwnProperty.call(fixed, field)) continue;
      put(rec, field, fixed[field]);
      changed.push(field);
    }
    // stamp — engine-owned, and THE PATH'S OWN fillOnly RULE COVERS IT, because the stamp is a field
    // like any other. §sharedRegistry above already promises "first capture wins for EVERY field" on a
    // `fillOnly` path; the stamp used to be written after that guard and so was the one field that
    // never obeyed it. A registry stamp is a CAPTURE time — a genre names it FirstSeen, DiscoveredAt —
    // so re-declaring a record moved the date on which it was first seen, forward, to now. Live
    // 2026-09-09: a probe pack's step 3 re-declared an NPC and its FirstSeen moved 08:10 -> 12:15.
    // A path that is NOT fillOnly still re-stamps on every write: that stamp is a TOUCH time (School
    // names it LastUpdated) and moving it is the whole point. Nothing new is declared to get both —
    // the path already says which kind it is, and `fillOnly` as a FIELD LIST lets a genre keep a
    // touch-stamp on an otherwise fill-only record by simply not listing the stamp.
    if (typeof entry.stamp === 'string' && entry.stamp) {
      if (typeof adapter.nowStamp !== 'function') log.push('WRITE stamp SKIPPED: the adapter declares no nowStamp(sd) — ' + where + '.' + entry.stamp);
      else if (exists && (fill === true || fill.indexOf(entry.stamp) >= 0) && !isEmptyValue(adapter.get(rec[entry.stamp], ''))) {
        log.push('WRITE ' + where + ' ' + entry.stamp + ' kept (first capture)');
      } else { put(rec, entry.stamp, adapter.nowStamp(sd)); changed.push(entry.stamp); }
    }
    log.push('WRITE ' + where + (exists ? '' : ' (new)') + ' <- ' + (changed.join('/') || '(nothing)'));
  }
  function boundValue(b, rec, adapter) {
    if (typeof b === 'number') return b;
    if (typeof b === 'string' && b) {
      var v = Number(adapter.get(rec[b], NaN));
      return isNaN(v) ? null : v;
    }
    return null;
  }
  // The eviction victim: the record with the SMALLEST `by` value (string compare — a
  // "YYYY-MM-DD HH:MM" stamp sorts), or the first-inserted key when `by` is absent.
  function oldestKey(container, by, adapter) {
    var keys = Object.keys(container);
    if (!keys.length) return null;
    if (!by) return keys[0];
    var best = null, bestVal = null;
    for (var i = 0; i < keys.length; i++) {
      var rec = container[keys[i]];
      var val = String(isPlainObject(rec) ? adapter.get(rec[by], '') : '');
      if (best === null || val < bestVal) { best = keys[i]; bestVal = val; }
    }
    return best;
  }

  // ---- APPLY STEP DONE — the numbered-beat cursor INSIDE one event body. An event whose prose is a
  // list of beats (School's day spine: 14 bodies of 2-8; an RPG set piece could be one body of 10) needs
  // to know which beat is live, and the beats are PROSE — nothing in a trigger row declares them. So the
  // engine holds one string, "<phase>.<step>", and this walks it.
  //
  // PHASE is whatever ordinal the genre groups beats by, and it is NEVER interpreted here: School passes
  // its day band (0 morning … 4 small hours); a chapter, an act, or a constant 0 for a genre that has no
  // grouping at all works identically. `currentPhase` is the genre's answer to "the furthest phase
  // reached RIGHT NOW" — pass null (a genre with no such authority) and the ahead-guard is simply skipped.
  //
  // The narrator reports /Intent/stepDone as a DUMP of the beats its prose PLAYED this reply, in any order.
  // Same trust model as applyEventFire: the narrator only PROPOSES; code disposes. Why a report and not a
  // counter: a per-reply counter is NOT a beat cursor — a beat spanning several replies desyncs it
  // permanently (the pointer marches while the story stands still). This cursor moves only when the
  // narrator reports, and one beat at a time: a beat opens once the one before it is reported played, so
  // walking onto a later beat's ground never unlocks it. A beat that cannot land stays live; the genre's
  // phase boundary (School: the clock leaving the band) is what moves the story past it.
  // Rules, in order, for each reported beat (sorted):
  //   unparseable                 → log, not stored (never store garbage)
  //   phase AHEAD of currentPhase → log, not stored (the genre owns how far it has got; a stored FUTURE phase
  //                                 would send the next reply's pointer back to step 1 — wrong twice)
  //   not past the stored cursor  → log, not stored, benign (a re-report / stale echo of an older beat)
  //   not the next beat in line   → log, HELD (it opens once the beat before it is reported played)
  //   else                        → the cursor walks to it
  // The genre clears the cursor at its own boundary (School: the day settle). A report from a PAST phase
  // still stores — harmless, because the live pointer derives from the CURRENT phase, so a closed phase's
  // report cannot move it.
  function applyStepDone(statData, reportStr, currentPhase, log, adapter) {
    // THE REPORT IS A DUMP, NOT A DECISION. The narrator lists every beat its prose played this reply, in any
    // order, comma-separated ("0.3,0.2" is as good as "0.2,0.3"); this function does the sorting. Asking a
    // language model to work out WHICH single number to send is asking it to hold a cursor it cannot see —
    // it guesses, and a guess here silently carries the story past scenes the player never had. Sorting is
    // trivial and exact in code, so the judgment lives here where it is deterministic.
    var raw = String(reportStr).trim();
    var seen = {}, want = [];
    var parts = raw.split(',');
    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i].trim();
      if (!tok) continue;                                        // tolerate "0.2," and stray spaces
      var m = /^(\d+)\.(\d+)$/.exec(tok);
      if (!m) { log.push('stepDone entry IGNORED (want "<phase>.<step>", e.g. "0.3"): ' + tok); continue; }
      var id = m[1] + '.' + m[2];
      if (seen[id]) continue;                                    // a repeat in the same dump is just noise
      seen[id] = 1;
      want.push({ phase: +m[1], step: +m[2], id: id });
    }
    if (!want.length) { log.push('stepDone DROPPED (nothing usable in "' + raw + '")'); return false; }
    want.sort(function (a, b) { return a.phase - b.phase || a.step - b.step; });

    var prev = String(adapter.getStepDone(statData) || '');
    var pm = /^(\d+)\.(\d+)$/.exec(prev);
    var curPhase = pm ? +pm[1] : null, curStep = pm ? +pm[2] : 0;
    var ahead = [], stale = [], held = [], took = null;
    for (var j = 0; j < want.length; j++) {
      var e = want[j];
      if (currentPhase != null && e.phase > Number(currentPhase)) { ahead.push(e.id); continue; }   // the genre owns the phase
      if (curPhase != null && (e.phase < curPhase || (e.phase === curPhase && e.step <= curStep))) { stale.push(e.id); continue; }
      // CONTIGUOUS ONLY. A beat opens once the one before it is reported played, so the cursor walks the run
      // and stops at the first hole — everything past it is HELD, not credited. Opening a new phase starts at .1.
      var expected = (curPhase != null && e.phase === curPhase) ? curStep + 1 : 1;
      if (e.step !== expected) { held.push(e.id); continue; }
      curPhase = e.phase; curStep = e.step; took = e.id;
    }
    if (stale.length) log.push('stepDone: ' + stale.join(',') + ' already spent (cursor was ' + (prev || 'unset') + ')');
    if (ahead.length) log.push('stepDone: ' + ahead.join(',') + ' HELD — past the current phase (' + currentPhase + '); never reach ahead');
    if (held.length) log.push('stepDone: ' + held.join(',') + ' HELD — the step before it was never reported played, so it has not opened yet');
    if (!took) { log.push('stepDone moved nothing (cursor stays at ' + (prev || 'unset') + '): ' + raw); return false; }
    adapter.setStepDone(statData, took);
    log.push('STEP DONE ' + took + (prev ? ' (was ' + prev + ')' : ''));
    return true;
  }

  // THE ARBITRATION, in one place. Returns the single trigger that would be armed right now, or null.
  // Shared by scanEvents and readyEvent so they can never disagree about who wins — if those two
  // picked differently the narrator could play one event while the pointer named another.
  // Order: TIME outranks TRG · then most-specific WHEN by token count (holding alternative) · then
  // declaration order.
  function eligibleWinner(statData, adapter) {
    var TRIGS = eventTriggers(statData, adapter);
    var elig = TRIGS.filter(function (t) { return isEligible(statData, t, adapter); });   // shared with verify-at-fire
    if (!elig.length) return null;
    elig.sort(function (a, b) {
      if (a.cat !== b.cat) return a.cat === 'TIME' ? -1 : 1;                    // TIME row outranks TRG
      var d = tokCount(b, statData, adapter) - tokCount(a, statData, adapter); if (d) return d;   // most-specific WHEN (holding alternative)
      return TRIGS.indexOf(a) - TRIGS.indexOf(b);                              // else first-listed (insertion order)
    });
    return elig[0];
  }

  // Evaluate every trigger against live stat_data, arm the winner. Returns true if the armed pointer
  // changed.
  function scanEvents(statData, log, adapter) {
    var prev = adapter.getArmed(statData);
    var win = eligibleWinner(statData, adapter);
    var winner = win ? ('@' + win.key) : '';
    if (winner !== prev) { adapter.setArmed(statData, winner); log.push('EVENT ARMED -> ' + (winner || '(none)')); return true; }
    return false;
  }

  // The ZERO-AWAY half of same-round firing: the winner that would be armed right now, offered to
  // [PRE] so a ripe event can play THIS reply instead of arm-now/play-next.
  // Returns the winner ONLY — never a list (scanEvents arms exactly one; an unarbitrated set would
  // let two ripe events be claimed in one reply). OFFER-only: if [PRE] declines, scanEvents arms as
  // always and the event plays next reply — nothing can be starved.
  // ⚠ ALREADY ARMED ⇒ NO OFFER: once the pointer holds the key, the armed path (Window-A ## EVENTS)
  // is already delivering the body this reply — offering it again double-delivers the same beat with
  // two differently-worded instructions in one prompt. Suppressing the redundant offer keeps the two
  // delivery paths mutually exclusive, and each one testable on its own.
  function readyEvent(statData, adapter) {
    var t = eligibleWinner(statData, adapter);
    if (!t) return null;
    if (adapter.getArmed(statData) === '@' + t.key) return null;   // the arm path is already delivering it
    return { key: t.key, series: t.series || '', cat: t.cat || 'TRG' };
  }

  return {
    FORMAT: FORMAT,                             // the pack-format level THIS engine executes (stamped by the bundle build)
    LIBRARY_SUGAR: LIBRARY_SUGAR,               // the LHS forms this file resolves for every genre (stamped beside the alias keys)
    resolveLHS: resolveLHS,                     // DaysSince · aliases · resolveScalar · raw path — the ONE resolution order
    expandAlias: expandAlias,
    civilDaysSince: civilDaysSince,             // the civil-clock subtraction a genre's daysSince may point at
    applyWrites: applyWrites,                   // the pack's writes under the genre's rules (also called by applyEventFire)
    applyRewards: applyRewards,                 // the row's payout under the genre's reward kinds (also called by applyEventFire)
    parseToken: parseToken,                     // ⚠ three-file grammar sync — see header
    formatToken: formatToken,                   // the EMIT direction; null = unemittable (GUI must reject)
    formatTokenChain: formatTokenChain,         // descriptors → one &-joined `when`/`prereq` string
    formatWhenAny: formatWhenAny,               // descriptor-lists → the `whenAny` OR array
    evalOne: evalOne,
    evalTokens: evalTokens,
    sweepCandidateLines: sweepCandidateLines,   // the PRE-facing text lines
    eligibleWinner: eligibleWinner,             // the ONE arbitration, shared by scanEvents + readyEvent
    readyEvent: readyEvent,                     // the zero-away winner, offered to [PRE] for same-reply play
    scanEvents: scanEvents,
    applyEventFire: applyEventFire,             // verify-at-fire · applyWrites · applyRewards · fired record · clear armed
    applyStepDone: applyStepDone,               // the numbered-beat cursor inside one event body (narrator-reported, monotonic)
  };
});

