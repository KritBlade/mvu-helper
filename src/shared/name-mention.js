// shared/name-mention.js — ownerless primitive: is a person's name written in a text. One rule wherever a
// name is looked for in story text or a picture's composition, so a name counts the same way everywhere.

// Is `name` written in `text`? A name in Latin letters (spaces, hyphens, apostrophes and periods allowed) counts only
// as a whole word, with no Latin letter or digit touching either end. A name in any other script counts wherever it
// appears, because those scripts put no space between words. A name with no letter at all is never found. Case is
// ignored. PURE.
const LATIN_NAME = /^(?=.*\p{Script=Latin})[\p{Script=Latin}\p{N} .'’-]+$/u;
export function mentionsName(text, name) {
    const wanted = String(name || '').trim();
    if (!/\p{L}/u.test(wanted)) return false;
    const haystack = String(text || '');
    if (!LATIN_NAME.test(wanted)) return haystack.toLowerCase().includes(wanted.toLowerCase());
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escaped}(?![\\p{Script=Latin}\\p{N}])`, 'iu').test(haystack);
}
