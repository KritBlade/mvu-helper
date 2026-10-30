// The allow-list for a GameLogic Pack's or Plugin's `schema` — the registerMvuSchema script that install
// writes as the card's enabled `Scheme` TavernHelper script. TavernHelper runs that script on the page,
// unsandboxed, on every chat load, so the script may only DECLARE a schema. What it may hold is what the
// StatusMenu builder's schema generator writes, plus z.looseObject (mvu-helper's own skeleton and the
// plugin probes declare the open root with it).
//
// KEPT, one top-level statement at a time:
//   · import { registerMvuSchema } from '<MVU_ZOD_MODULE_URL>'   the one import, from that one URL
//   · [export] const|let|var <name> = <value>, …                  every value built only from:
//         z.<member>(…) chains, and <declared name>.<member>(…) chains, member ∈ ZOD_MEMBERS
//         '…' and "…" strings, numbers, -numbers, true, false, null
//         [ … ] and { key: value, 'key': value } literals
//         names an earlier KEPT statement declared
//   · registerMvuSchema(<value>), bare or as $(() => { registerMvuSchema(<value>); })
//   · comments, as written
// Anything else is REMOVED — the whole statement — and reported as a removal (line, what, why). The rest
// still installs; the removals reach the author as warnings and a toast.
//
// Why each restriction exists:
//   · members are a LIST, not "anything after z.": z.constructor.constructor('…')() starts with `z.` and
//     runs whatever text it is handed.
//   · a value may name only what this file declared: fetch, window, eval and $ are the page.
//   · no function but the one register wrapper, no [ ] lookup, no template string, and no `\` outside a
//     string (fetch is still fetch).
//   · an object key may not be __proto__ (it sets the literal's prototype) and a quoted key may hold no
//     escape (an escape can spell __proto__).
//   · `</script`, `<script`, `<!--` and `-->` are removed wherever they stand, comments and strings too,
//     so the text cannot close or open a script element it is embedded in.
//   · a // comment ends at \n, \r, U+2028 and U+2029, exactly where JavaScript ends it. A scanner that
//     read a comment further than JavaScript does would hide the code after it from the scan, not from
//     the page.
// The filtered text is then scanned AGAIN and must come back with nothing to remove, or nothing is
// returned at all: the filter does not trust its own output.

export const MVU_ZOD_MODULE_URL = 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

// What the builder's generator calls on z, and looseObject.
export const ZOD_MEMBERS = Object.freeze(['string', 'number', 'boolean', 'null', 'any', 'object', 'looseObject',
    'tuple', 'union', 'array', 'record', 'coerce', 'passthrough', 'catchall', 'prefault']);
const ZOD_MEMBER_SET = new Set(ZOD_MEMBERS);

// The globals the script runs with. They are used, never declared, and never handed around as values.
const RUNTIME_NAMES = new Set(['z', '$', '_', 'registerMvuSchema']);
const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var']);
// A statement may end at a line break only when the next line starts one of these: none of them can
// continue an expression, so JavaScript ends the statement there too (automatic semicolon insertion).
const STATEMENT_STARTS = new Set(['import', 'export', 'const', 'let', 'var', '$', 'registerMvuSchema']);
// Names JavaScript refuses as a variable: declaring one would leave a script that does not parse.
const RESERVED_WORDS = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
    'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
    'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
    'var', 'void', 'while', 'with', 'yield']);
const HTML_MARKER = /<\/script|<script|<!--|-->/i;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const BACKSLASH = String.fromCharCode(0x5c);
const LINE_BREAK = new RegExp('[\n\r' + LINE_SEPARATOR + PARAGRAPH_SEPARATOR + ']');

const isLineTerminator = (ch) => ch === '\n' || ch === '\r' || ch === LINE_SEPARATOR || ch === PARAGRAPH_SEPARATOR;
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f'
    || ch === NO_BREAK_SPACE || ch === BYTE_ORDER_MARK || /\p{Zs}/u.test(ch);
