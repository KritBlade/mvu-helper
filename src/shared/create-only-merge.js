// shared/create-only-merge.js — seed a subtree into `stat_data` without ever overwriting a player's game.
//
// Two features share it (P3): card-sync seeds the card's `[InitVar]` tree with it, and the plugin lane
// creates each plugin's drawers under its own root (§26). It carries no artifact vocabulary at all — it
// takes two plain objects and a rule — so it belongs here rather than in either feature.
import { isPrototypeKey, deepClone } from './object-path.js';

// CREATE-ONLY AT EVERY DEPTH. An absent key is deep-cloned in; a present PLAIN OBJECT recurses (so a
// later version adding World.Weather seeds it into running games — the applyDataSync "missing container
// IS the upgrade case" semantics); any OTHER present value is NEVER touched — a keep-on-switch decision
// or an in-progress game must survive, and MVU's labelled tuples ([5000,'金錢']) are arrays, i.e.
// VALUES: cloned whole when absent, left whole when present, never merged into (the V1 lesson).
//
// Mutates statData in place (the sync-pass contract — card-sync owns persistence) and returns
// { changed, written: [dotted paths], skippedRoots: [top-level keys already complete] } — the §4a
// corollary says the rebuild log must ENUMERATE, so the report carries the names, not just a count.
//
// A prototype key is skipped at every depth. JSON.parse makes `"__proto__"` an OWN key, so
// Object.keys hands it over, and `target.__proto__` is Object.prototype — recursing into it would
// seed the card's fields onto every object in the realm. A subtree cloned in WHOLE goes through
// deepClone, which drops any `"__proto__"` nested inside it, so none is written into the save.
export function mergeInitSubtree(statData, init) {
    const out = { changed: false, written: [], skippedRoots: [] };
    if (!statData || typeof statData !== 'object' || !init || typeof init !== 'object') return out;
    const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const merge = (target, source, path) => {
        for (const key of Object.keys(source)) {
            if (isPrototypeKey(key)) continue;
            const at = path ? path + '.' + key : key;
            if (target[key] === undefined) {
                target[key] = deepClone(source[key]);
                out.written.push(at);
                out.changed = true;
            } else if (isPlain(target[key]) && isPlain(source[key])) {
                merge(target[key], source[key], at);
            }
            // present and not both plain objects → leave untouched, silently correct (§7)
        }
    };
    for (const root of Object.keys(init)) {
        if (isPrototypeKey(root)) continue;
        const before = out.written.length;
        if (statData[root] === undefined) {
            statData[root] = deepClone(init[root]);
            out.written.push(root);
            out.changed = true;
        } else if (isPlain(statData[root]) && isPlain(init[root])) {
            merge(statData[root], init[root], root);
        }
        if (out.written.length === before) out.skippedRoots.push(root);
    }
    return out;
}
