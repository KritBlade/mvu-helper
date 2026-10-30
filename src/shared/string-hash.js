// shared/string-hash.js — a small deterministic string hash, for names that must come out the same on
// every reload: a card's settings-profile key (sillytavern/settings-store.js) and the fingerprint of the
// card config a profile last imported (features/card-config).

// FNV-1a, 32-bit, written in base 36. No Math.random: one input always gives one output, so a changed
// result means a changed input. Changing this function renames every stored profile.
export function hash36(text) {
    const str = String(text);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
