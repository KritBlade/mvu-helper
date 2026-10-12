---
name: dev-workflow-standards-shell-logging-helpers
description: Core dev rules - Use Bash if you can because more tools available. Always check SigMap before new helpers. Logging migration. No fallback/migration without asking.
metadata:
  node_type: memory
  type: project
---

## Project layering — platform vs consumer (mandatory)
Platform/consumer boundaries prevent cross-repo coupling bugs where platforms fail silently by assuming downstream structures.

| Tier | May Know About |
|---|---|
| **Platform** (`mvu-helper`) | Own contracts and READ ONLY. **Zero downstream knowledge** (schemas, variables, logic). |
| **Consumer** (Genre repos: School, RPG, Love) | Your code inside workspace folder. Published platform contracts. Declares its own domain shape. |
| **Blind Adapter** (`galgame-companion`) | Neither side directly. Adapts interface shapes without knowing the consumers/platforms. |

## **Fallback / Migration**   (mandatory)
- **Always ask user first** before adding any fallback or migration logic. These become hard to troubleshoot later.
**Goal:** Cleaner codebase through reuse + consistent standards.

## Naming for folders and filename (mandatory)
**Core Rule**: Name by purpose/meaning—NEVER by sequence, age, author, or temporary state. Names must be clear without historical project context.
### Rules & Restrictions
* **Banned Vague/Temp Terms**: `feature2`, `v2`, `new`, `old`, `temp`, `tmp`, `final`, `helper2`, `data2`, `handler`, `manager`, `stuff`, `misc`, dumping-ground `utils`.
* **Ubiquitous Domain Language**: One concept = one term across files, classes, functions, variables, DB, API, and UI. Zero synonym drift (e.g., pick ONE: `user` vs `account` vs `member` vs `profile`). Prefer existing user-facing terms.
* **Spelling & Abbreviations**: Spell words out. 
  * *Allowed acronyms*: `URL`, `ID`, `HTTP`, `API`, `DB`.
  * *Prohibited short-forms*: `usr`, `cfg`, `calc2`, `req`, `res`, `fn`.
* **Scope Scaling**: Micro-local scope may use short names; exported/persisted/public/long-lived identifiers MUST be fully explicit.
* **Booleans**: MUST read as predicate questions (`isPresent`, `hasConfig`, `canDraw`, `shouldRetry`). BANNED: `flag`, `status`, `check`, `present`.
* **Refactoring & Refusal**:
  * Rename bad identifiers immediately when touching a file; NEVER propagate bad names for consistency.
  * **Dev/Pre-release**: Full rename, zero compatibility shims.
  * **Released/Persisted/Public API**: Migration required—stop and ask first.
**The one-line test:** *Could a stranger guess what this is from the name alone?* If no, rename it now.

### Tier Invariants (L1–L6)
* **L1: Vocabulary Isolation.** Platform code must NEVER hardcode consumer entities, state paths, channel names, or genre-specific prompts. (Example labels in comments are allowed).
* **L2: Consumer-Driven Schema.** Consumers declare configuration; platforms read/enumerate it dynamically (`Object.keys()`). Expand config schemas instead of adding platform-side defaults/constants.
* **L3: Read-Only Consumer Namespaces.** Platforms may manage their own state/namespace, but must NEVER write into or create roots inside a consumer-owned namespace.
* **L4: Consumer Agnosticism.** Every platform line must remain valid if the primary consumer is uninstalled or replaced with an empty stub consumer.
* **L5: No Conditional Starvation.** NEVER gate genre-neutral content on a consumer-specific condition. The platform names nothing here — it just puts a universal rule inside a block that exists only when a consumer field does, so the rule silently vanishes for everyone else. A grep cannot see this (no vocabulary to find). Ask of every conditional: *is everything inside it actually about the condition?* (Live: registered outfit variants reached the prompt ONLY via a presence-gated roster block, so every card without a presence flag was told to pick from a list it was never shown.)
* **L6: Decisions Must Be Reachable.** A gate inside a host-coupled file cannot be tested at all, so "add a test" is not a buildable fix — extract the decision to a pure `-core.js` FIRST, then guard it. Sharp edge of P2: **coupling hides in exactly the files no test can open**, so the defect and its invisibility share one cause. Audit what untestable files DECIDE, not only what they name. Verify every guard by MUTATION (break it on purpose, watch it fail, restore) — a guard never seen to fail is not known to be a guard.
* **L7: Fix The Bug Where It HURTS — never cross-fix.** Each repo exists for one goal; a bug belongs to the module whose OWN goal it breaks, and that module fixes it alone. Before touching a repo ask: *does this defect actually break THIS module's job?* If not, it is not this repo's bug, however easy the fix looks from here. Cross-fixing is how modules stop being independent: two repos end up encoding the same failure, and neither can be changed or deleted without breaking the other.
  * **Corollary — say it, don't fix it.** When a defect in someone else's layer is visible from here, SURFACE it (a warn naming the cause) instead of repairing it. A repair hides the defect from the module that should own it and leaves this one silently responsible forever.
