// tests/mvu-bootstrap-core.test.js — every decision the MVU bootstrap makes.
//
// The ordering of decideBootstrapAction IS the feature: a detached script API reads as an empty script list,
// so availability must be checked before anything that list says, or a dismissal gets recorded as a permanent
// decline the user never made. Every case below is written to fail if that order moves.

import { describe, it, expect } from 'vitest';
import {
    decideBootstrapAction,
    installOfferAfter,
    waitUntilReady,
    findMvuBundleImports,
    enabledMvuImports,
    duplicateCardMvuImports,
    MVU_BUNDLE_MARKER,
} from '../src/features/mvu-bootstrap/mvu-bootstrap-core.js';

const anImport = (name = 'mvu') => ({ name, url: 'https://x/MagVarUpdate/bundle.js', isEnabled: true });

const MVU_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
const script = (name, content = '', extra = {}) => ({
    type: 'script', enabled: true, name, id: 'id-' + name, content,
    info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false },
    ...extra,
});
const folder = (name, scripts, extra = {}) => ({ type: 'folder', enabled: true, name, id: 'f-' + name, icon: '', color: '', scripts, ...extra });
const mvuScript = (extra = {}) => script('mvu', `import '${MVU_URL}';`, extra);
const schemaScript = () => script('Scheme', "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';");

describe('decideBootstrapAction — unavailable is not absent', () => {
    // Every other field here says "install MVU"; the only thing stopping us is that we cannot see.
    it('returns unavailable when the script API is detached, even though nothing was found', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: false, enabledImports: [], hasDeclined: false, isRequestedByUser: false,
        })).toBe('unavailable');
    });

    // The write half is just as detached as the read half, so a click cannot be served either.
    it('stays unavailable when the user pressed Install MVU', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: false, enabledImports: [], hasDeclined: false, isRequestedByUser: true,
        })).toBe('unavailable');
    });

    // We did not read that import, we were handed it: 'present' while blind would be right by luck only.
    it('stays unavailable even when imports are somehow non-empty', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: false, enabledImports: [anImport()], hasDeclined: false, isRequestedByUser: false,
        })).toBe('unavailable');
    });

    it('stays unavailable for a user who previously declined', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: false, enabledImports: [], hasDeclined: true, isRequestedByUser: false,
        })).toBe('unavailable');
    });

    // A caller that forgot to pass state must not read as "API is fine".
    it('treats a missing state object as unavailable, never as ask', () => {
        expect(decideBootstrapAction()).toBe('unavailable');
        expect(decideBootstrapAction({})).toBe('unavailable');
    });
});

describe('decideBootstrapAction — the ordinary branches', () => {
    it('is present when a live import exists', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [anImport()], hasDeclined: false, isRequestedByUser: false,
        })).toBe('present');
    });

    // A user who said no and later installed MVU by hand must not be asked again.
    it('is present even for a user who declined, once MVU is actually there', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [anImport('my-own-mvu')], hasDeclined: true, isRequestedByUser: false,
        })).toBe('present');
    });

    // Pressing Install MVU while MVU already runs writes nothing.
    it('is present even when the user pressed Install MVU', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [anImport()], hasDeclined: false, isRequestedByUser: true,
        })).toBe('present');
    });

    it('asks when the API is attached and nothing is installed', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [], hasDeclined: false, isRequestedByUser: false,
        })).toBe('ask');
    });

    it('respects a remembered decline instead of asking again', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [], hasDeclined: true, isRequestedByUser: false,
        })).toBe('declined');
    });

    // The click is the consent: no popup, and a remembered decline does not stand in its way.
    it('installs without asking when the user pressed Install MVU, even after a decline', () => {
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [], hasDeclined: true, isRequestedByUser: true,
        })).toBe('install');
        expect(decideBootstrapAction({
            isScriptApiAvailable: true, enabledImports: [], hasDeclined: false, isRequestedByUser: true,
        })).toBe('install');
    });
});

describe('installOfferAfter — the MVU status on the Main tab follows each bootstrap result', () => {
    it('hides once MVU runs', () => {
        expect(installOfferAfter('present')).toBe('hide');
        expect(installOfferAfter('installed')).toBe('hide');
    });

    it('shows while MVU is missing', () => {
        expect(installOfferAfter('declined')).toBe('show');
        expect(installOfferAfter('failed')).toBe('show');
    });

    // A blind attempt says nothing about MVU, so the row stays as the last real answer left it.
    it('keeps the row as it is when the API was not attached, or for an unknown result', () => {
        expect(installOfferAfter('unavailable')).toBe('keep');
        expect(installOfferAfter(undefined)).toBe('keep');
    });
});

