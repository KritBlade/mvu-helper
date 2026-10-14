#!/usr/bin/env node
/* scan_ejs_scope.cjs — EJS scope + syntax auditor. v0.4 — PASS-AWARE, and it can FAIL A BUILD.
 *
 * ST-Prompt-Template concatenates every entry rendered in ONE pass into ONE EJS compile scope, so
 * a TOP-LEVEL (depth-0) `let`/`const` with the same name in two of them collides:
 *   SyntaxError: Identifier 'X' has already been declared
 * and the ENTIRE block is sent to the model as RAW, unrendered template text. That failure is
 * uniquely nasty: raw EJS still reads like plausible prose, so the model answers from the template's
 * literal branches instead of the rendered one and nothing looks broken anywhere.
 *
 * Two checks:
 *   1. CROSS-ENTRY COLLISIONS. Tools/entry_routes.cjs says WHICH PASS each file renders in, so a REAL
 *      collision (same pass — a build breaker) is told apart from a benign one (two files that never
 *      render together, e.g. current_variable_data narrate vs current_variable_data-post [POST]).
 *      EXIT 1 on a same-pass collision, so `npm test` stops on it.
 *   2. PER-FILE SYNTAX. Each file's own scriptlets are concatenated and compiled, which catches what the
 *      collision scan cannot see: a duplicate inside ONE file, a name not `_`-prefixed, and anything
 *      inside a `try {` (where most entries put their whole body). It needs no rules and no name
 *      convention: a redeclaration, a stray brace and a bad regex all fail here.
 *
 * Full authoring rules -> maker-app/Doc/dev-helper.md §6.
 * Run from maker-app/GameLogic/Schoolv4:  node Tools/scan_ejs_scope.cjs
 */
const fs = require('fs');
const path = require('path');
const { passesFor } = require('./entry_routes.cjs');
const WS = require('./workspace_paths.cjs');

const dir = WS.WINDOWS_DIR;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// Parse the comma-separated declarator identifiers of a let/const/var statement that starts
// at code[start] (just after the keyword). Skips each initializer, respecting () [] {} and
// strings, and collects identifiers that begin a declarator (statement start or after a
// depth-0 comma). Returns { names, end } where end is the index just past the statement.
function parseDeclarators(code, start) {
  const names = [];
  let i = start, depth = 0, expectName = true;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {            // skip string literal
      const q = ch; i++;
      while (i < code.length && code[i] !== q) { if (code.charCodeAt(i) === 92) i++; i++; }   // 92 = backslash (skip escape)
      i++; expectName = false; continue;
    }
    if ('([{'.includes(ch)) { depth++; i++; expectName = false; continue; }
    if (')]}'.includes(ch)) { if (depth === 0) break; depth--; i++; continue; }
    if (ch === ';') { i++; break; }
    if (depth === 0 && ch === ',') { expectName = true; i++; continue; }
    if (expectName && /[A-Za-z_$]/.test(ch)) {
      let j = i; while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++;
      names.push(code.slice(i, j)); i = j; expectName = false; continue;
    }
    i++;
  }
  return { names, end: i };
}

// ---- SYNTAX CHECK ------------------------------------------------------------------------------
// Join every scriptlet body in the file, exactly the way EJS composes them into one function, and
// COMPILE it. The literal text between scriptlets becomes output calls in real EJS and is dropped
// here — control flow survives the join (`if (x) {` + `}` is still a balanced statement), which is
// all a syntax check needs. Never executed: `new Function` compiles, nothing runs, so undefined
// helpers (getvar, sd) are irrelevant. Wrapped in an async function because Window A awaits.
const syntaxErrors = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!src.includes('<%')) continue;
  const bodies = [];
  const sre = /<%_?(?!=)([\s\S]*?)_?%>/g;
  let sm;
  while ((sm = sre.exec(src))) bodies.push(sm[1]);
  if (!bodies.length) continue;
  try {
    // eslint-disable-next-line no-new-func
    new Function('async function __syntaxProbe() {\n' + bodies.join('\n') + '\n}');
  } catch (e) {
    syntaxErrors.push({ file: f, message: String(e && e.message) });
  }
}
if (syntaxErrors.length) {
  console.error('\n=== EJS SYNTAX ERRORS — the entry cannot compile, so ST ships it RAW ===');
  for (const e of syntaxErrors) console.error('  ' + e.file + ' — ' + e.message);
  console.error('\nA scriptlet that throws at compile time reaches the model as unrendered template text,');
  console.error('which still reads like prose — every branch of it lies and nothing looks broken.');
  process.exit(1);
}
console.log('EJS syntax check PASSED — every entry\'s scriptlets compile as one scope.\n');

