// engine-frame-core tests — the Content-Security-Policy the engine Worker runs under, the frame that
// carries it, and the module list it allows. engine-worker-host.js needs a browser (an iframe, a
// Worker, a frame realm), so the decisions it makes are pinned here by reading its source.
//
// What the policy is FOR: dynamic import() is syntax, so the capability block cannot take it away; with
// the block up it loaded any URL (measured 2026-08-06). Only script-src refuses it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
    ENGINE_WORKER_MODULES, ENGINE_FRAME_ATTRIBUTE, cspSourceForUrl, buildEngineFrameCsp, composeEngineFrameSrcdoc,
} from '../src/features/logic-engine/engine-frame-core.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const EXTENSION = 'http://127.0.0.1:8000/scripts/extensions/third-party/mvu-helper/';
const MODULE_URLS = ENGINE_WORKER_MODULES.map((path) => new URL(path, EXTENSION).href);

function directivesOf(csp) {
    const out = {};
    for (const part of csp.split(';')) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) out[name] = values;
    }
    return out;
}

describe('the engine frame policy', () => {
    const csp = buildEngineFrameCsp(MODULE_URLS);
    const directives = directivesOf(csp);

    it('denies by default — connect-src is not opened, so fetch, XHR, WebSocket and sendBeacon stay refused', () => {
        expect(directives['default-src']).toEqual(["'none'"]);
        expect(directives['connect-src']).toBeUndefined();
    });
    it("script-src is 'unsafe-eval' alone — engine text becomes code through new Function, and import() has no URL to load", () => {
        expect(directives['script-src']).toEqual(["'unsafe-eval'"]);
    });
    it("worker-src is the bootstrap's blob plus each module file by full path — a module Worker's static imports are Worker loads", () => {
        expect(directives['worker-src']).toEqual(['blob:', ...MODULE_URLS]);
        for (const source of directives['worker-src'].slice(1)) {
            expect(source).toMatch(/^https?:\/\/[^/\s]+\/\S+\.js$/);
        }
    });
    it('nothing in the policy widens it — no keyword, wildcard or scheme beyond the blob a Worker starts from', () => {
        expect(csp).not.toMatch(/'self'|'unsafe-inline'|'strict-dynamic'|'wasm-unsafe-eval'|\bdata:|\*/);
        expect(Object.keys(directives).sort()).toEqual(['default-src', 'script-src', 'worker-src']);
    });

    it('an empty module list is refused — a Worker that can load nothing is a bug, not a policy', () => {
        expect(() => buildEngineFrameCsp([])).toThrow(/no module URLs/);
    });
});

describe('cspSourceForUrl', () => {
    it("percent-encodes the policy's own separators, which CSP decodes again before matching", () => {
        expect(cspSourceForUrl('http://h:1/ext/a;b,c.js')).toBe('http://h:1/ext/a%3Bb%2Cc.js');
    });
    it('refuses what a source expression cannot match exactly', () => {
        expect(() => cspSourceForUrl('http://h/a.js?x=1')).toThrow(/query or fragment/);
        expect(() => cspSourceForUrl('http://h/a.js#x')).toThrow(/query or fragment/);
        expect(() => cspSourceForUrl('http://user:pw@h/a.js')).toThrow(/credentials/);
        expect(() => cspSourceForUrl('file:///C:/a.js')).toThrow(/http\(s\)/);
        expect(() => cspSourceForUrl('a.js')).toThrow(/absolute URL/);
    });
});

