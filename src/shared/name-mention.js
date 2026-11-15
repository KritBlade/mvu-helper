// shared/name-mention.js — ownerless primitive: is a person's name written in a text. One rule wherever a
// name is looked for in story text or a picture's composition, so a name counts the same way everywhere.

// The rule, as a pattern: a name in Latin letters (spaces, hyphens, apostrophes and periods allowed) counts only as a
// whole word, with no Latin letter or digit touching either end. A name in any other script counts wherever it
// appears, because those scripts put no space between words. Case is ignored. A name with no letter at all has no
// pattern (null). `flags` are added to the pattern's own 'iu' — 'g' for a caller that replaces every mention. PURE.
const LATIN_NAME = /^(?=.*\p{Script=Latin})[\p{Script=Latin}\p{N} .'’-]+$/u;
export function nameMentionPattern(name, flags = '') {
    const wanted = String(name || '').trim();
    if (!/\p{L}/u.test(wanted)) return null;
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!LATIN_NAME.test(wanted)) return new RegExp(escaped, `iu${flags}`);
    return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escaped}(?![\\p{Script=Latin}\\p{N}])`, `iu${flags}`);
}

// Is `name` written in `text`? By the rule above; a name with no letter is never found. PURE.
export function mentionsName(text, name) {
    const pattern = nameMentionPattern(name);
    return pattern ? pattern.test(String(text || '')) : false;
}
