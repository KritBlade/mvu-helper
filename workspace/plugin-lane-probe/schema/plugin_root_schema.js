import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
// zod and lodash are available globally as `z` and `_`

/**
 * Your MVU variable name is `stat_data`, so this describes the VALUE of that variable directly.
 *
 * The platform roots are declared, and nothing else: GameLogicPlugin, the namespace every installed
 * plugin keeps its state in, and $mvuhelper, mvu-helper's own. Both are OPEN because the keys inside
 * them are chosen by someone else (one drawer per plugin, named at INSTALL time; mvu-helper's parts)
 * — a closed shape here strips them on the next write.
 *
 * THE ROOT ITSELF IS `looseObject`, and must stay that way: a plain `z.object` root drops every key
 * it was never told about, and this file names only the platform roots — so on a card where it is the
 * only schema, a strict root throws away every write into the game's own roots. Never wrap it in `.prefault({})`
 * either: mvu_zod re-wraps a root as looseObject only when it is `instanceof z.ZodObject`, and a
 * prefault is not one, so the rewrap silently does not fire.
 *
 * DO NOT add a GAME root here. A plugin that describes a game it was not written for is a plugin
 * that breaks the next card it is installed on.
 */
const StatDataSchema = z
  .looseObject({
    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
    $mvuhelper: z.record(z.string(), z.any()).prefault({}),
  });

// -------------------------
// Register — WITHOUT this call nothing above is ever used.
// -------------------------
$(() => {
  registerMvuSchema(StatDataSchema);
});
