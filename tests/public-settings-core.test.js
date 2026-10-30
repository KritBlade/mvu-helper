// tests/public-settings-core.test.js — `MvuHelper.settings`: the settings a card and an engine read by name
// (plans/pack-install-warning.md §2).
//
// What each block guards, and the mutation that proves the guard is one:
//   • every read answers what mvu-helper's own reader of that setting makes of it — a switch is
//     `=== true`, an unknown verbosity is 'off', a missing language is 'en' — and the debug domains are
//     log.js's — MUTATION: read a switch as truthy → the "yes" case fails;
//   • a card may set only a writable row, and only with a value of its kind — MUTATION: drop the
//     isWritable check → the read-only test fails; drop the kind check → the wrong-type test fails;
//   • a write never overwrites a value that stands where an object must go;
//   • the engine's copy carries the public rows and nothing else of mvu-helper's settings;
//   • the page door decides nothing itself: it checks before it writes, saves and repaints after, and
//     `MvuHelper.settings` is published (source gates — the door imports SillyTavern and cannot load here).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    PUBLIC_DEBUG_DOMAINS, publicSettingRow, publicSettingNames, readPublicSetting, publicSettingWriteProblem,
    writePublicSetting, publicSettingsSnapshot,
} from '../src/shared/public-settings-core.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r/g, '');
const valueOf = (root, name) => readPublicSetting(root, publicSettingRow(name));

describe('the rows', () => {
    it('name the verbosity, one switch per debug domain, and the language', () => {
        expect(publicSettingNames()).toEqual(['debug.verbosity', 'debug.pipeline', 'debug.imagegen', 'debug.roster', 'debug.smallllm', 'language']);
        expect(publicSettingRow('debug.pipeline')).not.toBeNull();
        expect(publicSettingRow('extensionSettings')).toBeNull();
        expect(publicSettingRow('__proto__')).toBeNull();
    });
    it("the debug domains are log.js's LOG_DOMAINS — a switch the log gate does not know would never print", () => {
        const logDomains = read('src/sillytavern/log.js').match(/export const LOG_DOMAINS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
        expect([...PUBLIC_DEBUG_DOMAINS].sort()).toEqual([...logDomains].sort());
    });
});

describe('a read answers what mvu-helper itself makes of the setting', () => {
    const live = { debug_verbosity: 'verbose', debug_domain: { pipeline: true, roster: false }, language: 'zh-cn', someOtherSetting: 'private' };

    it('answers the stored value', () => {
        expect(valueOf(live, 'debug.verbosity')).toBe('verbose');
        expect(valueOf(live, 'debug.pipeline')).toBe(true);
        expect(valueOf(live, 'debug.roster')).toBe(false);
        expect(valueOf(live, 'language')).toBe('zh-cn');
    });
    it('an unset setting, and no settings at all, answer as unset', () => {
        for (const root of [{}, undefined, null]) {
            expect(valueOf(root, 'debug.verbosity')).toBe('off');
            expect(valueOf(root, 'debug.imagegen')).toBe(false);
            expect(valueOf(root, 'language')).toBe('en');
        }
    });
    // log.js getDomain: `debug_domain?.[name] === true`. A switch that answered truthy would tell a card
    // the trace is on while the log gate keeps it silent.
    it('MUTATION TARGET — a switch is on only when it holds true', () => {
        for (const stored of ['yes', 1, 'true', {}]) expect(valueOf({ debug_domain: { pipeline: stored } }, 'debug.pipeline')).toBe(false);
        expect(valueOf({ debug_domain: 'pipeline' }, 'debug.pipeline')).toBe(false);
    });
    // log.js getVerbosity: an unknown level reads as off.
    it("each of log.js's levels reads as itself; anything else reads as 'off'", () => {
        const levels = [...read('src/sillytavern/log.js').match(/const VERBOSITY_LEVELS = \{([^}]*)\}/)[1].matchAll(/(\w+):\s*\d/g)].map((m) => m[1]);
        expect(levels).toEqual(['off', 'lifecycle', 'verbose', 'trace']);
        for (const level of levels) expect(valueOf({ debug_verbosity: level }, 'debug.verbosity')).toBe(level);
        for (const stored of ['bogus', '', 3, true]) expect(valueOf({ debug_verbosity: stored }, 'debug.verbosity')).toBe('off');
    });
    it("a missing language reads as 'en', as i18n.js reads it", () => {
        expect(read('src/sillytavern/i18n.js')).toContain("getGlobal().language || 'en'");
        expect(valueOf({ language: '' }, 'language')).toBe('en');
    });
});