**Litmus Test:** Would this line of platform code still be correct if the current consumer were completely deleted?

### Architectural Rules (P1–P8)
* **P1: Group by Feature, Never Kind.** Banned folder names: `helpers/`, `lib/`, `common/`, `core/`, `modules/`, `misc/`, `classes/`, `functions/`, `interfaces/`. No internal `api/`/`services/`/`models/` sub-folders until feature exceeds ~8 files (keep flat).
* **P2: Feature Self-Containment.** Everything a feature owns (UI, adapters, logic, constants) lives in its folder. Represent purity/layer splits via file suffixes (`x-core.js`), never sub-folders.
* **P3: Earned `shared/`.** Move code to `shared/` ONLY if 2+ distinct features consume it AND it lacks a single domain owner. No speculative abstractions.
* **P4: Unidirectional Flow (`features -> shared -> <host>`).** Only `<host>/` may touch host/vendor APIs. Host coupling must be obvious from path alone.
* **P5: No Upward Imports.** Lower layers and libraries must NEVER import features. Use inversion of control/registration hooks (`registerX()`, `setXSource()`) initialized at startup or in `src/index.js`.
* **P6: Strict Barrel Encapsulation.** Cross-feature imports MUST target the barrel file explicitly (`features/<f>/index.js`). Deep imports into another feature's internals are forbidden.
* **P7: Mechanical Move Verification.** After relocating files, run test suites, static module resolvers, and explicit path checks against installed dependencies.
* **P8: Immediate Placement Cleanup.** Fix wrong placement immediately upon touching a file. Update imports, clear stale path comments, and update/prune deployment `RETIRED` lists to prevent dead-file edits.
**Litmus Test:** A stranger must be able to correctly infer a file's placement and allowed importers purely from its path.

## **ALWAYS check existing functions first**   (mandatory)
Before writing any new helper: check if logic already exists (even with minor differences). Prefer refactoring to shared function over duplication.

## Narrate = observer, RES = brain (mandatory design doctrine)
Applies to every `/Intent` channel and every logic-engine function.
* **Narrate (AI model) = pure OBSERVER.** Emits `/Intent` reporting what its prose just did — one simple judgment at a time, never compound, never a verdict, never a forecast, never initiating from silence. Every duty must be doable by a low-end model (gemma 27b is the bar).
* **RES (engine) = the brain.** Parses the `/Intent` sentence and does ALL number crunching and logic diversion. May be arbitrarily complex — it is 100% deterministic and unit-tests without narrate.
* **Payoff:** the `/Intent` log lines ARE the result — the turn is known without reading the prose; prose is cross-checked only to catch an emit contradicting its own page. Every engine function's boundary is known before design starts.
* **When a channel misbehaves: a judgment leaked into narrate's duties — never a wording problem.** Do NOT make the instruction louder; convert the judgment into an observation. (Proven: social-check verdict removal after CHECK DESYNC, H-act `gate:<die>` never `gate:Success`, stepDone dump-and-sort — each fix = DELETE the judgment, KEEP the observation. The quest channel burned 5 prompt rounds before conforming: `Plans/quest-revisit.md` §0.)

