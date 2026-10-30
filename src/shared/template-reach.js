// shared/template-reach.js — what the template code and macros a pack is about to install can reach. Pure: no host
// imports.
//
// A pack's lorebook entries and regex replacements carry ST-Prompt-Template code (`<% %>`), which runs on the page
// with the page's reach, and SillyTavern's own macros (`{{…}}`). Before an install writes them, it asks
// templateReachIn what they can reach, and the user is warned when they reach SillyTavern's settings or outside this
// chat (plans/pack-install-warning.md §3).
//
// WHAT IT READS. Each text is rebuilt the way EJS compiles it (ejsSourceOf): the code of every tag, and the text
// between tags as the string EJS appends, so code that a template literal carries across tags is read too. A regex
// replacement is read a second time with its HTML character references decoded: ST-Prompt-Template also runs the
// template it finds in a rendered message, where `&lt;%` reads as `<%`. The code is read as tokens
// (templateCodeTokens), so comments and string literals never count. SillyTavern runs its macros over every text
// as written, template code or not, so each is also searched for the macros that reach its global variables
// (addMacroReach); that search covers the texts that carry macros only, too (an entry's keys and secondary keys, a
// regex row's trim strings, and its find pattern when its macro option is on).
//
// WHAT IT REPORTS, as three lists of what was found, once each:
//   settings   — a name holding SillyTavern's settings; a TavernHelper or SillyTavern call kept in SillyTavern's
//                settings (class C1: presets, personas, tags, SillyTavern's global variables, a settings save); a
//                variable call whose store is not this chat's (the type rule, and ST-Prompt-Template's global scope);
//                ST-Prompt-Template's activateRegex, which writes SillyTavern's regex list; a macro reading or writing
//                SillyTavern's global variables (`{{setglobalvar::…}}`, `{{$name}}`).
//   beyondChat — a TavernHelper or SillyTavern call reaching any chat, lorebook or character by name (C3), or running
//                code and reaching the page, the network or the model (D), and any member either does not list;
//                ST-Prompt-Template's execute, evalTemplate and define; the page's own reach (fetch, document, eval,
//                Function, `.constructor` and the rest of PAGE_REACH).
//   unchecked  — TavernHelper, SillyTavern, window, globalThis or EJS's `locals` used in a way no name can be read
//                from: an alias, `[…]`, passed along, SillyTavern's variables, preset manager and libs held; and
//                `self[…]`.
// Allowed, and not reported: TavernHelper's and SillyTavern's reads (A) and this chat (B, C2), SillyTavern's interface
// (popups, loaders, which chat is open), the variable functions on this chat's stores, and anything under `typeof`
// that is not called. The members are classified against TavernHelper 4.8.14 and SillyTavern 1.19.0 (the plan's
// Appendices A and B).
//
// LIMITS. Only names are read, never what a value holds: `const s = self; s['fe' + 'tch']()` is not seen (only window,
// globalThis and locals are held to their members), nor is a function reached through an object an allowed call
// returns; SillyTavern's variables, preset manager and libs are the objects ruled by their member. A macro is read
// by the name it is written with: one whose name another macro or a template builds is not seen. A template that
// declares its own `fetch` or `document` is reported all the same. This makes the reach visible to the user who
// installs the pack; it is not a boundary.

// ── what each name reaches ───────────────────────────────────────────────────

// TavernHelper's members by class (plans/pack-install-warning.md Appendix A). Every member TavernHelper 4.8.14
// returns from getTavernHelper() sits in exactly one list.
const TAVERN_HELPER_READS = [
    'getAudioList', 'getAudioSettings', 'getCurrentAudio', 'getCharacterNames', 'getCharacterIds', 'getCurrentCharacterName',
    'getCurrentCharacterId', 'getCharacter', 'getChatMessages', 'formatAsDisplayedMessage', 'tavern_events', 'iframe_events',
    'isAdmin', 'getTavernHelperExtensionId', 'getExtensionType', 'getExtensionStatus', 'isInstalledExtension',
    'builtin_prompt_default_order', 'getProxyPresetNames', 'waitGlobalInitialized', 'getLorebookEntries', 'getLorebookSettings',
    'getCharLorebooks', 'getLorebooks', 'getCurrentCharPrimaryLorebook', 'getChatLorebook', 'isPresetNormalPrompt',
    'isPresetSystemPrompt', 'isPresetPlaceholderPrompt', 'default_preset', 'getPresetNames', 'getLoadedPresetName', 'getPreset',
    'getPersonaNames', 'getPersonaIds', 'getCurrentPersonaName', 'getCurrentPersonaId', 'getPersonaAvatarPath', 'getPersona',
    'RawCharacter', 'getCharData', 'getCharAvatarPath', 'getChatHistoryBrief', 'getChatHistoryDetail', 'getAllEnabledScriptButtons',
    'getScriptTrees', 'formatAsTavernRegexedString', 'isCharacterTavernRegexesEnabled', 'getTavernRegexes', 'getLastMessageId',
    'getMessageId', 'errorCatched', 'getTavernHelperVersion', 'getFrontendVersion', 'getTavernVersion', 'getWorldbookNames',
    'getGlobalWorldbookNames', 'getCharWorldbookNames', 'getChatWorldbookName', 'getWorldbook',
];
const TAVERN_HELPER_THIS_CHAT = [
    // B — the chat's messages, prompts and generations
    'setChatMessages', 'setChatMessage', 'createChatMessages', 'deleteChatMessages', 'rotateChatMessages', 'refreshOneMessage',
    'injectPrompts', 'uninjectPrompts', 'stopGenerationById', 'stopAllGeneration', 'substitudeMacros',
    // C2 — this chat's lorebook, and the audio playlist kept per chat
    'setChatLorebook', 'rebindChatWorldbook', 'getOrCreateChatLorebook', 'getOrCreateChatWorldbook', 'playAudio', 'pauseAudio',
    'audioPlay', 'replaceAudioList', 'appendAudioList', 'audioImport', 'audioSelect', 'audioEnable',
];
// V — allowed when the store their option names is this chat's (variableOptionVerdict).
const TAVERN_HELPER_VARIABLES = [
    'getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables', 'deleteVariable', 'insertVariables',
    'registerVariableSchema',
];
// C1 — kept in SillyTavern's settings.
const TAVERN_HELPER_SETTINGS = [
    'setLorebookSettings', 'rebindGlobalWorldbooks', 'setCurrentCharLorebooks', 'rebindCharWorldbooks', 'setAudioSettings', 'audioMode',
    'loadPreset', 'createPreset', 'createOrReplacePreset', 'deletePreset', 'renamePreset', 'replacePreset', 'updatePresetWith',
    'setPreset', 'createPersona', 'createOrReplacePersona', 'deletePersona', 'replacePersona', 'updatePersonaWith',
];
const TAVERN_HELPER_BEYOND_CHAT = [
    // C3 — any lorebook or character, by name
    'createLorebook', 'deleteLorebook', 'createWorldbook', 'createOrReplaceWorldbook', 'deleteWorldbook', 'replaceWorldbook',
    'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries', 'replaceLorebookEntries', 'updateLorebookEntriesWith',
    'setLorebookEntries', 'createLorebookEntries', 'createLorebookEntry', 'deleteLorebookEntries', 'deleteLorebookEntry',
    'createCharacter', 'createOrReplaceCharacter', 'deleteCharacter', 'replaceCharacter', 'updateCharacterWith', 'importRawCharacter',
    'importRawPreset', 'importRawChat', 'importRawWorldbook',
    // D — runs code, or reaches the page, the network or the model
    'triggerSlash', 'triggerSlashWithResult', 'generate', 'generateRaw', 'getModelList', 'installExtension', 'uninstallExtension',
    'reinstallExtension', 'updateExtension', 'updateTavernHelper', 'updateFrontendVersion', 'replaceScriptTrees',
    'updateScriptTreesWith', 'replaceTavernRegexes', 'updateTavernRegexesWith', 'importRawTavernRegex', 'registerMacroLike',
    'unregisterMacroLike', 'initializeGlobal', 'retrieveDisplayedMessage', 'builtin', '_bind', '_th_impl',
];