describe('what a card may set', () => {
    it('a debug switch, with true or false', () => {
        for (const domain of PUBLIC_DEBUG_DOMAINS) {
            expect(publicSettingWriteProblem('debug.' + domain, true)).toBeNull();
            expect(publicSettingWriteProblem('debug.' + domain, false)).toBeNull();
        }
    });
    it('MUTATION TARGET — never the verbosity or the language: those are the user\'s', () => {
        expect(publicSettingWriteProblem('debug.verbosity', 'trace')).toMatch(/can be read but not set/);
        expect(publicSettingWriteProblem('language', 'en')).toMatch(/can be read but not set/);
    });
    it('MUTATION TARGET — never a value of another kind, and the refusal names what the row takes', () => {
        for (const value of ['true', 1, null, undefined, {}]) {
            expect(publicSettingWriteProblem('debug.pipeline', value)).toMatch(/takes true or false, and was given/);
        }
    });
    it('never a name that is not a row, and the refusal lists the rows', () => {
        const problem = publicSettingWriteProblem('debug_domain.pipeline', true);
        expect(problem).toMatch(/is not a setting/);
        expect(problem).toContain('debug.pipeline');
        expect(publicSettingWriteProblem('__proto__', true)).toMatch(/is not a setting/);
    });
});

describe('writePublicSetting', () => {
    it('stores the value at the row\'s place, making the domain object when there is none, and touches nothing else', () => {
        const root = { debug_verbosity: 'lifecycle', other: 1 };
        expect(writePublicSetting(root, publicSettingRow('debug.pipeline'), true)).toBe(true);
        expect(root).toEqual({ debug_verbosity: 'lifecycle', other: 1, debug_domain: { pipeline: true } });
        expect(writePublicSetting(root, publicSettingRow('debug.roster'), false)).toBe(true);
        expect(root.debug_domain).toEqual({ pipeline: true, roster: false });
    });
    it('writes nothing over a value that stands where the domain object belongs', () => {
        const root = { debug_domain: 'hand-edited' };
        expect(writePublicSetting(root, publicSettingRow('debug.pipeline'), true)).toBe(false);
        expect(root).toEqual({ debug_domain: 'hand-edited' });
    });
});

describe("publicSettingsSnapshot — the engine's copy", () => {
    const live = { debug_verbosity: 'trace', debug_domain: { pipeline: true }, language: 'zh-cn', someOtherSetting: 'private', profiles: { a: { key: 'x' } } };

    it('holds every engine-visible row by name, read as the page reads it', () => {
        expect(publicSettingsSnapshot(live)).toEqual({
            'debug.verbosity': 'trace', 'debug.pipeline': true, 'debug.imagegen': false, 'debug.roster': false, 'debug.smallllm': false, language: 'zh-cn',
        });
    });
    it('carries nothing else of mvu-helper\'s settings, and survives a structured clone', () => {
        const snapshot = structuredClone(publicSettingsSnapshot(live));
        expect(JSON.stringify(snapshot)).not.toContain('private');
        expect(JSON.stringify(snapshot)).not.toContain('profiles');
        expect(snapshot['debug.pipeline']).toBe(true);
    });
});

describe('the page door decides nothing itself (source gates)', () => {
    const door = read('src/features/public-settings/public-settings.js');
    const bodyOf = (signature) => { const from = door.slice(door.indexOf(signature)); return from.slice(0, from.indexOf('\n}')); };

    it('get reads the live settings through the row', () => {
        expect(bodyOf('function get(')).toContain('return readPublicSetting(getGlobal(), row);');
    });
    it('MUTATION TARGET — set checks before it writes, and saves and repaints only after a write', () => {
        const set = bodyOf('function set(');
        const check = set.indexOf('publicSettingWriteProblem(');
        const write = set.indexOf('writePublicSetting(');
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(write);
        expect(set.indexOf('saveSettingsDebounced();')).toBeGreaterThan(write);
        expect(set.indexOf('updateMainUI();')).toBeGreaterThan(write);
    });
    it('MUTATION TARGET — MvuHelper.settings is the door, on the frozen page global', () => {
        expect(read('src/index.js')).toMatch(/globalThis\.MvuHelper = Object\.freeze\(\{[^\n]*\bsettings: publicSettings \}\);/);
    });
});