describe('waitUntilReady — the load-time wait for TavernHelper\'s script API', () => {
    const timing = (sleeps) => ({ deadlineMs: 30000, intervalMs: 500, sleep: async (ms) => { sleeps.push(ms); } });

    it('answers at once, without sleeping, when already ready', async () => {
        const sleeps = [];
        expect(await waitUntilReady(() => true, timing(sleeps))).toBe(true);
        expect(sleeps).toEqual([]);
    });

    it('keeps polling until ready, one interval at a time', async () => {
        const sleeps = [];
        let calls = 0;
        expect(await waitUntilReady(() => ++calls === 4, timing(sleeps))).toBe(true);
        expect(sleeps).toEqual([500, 500, 500]);
    });

    // 30 s at 500 ms = 60 waits, then one last look, then false — never an endless wait.
    it('gives up once the deadline has been waited, after one last look', async () => {
        const sleeps = [];
        let calls = 0;
        expect(await waitUntilReady(() => { calls++; return false; }, timing(sleeps))).toBe(false);
        expect(sleeps.length).toBe(60);
        expect(calls).toBe(61);
    });

    it('takes the answer that arrives on the very last look', async () => {
        const sleeps = [];
        let calls = 0;
        expect(await waitUntilReady(() => ++calls === 61, timing(sleeps))).toBe(true);
    });
});

describe('findMvuBundleImports / duplicateCardMvuImports (the double-load scan)', () => {
    it('finds the card import, the url it pins, and the id a disable needs', () => {
        expect(findMvuBundleImports([mvuScript(), schemaScript()]))
            .toEqual([{ id: 'id-mvu', name: 'mvu', url: MVU_URL, isEnabled: true }]);
    });

    // A disabled script provides nothing (window.Mvu stays undefined), but naming it is what tells a user why.
    it('reports isEnabled:false rather than hiding it — a disabled script is still worth naming', () => {
        expect(findMvuBundleImports([mvuScript({ enabled: false })]))
            .toEqual([{ id: 'id-mvu', name: 'mvu', url: MVU_URL, isEnabled: false }]);
    });

    it('an import inside a disabled folder does not run, whatever its own flag says', () => {
        const trees = [folder('parked', [mvuScript()], { enabled: false })];
        expect(findMvuBundleImports(trees)[0].isEnabled).toBe(false);
        expect(enabledMvuImports(findMvuBundleImports(trees))).toEqual([]);
    });

    it('an import inside an enabled folder runs', () => {
        expect(enabledMvuImports(findMvuBundleImports([folder('libs', [mvuScript()])])).map((i) => i.name)).toEqual(['mvu']);
    });

    it('enabledMvuImports drops the disabled ones — only running code provides MVU', () => {
        const trees = [mvuScript({ enabled: false }), script('mvu2', `import '${MVU_URL}';`)];
        expect(enabledMvuImports(findMvuBundleImports(trees)).map((i) => i.name)).toEqual(['mvu2']);
    });

    it('matches on the repo name, so a DIFFERENT mirror is still recognised as MVU', () => {
        const other = 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
        expect(findMvuBundleImports([script('mvu', `import '${other}';`)])[0].url).toBe(other);
    });

    it('does not mistake the schema script for an MVU import', () => {
        expect(findMvuBundleImports([schemaScript()])).toEqual([]);
    });

    it('reports url:"" when the marker is present but no specifier parses — still worth surfacing', () => {
        expect(findMvuBundleImports([script('odd', `/* ${MVU_BUNDLE_MARKER} mentioned, no import */`)]))
            .toEqual([{ id: 'id-odd', name: 'odd', url: '', isEnabled: true }]);
    });

    // Each TavernHelper script runs in its own iframe, so module maps never dedupe across scripts: the same url
    // still boots a second MVU instance.
    it('the SAME url IS a duplicate — per-iframe module maps never dedupe across scripts', () => {
        expect(duplicateCardMvuImports(findMvuBundleImports([mvuScript(), schemaScript()])).map((i) => i.name)).toEqual(['mvu']);
    });

    it('a DISABLED card import is NOT a duplicate — it never loads', () => {
        expect(duplicateCardMvuImports(findMvuBundleImports([mvuScript({ enabled: false })]))).toEqual([]);
    });

    it('a card with no MVU import of its own duplicates nothing', () => {
        expect(duplicateCardMvuImports(findMvuBundleImports([schemaScript()]))).toEqual([]);
    });
});