/**
 * @internal — the class lists, for the tests that hold every name to its class.
 */
export const TAVERN_HELPER_MEMBER_CLASSES = Object.freeze({
    reads: Object.freeze([...TAVERN_HELPER_READS]),
    thisChat: Object.freeze([...TAVERN_HELPER_THIS_CHAT]),
    variables: Object.freeze([...TAVERN_HELPER_VARIABLES]),
    settings: Object.freeze([...TAVERN_HELPER_SETTINGS]),
    beyondChat: Object.freeze([...TAVERN_HELPER_BEYOND_CHAT]),
});

const TAVERN_HELPER_CLASS = new Map([
    ...TAVERN_HELPER_READS.map((name) => [name, 'allowed']),
    ...TAVERN_HELPER_THIS_CHAT.map((name) => [name, 'allowed']),
    ...TAVERN_HELPER_VARIABLES.map((name) => [name, 'variables']),
    ...TAVERN_HELPER_SETTINGS.map((name) => [name, 'settings']),
    ...TAVERN_HELPER_BEYOND_CHAT.map((name) => [name, 'beyondChat']),
]);

// SillyTavern's members by class (plans/pack-install-warning.md Appendix B). Every member SillyTavern 1.19.0's
// getContext() returns sits in exactly one list. In a template `SillyTavern` is that context; on the page it is an
// object holding getContext() and libs.
const SILLYTAVERN_READS = [
    'characters', 'groups', 'name1', 'name2', 'characterId', 'groupId', 'chatId', 'getCurrentChatId', 'onlineStatus', 'maxContext',
    'eventTypes', 'event_types', 'tokenizers', 'getTextTokens', 'getTokenCount', 'getTokenCountAsync', 'getTokenizerModel',
    'SlashCommand', 'SlashCommandArgument', 'SlashCommandNamedArgument', 'SlashCommandEnumValue', 'ARGUMENT_TYPE',
    'timestampToMoment', 'isToolCallingSupported', 'canPerformToolCalls', 'renderExtensionTemplate', 'renderExtensionTemplateAsync',
    'mainApi', 'ModuleWorkerWrapper', 'getThumbnailUrl', 'messageFormatting', 'shouldSendOnEnter', 'isMobile', 't', 'translate',
    'getCurrentLocale', 'menuType', 'POPUP_TYPE', 'POPUP_RESULT', 'getCharacters', 'getOneCharacter', 'getCharacterCardFields',
    'getCharacterSource', 'uuidv4', 'humanizedDateTime', 'getMediaDisplay', 'getMediaIndex', 'loadWorldInfo', 'updateWorldInfoList',
    'convertCharacterBook', 'getWorldInfoNames', 'CONNECT_API_MAP', 'getTextGenServer', 'extractMessageFromData',
    'getChatCompletionModel', 'parseReasoningFromString', 'getReasoningTemplateByName', 'unshallowCharacter', 'unshallowGroupMembers',
    'getExtensionManifest', 'symbols', 'constants',
];
// B — this chat: its messages, metadata, prompts, swipes and generation.
const SILLYTAVERN_THIS_CHAT = [
    'chat', 'chatMetadata', 'reloadCurrentChat', 'saveMetadataDebounced', 'streamingProcessor', 'addOneMessage', 'deleteLastMessage',
    'deleteMessage', 'stopGeneration', 'extensionPrompts', 'setExtensionPrompt', 'updateChatMetadata', 'saveChat', 'saveMetadata',
    'sendSystemMessage', 'saveReply', 'substituteParams', 'substituteParamsExtended', 'updateMessageBlock', 'appendMediaToMessage',
    'ensureMessageMediaIsArray', 'swipe', 'getWorldInfoPrompt', 'printMessages', 'clearChat', 'updateReasoningUI',
];
// The page's interface, nothing kept: popups, loaders, scrolling, the send buttons, and which chat is open.
const SILLYTAVERN_PAGE_INTERFACE = [
    'activateSendButtons', 'deactivateSendButtons', 'openCharacterChat', 'openGroupChat', 'selectCharacterById', 'callPopup',
    'callGenericPopup', 'Popup', 'showLoader', 'hideLoader', 'loader', 'scrollChatToBottom', 'scrollOnMediaLoad',
    'reloadWorldInfoEditor', 'createCharacterData',
];
// C1 — kept in SillyTavern's settings: the settings objects, a settings save, and the tags.
const SILLYTAVERN_SETTINGS = [
    'accountStorage', 'saveSettingsDebounced', 'extensionSettings', 'chatCompletionSettings', 'textCompletionSettings',
    'powerUserSettings', 'tags', 'tagMap', 'importTags',
];
const SILLYTAVERN_BEYOND_CHAT = [
    // C3 — any chat, lorebook or character, by name
    'renameChat', 'writeExtensionField', 'writeExtensionFieldBulk', 'saveWorldInfo',
    // D — runs code, or reaches the page, the network or the model
    'getRequestHeaders', 'eventSource', 'generate', 'sendStreamingRequest', 'sendGenerationRequest', 'SlashCommandParser',
    'executeSlashCommandsWithOptions', 'registerSlashCommand', 'executeSlashCommands', 'registerHelper', 'registerMacro',
    'unregisterMacro', 'registerFunctionTool', 'unregisterFunctionTool', 'ToolManager', 'registerDebugFunction',
    'registerDataBankScraper', 'generateQuietPrompt', 'generateRaw', 'generateRawData', 'addLocaleData', 'importFromExternalUrl',
    'macros', 'messageFormatter', 'ChatCompletionService', 'TextCompletionService', 'ConnectionManagerRequestService',
    'openThirdPartyExtensionMenu',
];
// Ruled by the member after them: the variables (this chat's, or the global ones kept in SillyTavern's settings), what
// getPresetManager() returns, and the page's libs (localforage is the browser's own storage).
const SILLYTAVERN_OBJECT_MEMBERS = {
    variables: { allowed: ['local'], settings: ['global'], beyondChat: [] },
    getPresetManager: {
        allowed: [
            'getAllPresets', 'findPreset', 'getSelectedPreset', 'getSelectedPresetName', 'getPresetList', 'isKeyedApi',
            'isAdvancedFormatting', 'getPresetSettings', 'getCompletionPresetByName', 'getDefaultPreset', 'readPresetExtensionField',
        ],
        settings: [
            'selectPreset', 'updatePreset', 'savePresetAs', 'savePreset', 'renamePreset', 'deletePreset', 'updateList',
            'writePresetExtensionField',
        ],
        beyondChat: [],
    },
    libs: {
        allowed: [
            'lodash', 'Fuse', 'DOMPurify', 'hljs', 'Handlebars', 'css', 'Bowser', 'DiffMatchPatch', 'Readability',
            'isProbablyReaderable', 'SVGInject', 'showdown', 'moment', 'seedrandom', 'Popper', 'droll', 'morphdom', 'slideToggle',
            'chalk', 'yaml', 'chevrotain', 'gzipSync', 'gzip', 'sha256',
        ],
        settings: [],
        beyondChat: ['localforage'],
    },
};

