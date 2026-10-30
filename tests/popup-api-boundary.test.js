/**
 * MVU Helper — one door to SillyTavern's dialogs.
 *
 * Only src/sillytavern/ touches SillyTavern's popup API (`Popup`, `callGenericPopup`, `POPUP_TYPE`,
 * `POPUP_RESULT`). Everything else opens a dialog through sillytavern/popup.js — confirmPopup,
 * noticePopup, inputPopup, formPopup, openPanelPopup — so how every dialog behaves, looks and fails can
 * be changed in that one file. Four behaviours are held here too: every dialog scrolls once it is taller
 * than the window, a form that holds long text opens wide, a danger or destructive dialog opens on Cancel (every
 * destructive question marked so, and nothing else), and only a safety question is a danger dialog.
 *
 * Code only: a mention in a comment or a string is not a use.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, jsFilesUnder } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOST_FOLDER = 'sillytavern' + path.sep;

// `new ctx.Popup(`, `ctx.callGenericPopup(`, `ctx.POPUP_TYPE`, `POPUP_RESULT` — but not popup.js's own
// wrappers, whose names merely end in "Popup" (confirmPopup(…) has no word boundary before "Popup").
const POPUP_API_USE = /\bPopup\s*\(|\bcallGenericPopup\b|\bPOPUP_TYPE\b|\bPOPUP_RESULT\b/g;

function popupApiUses(code) {
    return [...code.matchAll(POPUP_API_USE)].map((match) => match[0].replace(/\s*\($/, ''));
}

describe('SillyTavern popup API boundary', () => {
    it('no file outside src/sillytavern/ uses the popup API directly', () => {
        const offenders = [];
        for (const file of jsFilesUnder(SRC)) {
            const relative = path.relative(SRC, file);
            if (relative.startsWith(HOST_FOLDER)) continue;
            codeOnly(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
                for (const use of popupApiUses(line)) offenders.push(`${relative}:${index + 1} ${use}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it('sees the API in code, and ignores the wrappers, comments and strings', () => {
        const scanned = codeOnly("new ctx.Popup(el, ctx.POPUP_TYPE.CONFIRM); await confirmPopup('x'); formPopup(f);\n"
            + "// ctx.callGenericPopup(1)\nconst s = 'POPUP_RESULT'; ctx.callGenericPopup(q);\n");
        expect(popupApiUses(scanned)).toEqual(['Popup', 'POPUP_TYPE', 'callGenericPopup']);
    });
});

describe('every dialog scrolls', () => {
    // SillyTavern's popup clips its content unless the dialog allows vertical scrolling, so a field below the cut — the
    // Roster editor's "Wearing now" on a short window — cannot be reached.
    it('showDialog opens every dialog with allowVerticalScrolling', () => {
        const code = codeOnly(readFileSync(path.join(SRC, 'sillytavern', 'popup.js'), 'utf8'));
        const options = (code.match(/new ctx\.Popup\(([^;]*)\);/) || [])[1];
        expect(options).toMatch(/allowVerticalScrolling: true/);
    });
});

describe('a danger or destructive dialog opens on Cancel', () => {
    // SillyTavern focuses the button of a popup's default answer, and Enter presses the focused button: a danger or
    // destructive dialog that opened on its action would say yes at a keypress. Red stays the safety question's alone.
    // The lines that carry a string are matched in the source itself: codeOnly blanks a string's contents.
    const popupSource = () => readFileSync(path.join(SRC, 'sillytavern', 'popup.js'), 'utf8').replace(/\r/g, '');

    it('MUTATION TARGET — showDialog makes Cancel the default answer of a danger or destructive dialog, and only of those', () => {
        const code = codeOnly(popupSource());
        expect(code).toContain('const defaultResult = isDanger || isDestructive ? ctx.POPUP_RESULT.NEGATIVE : ctx.POPUP_RESULT.AFFIRMATIVE;');
        const options = (code.match(/new ctx\.Popup\(([^;]*)\);/) || [])[1];
        expect(options).toMatch(/\bdefaultResult\b/);
        expect(popupSource()).toContain("    if (isDanger) popup.dlg.classList.add('is-danger');\n");
    });

    it('MUTATION TARGET — confirmPopup takes isDestructive, off unless set, and hands it to showDialog', () => {
        expect(popupSource()).toContain("export async function confirmPopup(lines, { okButton, cancelButton = 'Cancel', isDanger = false, isDestructive = false } = {}) {");
        expect(codeOnly(popupSource())).toContain('return await showDialog(dialogTextBlock(lines), getContext().POPUP_TYPE.CONFIRM, { okButton, cancelButton, isDanger, isDestructive });');
    });
});

describe('every destructive question opens on Cancel', () => {
    // A question is destructive when its yes deletes, removes, replaces or resets something the card or the library
    // holds; its action is named by one of these verbs. Install, Create, Import, Save and the rest open on their action.
    const DESTRUCTIVE_ACTIONS = ['Delete', 'Delete state', 'Downgrade', 'Merge', 'Re-harvest', 'Remove', 'Replace', 'Reset',
        'Reset every card', 'Switch', 'Uninstall'];
    const dialogOptionLines = () => {
        const lines = [];
        for (const file of jsFilesUnder(SRC)) {
            const relative = path.relative(SRC, file).split(path.sep).join('/');
            const source = readFileSync(file, 'utf8');
            const sourceLines = source.split('\n');
            codeOnly(source).split('\n').forEach((code, index) => {
                // codeOnly blanks a string's contents in place, so the verb is read at the same column of the source.
                const at = code.search(/\bokButton:\s*['"]/);
                const action = at < 0 ? undefined : (sourceLines[index].slice(at).match(/^okButton:\s*(['"])(.*?)\1/) || [])[2];
                const isDestructive = /\bisDestructive:\s*true\b/.test(code);
                if (action !== undefined || isDestructive) lines.push({ at: `${relative}:${index + 1}`, action, isDestructive });
            });
        }
        return lines;
    };

    it('MUTATION TARGET — a dialog whose action is a destructive verb is marked destructive, and no other dialog is', () => {
        const lines = dialogOptionLines();
        const unmarked = lines.filter((line) => DESTRUCTIVE_ACTIONS.includes(line.action) && !line.isDestructive);
        const overmarked = lines.filter((line) => line.isDestructive && !DESTRUCTIVE_ACTIONS.includes(line.action));
        expect(unmarked.map((line) => `${line.at} ${line.action}`)).toEqual([]);
        expect(overmarked.map((line) => `${line.at} ${line.action}`)).toEqual([]);
    });

    it('sees every destructive verb in use, so the scan is reading the dialogs', () => {
        const used = new Set(dialogOptionLines().filter((line) => line.isDestructive).map((line) => line.action));
        expect([...used].sort()).toEqual(DESTRUCTIVE_ACTIONS);
    });
});

describe('only a safety question is a danger dialog', () => {
    // A dialog is drawn as danger only when its yes lets something reach the user's SillyTavern beyond the game (the
    // pack install warning). A question that deletes, replaces or resets is an ordinary one: red on every such question
    // scares people and teaches them to click through the one that matters. A row's red trash button (iconButton) is no
    // dialog.
    const SAFETY_QUESTIONS = ['shared/pack-install-warning-core.js'];
    it('MUTATION TARGET — isDanger is set on a dialog in the safety questions\' files alone', () => {
        const found = [];
        for (const file of jsFilesUnder(SRC)) {
            const relative = path.relative(SRC, file).split(path.sep).join('/');
            codeOnly(readFileSync(file, 'utf8')).split('\n').forEach((line) => {
                if (/\bisDanger:\s*true\b/.test(line) && !/\biconButton\(/.test(line)) found.push(relative);
            });
        }
        expect(found).toEqual(SAFETY_QUESTIONS);
    });
});

describe('a form that holds long text opens wide', () => {
    // At SillyTavern's 500px, a desktop shows the Roster editor's body and outfits as a narrow column.
    const read = (...parts) => readFileSync(path.join(SRC, ...parts), 'utf8').replace(/\r/g, '');

    it('MUTATION TARGET — the Roster editor asks for it, popup.js marks the dialog, and the stylesheet sizes it', () => {
        const popup = read('sillytavern', 'popup.js');
        expect(popup).toContain("if (isWide) popup.dlg.classList.add('is-wide');");
        expect(popup).toContain('return await showDialog(form, getContext().POPUP_TYPE.CONFIRM, { okButton, cancelButton, isWide });');
        expect(read('features', 'character-roster', 'roster-ui.js')).toContain("formPopup(form, { okButton: 'Save', isWide: true })");
        expect(read('features', 'settings-panel', 'settings-panel.css')).toContain('dialog.popup.mvuh-popup.is-wide {\n    width: min(1100px, calc(100dvw - 2em));\n}');
    });
});
