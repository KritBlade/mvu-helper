// character-roster/cast-record-format-core.js — how a cast record is WRITTEN in model text, the names in it included,
// and the only file that knows (plans/reply-cast.md §1.8 rule 4). PURE: no imports. Tested by
// tests/cast-record-format-core.test.js.
//
// A cast record is `{ name, attributes }`: one named character, plus what the text says about them.
// Everything past this file — registration, the instruction builders, a later tracker — handles
// records and never a tag string, so the format can change (to JSON Patch, say) by replacing this
// file alone.
//
// THE FORMAT: one self-contained tag per line, `<cast name="…" key="…">`, no closing tag. Values are
// double-quoted and never contain a line break, `"`, `<` or `>`.
// CAST_RECORD_PATTERN is the one definition of a record, published so memory tools strip exactly
// what this file reads. It cannot cross a line or a `>`, so a malformed record leaks at most the
// rest of its own line and never swallows prose after it. A paired `<cast>…</cast>` would do the
// opposite: one forgotten closer and a lazy match eats everything up to the next closer.

export const CAST_RECORD_PATTERN = /<cast\b[^>\n]*>/gi;

// STRAY CLOSERS. Models write closers nobody asked for (they did it for years with the retired
// `<charImage>`). An UNFINISHED one — `</cast` with no `>` — makes the browser swallow the page up to
// the next `>` (live 2026-08-09: it ate a status placeholder). Matched WITHOUT `[^>]*`: `\s*>?` takes
// the closer and nothing past it, so removing one can never commit the bug it exists to remove.
const CAST_CLOSER_PATTERN = /<\/cast\s*>?/gi;

// `key="value"`. A key is any run of characters that is not whitespace, `=`, a quote or markup, so a
// user field keyed in any script (好感度) reads the same as a latin one.
const ATTRIBUTE_PATTERN = /([^\s="'<>/]+)\s*=\s*"([^"]*)"/g;

// Keys compared case-insensitively and stored lower-case. Every other key is kept as written: a user
// field's key is fixed when the field is created (§1.8 rule 3), and folding its case here would split
// one field from its stored values.
const CASE_FOLDED_KEYS = ['name', 'body', 'clothes', 'outfit'];

// What a value may never contain, because each one would end the record early or split it.
const FORBIDDEN_VALUE_CHARACTERS = /["<>\r\n]/g;

/**
 * Read every cast record in `text`.
 * Returns:
 *   records     — [{ name, attributes, raw }] in text order; `attributes` excludes `name`.
 *   invalid     — [{ raw, error }] for a record that cannot be read (no name).
 *   strayMarkup — exact strings the caller removes from a LIVE message (stray closers). Never part
 *                 of a record, and never reported as a record.
 */
export function readCastRecords(text) {
    const src = String(text || '');
    const records = [];
    const invalid = [];
    CAST_RECORD_PATTERN.lastIndex = 0;
    for (const match of src.matchAll(CAST_RECORD_PATTERN)) {
        const raw = match[0];
        const attributes = {};
        let name = '';
        ATTRIBUTE_PATTERN.lastIndex = 0;
        for (const pair of raw.matchAll(ATTRIBUTE_PATTERN)) {
            const written = pair[1];
            const folded = written.toLowerCase();
            const key = CASE_FOLDED_KEYS.includes(folded) ? folded : written;
            const value = pair[2].trim();
            if (key === 'name') {
                if (!name) name = value;
                continue;
            }
            // First occurrence wins, so a repeated key cannot silently replace what the record said first.
            if (!Object.prototype.hasOwnProperty.call(attributes, key)) attributes[key] = value;
        }
        if (!name) {
            invalid.push({ raw, error: 'no name= (the character a record is about)' });
            continue;
        }
        records.push({ name, attributes, raw });
    }
    CAST_CLOSER_PATTERN.lastIndex = 0;
    const strayMarkup = [...src.matchAll(CAST_CLOSER_PATTERN)].map((m) => m[0]);
    return { records, invalid, strayMarkup };
}

/**
 * Write one record as the model is asked to write it — used for the examples in instructions, so an
 * instruction never spells the syntax by hand. A character a value may not contain is dropped.
 */
export function writeCastRecord({ name, attributes = {} } = {}) {
    const clean = (value) => String(value == null ? '' : value).replace(FORBIDDEN_VALUE_CHARACTERS, '').trim();
    const parts = [`name="${clean(name)}"`];
    for (const [key, value] of Object.entries(attributes || {})) {
        if (String(key).toLowerCase() === 'name') continue;
        parts.push(`${key}="${clean(value)}"`);
    }
    return `<cast ${parts.join(' ')}>`;
}

// How to write a record, for any instruction that asks the model for one. NO EXAMPLE HERE: the
// instruction that asks for a record shows the record it wants. A placeholder attribute in a generic
// example is copied as if it were asked for (live 2026-09-26: `key="value"` here made the narrator write
// `key="ShiraishiHaruka"` on every record).
// THE LOOK VALUES ARE ENGLISH, HERE: every instruction that asks for a record carries these rules, so body= and
// clothes= are asked in English wherever they are asked — a newcomer's look and a one-off's clothes alike. A rule kept
// in one ask misses the others, and a value in the story's language reaches an image model that reads English: it
// draws the composition's English garments over it.
// How every name in model text is written: name= on a record, and char=, char2= … on a <pic>, which name the same
// people. ONE rule for both, sent inside every <reply_cast> — the narrator's (reply-cast-core) and the one a POST call
// that writes the pictures reads (imagegen readerPictureContract) — and the <pic> contract and <scene_roster> point
// here. <reply_cast> is the home because it travels with every <pic> contract and also stands alone while only looks
// are stored. A name stays in the story's own script because the registry matches it against the story's text: a
// romanized or title-welded name mints an entry nothing matches. A role ("a guard") names nobody the registry can hold.
export const NAME_RULES = `Names — name= on a record, and char=, char2= … on a <pic>, name the same people:
- copied character-for-character from the story's own text, in the story's own script: NEVER translated, romanized, transliterated, shortened, re-spelled, or with a title welded on. A Chinese/Japanese/Korean/Cyrillic name STAYS in that script. Identical spelling every time.
- a NAME, never a role or description ("the middle-aged mage", "a guard", "the waiter", "unknown", "none"): someone the story has not named takes no record and no slot, and stays scenery in a picture's composition.`;

export const CAST_RECORD_FORMAT_RULES = `Record format:
- ONE line per record, self-contained: the line ends at its own ">". NEVER write a closing tag, never wrap anything inside it.
- Attributes: those an instruction in this prompt asks for — never one you invent.
- Every value in double quotes. A value never contains a line break, a double quote, < or >.
- When a record carries body= or clothes=, those values are English danbooru tags, whatever language the story is in: they feed an image model that reads only English.`;
