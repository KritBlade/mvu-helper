The ONE Zod registration script - schema/ holds exactly one file, whatever its name.
It runs in the page, so z (zod) and _ (lodash) are already global; import only
registerMvuSchema, and CALL it at the end or nothing is registered and MVU silently
validates nothing. Your schema describes the VALUE of stat_data directly, so every
root your game writes must appear in it - a field the schema does not name is STRIPPED
on the next write, with no error anywhere.

Leave GameLogicPlugin and $mvuhelper declared OPEN as shipped. They are the platform
roots: installed plugins name their own keys in GameLogicPlugin at install time, and
mvu-helper keeps its own parts in $mvuhelper. A closed shape strips them on the next
write. The pack validator refuses a closed one.