const isNameStart = (ch) => /[A-Za-z_$]/.test(ch);
const isNamePart = (ch) => /[A-Za-z0-9_$]/.test(ch);
const NUMBER_AT = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const PUNCTUATORS = new Set(['{', '}', '(', ')', '[', ']', ',', ';', '.', ':', '=', '-']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const SNIPPET_LENGTH = 80;

// ── tokens ───────────────────────────────────────────────────────────────────

// Every character of the text lands in exactly one token, so the text can be rebuilt from them. Kinds:
// space, comment, string, number, name, punct, and `other` — anything this grammar never keeps (a
// template string, an operator, a backslash), tokenized only so the statement holding it can be found.
function tokenize(text) {
    const tokens = [];
    let at = 0;
    while (at < text.length) {
        const start = at;
        const ch = text[at];
        let kind;
        let isUnclosed = false;
        if (isSpace(ch) || isLineTerminator(ch)) {
            kind = 'space';
            while (at < text.length && (isSpace(text[at]) || isLineTerminator(text[at]))) at++;
        } else if (ch === '/' && text[at + 1] === '/') {
            kind = 'comment';
            while (at < text.length && !isLineTerminator(text[at])) at++;
        } else if (ch === '/' && text[at + 1] === '*') {
            kind = 'comment';
            const close = text.indexOf('*/', at + 2);
            isUnclosed = close < 0;
            at = isUnclosed ? text.length : close + 2;
        } else if (ch === '\'' || ch === '"') {
            kind = 'string';
            isUnclosed = true;
            at++;
            while (at < text.length) {
                const c = text[at];
                if (c === ch) { at++; isUnclosed = false; break; }
                if (c === '\n' || c === '\r') break;                 // a string cannot cross these (it can cross U+2028/U+2029)
                if (c === BACKSLASH) at += (text[at + 1] === '\r' && text[at + 2] === '\n') ? 3 : 2;
                else at++;
            }
            at = Math.min(at, text.length);
        } else if (ch === '`') {
            kind = 'other';
            at++;
            while (at < text.length && text[at] !== '`') at += text[at] === BACKSLASH ? 2 : 1;
            at = Math.min(at + 1, text.length);
        } else if (/\d/.test(ch)) {
            kind = 'number';
            NUMBER_AT.lastIndex = at;
            NUMBER_AT.exec(text);
            at = NUMBER_AT.lastIndex;
        } else if (isNameStart(ch)) {
            kind = 'name';
            while (at < text.length && isNamePart(text[at])) at++;
        } else if (ch === '=' && text[at + 1] === '>') {
            kind = 'punct';
            at += 2;
        } else if (PUNCTUATORS.has(ch)) {
            kind = 'punct';
            at++;
        } else {
            kind = 'other';
            at += String.fromCodePoint(text.codePointAt(at)).length;
        }
        tokens.push({ kind, start, end: at, text: text.slice(start, at), isUnclosed });
    }
    return tokens;
}

// ── statements ───────────────────────────────────────────────────────────────

class SchemaRefusal extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
        this.declaredNames = [];
    }
}
const refuse = (reason) => { throw new SchemaRefusal(reason); };
const quoted = (token) => (token ? '`' + token.text + '`' : 'the end of the script');

