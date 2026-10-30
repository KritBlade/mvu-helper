// imagegen/comfy-placeholder-core.js — PURE: whether SillyTavern's ComfyUI custom placeholder for the bust
// multiplier needs seeding, and which entry is the seeded one to remove. No ST imports (tested by
// tests/comfy-placeholder-core.test.js); the writes live in comfy-placeholder-seed.js, driven by the
// "Send bust multiplier to the backend" checkbox.
//
// WHY A SEED AT ALL: the bust multiplier hands its value to the workflow through a ST chat variable
// (image-gen.js applyBustStrength, `/setvar key=<name> <value>`). The workflow can only read it through a
// custom placeholder in SillyTavern's ComfyUI Workflow Editor: find `<name>`, replace `{{getvar::<name>}}`.
// Every user had to type that entry by hand, and a missing one fails silently — the workflow keeps the
// literal "%<name>%" and the LoRA does nothing.
//
// HOW SILLYTAVERN STORES IT (public/scripts/extensions/stable-diffusion/index.js): one GLOBAL list,
// extension_settings.sd.comfy_placeholders = [{ find, replace }], shared by every workflow. At each /sd call
// it replaces `"%<find>%"` with JSON.stringify(substituteParams(replace)) — a quoted string, which is why
// the workflow input must be a typed FLOAT. The match on `find` is exact and case-sensitive, so this one is.

// The entry the bust multiplier needs for variable `variableName`, or null when the name is blank.
export function bustPlaceholderFor(variableName) {
    const name = String(variableName || '').trim();
    return name ? { find: name, replace: `{{getvar::${name}}}` } : null;
}

// What to do about SillyTavern's placeholder list `placeholders` for variable `variableName`. Returns
// { action, entry, existing }:
//   'skip'     the name is blank — nothing to seed
//   'present'  an entry with this find and the expected replace is already there
//   'differs'  an entry with this find holds another replace — the user's own; never overwritten
//   'add'      no entry with this find — `entry` is the one to append
// A list that is missing or not an array reads as empty: SillyTavern creates it on its own first "+".
export function planBustPlaceholderSeed(placeholders, variableName) {
    const entry = bustPlaceholderFor(variableName);
    if (!entry) return { action: 'skip', entry: null, existing: null };
    const list = Array.isArray(placeholders) ? placeholders : [];
    const existing = list.find((ph) => ph && typeof ph === 'object' && String(ph.find) === entry.find) || null;
    if (!existing) return { action: 'add', entry, existing: null };
    return { action: String(existing.replace) === entry.replace ? 'present' : 'differs', entry, existing };
}

// The indexes in `placeholders` of the entry the bust multiplier seeds for `variableName`, highest first so
// they can be spliced out in order. Only an exact copy counts — same find AND same replace — so an entry
// the user wrote under that find with a replace of their own is never removed. [] when there is none.
export function seededBustPlaceholderIndexes(placeholders, variableName) {
    const entry = bustPlaceholderFor(variableName);
    if (!entry || !Array.isArray(placeholders)) return [];
    const found = [];
    placeholders.forEach((ph, i) => {
        if (ph && typeof ph === 'object' && String(ph.find) === entry.find && String(ph.replace) === entry.replace) found.push(i);
    });
    return found.reverse();
}
