// features/card-config — the [Initmvuhelper] carry: a card ships its own mvu-helper setup in a
// lorebook entry, the extension imports it when the card is first opened and again whenever the entry
// changes, and the Main tab exports it back.
//
// It is its own feature rather than part of small-llm because the config is not one feature's: the
// section registry decides what EVERY tab may carry inside a card, and the rules for what may travel
// (card-owned / card-seeded / never-travels) are the same everywhere.
export { exportCardConfig, importCardConfig, resetCardConfig } from './card-config.js';
