// tools/dev-server.mjs — `npm run dev`: the node half of the artifact dev loop (workflow plan W3).
//
//   npm run dev -- <workspace-path> [--port 6620]
//
// Watches an artifact WORKSPACE (workflow plan §2.1: a pack.json at the path means one artifact,
// otherwise every immediate subdirectory holding one) and judges every artifact through
// buildWorkspaceArtifacts — the ONE pipeline (assembler + validatePack + §7 gates) the folder
// import also runs (§4.1: two code paths would mean debugging an artifact that never ships) —
// then serves the result to the browser:
//
//   GET /workspace   the full assembled state as JSON
//   GET /events      SSE — one `change` event per rebuild, naming the files that caused it
//
// The browser side (src/features/artifact-dev-loop/) opens /events only while its dev toggle is on
// (D-E: nothing polls; a regular user's session opens no connection at all).
//
// Raw node, no dependencies. CORS is wide open on purpose: the server binds 127.0.0.1 and serves a
// developer's own working tree to a developer's own SillyTavern tab.

import { readFileSync, readdirSync, statSync, existsSync, watch, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { buildWorkspaceArtifacts } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { readMenuEngineExportsInProcess } from './menu-engine-exports-in-process.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 6620;
const rootArg = args.filter((a, i) => i !== portFlag && i !== (portFlag >= 0 ? portFlag + 1 : -1))[0];
if (!rootArg) {
    console.error('usage: npm run dev -- <workspace-path> [--port 6620]');
    process.exit(1);
}
const ROOT = path.resolve(rootArg);
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
    console.error('[dev] not a directory: ' + ROOT);
    process.exit(1);
}

const readTree = (dir, base = '') => {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) out.push(...readTree(p, base + name + '/'));
        else out.push({ path: base + name, text: readFileSync(p, 'utf8') });
    }
    return out;
};

// ── assemble the whole workspace, validate each artifact ─────────────────────
let state = { version: 0, artifacts: [] };
let servedFingerprint = '';   // what the browser was last TOLD — the thing a rebuild is compared to

// A rebuild that assembles byte-identical artifacts is NOT a change, and must not be announced as
// one. The watcher answers filesystem EVENTS, and plenty of those touch no content: git re-stats
// the working tree on `git diff`/`git status` (core.autocrlf=true on Windows makes that routine),
// editors write temp siblings, backup tools touch attributes. Live 2026-08-27: `git diff` during a
// commit produced builds #20 and #21 naming entries whose mtimes were two HOURS old — two applies,
// two regex writes, two chat reloads, for zero content change.
//
// The engine sink is already immune (the loader byte-compares hosted texts before restarting the
// Worker), which is why this went unnoticed: the reload comes from the REGEX sink, which has no
// such guard and ends in reloadCurrentChat(). So the comparison belongs here, once, over the whole
// assembled result — where it covers every sink and every no-op cause at the same time.
const fingerprintOf = (artifacts) => JSON.stringify(artifacts.map((a) => [a.name, a.pack, a.errors]));

