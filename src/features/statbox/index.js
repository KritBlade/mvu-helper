// features/statbox — the StatBox: a per-reply summary of the stats the card declared, written into the
// reply's own text so every reply keeps its own numbers. See devdoc/statbox-guide.md.
//
// The card-config SECTION HANDLER's statBox half (normalize/serialize/configured for `statBox`) lives in
// statbox-core.js and is read by features/card-config's registry, deliberately NOT re-exported here: this barrel
// imports the ST host, and the registry must stay host-free to be unit-testable.
//
// The box builds itself when MVU's parse of a reply ends (statbox.js), announced to the turn's one write when
// the reply arrives so that write waits for the parse; the engine's resolved-reply edit
// and the post-reply phase's end call composeStatBox to refresh it; the readers that must not see the box
// call stripStatBoxFromText.
export { isStatBoxDeclared, composeStatBox, stripStatBoxFromText } from './statbox.js';
export { statBoxProfileDefaults } from './statbox-core.js';
