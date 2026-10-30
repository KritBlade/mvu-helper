// popup.js — SillyTavern's async popups, wrapped.
//
// ⚠ NEVER use the browser's native `confirm()` / `alert()` on the ST page. They open INVISIBLY and
// block the whole page thread, freezing generation — a hang with no dialog to dismiss. This is the
// only sanctioned way to ask the user something.
//
// Lives in sillytavern/ rather than shared/ because it is a HOST-API wrapper, not an ownerless
// primitive: `Popup` + `POPUP_TYPE` are ST's, and this folder is where knowledge of ST's API belongs.
//
// THE ONE DOOR. Nothing outside sillytavern/ touches ST's popup API (tests/popup-api-boundary.test.js):
// every dialog mvu-helper opens comes through here, so how they all behave, look and fail is changed in
// this file alone.
//
// THE LOOK. Every dialog carries .mvuh-popup.mvuh-ui, so it is drawn from the GUI-DNA (settings-panel.css):
// the palette, DNA buttons (the action primary, or red with `isDanger`, which only a safety question sets; Cancel
// secondary), and DNA fields in a form. The settings panel's own dialog adds .is-panel, and a form that holds long
// text adds .is-wide.
//
// TEXT IS LINES (popup-core.js): a fixed sentence is keyed with its English source, a value is shown as written,
// and the shape is a one-line question, the things it touches one per line, then one short line per answer.
// The keyed words are translated before the dialog shows (applyHelperLocale), and so are the buttons: each is
// named by the verb it performs, with its English as the key.
//
// FAILURE STANCE — a popup that cannot open answers NO. Every caller guards an action, often a destructive one,
// so "the dialog broke" must never read as "the user said yes". Never make this return true on error.

import { getContext } from '../../../../../extensions.js';
import { createModuleLog } from './log.js';
import { applyHelperLocale } from './i18n.js';
import { dialogLineSegments, dialogLineText } from './popup-core.js';

const log = createModuleLog('popup');

// The lines as paragraphs: a line that is one fixed sentence is keyed itself; a mixed line keys each fixed word in
// a span of its own, so the locale pass never drops a value. A leading icon is an element of its own, before them.
function dialogTextBlock(lines) {
    const block = document.createElement('div');
    block.className = 'mvuh-dialog-text';
    for (const line of Array.isArray(lines) ? lines : []) {
        const segments = dialogLineSegments(line);
        if (!segments.length) continue;
        const paragraph = document.createElement('p');
        if (segments.length === 1 && segments[0].key) {
            paragraph.dataset.i18n = segments[0].key;
            paragraph.textContent = segments[0].key;
        } else {
            for (const segment of segments) {
                if (segment.icon) {
                    const icon = document.createElement('i');
                    icon.className = 'fa-solid mvuh-dialog-icon';
                    icon.classList.add(segment.icon);
                    icon.setAttribute('aria-hidden', 'true');
                    paragraph.append(icon);
                } else if (segment.key) {
                    const span = document.createElement('span');
                    span.dataset.i18n = segment.key;
                    span.textContent = segment.key;
                    paragraph.append(span);
                } else if (segment.isStrong) {
                    const span = document.createElement('span');
                    span.className = 'mvuh-dialog-value';
                    span.textContent = segment.value;
                    paragraph.append(span);
                } else {
                    paragraph.append(document.createTextNode(segment.value));
                }
            }
        }
        block.append(paragraph);
    }
    return block;
}

// Open one dialog in the GUI-DNA frame, its keyed words (body and buttons) translated before it shows. Its content
// scrolls once it is taller than the window: SillyTavern's popup clips it otherwise (.popup-content overflow: hidden),
// and a field below the cut cannot be reached. A danger or destructive dialog opens on Cancel: SillyTavern focuses
// the button of the default answer, and Enter presses the focused button.
// Resolves to ST's answer. Throws only if ST's Popup cannot be built; each caller below turns that into NO.
async function showDialog(content, type, { okButton, cancelButton, inputValue = '', isDanger = false, isDestructive = false, isPanel = false, isWide = false, popupOptions = {} } = {}) {
    const ctx = getContext();
    const defaultResult = isDanger || isDestructive ? ctx.POPUP_RESULT.NEGATIVE : ctx.POPUP_RESULT.AFFIRMATIVE;
    const popup = new ctx.Popup(content, type, inputValue, { okButton, cancelButton, leftAlign: true, allowVerticalScrolling: true, defaultResult, ...popupOptions });
    popup.dlg.classList.add('mvuh-popup', 'mvuh-ui');
    if (isDanger) popup.dlg.classList.add('is-danger');
    if (isPanel) popup.dlg.classList.add('is-panel');
    if (isWide) popup.dlg.classList.add('is-wide');
    await applyHelperLocale(popup.body);
    return popup.show();
}