async function rebuild(changedFiles) {
    // Assembly, §3 validation and the §7 gates in ONE call — the same judgement the import UI
    // runs (same-assembler invariant, workflow plan §4.1): break the pipeline and the dev loop
    // and the folder import fail TOGETHER, which is the invariant's whole point.
    // A menu engine is read IN THIS PROCESS: the workspace is the developer's own, on their own machine.
    // The page's import lane reads the same text in the engine frame's throwaway Worker instead.
    const artifacts = await buildWorkspaceArtifacts(readTree(ROOT), { readMenuEngine: readMenuEngineExportsInProcess });
    const fingerprint = fingerprintOf(artifacts);
    const isUnchanged = fingerprint === servedFingerprint;
    const stamp0 = new Date().toTimeString().slice(0, 8);
    if (isUnchanged) {
        // Said, never silent: a developer who saw their editor write must be able to tell
        // "the server ignored it" from "the server never noticed".
        console.log('[dev ' + stamp0 + '] no change — ' + (changedFiles.join(', ') || 'rebuild')
            + ' assembles byte-identical to build #' + state.version + '; not re-applied');
        return { changedFiles, isUnchanged: true };
    }
    servedFingerprint = fingerprint;
    state = { version: state.version + 1, artifacts };

    const stamp = new Date().toTimeString().slice(0, 8);
    const changed = changedFiles.length ? ' — ' + changedFiles.slice(0, 4).join(', ') + (changedFiles.length > 4 ? ' (+' + (changedFiles.length - 4) + ')' : '') : '';
    console.log('[dev ' + stamp + '] build #' + state.version + changed);
    for (const a of artifacts) {
        const label = (a.name || '(single artifact)') + (a.pack ? ' [' + a.pack.packType + ' "' + a.pack.id + '"]' : '');
        if (a.errors.length) {
            console.log('  ✗ ' + label);
            for (const e of a.errors) console.log('      ' + e);
        } else {
            const bits = [];
            if (a.pack.engine) bits.push('engine ' + a.pack.engine.length + 'ch');
            if (a.pack.entries) bits.push(a.pack.entries.length + ' entries');
            if (a.pack.regex) bits.push(a.pack.regex.length + ' regex');
            if (a.pack.schema) bits.push('schema');
            if (a.pack.layout) bits.push('layout');
            if (a.pack.panel) bits.push('panel');
            console.log('  ✓ ' + label + ' — ' + bits.join(' · '));
        }
        for (const w of a.warnings) console.log('  ⚠ ' + w);
    }
    return { changedFiles, isUnchanged: false };
}

// The order table, printed ONCE at start — the gate that replaced School's authored ORDER map.
function printOrderTables() {
    for (const a of state.artifacts) {
        if (!a.orderListing.length) continue;
        console.log('  entry order — ' + (a.name || '(single artifact)') + ':');
        for (const row of a.orderListing) {
            console.log('    ' + String(row.order ?? '?').padStart(4) + '  '
                + (row.type === 'constant' ? 'C' : row.type === 'vectorized' ? 'V' : 'k')
                + (row.enabled ? ' ' : '·') + ' ' + row.comment);
        }
    }
}

// ── the server ───────────────────────────────────────────────────────────────
const clients = new Set();

// THIS PROCESS's identity, and the only thing that can define "the dev loop restarted".
//
// The browser cannot work that out for itself: SillyTavern resumes the loop on page load exactly the way
// the toggle starts it, so a reload and a deliberate restart run the same code with the same settings and
// are indistinguishable from inside the tab. Anything the page invents therefore resets on F5 — which is
// precisely when a question must NOT be asked again.
//
// `state.version` cannot stand in for it either: it restarts at 1 on every boot, so "1" means both "just
// started" and "one save ago".
//
// The browser stores an adoption decline against this id, so: reload keeps it, a dropped SSE socket
// reconnecting keeps it, and stopping the server and starting it again — on this path or another one —
// is a new process, a new id, and one fresh question.
const bootId = randomUUID();

