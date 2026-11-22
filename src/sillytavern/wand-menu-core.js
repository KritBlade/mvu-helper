// sillytavern/wand-menu-core.js — the order of the ranked rows that end SillyTavern's wand menu. Pure; wand-menu.js
// reads the ranks and moves the rows.

/**
 * The ranked rows in the order they end the wand menu: lowest rank first, rows of one rank in the order given.
 * @template T
 * @param {T[]} rows The ranked rows in menu order, the new row last
 * @param {(row: T) => number} rankOf
 * @returns {T[]}
 */
export function wandMenuRankOrder(rows, rankOf) {
    return [...rows].sort((first, second) => rankOf(first) - rankOf(second));
}