/**
 * @internal — the class lists, for the tests that hold every name to its class. `objects` are ruled by the member
 * after them; a member none of their lists hold is outside this chat, as an unlisted member of SillyTavern is.
 */
export const SILLYTAVERN_MEMBER_CLASSES = Object.freeze({
    reads: Object.freeze([...SILLYTAVERN_READS]),
    thisChat: Object.freeze([...SILLYTAVERN_THIS_CHAT]),
    pageInterface: Object.freeze([...SILLYTAVERN_PAGE_INTERFACE]),
    settings: Object.freeze([...SILLYTAVERN_SETTINGS]),
    beyondChat: Object.freeze([...SILLYTAVERN_BEYOND_CHAT]),
    objects: Object.freeze(Object.fromEntries(Object.entries(SILLYTAVERN_OBJECT_MEMBERS).map(([name, classes]) => [name, Object.freeze({
        allowed: Object.freeze([...classes.allowed]),
        settings: Object.freeze([...classes.settings]),
        beyondChat: Object.freeze([...classes.beyondChat]),
    })]))),
});

const SILLYTAVERN_CLASS = new Map([
    ...SILLYTAVERN_READS.map((name) => [name, 'allowed']),
    ...SILLYTAVERN_THIS_CHAT.map((name) => [name, 'allowed']),
    ...SILLYTAVERN_PAGE_INTERFACE.map((name) => [name, 'allowed']),
    ...SILLYTAVERN_SETTINGS.map((name) => [name, 'settings']),
    ...SILLYTAVERN_BEYOND_CHAT.map((name) => [name, 'beyondChat']),
    ...Object.keys(SILLYTAVERN_OBJECT_MEMBERS).map((name) => [name, 'object']),
]);

// The stores a TavernHelper variable call may name: this message, this chat, this character. 'global' and
// 'extension' are kept in SillyTavern's settings, 'preset' in the user's preset, 'script' is another script's.
const VARIABLE_TYPES_OF_THIS_CHAT = new Set(['message', 'chat', 'character']);

// ST-Prompt-Template's variable functions, and the argument their options sit in. A string option is its shorthand
// ('global' is a scope like the rest); an object names its scopes in `scope`, `inscope` and `outscope`.
const TEMPLATE_VARIABLE_OPTION_AT = new Map([
    ['getvar', 1], ['getLocalVar', 1], ['getMessageVar', 1],
    ['setvar', 2], ['setLocalVar', 2], ['setMessageVar', 2],
    ['incvar', 2], ['incLocalVar', 2], ['incMessageVar', 2],
    ['decvar', 2], ['decLocalVar', 2], ['decMessageVar', 2],
    ['delvar', 2], ['delLocalVar', 1], ['delMessageVar', 1],
    ['insvar', 3], ['insertLocalVar', 3], ['insertMessageVar', 3],
    ['patchVariables', 2],
]);
const TEMPLATE_SCOPE_KEYS = new Set(['scope', 'inscope', 'outscope']);

// Reported as settings wherever they appear: ST-Prompt-Template's global variables live in SillyTavern's settings,
// activateRegex writes SillyTavern's regex list, and the rest are the settings objects of SillyTavern's context.
const SETTINGS_NAMES = new Set([
    'extensionSettings', 'extension_settings', 'chatCompletionSettings', 'textCompletionSettings', 'powerUserSettings', 'accountStorage',
]);
const TEMPLATE_SETTINGS_FUNCTIONS = new Set([
    'getGlobalVar', 'setGlobalVar', 'incGlobalVar', 'decGlobalVar', 'delGlobalVar', 'insertGlobalVar', 'activateRegex',
]);