const server = createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    };
    const url = new URL(req.url, 'http://x');
    // The POST below sends JSON, which makes it a NON-SIMPLE cross-origin request: SillyTavern is
    // served from :8000 and this from :6620, so the browser sends an OPTIONS preflight FIRST and
    // refuses to send the POST at all unless that preflight answers 2xx and names the method and the
    // Content-Type header. Without this the capture reaches the network and dies there — the browser
    // reports `TypeError: Failed to fetch`, the server logs NOTHING because the POST never arrived,
    // and a node-side test of the route passes because node does not preflight (live 2026-09-01).
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }
    if (url.pathname === '/workspace') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...state, bootId }));
        return;
    }
    // W9 (§2.8) — the loop's one browser→disk write: the developer dragged a pack's regexes into a
    // new order in ST, the browser noticed on CHAT_CHANGED, and this writes the arrangement into the
    // artifact's regex/regex-order.json so it survives restarts, reinstalls and fresh cards. The
    // write wakes the watcher, whose rebuild re-serves the workspace with the new declaration — at
    // which point browser and disk agree and the capture goes quiet (the no-loop construction).
    if (url.pathname === '/regex-order' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const refuse = (why) => { res.writeHead(400, cors); res.end(why); console.error('[dev] regex-order refused: ' + why); };
            let parsed;
            try { parsed = JSON.parse(body); } catch (e) { refuse('body is not JSON: ' + e.message); return; }
            const artifact = String((parsed && parsed.artifact) || '');
            const order = parsed && parsed.order;
            if (!Array.isArray(order) || order.length < 2 || order.some((n) => typeof n !== 'string' || !n)) {
                refuse('"order" must be an array of 2+ script_name strings'); return;
            }
            const known = state.artifacts.find((a) => a.name === artifact);
            if (!known) { refuse('"' + artifact + '" is not an artifact this server watches (' + state.artifacts.map((a) => a.name || '(root)').join(', ') + ')'); return; }
            // The names must be exactly the artifact's own regex set — writing anything else
            // produces a file the very next rebuild fails on rule 14, which would be this server
            // manufacturing a broken workspace out of a bad request.
            const shipped = (Array.isArray(known.pack && known.pack.regex) ? known.pack.regex : [])
                .map((r) => String((r && r.script_name) || '')).filter(Boolean);
            if (order.length !== shipped.length || order.some((n) => !shipped.includes(n))) {
                refuse('"order" must list exactly the own regexes of "' + (artifact || '(root)') + '" [' + shipped.join(', ') + '] — got [' + order.join(', ') + ']'); return;
            }
            const dir = artifact ? path.join(ROOT, artifact, 'regex') : path.join(ROOT, 'regex');
            if (!existsSync(dir)) { refuse('"' + (artifact || '(root)') + '" has no regex/ directory — nothing there to order'); return; }
            const target = path.join(dir, 'regex-order.json');
            try {
                writeFileSync(target, JSON.stringify(order, null, 2) + '\n');
            } catch (e) { refuse('write failed: ' + e.message); return; }
            const stamp = new Date().toTimeString().slice(0, 8);
            console.log('[dev ' + stamp + '] regex order captured from the card — ' + (artifact || '(root)') + '/regex/regex-order.json: ' + order.join(' → '));
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }
    if (url.pathname === '/events') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        res.write('event: hello\ndata: ' + JSON.stringify({ version: state.version, bootId }) + '\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }
    res.writeHead(404, cors);
    res.end('dev server: /workspace, /events or POST /regex-order');
});

function notify(changedFiles) {
    const payload = 'event: change\ndata: ' + JSON.stringify({ version: state.version, files: changedFiles }) + '\n\n';
    for (const c of clients) c.write(payload);
}

// ── the watcher — debounced, because editors save in bursts ──────────────────
let pending = new Set();
let timer = null;
watch(ROOT, { recursive: true }, (_event, file) => {
    if (!file || String(file).split(/[\\/]/).some((part) => part.startsWith('.'))) return;
    pending.add(String(file).replace(/\\/g, '/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
        const files = [...pending];
        pending = new Set();
        rebuild(files)
            .then((result) => { if (!result.isUnchanged) notify(files); })
            .catch((e) => console.error('[dev] rebuild failed: ' + e.message));
    }, 150);
});

await rebuild([]);
printOrderTables();
server.listen(PORT, '127.0.0.1', () => {
    console.log('[dev] watching ' + ROOT);
    console.log('[dev] serving http://127.0.0.1:' + PORT + '  (/workspace · /events) — '
        + state.artifacts.length + ' artifact(s)');
    console.log('[dev] in SillyTavern: MVU Helper → GameLogic Packs → Artifact dev loop → enable');
});
