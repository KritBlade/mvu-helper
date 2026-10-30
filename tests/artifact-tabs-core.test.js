/**
 * MVU Helper — gamelogic-pack/artifact-tabs-core.js, what the GameLogic Packs and StatusMenu Packs tabs show.
 *
 * Which tab lists which type, the header pill, the lorebook fix a notice offers, the library's groups and rows, the
 * added-to-library toast, and the three import reports. What each must hold: a fixed word as { text } (a key zh-cn
 * holds), a value as { name } or { code }, and no button that cannot work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARTIFACT_ROLES } from '../src/shared/card-artifact-store.js';
import {
    ARTIFACT_TABS, artifactTabOf, activeArtifactPill, cardLoreRepairButton, libraryRowView, libraryGroups, libraryAddedText,
    packFileReportView, sourceReportView, blankPackReportView,
} from '../src/features/gamelogic-pack/artifact-tabs-core.js';
import { PACK_TYPES } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';

const stored = (over = {}) => ({ packType: 'gamelogic', id: 'school-v4', name: 'School v4', version: '5.56', description: '', parseError: '', ...over });

describe('ARTIFACT_TABS — which tab lists which type', () => {
    it('a plugin sits with the game it extends; the menu has a tab of its own', () => {
        expect(artifactTabOf('gamelogic')).toBe('gamelogic');
        expect(artifactTabOf('plugin')).toBe('gamelogic');
        expect(artifactTabOf('statusmenu')).toBe('statusmenu');
    });
    it('every library type has exactly one tab, and an event pack none (it has its own)', () => {
        const listed = Object.values(ARTIFACT_TABS).flatMap((tab) => tab.packTypes);
        expect(listed.sort()).toEqual(PACK_TYPES.filter((packType) => packType !== 'eventpack').sort());
        expect(new Set(listed).size).toBe(listed.length);
        expect(artifactTabOf('eventpack')).toBe('');
    });
    it("each tab's ids carry their own prefix, so the two Import cards never share an element", () => {
        expect(new Set(Object.values(ARTIFACT_TABS).map((tab) => tab.idPrefix)).size).toBe(Object.keys(ARTIFACT_TABS).length);
    });
});

describe('activeArtifactPill', () => {
    it('the running pack or the shown menu by name, in its row status', () => {
        expect(activeArtifactPill({ packType: 'gamelogic', isReadable: true, artifact: { name: 'School v4', status: 'success' } })).toEqual({ name: 'School v4', status: 'success' });
        expect(activeArtifactPill({ packType: 'statusmenu', isReadable: true, artifact: { name: 'School menu', status: 'danger' } })).toEqual({ name: 'School menu', status: 'danger' });
    });
    // MUTATION TARGET: each tab names its own type when the card has none.
    it('a readable card with none of the tab\'s artifacts says which one it lacks', () => {
        expect(activeArtifactPill({ packType: 'gamelogic', isReadable: true })).toEqual({ text: 'No GameLogic Pack', status: 'neutral' });
        expect(activeArtifactPill({ packType: 'statusmenu', isReadable: true })).toEqual({ text: 'No StatusMenu Pack', status: 'neutral' });
    });
    it('nothing while the card cannot be read or its registry is broken', () => {
        expect(activeArtifactPill({ packType: 'gamelogic', isReadable: false, artifact: { name: 'x', status: 'success' } })).toBeNull();
        expect(activeArtifactPill({ packType: 'statusmenu', isReadable: true, hasRegistryError: true })).toBeNull();
    });
});

describe('cardLoreRepairButton', () => {
    it('no lore at all: create a lorebook', () => {
        expect(cardLoreRepairButton({ binding: 'no-book-bound' })).toEqual({ text: 'Create Card Lorebook' });
    });
    // MUTATION TARGET (F8): a book of the card's own name already exists, so the fix is a link, never a re-import.
    it('embedded lore whose book already exists: link it', () => {
        expect(cardLoreRepairButton({ binding: 'embedded-not-imported', canLink: true })).toEqual({ text: 'Link Card Lore' });
    });
    it('embedded lore with no book yet: Import Card Lore', () => {
        expect(cardLoreRepairButton({ binding: 'embedded-not-imported', canLink: false })).toEqual({ text: 'Import Card Lore' });
    });
    it('a renamed book or one still loading: no button, since none fixes it', () => {
        expect(cardLoreRepairButton({ binding: 'dangling-bind' })).toBeNull();
        expect(cardLoreRepairButton({ binding: 'loading' })).toBeNull();
    });
});

describe('libraryRowView', () => {
    it('a stored pack: its name, version and id, installable', () => {
        expect(libraryRowView(stored(), { isInstallable: true })).toEqual({
            name: 'School v4', pills: [], sub: [{ parts: [{ name: 'v5.56 · ' }, { code: 'school-v4' }] }], canInstall: true,
        });
    });
    it('already on this card: marked, and no install button', () => {
        const view = libraryRowView(stored(), { isOnThisCard: true, isInstallable: true });
        expect(view.pills).toEqual([{ text: 'Installed here', status: 'accent' }]);
        expect(view.canInstall).toBe(false);
    });
    it('a type this tab cannot install offers no install', () => {
        expect(libraryRowView(stored(), { isInstallable: false }).canInstall).toBe(false);
    });
    it('a plugin shows its flavor, and a description its own line', () => {
        const view = libraryRowView(stored({ packType: 'plugin', id: 'p', requires: ['cast@1'], description: 'Adds a cast.' }), { isInstallable: true });
        expect(view.sub.slice(1)).toEqual([
            { parts: [{ text: 'game-bound' }, { name: ' — ' }, { text: 'needs' }, { name: ' ' }, { code: 'cast@1' }] },
            { name: 'Adds a cast.' },
        ]);
    });
    // MUTATION TARGET: a file that no longer parses cannot install; listing it is what keeps it removable.
    it('a stored file that no longer parses: a danger pill, its error, no install', () => {
        expect(libraryRowView(stored({ name: '', parseError: 'Unexpected token' }), { isInstallable: true })).toEqual({
            name: 'school-v4', pills: [{ text: 'Does not parse', status: 'danger' }], sub: [{ name: 'Unexpected token' }], canInstall: false,
        });
    });
});

describe('libraryGroups', () => {
    it('one group per type that holds files, in the taxonomy order, each titled with its label and count', () => {
        const groups = libraryGroups([
            stored({ packType: 'plugin', id: 'p1' }), stored(), stored({ packType: 'plugin', id: 'p2' }),
        ], { installedIds: new Set(['p2']), installableTypes: new Set(['gamelogic', 'plugin']) });
        expect(groups.map((group) => group.packType)).toEqual(['gamelogic', 'plugin']);
        expect(groups[1].title).toEqual({ icon: 'fa-puzzle-piece', parts: [{ text: 'GameLogic Plugin' }, { name: ' (2)' }] });
        expect(groups[1].rows.map((row) => [row.id, row.canInstall])).toEqual([['p1', true], ['p2', false]]);
    });
    it('an empty library has no groups', () => {
        expect(libraryGroups([])).toEqual([]);
    });
    // MUTATION TARGET: a tab lists only its own types, so a menu never shows on the GameLogic Packs tab.
    it("a tab lists only its own types, each tab's list from one shared library", () => {
        const library = [stored(), stored({ packType: 'plugin', id: 'p1' }), stored({ packType: 'statusmenu', id: 'menu' })];
        const ids = (name) => libraryGroups(library, { packTypes: ARTIFACT_TABS[name].packTypes }).flatMap((group) => group.rows.map((row) => row.id));
        expect(ids('gamelogic')).toEqual(['school-v4', 'p1']);
        expect(ids('statusmenu')).toEqual(['menu']);
    });
    // MUTATION TARGET: a one-type tab carries no group title, since the card's own title already names the type.
    it('a group is titled only on a tab listing more than one type', () => {
        const library = [stored(), stored({ packType: 'statusmenu', id: 'menu' })];
        expect(libraryGroups(library, { packTypes: ['gamelogic', 'plugin'] })[0].title).not.toBeNull();
        expect(libraryGroups(library, { packTypes: ['statusmenu'] })[0].title).toBeNull();
    });
});

describe("libraryAddedText — the Import card's toast", () => {
    const added = (over = {}) => ({ created: true, pack: { packType: 'gamelogic', name: 'School v4', version: '5.56' }, ...over });
    it('an artifact this tab lists: added, or its library copy updated', () => {
        expect(libraryAddedText(added(), 'gamelogic')).toBe('Added to the library: School v4 v5.56');
        expect(libraryAddedText(added({ created: false }), 'gamelogic')).toBe('Library copy updated: School v4 v5.56');
    });
    // MUTATION TARGET: either tab's Import takes every type, so what lands elsewhere says where to find it.
    it('an artifact the other tab lists names that tab', () => {
        const menu = added({ pack: { packType: 'statusmenu', name: 'School menu', version: '1.2' } });
        expect(libraryAddedText(menu, 'gamelogic')).toBe('Added to the library: School menu v1.2 (StatusMenu Packs tab)');
        expect(libraryAddedText(menu, 'statusmenu')).toBe('Added to the library: School menu v1.2');
        expect(libraryAddedText(added({ pack: { packType: 'plugin', name: 'Cast', version: '1' } }), 'statusmenu'))
            .toBe('Added to the library: Cast v1 (GameLogic Packs tab)');
    });
    it('an event pack names its own library', () => {
        expect(libraryAddedText(added({ eventPackIds: ['beach', 'rain'] }), 'statusmenu')).toBe('Event Packs library: beach, rain');
    });
});

describe('import reports', () => {
    const pack = { packType: 'statusmenu', id: 'menu', name: 'Menu', version: '1.2' };
    it('a valid pasted file: the artifact, its warnings, then Pack file is valid', () => {
        expect(packFileReportView({ ok: true, pack, errors: [], warnings: ['no regex'] }).lines).toEqual([
            { icon: 'fa-table-list', parts: [{ name: 'Menu · ' }, { text: 'StatusMenu Pack' }, { name: ' · ' }, { code: 'menu' }, { name: ' · v1.2' }] },
            { status: 'warning', name: 'no regex' },
            { text: 'Pack file is valid', status: 'success' },
        ]);
    });
    it('an invalid file: every error, and no valid line', () => {
        const lines = packFileReportView({ ok: false, pack: null, errors: ['rule 1', 'rule 2'], warnings: [] }).lines;
        expect(lines).toEqual([{ status: 'danger', name: 'rule 1' }, { status: 'danger', name: 'rule 2' }]);
    });
    it('a source with nothing in it says what to pick', () => {
        expect(sourceReportView([]).lines).toEqual([
            { text: 'No pack.json found: pick the artifact folder itself, or a workspace whose subfolders each carry one.', status: 'danger' },
        ]);
    });
    it('a source: each artifact with its folder, ready only when it has no error', () => {
        const lines = sourceReportView([
            { name: 'statusmenu', pack, errors: [], warnings: [] },
            { name: 'broken', pack: null, errors: ['no pack.json'], warnings: [] },
            { name: '', pack: null, errors: ['bad'], warnings: [] },
        ]).lines;
        expect(lines[0].parts.slice(-2)).toEqual([{ name: ' · ' }, { code: 'statusmenu/' }]);
        expect(lines.slice(1)).toEqual([
            { text: 'Ready for the library', status: 'success' },
            { icon: 'fa-folder', name: 'broken/' }, { status: 'danger', name: 'no pack.json' },
            { text: 'Picked folder', icon: 'fa-folder' }, { status: 'danger', name: 'bad' },
        ]);
    });
    it('a blank pack: its errors, or the archive and what to do with it', () => {
        expect(blankPackReportView({ errors: ['"name" is required'] }).lines).toEqual([{ status: 'danger', name: '"name" is required' }]);
        expect(blankPackReportView({ fileName: 'gamelogic.zip' }).lines).toEqual([{
            status: 'success', parts: [{ code: 'gamelogic.zip' }, { name: ' ' }, { text: 'Extract it at your workspace root, then point npm run dev at it.' }],
        }]);
    });
});

// A type's label reaches the panel as a { text } read from ARTIFACT_ROLES, which the G1 scan cannot see as a literal.
describe('type labels', () => {
    it('every artifact type label is a zh-cn key', () => {
        const dictionary = JSON.parse(readFileSync(new URL('../i18n/zh-cn.json', import.meta.url), 'utf8'));
        expect(Object.values(ARTIFACT_ROLES).map((role) => role.label).filter((label) => !(label in dictionary))).toEqual([]);
    });
});