// Outside this chat, wherever they appear: SillyTavern's request headers carry the key to its whole server API, and
// its connection service calls the user's model.
const BEYOND_CHAT_NAMES = new Set(['getRequestHeaders', 'ConnectionManagerRequestService']);
// ST-Prompt-Template's own: slash commands, a template built at run time, and a name shared with every template.
const TEMPLATE_BEYOND_CHAT_FUNCTIONS = new Set(['execute', 'evalTemplate', 'define']);
// The page's own reach, as a global.
const PAGE_REACH_NAMES = new Set([
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'import', 'eval', 'Function', 'document', 'localStorage',
    'sessionStorage', 'indexedDB', 'jQuery', '$',
]);
// A timer given a string evaluates it.
const STRING_EVALUATING_TIMERS = new Set(['setTimeout', 'setInterval']);
// Names a global is read through: the page's own windows, EJS's `locals` (the template's context) and `this` (the
// same context). A member of one is ruled like a global of that name.
const ROOT_NAMES = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames', 'locals', 'this']);
// The roots nothing else is called: used other than through a member, they are unchecked. `self` is an everyday
// local name as well, so only `self[…]` is; `top`, `parent`, `frames` and `this` are only read through their members.
const ROOTS_ONLY_THE_PAGE_HAS = new Set(['window', 'globalThis', 'locals']);
const ROOTS_UNCHECKED_WHEN_INDEXED = new Set(['window', 'globalThis', 'locals', 'self']);

// ── EJS, as ST-Prompt-Template compiles it ───────────────────────────────────

const EJS_TAG = /(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)/;

// EJS's output line for text: the text in a double-quoted string, its backslashes, line breaks and quotes escaped.
function appendedText(text) {
    if (!text) return '';
    const escaped = text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/"/g, '\\"');
    return '    ; __append("' + escaped + '")\n';
}

/**
 * @internal — the source EJS compiles `text` into, for the tests that hold the tokenizer to acorn's.
 *
 * The tags are split as EJS splits them; a code tag's text is a statement, `<%=`/`<%-` an appended expression, `<%#`
 * nothing; `<%%` and `%%>` are literal text. A tag EJS would refuse to compile is read all the same.
 */
export function ejsSourceOf(text) {
    let rest = String(text).replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>');
    const pieces = [];
    for (let match = EJS_TAG.exec(rest); match; match = EJS_TAG.exec(rest)) {
        if (match.index) pieces.push(rest.slice(0, match.index));
        pieces.push(match[0]);
        rest = rest.slice(match.index + match[0].length);
    }
    if (rest) pieces.push(rest);
    let mode = null;
    let source = '';
    for (const piece of pieces) {
        if (piece === '<%' || piece === '<%_') mode = 'statement';
        else if (piece === '<%=') mode = 'escaped';
        else if (piece === '<%-') mode = 'raw';
        else if (piece === '<%#') mode = 'comment';
        else if (piece === '<%%') { mode = 'literal'; source += appendedText('<%'); }
        else if (piece === '%%>') { mode = 'literal'; source += appendedText('%>'); }
        else if (piece === '%>' || piece === '-%>' || piece === '_%>') {
            if (mode === 'literal') source += appendedText(piece);
            mode = null;
        } else if (mode === 'statement' || mode === 'escaped' || mode === 'raw') {
            // EJS closes a trailing `//` comment's line, so the comment cannot swallow what it appends.
            const line = piece.lastIndexOf('//') > piece.lastIndexOf('\n') ? piece + '\n' : piece;
            const expression = line.replace(/;(\s*$)/, '$1');
            if (mode === 'statement') source += '    ; ' + line + '\n';
            else if (mode === 'escaped') source += '    ; __append(escapeFn(' + expression + '))\n';
            else source += '    ; __append(' + expression + ')\n';
        } else if (mode !== 'comment') {
            source += appendedText(piece);
        }
    }
    return source;
}

// What a browser decodes back into a character in a message's text, for the characters code is spelled with:
// numeric references, the named ones for ASCII punctuation, and the legacy names it reads even without `;`.
const NAMED_CHARACTER_REFERENCES = {
    lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'', percnt: '%', excl: '!', num: '#', dollar: '$', lpar: '(', rpar: ')',
    ast: '*', midast: '*', plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', equals: '=', quest: '?',
    commat: '@', lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', Hat: '^', lowbar: '_', UnderBar: '_', grave: '`',
    DiacriticalGrave: '`', lcub: '{', lbrace: '{', verbar: '|', vert: '|', VerticalLine: '|', rcub: '}', rbrace: '}',
    NewLine: '\n', Tab: '\t', nbsp: '\u00a0', LT: '<', GT: '>', AMP: '&', QUOT: '"',
};
const NAMES_READ_WITHOUT_SEMICOLON = ['lt', 'gt', 'amp', 'quot', 'nbsp', 'LT', 'GT', 'AMP', 'QUOT'];

function decodeCharacterReferences(text) {
    return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, body, semicolon) => {
        if (body[0] === '#') {
            const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
        }
        if (semicolon && Object.hasOwn(NAMED_CHARACTER_REFERENCES, body)) return NAMED_CHARACTER_REFERENCES[body];
        const legacy = NAMES_READ_WITHOUT_SEMICOLON.find((name) => body.startsWith(name));
        return legacy ? NAMED_CHARACTER_REFERENCES[legacy] + body.slice(legacy.length) + semicolon : whole;
    });
}

// ── the tokenizer ────────────────────────────────────────────────────────────

const KEYWORDS_BEFORE_AN_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const KEYWORDS_BEFORE_A_BLOCK = new Set(['else', 'do', 'try', 'finally']);
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const isDigit = (character) => character >= '0' && character <= '9';
const isLineTerminator = (character) => character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

