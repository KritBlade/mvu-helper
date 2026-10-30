// features/pack-info — public API (P6: cross-feature imports stop here).
// The read-only install report across ALL FOUR artifact types (GameLogic Pack, GameLogic Plugin,
// StatusMenu Pack, Event Pack): what the library holds, what this card has, and where the two
// disagree. Hung on globalThis.MvuHelper by the composition root.
export { packInfo } from './pack-info.js';