const report = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!src.includes('<%')) continue;
  const re = /<%_?(?!=)([\s\S]*?)_?%>/g;                     // scriptlets only — NOT <%= output tags
  let m, depth = 0;
  const top = new Set();
  while ((m = re.exec(src))) {
    const code = stripComments(m[1]);
    const kw = /\b(?:let|const|var)\s+/g;
    let dm;
    while ((dm = kw.exec(code))) {
      let dd = depth;                                         // brace depth AT the keyword
      for (let k = 0; k < dm.index; k++) { const ch = code[k]; if (ch === '{') dd++; else if (ch === '}') dd--; }
      if (dd !== 0) continue;
      const { names, end } = parseDeclarators(code, dm.index + dm[0].length);
      for (const n of names) if (n.startsWith('_')) top.add(n);
      kw.lastIndex = end;                                     // resume after this statement
    }
    for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  report[f] = { top: [...top].sort(), endDepth: depth };
}

// name -> pass -> [files]. Bucketing by PASS is the whole point: only names that share a pass can
// collide at compile time. A file routed 'llmshare' rides both extension calls, so it lands in two
// buckets and is checked against PRE *and* POST entries.
const byPass = {};
for (const f of Object.keys(report).sort()) {
  const r = report[f];
  const passes = passesFor(f);
  console.log(f.padEnd(34) + (passes.join('+') + ' ').padEnd(10) + (r.top.join(', ') || '(none)')
    + (r.endDepth ? '  [!! endDepth=' + r.endDepth + ']' : ''));
  for (const p of passes) {
    const bucket = byPass[p] || (byPass[p] = {});
    for (const v of r.top) (bucket[v] = bucket[v] || []).push(f);
  }
}

const real = [];
const benign = [];
const seenPairs = new Set();
for (const pass of Object.keys(byPass).sort()) {
  for (const name of Object.keys(byPass[pass]).sort()) {
    const files = byPass[pass][name];
    if (files.length > 1) real.push({ pass, name, files });
  }
}
// A name in >1 file that never shares a pass — reported for awareness, NOT a failure.
const everywhere = {};
for (const f of Object.keys(report)) for (const v of report[f].top) (everywhere[v] = everywhere[v] || []).push(f);
for (const name of Object.keys(everywhere).sort()) {
  const files = everywhere[name];
  if (files.length < 2) continue;
  if (real.some((c) => c.name === name)) continue;
  benign.push({ name, files });
}

console.log('\n=== COLLISIONS — same top-level name, SAME render pass (build breakers) ===');
if (!real.length) console.log('(none)');
for (const c of real) {
  const key = c.name + '|' + c.files.join(',');
  if (seenPairs.has(key)) continue;
  seenPairs.add(key);
  console.log(`  [${c.pass}] ${c.name} -> ${c.files.join(', ')}`);
}

if (benign.length) {
  console.log('\n--- shared names across DIFFERENT passes (harmless — they never compile together) ---');
  for (const b of benign) console.log(`  ${b.name} -> ${b.files.join(', ')}`);
}

if (real.length) {
  console.error('\nEJS SCOPE CHECK FAILED — rename one side so each depth-0 declaration is unique within its pass.');
  console.error('Left unfixed, the duplicate `let` throws at compile time and the ENTIRE block reaches the model as');
  console.error('raw, unrendered EJS — which still reads like prose, so nothing looks broken while every branch lies.');
  process.exit(1);
}
console.log('\nEJS scope check PASSED — no two entries in the same render pass declare the same depth-0 name.');