// A string or template literal's value: every escape the language reads, legacy octal included.
function cookEscapes(raw) {
    return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|\r\n|[\s\S])/g, (_whole, escape) => {
        if (escape[0] === 'u') {
            const codePoint = parseInt(escape[1] === '{' ? escape.slice(2, -1) : escape.slice(1), 16);
            return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
        }
        if (escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
        if (isDigit(escape[0]) && escape[0] <= '7') {
            const digits = escape[0] >= '4' ? escape.slice(0, 2) : escape;
            return String.fromCharCode(parseInt(digits, 8)) + escape.slice(digits.length);
        }
        if (isLineTerminator(escape) || escape === '\r\n') return '';
        return Object.hasOwn(SIMPLE_ESCAPES, escape) ? SIMPLE_ESCAPES[escape] : escape;
    });
}

// `\uXXXX` or `\u{X…}` from `from` (just past the `\u`), or null.
function readUnicodeEscape(text, from) {
    if (text[from] === '{') {
        const close = text.indexOf('}', from);
        const hex = close === -1 ? '' : text.slice(from + 1, close);
        if (!/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
        return { codePoint: parseInt(hex, 16), end: close + 1 };
    }
    const hex = text.slice(from, from + 4);
    return /^[0-9a-fA-F]{4}$/.test(hex) ? { codePoint: parseInt(hex, 16), end: from + 4 } : null;
}

// An identifier starting at `at`, its escapes decoded (`\u0066etch` is `fetch`), or null.
function readIdentifier(text, at) {
    let index = at;
    let value = '';
    while (index < text.length) {
        let character;
        let end;
        if (text[index] === '\\' && text[index + 1] === 'u') {
            const escape = readUnicodeEscape(text, index + 2);
            if (!escape) break;
            character = String.fromCodePoint(escape.codePoint);
            end = escape.end;
        } else {
            character = String.fromCodePoint(text.codePointAt(index));
            end = index + character.length;
        }
        if (!(value ? IDENTIFIER_PART : IDENTIFIER_START).test(character)) break;
        value += character;
        index = end;
    }
    return value ? { value, end: index } : null;
}

// A quoted string from `at`: its value and where it ends. A string never crosses a line, so an unclosed one ends there.
function readQuoted(text, at) {
    const quote = text[at];
    let index = at + 1;
    let raw = '';
    while (index < text.length) {
        const character = text[index];
        if (character === '\\') {
            const width = text[index + 1] === '\r' && text[index + 2] === '\n' ? 3 : 2;
            raw += text.slice(index, index + width);
            index += width;
            continue;
        }
        if (character === quote) return { value: cookEscapes(raw), end: index + 1 };
        if (character === '\n' || character === '\r') break;
        raw += character;
        index += 1;
    }
    return { value: cookEscapes(raw), end: index };
}

// A regex literal from `at` (its opening `/`), flags included; where it ends.
function regexLiteralEnd(text, at) {
    let index = at + 1;
    let isInClass = false;
    while (index < text.length) {
        const character = text[index];
        if (character === '\\') { index += 2; continue; }
        if (isLineTerminator(character)) return index;
        index += 1;
        if (character === '[') isInClass = true;
        else if (character === ']') isInClass = false;
        else if (character === '/' && !isInClass) break;
    }
    while (index < text.length && IDENTIFIER_PART.test(text[index])) index += 1;
    return index;
}

// A numeric literal from `at`; where it ends. `1..constructor` is the number `1.` and then a member.
function numberEnd(text, at) {
    let index = at;
    if (text[index] === '0' && /[xXbBoO]/.test(text[index + 1] || '')) {
        index += 2;
        while (/[0-9a-fA-F_]/.test(text[index] || '')) index += 1;
        return text[index] === 'n' ? index + 1 : index;
    }
    while (/[0-9_]/.test(text[index] || '')) index += 1;
    if (text[index] === 'n') return index + 1;
    if (text[index] === '.') {
        index += 1;
        while (/[0-9_]/.test(text[index] || '')) index += 1;
    }
    if (/[eE]/.test(text[index] || '')) {
        let exponent = index + 1;
        if (/[+-]/.test(text[exponent] || '')) exponent += 1;
        if (isDigit(text[exponent] || '')) {
            index = exponent;
            while (/[0-9_]/.test(text[index] || '')) index += 1;
        }
    }
    return index;
}

/**
 * @internal — the tokenizer, exported for the tests that hold it to acorn's.
 *
 * The tokens of JavaScript source: { type: 'name'|'punct'|'string'|'template'|'number'|'regex'|'private', value }.
 * Comments and whitespace are dropped; a string's and a template chunk's value is its cooked text; a template
 * literal's `${…}` is read as code, between a `${` and a `}` token. A regex literal is told from a division the way
 * the language does: by what the previous token leaves the parser expecting.
 */
export function templateCodeTokens(source) {
    const text = String(source);
    const tokens = [];
    const braces = [];   // per open `{` or `${`: 'block', 'object' or 'template'
    const parens = [];   // per open `(`: whether it holds an if/while/for/with condition
    let at = 0;

    const push = (token) => { tokens.push(token); };
    const last = () => tokens[tokens.length - 1];
    const isExpressionExpected = () => {
        const previous = last();
        if (!previous) return true;
        if (previous.type === 'name') return KEYWORDS_BEFORE_AN_EXPRESSION.has(previous.value);
        if (previous.type !== 'punct') return false;
        if (previous.value === ')') return previous.closesCondition === true;
        if (previous.value === '}') return previous.closesBlock === true;
        return previous.value !== ']';
    };
    const isBlockOpening = () => {
        const previous = last();
        if (!previous) return true;
        if (previous.type === 'name') return KEYWORDS_BEFORE_A_BLOCK.has(previous.value) || !KEYWORDS_BEFORE_AN_EXPRESSION.has(previous.value);
        if (previous.type !== 'punct') return false;
        return [';', '{', '}', ')', '=>'].includes(previous.value);
    };
    // A template's text from `from` (past its backtick, or past the `}` closing a substitution) to its closing
    // backtick or its next `${`.
    const readTemplateText = (from) => {
        let index = from;
        let raw = '';
        while (index < text.length) {
            const character = text[index];
            if (character === '\\') { raw += text.slice(index, index + 2); index += 2; continue; }
            if (character === '`') { push({ type: 'template', value: cookEscapes(raw) }); return index + 1; }
            if (character === '$' && text[index + 1] === '{') {
                push({ type: 'template', value: cookEscapes(raw) });
                push({ type: 'punct', value: '${' });
                braces.push('template');
                return index + 2;
            }
            raw += character;
            index += 1;
        }
        push({ type: 'template', value: cookEscapes(raw) });
        return index;
    };

    while (at < text.length) {
        const character = text[at];
        if (/\s/.test(character)) { at += 1; continue; }
        if (character === '/' && text[at + 1] === '/') {
            while (at < text.length && !isLineTerminator(text[at])) at += 1;
            continue;
        }
        if (character === '/' && text[at + 1] === '*') {
            const close = text.indexOf('*/', at + 2);
            at = close === -1 ? text.length : close + 2;
            continue;
        }
        if (character === '\'' || character === '"') {
            const quoted = readQuoted(text, at);
            push({ type: 'string', value: quoted.value });
            at = quoted.end;
            continue;
        }
        if (character === '`') { at = readTemplateText(at + 1); continue; }
        if (character === '/' && isExpressionExpected()) {
            const end = regexLiteralEnd(text, at);
            push({ type: 'regex', value: text.slice(at, end) });
            at = end;
            continue;
        }
        if (isDigit(character) || (character === '.' && isDigit(text[at + 1] || ''))) {
            const end = numberEnd(text, at);
            push({ type: 'number', value: text.slice(at, end) });
            at = end;
            continue;
        }
        const identifier = readIdentifier(text, at);
        if (identifier) {
            push({ type: 'name', value: identifier.value });
            at = identifier.end;
            continue;
        }
        if (character === '#') {
            const privateName = readIdentifier(text, at + 1);
            if (privateName) {
                push({ type: 'private', value: privateName.value });
                at = privateName.end;
                continue;
            }
        }
        if (character === '{') {
            braces.push(isBlockOpening() || !isExpressionExpected() ? 'block' : 'object');
            push({ type: 'punct', value: '{' });
            at += 1;
            continue;
        }
        if (character === '}') {
            const kind = braces.pop();
            push({ type: 'punct', value: '}', closesBlock: kind !== 'object' && kind !== 'template' });
            at = kind === 'template' ? readTemplateText(at + 1) : at + 1;
            continue;
        }
        if (character === '(') {
            const previous = last();
            parens.push(!!previous && previous.type === 'name' && CONTROL_KEYWORDS.has(previous.value));
            push({ type: 'punct', value: '(' });
            at += 1;
            continue;
        }
        if (character === ')') {
            push({ type: 'punct', value: ')', closesCondition: parens.pop() === true });
            at += 1;
            continue;
        }
        if (character === '?' && text[at + 1] === '.' && !isDigit(text[at + 2] || '')) {
            push({ type: 'punct', value: '?.' });
            at += 2;
            continue;
        }
        const punctuator = PUNCTUATORS.find((candidate) => text.startsWith(candidate, at)) || character;
        push({ type: 'punct', value: punctuator });
        at += punctuator.length;
    }
    return tokens;
}

// ── reading the tokens ───────────────────────────────────────────────────────

const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);

