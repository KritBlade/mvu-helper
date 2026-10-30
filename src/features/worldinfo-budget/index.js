// features/worldinfo-budget — SillyTavern cuts world info at a token budget and says nothing in the
// reply; this feature listens for that and names the Context Size that would have fitted.
//
// Its own feature because the cut belongs to no other one: the entries lost can be any extension's,
// any card's, or the user's own lorebook, and the fix is always a connection-preset number. Nothing
// here reads what an entry MEANS — a platform cannot know whether a dropped entry mattered (L1), so
// it reports the fact, names the entries, and leaves the judgement to the person reading it.
export { initWorldInfoBudgetWarning } from './worldinfo-budget.js';
