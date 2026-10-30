// shared/pack-install-warning-core.js — the install warning, pure: the texts it reads from what an install writes, the
// question a pack's reach asks before the install writes it, and the warn line that records the answer
// (plans/pack-install-warning.md §3, §4). The reach is what templateReachIn found (shared/template-reach.js);
// pack-install-warning.js asks the question.

// A line of the question names at most this many finds, then how many more there are; the warn line names them all.
const FINDS_PER_LINE = 5;

export const PACK_REACH_QUESTION_BUTTONS = { okButton: 'Install anyway', isDanger: true };

const findsIn = (reach, kind) => (reach && Array.isArray(reach[kind]) ? reach[kind] : []);
const packLabel = (packName, version) => String(packName || '?') + (version ? ' v' + version : '');

function findsShown(finds) {
    const shown = finds.slice(0, FINDS_PER_LINE).join(', ');
    return finds.length > FINDS_PER_LINE ? shown + ' (+' + (finds.length - FINDS_PER_LINE) + ')' : shown;
}

/**
 * The texts templateReachIn reads, from the lorebook entries and regex rows an install writes, in TavernHelper's shapes:
 * each entry's content and each row's replacement, read as template code and searched for macros; and, searched for
 * macros only, each entry's `keys` and `filters` (SillyTavern's keys and secondary keys, as TavernHelper writes them)
 * and each row's trim strings. A row's find pattern is not read: every row is written with SillyTavern's macro option
 * off (`substituteRegex` 0, in sillytavern/tavern-regex-core.js and in TavernHelper's own conversion), so its macros
 * never run.
 */
export function installReachTexts({ entries = [], regexRows = [] } = {}) {
    const objects = (list) => (Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : []);
    const strings = (list) => (Array.isArray(list) ? list.map((item) => String(item ?? '')) : []);
    const entryList = objects(entries);
    const rowList = objects(regexRows);
    return {
        entries: entryList.map((entry) => String(entry.content ?? '')),
        regexReplacements: rowList.map((row) => String(row.replace_string ?? '')),
        macroTexts: [
            ...entryList.flatMap((entry) => [...strings(entry.keys), ...strings(entry.filters)]),
            ...rowList.flatMap((row) => strings(row.trim_strings)),
        ],
    };
}

/** Whether the reach holds anything the warning names. */
export function hasPackReach(reach) {
    return ['settings', 'beyondChat', 'unchecked'].some((kind) => findsIn(reach, kind).length > 0);
}

/**
 * The question, as dialog lines (sillytavern/popup-core.js): the danger headline, the pack, one line for each kind of
 * reach found, then the question and what each answer does.
 */
export function packReachQuestion({ packName, version, reach } = {}) {
    const lines = [
        { text: 'This pack can reach outside the game.', icon: 'fa-circle-exclamation' },
        { name: packLabel(packName, version) },
    ];
    if (findsIn(reach, 'settings').length) {
        lines.push({ text: 'It has code that can access Extension settings, which can read or change your SillyTavern settings:', name: findsShown(findsIn(reach, 'settings')) });
    }
    if (findsIn(reach, 'beyondChat').length) {
        lines.push({ text: 'It has code that can change SillyTavern outside this chat:', name: findsShown(findsIn(reach, 'beyondChat')) });
    }
    if (findsIn(reach, 'unchecked').length) {
        lines.push({ text: 'It uses TavernHelper, SillyTavern or the page in a way MVU Helper cannot check:', name: findsShown(findsIn(reach, 'unchecked')) });
    }
    lines.push(
        { text: 'Are you sure you REALLY want to install this pack?' },
        { text: 'Install anyway: the pack is installed, and this code runs as you play.' },
        { text: 'Cancel: nothing is installed or changed.' },
    );
    return lines;
}

/**
 * The warn line an asked install leaves in the console: the pack, every find by kind, and the user's answer to the
 * warning. The warning is asked first, so Install anyway can still be followed by the install's own questions.
 */
export function packReachLogLine({ packName, version, reach, isInstalled } = {}) {
    const kinds = [['settings', 'settings'], ['beyondChat', 'outside this chat'], ['unchecked', 'unchecked']]
        .filter(([kind]) => findsIn(reach, kind).length)
        .map(([kind, label]) => label + ': ' + findsIn(reach, kind).join(', '));
    return 'warned before installing ' + packLabel(packName, version) + ', which can reach outside the game (' + kinds.join('; ')
        + ') — the user answered ' + (isInstalled ? 'Install anyway' : 'Cancel');
}