const isPunct = (token, value) => !!token && token.type === 'punct' && token.value === value;
const isMemberDot = (token) => isPunct(token, '.') || isPunct(token, '?.');
const nameAt = (tokens, index) => (tokens[index] && tokens[index].type === 'name' ? tokens[index].value : null);

// The member name after `.`/`?.` at `index`, or null (a `?.[` or `?.(` names none).
const memberAfter = (tokens, index) => (isMemberDot(tokens[index]) ? nameAt(tokens, index + 1) : null);

// The index of the `(` that calls what ends at `index - 1` (`f(`, `f?.(`), or -1.
function callOpenAt(tokens, index) {
    if (isPunct(tokens[index], '(')) return index;
    if (isPunct(tokens[index], '?.') && isPunct(tokens[index + 1], '(')) return index + 1;
    return -1;
}

const isIndexedAt = (tokens, index) => isPunct(tokens[index], '[') || (isPunct(tokens[index], '?.') && isPunct(tokens[index + 1], '['));

// The member chain a name sits in (`a.b.c`): its first and last name.
function chainStartOf(tokens, index) {
    let start = index;
    while (isMemberDot(tokens[start - 1]) && nameAt(tokens, start - 2) !== null) start -= 2;
    return start;
}
function chainEndOf(tokens, index) {
    let end = index;
    while (memberAfter(tokens, end + 1) !== null) end += 2;
    return end;
}

// `typeof a.b.c` reads nothing; `typeof a.b.c(…)` calls c.
function isTypeofCheck(tokens, index) {
    return nameAt(tokens, chainStartOf(tokens, index) - 1) === 'typeof' && callOpenAt(tokens, chainEndOf(tokens, index) + 1) === -1;
}

// A key in an object literal (`{ fetch: … }`) names nothing.
function isObjectKey(tokens, index) {
    return isPunct(tokens[index + 1], ':') && (isPunct(tokens[index - 1], '{') || isPunct(tokens[index - 1], ','));
}

// A global the name reaches: a bare name, or a member of a root (`window.fetch`, `globalThis.window.fetch`).
function isGlobalReference(tokens, index) {
    if (!isMemberDot(tokens[index - 1])) return true;
    const owner = nameAt(tokens, index - 2);
    return owner !== null && ROOT_NAMES.has(owner) && isGlobalReference(tokens, index - 2);
}

// A token run split at its top-level commas, from `from` until the closer that ends it. Returns the runs.
function splitAtTopLevelCommas(tokens, from) {
    const runs = [[]];
    let depth = 0;
    let index = from;
    for (; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === 'punct' && OPENERS.has(token.value)) depth += 1;
        else if (token.type === 'punct' && CLOSERS.has(token.value)) {
            if (depth === 0) break;
            depth -= 1;
        } else if (depth === 0 && isPunct(token, ',')) {
            runs.push([]);
            continue;
        }
        runs[runs.length - 1].push(token);
    }
    if (!runs[runs.length - 1].length) runs.pop();
    return runs;
}

