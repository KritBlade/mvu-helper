# RETIRED — the workaround register

**This register is retired. mvu-helper is working around nothing.** It held one entry, for MVU
overwriting a reply from a pre-splice snapshot; that shipped upstream and both the entry and the
stand-in code are gone. Nothing in `src/` compensates for another module today:

```
grep -rn "OUTSTANDING-BUG-" src/ tests/     # no matches — this is the proof, re-run it
```

Kept, renamed, for the protocol below. A workaround is a debt, and the debt needs a written way to
pay it off the moment one is taken on again — do not re-invent this, reopen it.

---

## The protocol, for whoever needs it next

Every entry here is a defect in **someone else's** module that mvu-helper is compensating for. That
is a violation of the house rule — a module fixes bugs where they hurt, and surfaces everyone else's
instead of repairing them (`CLAUDE.md` L7 and its "say it, don't fix it" corollary) — so each entry
is a debt with a written-down way to pay it off.

**One section per workaround.** Every section names the upstream report, the exact files that carry
the stand-in, and the removal checklist. When the upstream fix ships, delete the workaround AND
delete the section — this file shrinks, it never accumulates history. An entry with no upstream
report filed is not allowed: if it is worth working around, it is worth reporting.

**Every workaround site carries a marker, and the marker is a two-way link.** Section *n* is
`OUTSTANDING-BUG-<n>`, written in a comment at every site that implements it, so the grep above finds
every stand-in from the code side and this file explains them from the other.

**Touching a marked area obliges you to update this file in the SAME pass** — both the section's file
table and its removal checklist. This is not tidiness. This file is the only map back out of code
that is deliberately wrong, and the map is followed by someone who was not here when it was drawn: a
checklist that no longer matches the code cannot be executed, so the workaround stops being
removable and quietly becomes the design. The marker in the code is what tells that person this file
exists at all; if you add a site without one, it will be left behind when the rest is deleted.

**A DETECTOR IS NOT A WORKAROUND, and never belongs here.** Code that reports a foreign module's
defect is the corollary working as intended — it stays after the upstream fix ships, because the
shape it catches belongs to any module that repeats it. Only code that *stands in* for a defect is a
debt. `auditRenderedImages` is the live example: it survived its section's deletion, on purpose.

**Taking on a new workaround un-retires this file.** Rename it back to `outstanding-bug.md`, open
`## §1`, and mark the sites.