## Same reply calcuation protection (mandatory)
We made numerous edition in mvu-helper and mvu-squid logic just to make sure dice roll can be resolved inside the same reply instead of delaying to the next round.  Whenever changes that seems to break this protection, STOP , verify and ASK.
Same-reply EVENT firing — which piece is the engine's, which is mvu-helper's, and why: `maker-app/GameLogic/Schoolv4/doc/GameLogicEngine_Guide.md`.

### Failure Mode & Impact
* **Silent Dropping:** Files wrapped in IIFE/UMD (`(function(...)`) or non-exported scripts (`_engine/eventpack.cjs`, `engine/i18n.cjs`, `globalLogic.cjs`, `logicengine-bundle.cjs`, `Tools/*.cjs`) yield 0 signatures and are omitted from `.github/copilot-instructions.md` with no warning.
* **Misleading Diagnostics:** `sigmap --report` misdiagnoses extractor misses as token/`srcDirs` issues. A green budget report DOES NOT guarantee coverage.
* **False Negatives:** AI queries asking "does helper X exist?" receive confident "no" answers for dropped files, causing duplicate code creation.
### Config vs. Extractor Separation
* **Config Fix (Budget Half):** `gen-context.config.json` pins `srcDirs`, sets `autoMaxTokens: false`, and `maxTokens: 25000` (fixing token/outline bloat, dropping files 35 → 0).
* **Extractor Limit (Code Half):** No config key (`customExtractor`, etc.) fixes column 0 regex blindness.

## Comments in source file including lorebook entry or javascript files
- It should ONLY contain what it does, we do not need history what has been changed.  If you still find old files have full history, change it.
- **Stale comments** If you see stale comments in code after verification, warn me and make the correction.

## Documents must be PRUNED, not appended   (mandatory)
A document is NOT a history audit. Do not append changes to the doc.  Applies to every doc, guide, plan, and every comment block in source files or lorebook entries.
- **Edit the ASSERTION SITE; never append a correction.** When a claim is retired, find every place
  that states it and change those. A correction that lives only in the newest section is NOT a
  correction — the old text still teaches the old thing to whoever reads only that part.
- **Every addition names what it REPLACES.** If it replaces nothing, say why the doc had to grow.
- **Retire by DELETION** — not strikethrough, not "(deprecated)", not "(old)". Delete stale information.
- **Grep before you trust a doc claim.** If code and doc disagree, the code wins and the doc is
  fixed in the SAME pass.
- **HISTORY IS PROHIBITED. To write anything, READ the existing block first, then REPLACE it WHOLE.**
  Never revise a fragment and leave the rest standing; never set a newer paragraph beside an older
  one. No exception. **Why:** retained history READS AS CURRENT — the model finds a confident
  sentence, acts on it, and the real answer was two blocks further down. This is an ongoing trap, not
  a tidiness preference. Four live cases in ONE day (2026-08-26): a hook described as "becomes an
  action" when it is folded INTO actions; a sync stamp claiming v0.2 against an authority at v0.14; a
  verification row naming layout files that exist under no such name; a row claiming a later phase
  deletes an encode path it never touches.
- **PLAN DOCS have ONE shape, in this order.** (1) TOP — description + the CURRENT version's changes
  ONLY; never a version log, because git holds every earlier one. (2) TRACKING tables — done or not,
  and how each item is verified. These hold ALL status: no ✅, no "BUILT", no `[x]` anywhere below
  them. (3) Everything after — scope, implementation detail, description: what the model reads while
  building and updates when reality deviates from the plan. The user reads only the top and learns
  the whole state.
**Litmus test:** *If a reader saw ONLY this section, would they be correct?* If not, fix the section.