// The top-level statements, each kept or carrying the reason it is removed. `sig` holds the tokens that
// are not space or comment, with `index` (its place in `tokens`) and `isAfterLineBreak`.
function readStatements(tokens) {
    const sig = [];
    let sawLineBreak = false;
    tokens.forEach((token, index) => {
        if (token.kind === 'space' || token.kind === 'comment') {
            if (LINE_BREAK.test(token.text)) sawLineBreak = true;
            return;
        }
        sig.push({ ...token, index, isAfterLineBreak: sawLineBreak });
        sawLineBreak = false;
    });

    const declared = new Set();        // names an earlier KEPT statement declared
    const removedNames = new Set();    // names a REMOVED statement declared
    let hasImport = false;
    let hasRegistration = false;
    let statementHasImport = false;
    let statementHasRegistration = false;

    const isPunct = (k, text) => Boolean(sig[k]) && sig[k].kind === 'punct' && sig[k].text === text;
    const isName = (k, text) => Boolean(sig[k]) && sig[k].kind === 'name' && sig[k].text === text;
    const expectPunct = (k, text, where) => {
        if (!isPunct(k, text)) refuse('expected `' + text + '` ' + where + ', found ' + quoted(sig[k]));
        return k + 1;
    };
    const plainString = (token) => {
        if (token.isUnclosed) refuse('a string is not closed on its line');
        if (HTML_MARKER.test(token.text)) refuse('a string holds an HTML script or comment marker');
    };

    function value(k) {
        const token = sig[k];
        if (!token) refuse('the script ends in the middle of a value');
        if (token.kind === 'string') { plainString(token); return k + 1; }
        if (token.kind === 'number') return k + 1;
        if (isPunct(k, '-') && sig[k + 1] && sig[k + 1].kind === 'number') return k + 2;
        if (isPunct(k, '[')) return list(k + 1, ']');
        if (isPunct(k, '{')) return objectLiteral(k + 1);
        if (token.kind === 'name') {
            const name = token.text;
            if (name === 'true' || name === 'false' || name === 'null') return k + 1;
            if (name === 'z') {
                if (!isPunct(k + 1, '.')) refuse('`z` is used as something other than the start of a z.<member>(…) call');
                return chain(k + 1, name);
            }
            if (RUNTIME_NAMES.has(name)) refuse('`' + name + '` is handed around as a value');
            if (removedNames.has(name)) refuse('it uses `' + name + '`, whose own statement was removed');
            if (!declared.has(name)) refuse('`' + name + '` is not declared in this file — a value may use only z.<member>(…) calls, literals and names declared above it');
            return chain(k + 1, name);
        }
        refuse('unexpected ' + quoted(token));
    }

    // `.member` and `(…)` after a base, the call only straight after a member.
    function chain(k, base) {
        let mayCall = false;
        let hasCalled = false;
        for (;;) {
            if (isPunct(k, '.')) {
                const member = sig[k + 1];
                if (!member || member.kind !== 'name') refuse('`' + base + '.` is followed by ' + quoted(member));
                if (!ZOD_MEMBER_SET.has(member.text)) refuse('`.' + member.text + '` is not on the schema allow-list (' + ZOD_MEMBERS.join(', ') + ')');
                k += 2;
                mayCall = true;
            } else if (isPunct(k, '(')) {
                if (!mayCall) {
                    refuse(hasCalled ? 'a call on what a call returned — only z.<member>(…) is called'
                        : '`' + base + '(…)` is a call to something other than a z member');
                }
                k = list(k + 1, ')');
                mayCall = false;
                hasCalled = true;
            } else if (isPunct(k, '[')) {
                refuse('a [ ] lookup on `' + base + '`');
            } else {
                return k;
            }
        }
    }

    function list(k, close) {
        if (isPunct(k, close)) return k + 1;
        for (;;) {
            k = value(k);
            if (isPunct(k, close)) return k + 1;
            k = expectPunct(k, ',', 'between items');
            if (isPunct(k, close)) return k + 1;
        }
    }

    function objectLiteral(k) {
        if (isPunct(k, '}')) return k + 1;
        for (;;) {
            const key = sig[k];
            if (!key || (key.kind !== 'name' && key.kind !== 'string')) refuse('an object key must be a name or a quoted string, found ' + quoted(key));
            if (key.kind === 'string') {
                plainString(key);
                if (key.text.includes(BACKSLASH)) refuse('the object key ' + key.text + ' holds an escape');
            }
            const keyName = key.kind === 'string' ? key.text.slice(1, -1) : key.text;
            if (keyName === '__proto__') refuse('an object key named __proto__ sets the object\'s prototype');
            k = expectPunct(k + 1, ':', 'after the key ' + key.text);
            k = value(k);
            if (isPunct(k, '}')) return k + 1;
            k = expectPunct(k, ',', 'between object entries');
            if (isPunct(k, '}')) return k + 1;
        }
    }

    function statementEnd(k) {
        if (k >= sig.length) return k;
        if (isPunct(k, ';')) return k + 1;
        const token = sig[k];
        if (token.isAfterLineBreak && token.kind === 'name' && STATEMENT_STARTS.has(token.text)) return k;
        refuse('unexpected ' + quoted(token) + ' after the statement');
    }

    function importStatement(k) {
        if (hasImport) refuse('a second import');
        k = expectPunct(k + 1, '{', 'after `import`');
        if (!isName(k, 'registerMvuSchema')) refuse('the import must bring in registerMvuSchema alone, found ' + quoted(sig[k]));
        k = expectPunct(k + 1, '}', 'after registerMvuSchema');
        if (!isName(k, 'from')) refuse('expected `from`, found ' + quoted(sig[k]));
        const from = sig[k + 1];
        if (!from || from.kind !== 'string' || from.isUnclosed || from.text.slice(1, -1) !== MVU_ZOD_MODULE_URL) {
            refuse('the import must come from ' + MVU_ZOD_MODULE_URL + ', found ' + quoted(from));
        }
        statementHasImport = true;
        return statementEnd(k + 2);
    }

    function declaration(k) {
        const names = [];
        try {
            k += 1;
            for (;;) {
                const nameToken = sig[k];
                if (!nameToken || nameToken.kind !== 'name') refuse('a declaration names ' + quoted(nameToken) + ' instead of a variable');
                const name = nameToken.text;
                if (RUNTIME_NAMES.has(name)) refuse('it declares `' + name + '`, a name the script runs with');
                if (RESERVED_WORDS.has(name)) refuse('it declares `' + name + '`, a reserved word');
                if (declared.has(name) || removedNames.has(name) || names.includes(name)) refuse('it declares `' + name + '` a second time');
                names.push(name);
                k += 1;
                if (isPunct(k, '=')) k = value(k + 1);
                if (!isPunct(k, ',')) break;
                k += 1;
            }
            k = statementEnd(k);
        } catch (e) {
            if (e instanceof SchemaRefusal) e.declaredNames = names;
            throw e;
        }
        names.forEach((name) => declared.add(name));
        return k;
    }

    function registration(k) {
        if (hasRegistration) refuse('a second registerMvuSchema call');
        k = expectPunct(k + 1, '(', 'after registerMvuSchema');
        k = value(k);
        k = expectPunct(k, ')', 'to close registerMvuSchema(…)');
        statementHasRegistration = true;
        return k;
    }

    // $(() => { registerMvuSchema(<value>); }) — the builder's register step, and the one function allowed.
    function registerWrapper(k) {
        const shape = 'only $(() => { registerMvuSchema(…); }) is allowed';
        for (const text of ['(', '(', ')', '=>', '{']) {
            k += 1;
            if (!isPunct(k, text)) refuse('`$(…)` — ' + shape);
        }
        k += 1;
        if (!isName(k, 'registerMvuSchema')) refuse('`$(…)` runs ' + quoted(sig[k]) + ' — ' + shape);
        k = registration(k);
        if (isPunct(k, ';')) k += 1;
        if (!isPunct(k, '}') || !isPunct(k + 1, ')')) refuse('`$(…)` runs more than the registerMvuSchema call — ' + shape);
        return statementEnd(k + 2);
    }

    function statement(k) {
        const token = sig[k];
        if (isPunct(k, ';')) return k + 1;
        if (token.kind === 'name') {
            if (token.text === 'import') return importStatement(k);
            if (token.text === 'export') {
                const next = sig[k + 1];
                if (!next || next.kind !== 'name' || !DECLARATION_KEYWORDS.has(next.text)) {
                    refuse('`export` is followed by ' + quoted(next) + ' — only export const|let|var is allowed');
                }
                return declaration(k + 1);
            }
            if (DECLARATION_KEYWORDS.has(token.text)) return declaration(k);
            if (token.text === '$') return registerWrapper(k);
            if (token.text === 'registerMvuSchema') return statementEnd(registration(k));
            if (isPunct(k + 1, '(')) refuse('`' + token.text + '(…)` is a call to something other than registerMvuSchema');
        }
        refuse('a statement that is not the import, a declaration or the registerMvuSchema call');
    }

    // Where a removed statement ends: its `;` at bracket depth 0, or the line before the next statement
    // start at depth 0. Only WHICH text is removed depends on this — whatever is kept is re-scanned whole.
    function removedStatementEnd(from) {
        let depth = 0;
        for (let k = from; k < sig.length; k++) {
            const token = sig[k];
            if (k > from && depth === 0 && token.isAfterLineBreak && token.kind === 'name' && STATEMENT_STARTS.has(token.text)) return k;
            if (token.kind !== 'punct') continue;
            if (OPENERS.has(token.text)) depth++;
            else if (CLOSERS.has(token.text)) depth = Math.max(0, depth - 1);
            else if (token.text === ';' && depth === 0) return k + 1;
        }
        return sig.length;
    }

    const statements = [];
    let k = 0;
    while (k < sig.length) {
        statementHasImport = false;
        statementHasRegistration = false;
        try {
            const end = statement(k);
            hasImport = hasImport || statementHasImport;
            hasRegistration = hasRegistration || statementHasRegistration;
            statements.push({ first: k, last: end - 1, reason: '' });
            k = end;
        } catch (e) {
            if (!(e instanceof SchemaRefusal)) throw e;
            e.declaredNames.forEach((name) => removedNames.add(name));
            const end = removedStatementEnd(k);
            statements.push({ first: k, last: end - 1, reason: e.reason });
            k = end;
        }
    }
    return { sig, statements, isRegistered: hasRegistration };
}