// The index of the closer that ends the opener at `open`, or -1 when the code ends first.
function closerOf(tokens, open) {
    let depth = 0;
    for (let index = open; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === 'punct' && OPENERS.has(token.value)) depth += 1;
        else if (token.type === 'punct' && CLOSERS.has(token.value)) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

// The properties of an object literal that makes up `run` whole, or null when `run` is no such literal.
function objectLiteralProperties(run) {
    if (!isPunct(run[0], '{')) return null;
    let depth = 0;
    for (let index = 0; index < run.length; index += 1) {
        const token = run[index];
        if (token.type === 'punct' && OPENERS.has(token.value)) depth += 1;
        else if (token.type === 'punct' && CLOSERS.has(token.value)) {
            depth -= 1;
            if (depth === 0 && index !== run.length - 1) return null;
        }
    }
    return splitAtTopLevelCommas(run, 1).map((property) => {
        const [first, second] = property;
        if (isPunct(first, '...')) return { kind: 'spread' };
        if (isPunct(first, '[')) return { kind: 'computed' };
        const key = first && (first.type === 'name' || first.type === 'string' || first.type === 'number') ? String(first.value) : null;
        if (property.length === 1) return { kind: 'shorthand', key };
        if (isPunct(second, ':')) return { kind: 'value', key, value: property.slice(2) };
        // `get type() {…}`, `async type() {…}`, `type() {…}`: the key is computed when it is read.
        const accessorKey = second && (second.type === 'name' || second.type === 'string') ? String(second.value) : key;
        return { kind: 'method', key: ['get', 'set', 'async'].includes(key) ? accessorKey : key };
    });
}

const singleString = (run) => (run.length === 1 && run[0].type === 'string' ? run[0].value : null);

// An option object's verdict: every key in `keys` holds one string literal `isAllowed` accepts; no spread, computed
// key or `__proto__` that could carry another. A key that is absent is fine.
function objectOptionVerdict(run, keys, isAllowed) {
    const properties = objectLiteralProperties(run);
    if (!properties) return { isAllowed: false, label: 'an option that cannot be checked' };
    for (const property of properties) {
        if (property.kind === 'spread' || property.kind === 'computed' || property.key === '__proto__') {
            return { isAllowed: false, label: 'an option that cannot be checked' };
        }
        if (!keys.has(property.key)) continue;
        const value = property.kind === 'value' ? singleString(property.value) : null;
        if (value === null) return { isAllowed: false, label: 'an option that cannot be checked' };
        if (!isAllowed(value)) return { isAllowed: false, label: '{ ' + property.key + ': \'' + value + '\' }' };
    }
    return { isAllowed: true, label: '' };
}

// TavernHelper's type rule: no option (`{ type: 'chat' }`), or an object literal naming this chat's store.
function variableOptionVerdict(run) {
    return objectOptionVerdict(run, new Set(['type']), (value) => VARIABLE_TYPES_OF_THIS_CHAT.has(value));
}

// ST-Prompt-Template's scope rule: no option, a shorthand string or a boolean, or an object literal — none of them
// naming the global scope.
function templateScopeVerdict(run) {
    const shorthand = singleString(run);
    if (shorthand !== null) return shorthand === 'global' ? { isAllowed: false, label: '\'global\'' } : { isAllowed: true, label: '' };
    if (run.length === 1 && run[0].type === 'name' && (run[0].value === 'true' || run[0].value === 'false')) return { isAllowed: true, label: '' };
    return objectOptionVerdict(run, TEMPLATE_SCOPE_KEYS, (value) => value !== 'global');
}

// A variable call at `index` whose option sits in argument `optionAt`: allowed when that option passes `verdictOf`.
// Named without a call (`const get = TavernHelper.getVariables`), its later call cannot be checked.
function variableCallFinding(tokens, index, label, optionAt, verdictOf) {
    const open = callOpenAt(tokens, index + 1);
    if (open === -1) return label + ', held without a call';
    const option = splitAtTopLevelCommas(tokens, open + 1)[optionAt];
    if (!option) return null;
    const verdict = verdictOf(option);
    return verdict.isAllowed ? null : label + '(' + verdict.label + ')';
}

function ruleTavernHelper(tokens, index, found) {
    const member = memberAfter(tokens, index + 1);
    if (member === null) {
        found.unchecked.add(isIndexedAt(tokens, index + 1) ? 'TavernHelper[…]' : 'TavernHelper');
        return;
    }
    const label = 'TavernHelper.' + member;
    const memberClass = TAVERN_HELPER_CLASS.get(member);
    if (memberClass === 'allowed') return;
    if (memberClass === 'variables') {
        const finding = variableCallFinding(tokens, index + 2, label, member === 'getVariables' ? 0 : 1, variableOptionVerdict);
        if (finding) found.settings.add(finding);
    } else if (memberClass === 'settings') {
        found.settings.add(label);
    } else {
        found.beyondChat.add(label);
    }
}

// The SillyTavern member named at `index`. The settings objects, getRequestHeaders and ConnectionManagerRequestService
// are reported by their own name, wherever they appear.
function ruleSillyTavernMember(tokens, index, found) {
    const member = tokens[index].value;
    if (SETTINGS_NAMES.has(member) || BEYOND_CHAT_NAMES.has(member)) return;
    const memberClass = SILLYTAVERN_CLASS.get(member);
    if (memberClass === 'allowed') return;
    if (memberClass === 'settings') found.settings.add('SillyTavern.' + member);
    else if (memberClass === 'object') ruleSillyTavernObject(tokens, index, member, found);
    else found.beyondChat.add('SillyTavern.' + member);
}

// variables, what getPresetManager() returns, and libs: ruled by the member after them. Held or indexed, they cannot
// be checked.
function ruleSillyTavernObject(tokens, index, member, found) {
    let label = 'SillyTavern.' + member;
    let after = index + 1;
    if (member === 'getPresetManager') {
        label += '()';
        const open = callOpenAt(tokens, after);
        const close = open === -1 ? -1 : closerOf(tokens, open);
        if (close === -1) {
            found.unchecked.add(label);
            return;
        }
        after = close + 1;
    }
    const next = memberAfter(tokens, after);
    if (next === null) {
        found.unchecked.add(isIndexedAt(tokens, after) ? label + '[…]' : label);
        return;
    }
    const classes = SILLYTAVERN_OBJECT_MEMBERS[member];
    if (classes.allowed.includes(next)) return;
    (classes.settings.includes(next) ? found.settings : found.beyondChat).add(label + '.' + next);
}

// In a template `SillyTavern` is SillyTavern's context; on the page, an object whose getContext() returns it.
function ruleSillyTavern(tokens, index, found) {
    const member = memberAfter(tokens, index + 1);
    if (member === null) {
        found.unchecked.add(isIndexedAt(tokens, index + 1) ? 'SillyTavern[…]' : 'SillyTavern');
        return;
    }
    if (member !== 'getContext') {
        ruleSillyTavernMember(tokens, index + 2, found);
        return;
    }
    const open = callOpenAt(tokens, index + 3);
    const contextMember = open !== -1 && isPunct(tokens[open + 1], ')') ? memberAfter(tokens, open + 2) : null;
    if (contextMember === null) found.unchecked.add('SillyTavern.getContext()');
    else ruleSillyTavernMember(tokens, open + 3, found);
}

// A root's member is ruled at its own index. A root only the page has is fine only that way.
function ruleRoot(tokens, index, name, found) {
    if (memberAfter(tokens, index + 1) !== null) return;
    if (isIndexedAt(tokens, index + 1)) {
        if (ROOTS_UNCHECKED_WHEN_INDEXED.has(name)) found.unchecked.add(name + '[…]');
    } else if (ROOTS_ONLY_THE_PAGE_HAS.has(name)) {
        found.unchecked.add(name);
    }
}

function ruleTimer(tokens, index, name, found) {
    const open = callOpenAt(tokens, index + 1);
    const first = open === -1 ? null : tokens[open + 1];
    if (first && (first.type === 'string' || first.type === 'template')) found.beyondChat.add(name + '(string)');
}

/**
 * @internal — the rules over one token list, exported for the tests that run them over acorn's tokens too.
 * Adds what the tokens reach to `found`'s three sets.
 */
export function addTemplateReach(tokens, found) {
    for (let index = 0; index < tokens.length; index += 1) {
        const name = nameAt(tokens, index);
        if (name === null || isObjectKey(tokens, index) || isTypeofCheck(tokens, index)) continue;
        if (SETTINGS_NAMES.has(name)) found.settings.add(name);
        if (BEYOND_CHAT_NAMES.has(name)) found.beyondChat.add(name);
        if (name === 'constructor' && isMemberDot(tokens[index - 1])) found.beyondChat.add('constructor');
        if (!isGlobalReference(tokens, index)) continue;
        if (name === 'TavernHelper') ruleTavernHelper(tokens, index, found);
        else if (name === 'SillyTavern') ruleSillyTavern(tokens, index, found);
        else if (ROOT_NAMES.has(name)) ruleRoot(tokens, index, name, found);
        else if (PAGE_REACH_NAMES.has(name)) found.beyondChat.add(name === 'import' ? 'import()' : name);
        else if (TEMPLATE_BEYOND_CHAT_FUNCTIONS.has(name)) found.beyondChat.add(name);
        else if (TEMPLATE_SETTINGS_FUNCTIONS.has(name)) found.settings.add(name);
        else if (STRING_EVALUATING_TIMERS.has(name)) ruleTimer(tokens, index, name, found);
        else if (TEMPLATE_VARIABLE_OPTION_AT.has(name)) {
            const finding = variableCallFinding(tokens, index, name, TEMPLATE_VARIABLE_OPTION_AT.get(name), templateScopeVerdict);
            if (finding) found.settings.add(finding);
        }
    }
}

// ── SillyTavern's macros ─────────────────────────────────────────────────────

// SillyTavern keeps its global variables in its settings (`extension_settings.variables.global`), and these macros
// read or write them in either of its macro engines; aliases included. 1.19.0's newer engine, on by default, adds the
// `$` shorthand (`{{$name}}`, `{{$name = 1}}`, `{{$name++}}`). A name is matched as the engines match it: in any
// case, after any flags or spaces. The chat's own variables (`{{setvar::…}}`, `{{.name}}`) are this chat's.
const GLOBAL_VARIABLE_MACROS = [
    'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'deleteglobalvar', 'flushglobalvar', 'setglobalvarkey',
    'setglobalvarindex', 'getglobalvar', 'hasglobalvar', 'globalvarexists', 'getglobalvarkey', 'getglobalvarindex',
];
const GLOBAL_VARIABLE_MACRO = new RegExp('\\{\\{[\\s!?~#/>]*(' + GLOBAL_VARIABLE_MACROS.join('|') + ')(?![\\w-])', 'gi');
const GLOBAL_VARIABLE_SHORTHAND = /\{\{[\s!?~#/>]*\$[a-zA-Z]/;

function addMacroReach(text, found) {
    if (!text.includes('{{')) return;
    for (const match of text.matchAll(GLOBAL_VARIABLE_MACRO)) found.settings.add('{{' + match[1].toLowerCase() + '::…}}');
    if (GLOBAL_VARIABLE_SHORTHAND.test(text)) found.settings.add('{{$…}}');
}

/**
 * What the template code and the macros in a pack's lorebook entries and regex rows can reach.
 *
 * @param {{ entries?: string[], regexReplacements?: string[], macroTexts?: string[] }} texts  as the install is about
 *   to write them: each entry's content, each regex row's replacement, and the other texts SillyTavern runs its macros
 *   over (an entry's keys and secondary keys, a regex row's trim strings, and its find pattern when its macro option
 *   is on), which are searched for macros only
 * @returns {{ settings: string[], beyondChat: string[], unchecked: string[] }}  what was found, once each, in the
 *   order it was first found; three empty lists when nothing reaches what it should not
 */
export function templateReachIn({ entries = [], regexReplacements = [], macroTexts = [] } = {}) {
    const found = { settings: new Set(), beyondChat: new Set(), unchecked: new Set() };
    const scan = (text) => {
        if (text.includes('<%')) addTemplateReach(templateCodeTokens(ejsSourceOf(text)), found);
    };
    for (const entry of entries) {
        const text = String(entry ?? '');
        scan(text);
        addMacroReach(text, found);
    }
    for (const replacement of regexReplacements) {
        const text = String(replacement ?? '');
        scan(text);
        if (text.includes('&')) scan(decodeCharacterReferences(text));
        addMacroReach(text, found);
    }
    for (const macroText of macroTexts) addMacroReach(String(macroText ?? ''), found);
    return { settings: [...found.settings], beyondChat: [...found.beyondChat], unchecked: [...found.unchecked] };
}