## **Error handling — NEVER hide a caught exception**   (mandatory)
- Do NOT swallow silently: no `catch {}`, no `catch (e) { /* ignore */ }`, no bare `return null/-1/''` in a catch with no log. Hidden catches bury bugs and make them far harder to hunt later.  
- Surface every caught error with `log.warn('<context>:', e)` — or `log.error` if it breaks the operation. Always include a contextual message **and** the error object.  
- Swallow ONLY when the thrown condition is genuinely EXPECTED, frequent, and benign. Then PREFER restructuring so it can't throw (optional chaining / feature-detection) over catching; if you must catch, comment `// EXPECTED: <why it's safe>`.  
- **Why (user):** "make it right the first time so you don't hunt for your own bug." Faster-but-hidden costs more later. (Pure files with no logger surface via an injected `onError` hook or by returning to a caller that logs — never a silent swallow.)


##  Logging instructions
- New code: **never** use `console.*`. Always use `import { log } from 'path_to_logging_lib/log.js'`.  Check project level CLAUDE.md for more info.
- Levels: `error`/`warn` (always on), `lifecycle`/`verbose`/`trace` (gated), `log.domain(...)` for subsystems.  


## **Logging**    (mandatory)
- Before editing: scan for old `console.*` or manual gates. Migrate to central helper.  
- New code: **never** use `console.*`. Every line names WHO wrote it: `[mvu-helper] [<source>] [<stage>]… message`.  
  - **mvu-helper code:** `const log = createModuleLog('<source>')` from `src/sillytavern/log.js` — the rules are in `mvu-helper/CLAUDE.md`.  
  - **Our engine (Worker) and our card's scripts (EJS entries, TavernHelper scripts, on the page):** `MvuHelper.log`, a stage via `.child('RES')` — they print as `[mvu-helper] [engine:game] [RES] …` and `[mvu-helper] [card] [EJS] …`. Other people's engines and cards are offered it, never held to it.  
- Levels: `error`/`warn` (always on), `lifecycle`/`verbose`/`trace` (gated), `log.domain(...)` for subsystems.  

## **Log sanity check — after building ANY new mechanic / channel / stage**  
The pipeline console log — every line under `[mvu-helper]`, one stage per tag: `[small-llm] [PRE]`/`[SIM]`/`[POST]`, `[logic-engine] [RES]`/`[RES2]`, `[engine:game] [RES]`/`[PRE]` (the engine's own lines; `[PRE]` is its same-reply event pick), `[card] [EJS]`/`[EJS1]`/`[EJS3]` (the card's templates), and the RES `fired — pending:` line — is our **source of truth** for debugging the turn. Search `[mvu-helper]` for the whole turn, a stage tag for one stage. So the moment you add a new signal, Intent channel, state field, or stage, RE-READ each affected log **line by line against what it actually prints** — in the SAME pass, not later. Verify two things: 
1. **Completeness** — every new thing is REFLECTED. A log that ENUMERATES channels/state (e.g. the RES `pending:` line) MUST list the new one, or a turn firing only it reads as "nothing pending" — a lie. (Real miss: the old hand-written `_pend` list omitted `relationship`/`training`/`advance`.)  
2. **Label accuracy** — each label truthfully describes the value it prints and cannot be misread. (Real miss: `built=` meant "roster that ALREADY exists" but read as "built THIS reply" → renamed `roster/exists=`.)  
- **Why (user):** a stale or misleading log line sends you hunting the wrong bug — worse than no log. Make the log match reality the instant the feature lands.

## **Live Chrome view (Chrome DevTools MCP → live SillyTavern)**  
Lets Claude attach to the real ST tab and read frames/console/`stat_data` directly (incl. the `TH-script--*` `about:srcdoc` iframes that capture extensions can't see). **Remind the user to do this before any live browser-inspection task.**  
1. **Launch the debug Chrome FIRST** (dedicated profile → runs alongside normal Chrome, no need to close anything):  
   `start chrome --remote-debugging-port=9222 --profile-directory="Profile 1" --user-data-dir="H:\Github\misc\TestChromeProfile\Profile 1"`  
2. Open SillyTavern in it (http://127.0.0.1:8000). Point 4 below will need to use the correct URL.  
3. **Then (re)launch VS Code / Claude Code** — the MCP attaches at startup, so 9222 must already be up.  
4. Config: `.mcp.json` `chrome-devtools` uses `--browser-url=http://localhost:9222` (untracked, local). Revert to `--isolated` to spawn a throwaway browser instead.  
5. Verify: `curl http://localhost:9222/json/version`, or MCP `list_pages` shows `SillyTavern → http://127.0.0.1:8000/` (not `about:blank`).  
- If `list_pages` shows `about:blank`, the debug Chrome wasn't up at MCP start → relaunch Chrome on 9222, then restart Claude Code.




