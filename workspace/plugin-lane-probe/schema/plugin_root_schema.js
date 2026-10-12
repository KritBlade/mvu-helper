import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
// zod and lodash are available globally as `z` and `_`

/**
 * The lane probe declares ONE root: GameLogicPlugin, the platform namespace every installed plugin
 * keeps its state in, OPEN because the keys inside it are chosen at install time.
 *
 * Rule 7 asks this of EVERY plugin, and the reason is the card the probe is NOT usually run on.
 * On School the GameLogic Pack already declares this root, so install skips this file and it costs
 * that card nothing. On a card with no pack nothing else declares it, MVU falls back to a schema
 * derived from the shape of stat_data, and that one freezes every object to the keys it held at
 * derivation — including this plugin's drawer, which is created empty, so every resolver op is
 * refused one key at a time.
 *
 * Nothing else belongs here. Every other root on whatever card this lands on passes through
 * untouched because THIS ROOT IS DECLARED LOOSE. A plain `z.object` root strips every key it was
 * never told about, and on a card whose only schema is this one that is the whole game. Never wrap
 * it in `.prefault({})`: mvu_zod re-wraps a root only when it is `instanceof z.ZodObject`, and a
 * prefault is not one, so the rewrap silently does not fire (zod 4.4.3). Declaring a GAME root here is what
 * breaks the next card the probe is installed on.
 */
const StatDataSchema = z
  .looseObject({
    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
  });

// -------------------------
// Register — WITHOUT this call nothing above is ever used.
// -------------------------
$(() => {
  registerMvuSchema(StatDataSchema);
});