describe('composeEngineFrameSrcdoc', () => {
    it('carries the policy in a <meta> the frame parses before anything else, and runs no script', () => {
        const csp = buildEngineFrameCsp(MODULE_URLS);
        const doc = composeEngineFrameSrcdoc(csp);
        expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp.replace(/'/g, '&#39;')}">`);
        expect(doc).not.toMatch(/<script/i);
    });
    it('escapes the attribute, so a URL cannot close it', () => {
        const doc = composeEngineFrameSrcdoc(`default-src 'none'; x "><script>`);
        expect(doc).not.toContain('"><script>');
        expect(doc).toContain('&quot;&gt;&lt;script&gt;');
    });
});

describe("ENGINE_WORKER_MODULES is the Worker's whole import graph", () => {
    const host = read('src/features/logic-engine/engine-worker-host.js');
    // The bootstrap's own imports, as engine-worker-host.js names them.
    const entries = [...host.matchAll(/moduleUrl\('([^']+)'\)/g)].map((m) => `src/features/logic-engine/${m[1]}`);
    const IMPORT = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

    function closure(roots) {
        const seen = new Set();
        const queue = [...roots];
        while (queue.length) {
            const file = queue.shift();
            if (seen.has(file)) continue;
            seen.add(file);
            for (const m of read(file).matchAll(IMPORT)) {
                const specifier = m[1] || m[2];
                expect(specifier.startsWith('.'), `${file} imports "${specifier}" — the Worker can only load files of this extension`).toBe(true);
                queue.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
            }
        }
        return seen;
    }

    it('the bootstrap imports the capability block and the engine core', () => {
        expect(entries).toEqual(['src/features/logic-engine/engine-capability-block.js', 'src/features/logic-engine/logic-engine-core.js']);
    });
    it('every module those import, transitively, is listed — and nothing else is', () => {
        expect([...closure(entries)].sort()).toEqual([...ENGINE_WORKER_MODULES].sort());
    });
});

describe('the host makes the Worker inside the frame (engine-worker-host.js, pinned by source)', () => {
    const host = read('src/features/logic-engine/engine-worker-host.js');

    it('the frame makes the blob URL AND owns the Worker — the page never constructs one', () => {
        expect(host).toMatch(/frameWindow\.URL\.createObjectURL\(new frameWindow\.Blob\(/);
        expect(host).toMatch(/new frameWindow\.Worker\(url, \{ type: 'module' \}\)/);
        expect(host).not.toMatch(/\bnew Worker\(/);
        expect(host).not.toMatch(/(?<![.\w])URL\.createObjectURL\(/);
    });
    it('the frame is checked for its policy before any Worker starts in it', () => {
        expect(host).toMatch(/querySelector\('meta\[http-equiv="Content-Security-Policy"\]'\)/);
        expect(host).toMatch(/meta\.getAttribute\('content'\) !== csp/);
        expect(host).toMatch(/element\.setAttribute\(ENGINE_FRAME_ATTRIBUTE, ''\)/);
        expect(ENGINE_FRAME_ATTRIBUTE).toBe('data-mvu-helper-engine-frame');
    });
    it('every message from the Worker is cloned into the page realm before it is read', () => {
        expect(host).toMatch(/function adoptMessage\(event\) \{\s*return structuredClone\(event\.data \|\| \{\}\);/);
        const listeners = [...host.matchAll(/=> \{\s*const msg = (\w+)\(event\);/g)].map((m) => m[1]);
        expect(listeners).toEqual(['adoptMessage', 'adoptMessage', 'adoptMessage']);   // the engine's two, the check Worker's one
        expect(host).not.toMatch(/const msg = event\.data/);
    });
    it('a frame that is gone ends the Worker loudly, and its calls are refused, never left waiting', () => {
        expect(host).toMatch(/addEventListener\('pagehide', \(\) => \{\s*if \(current && current\.frameWindow === frameWindow\) current\.end\(ENGINE_FRAME_GONE\);/);
        expect(host).toMatch(/if \(!ended && frameWindow\.closed\) end\(ENGINE_FRAME_GONE\);/);
        expect((host.match(/const refused = refusal\(\);/g) || []).length).toBe(2);
    });
    it('the Worker reports what the policy refused', () => {
        expect(host).toMatch(/onMessage\('securitypolicyviolation', /);
    });
});
