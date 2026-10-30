// shared/serial-queue.js — runs async work ONE AT A TIME, in call order. Pure and testable on purpose: the thing it
// decides — "never let two of these overlap" — is otherwise buried in a host-coupled file no test can open (L6).
// Tested by tests/serial-queue.test.js.
//
// WHO NEEDS IT, AND WHY. Work that awaits between reading a message's state and writing it back must not overlap
// itself, or every runner reads before any of them writes and each does the whole job on stale state:
//   • the card sync — three hooks kick it on one page load (CHAT_CHANGED, MVU's init event, the initial-load retry
//     kick); unserialized, the same rows were merged three times and an event pack announced itself five times on a
//     single reload (live 2026-09-11);
//   • the character registry's store — a harvest's writes and a Roster-tab edit each read a state and save it back.
//
// SERIALIZE, DO NOT COALESCE. Each call runs, in order; none shares another's result, because callers pass different
// work (the card sync's MVU-init caller hands in the very blob MVU is about to persist). Running second is what makes
// a repeat cheap: it re-reads state the first one already wrote.
//
// A REJECTING TASK MUST NOT WEDGE THE QUEUE: the tail swallows, so the next enqueue always runs, while the caller
// still sees its own rejection.
export function createSerialQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
        const run = tail.then(task);
        tail = run.then(() => {}, () => {});
        return run;
    };
}