// ── rebuilding ───────────────────────────────────────────────────────────────

function lineFinder(text) {
    const lineStarts = [0];
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        if (!isLineTerminator(ch)) continue;
        if (ch === '\r' && text[at + 1] === '\n') at++;
        lineStarts.push(at + 1);
    }
    return (offset) => {
        let line = 1;
        while (line < lineStarts.length && lineStarts[line] <= offset) line++;
        return line;
    };
}

function snippet(text) {
    const flat = text.replace(/\s+/gu, ' ').trim();
    return '`' + (flat.length > SNIPPET_LENGTH ? flat.slice(0, SNIPPET_LENGTH) + '…' : flat) + '`';
}

// One pass: the text with every removed statement and every unsafe comment replaced by a marker comment,
// and the removals in line order.
function filterOnce(text) {
    const tokens = tokenize(text);
    const { sig, statements, isRegistered } = readStatements(tokens);
    const lineOf = lineFinder(text);
    const removals = [];
    const removedSpans = new Map();      // token index of a removed statement's first token -> its last token index
    for (const s of statements) {
        if (!s.reason) continue;
        const first = sig[s.first];
        const last = sig[s.last];
        const line = lineOf(first.start);
        removals.push({ line, what: snippet(text.slice(first.start, last.end)), why: s.reason });
        removedSpans.set(first.index, { lastIndex: last.index, line });
    }
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
        const span = removedSpans.get(i);
        if (span) {
            out += '/* mvu-helper removed the statement on line ' + span.line + ': it is not on the schema allow-list */';
            i = span.lastIndex;
            continue;
        }
        const token = tokens[i];
        if (token.kind === 'comment' && (token.isUnclosed || HTML_MARKER.test(token.text))) {
            const line = lineOf(token.start);
            removals.push({ line, what: 'a comment', why: token.isUnclosed ? 'the /* comment is never closed' : 'it holds an HTML script or comment marker' });
            out += token.text.startsWith('//') ? '// mvu-helper removed a comment here' : '/* mvu-helper removed a comment here */';
            continue;
        }
        out += token.text;
    }
    removals.sort((a, b) => a.line - b.line);
    return { text: out, removals, isRegistered };
}

/**
 * The schema script with everything off the allow-list removed.
 * @param {string} text  a pack's or plugin's `schema`
 * @returns {{ text: string|null, removals: Array<{line: number, what: string, why: string}>, isRegistered: boolean, failure: string }}
 *   `text` is what may be installed — the input itself when nothing was removed — or null when the filtered
 *   text failed its own re-scan (`failure` says how); `isRegistered` is whether the kept text calls
 *   registerMvuSchema.
 */
export function filterSchemaScript(text) {
    const source = String(text == null ? '' : text);
    const first = filterOnce(source);
    if (!first.removals.length) {
        return HTML_MARKER.test(source)
            ? { text: null, removals: [], isRegistered: false, failure: 'the schema holds an HTML script or comment marker outside every comment and string it was scanned as' }
            : { text: source, removals: [], isRegistered: first.isRegistered, failure: '' };
    }
    const again = filterOnce(first.text);
    if (again.removals.length || HTML_MARKER.test(first.text)) {
        return { text: null, removals: first.removals, isRegistered: false,
            failure: 'the filtered schema did not pass its own re-scan, so none of it is installed' };
    }
    return { text: first.text, removals: first.removals, isRegistered: first.isRegistered, failure: '' };
}