/**
 * Ask the user to confirm. Returns truthy only when they press the action button.
 * Never throws — a failed popup logs and answers NO.
 *
 * @param {object[]} lines  What is about to happen (popup-core.js). Say what is LOST, not just what is clicked:
 *                          the user is deciding, and "Delete?" gives them nothing to decide with.
 * @param {object}  options
 * @param {string}  options.okButton       The action, as a verb: "Delete", "Install", "Switch".
 * @param {string}  [options.cancelButton]
 * @param {boolean} [options.isDanger]     A safety question only: yes lets something reach the user's SillyTavern
 *                                         beyond the game (the pack install warning). Its button and icon are drawn
 *                                         red, and the dialog opens on Cancel, so Enter cancels.
 * @param {boolean} [options.isDestructive] Yes deletes, removes, replaces or resets something: the dialog opens on
 *                                         Cancel, so Enter cancels, and its action stays primary. Red is for a safety
 *                                         question alone: on every destructive question it would scare users and teach
 *                                         them to click through the one that matters.
 */
export async function confirmPopup(lines, { okButton, cancelButton = 'Cancel', isDanger = false, isDestructive = false } = {}) {
    try {
        return await showDialog(dialogTextBlock(lines), getContext().POPUP_TYPE.CONFIRM, { okButton, cancelButton, isDanger, isDestructive });
    } catch (e) {
        log.warn('confirmPopup failed to open — answering NO (safe):', e);
        return false;
    }
}

/**
 * Tell the user something that needs no answer (a refusal before a dialog re-opens, say).
 * Never throws — a failed popup logs, and the caller carries on.
 *
 * @param {object[]} lines  The message (popup-core.js).
 */
export async function noticePopup(lines) {
    try {
        await showDialog(dialogTextBlock(lines), getContext().POPUP_TYPE.TEXT, { okButton: 'OK', cancelButton: false });
    } catch (e) {
        log.warn('noticePopup failed to open — the message was:', (Array.isArray(lines) ? lines : []).map(dialogLineText).join(' / '), e);
    }
}

/**
 * Ask the user for a line of text. Returns the trimmed string, or '' for cancel/empty/failure —
 * the SAME failure stance as confirmPopup: a dialog that could not open must never read as input.
 * Callers therefore treat '' as "do nothing", never as "clear the value".
 *
 * ST's INPUT popup answers with the string on OK and a falsy value on Cancel; an OK on an empty
 * field is indistinguishable from Cancel here, which is correct for every caller (an empty key is
 * not a thing anyone means to type).
 *
 * @param {object[]} lines                  What is being asked, and what the value will DO (popup-core.js).
 * @param {object}   options
 * @param {string}   options.okButton       What OK does, as a verb: "Create", "Rename".
 * @param {string}   [options.defaultValue] Prefill — usually the current value, so an edit is a small change.
 */
export async function inputPopup(lines, { okButton, defaultValue = '' } = {}) {
    try {
        const answer = await showDialog(dialogTextBlock(lines), getContext().POPUP_TYPE.INPUT, {
            okButton, cancelButton: 'Cancel', inputValue: String(defaultValue || ''),
        });
        return typeof answer === 'string' ? answer.trim() : '';
    } catch (e) {
        log.warn('inputPopup failed to open — answering EMPTY (safe):', e);
        return '';
    }
}

/**
 * Show a form the caller built from the gene builders and wait for the user to submit or cancel it. Returns truthy
 * only on the OK button; the caller then reads its own inputs from `form`.
 * Never throws — a failed popup logs and answers NO, so a broken dialog never reads as a submit.
 *
 * @param {HTMLElement} form                  The dialog body; it stays the caller's element, inputs and all.
 * @param {object}      options
 * @param {string}      options.okButton      What OK does, as a verb: "Add", "Install", "Rebind".
 * @param {string}      [options.cancelButton]
 * @param {boolean}     [options.isWide]      The form holds long text (the Roster editor): wide on a desktop, and on a
 *                                            phone as wide as any dialog (settings-panel.css).
 */
export async function formPopup(form, { okButton, cancelButton = 'Cancel', isWide = false } = {}) {
    try {
        return await showDialog(form, getContext().POPUP_TYPE.CONFIRM, { okButton, cancelButton, isWide });
    } catch (e) {
        log.warn('formPopup failed to open — answering NO (safe):', e);
        return false;
    }
}

/**
 * Show the settings panel in a near-fullscreen dialog and wait until the user closes it.
 * `panel` is MOVED into the dialog, never cloned: ST's Popup appends the live element, and DOM listeners
 * belong to the node, so every handler keeps working. The caller moves it back afterwards.
 * Never throws — a dialog that cannot open is logged and this returns at once.
 *
 * @param {HTMLElement} panel
 */
export async function openPanelPopup(panel) {
    try {
        await showDialog(panel, getContext().POPUP_TYPE.TEXT, {
            okButton: 'Close',
            cancelButton: false,
            isPanel: true,
            popupOptions: {
                large: true,                    // 90vh tall; the width comes from .mvuh-popup.is-panel (settings-panel.css)
            },
        });
    } catch (e) {
        log.error('the settings panel could not open:', e);
    }
}
