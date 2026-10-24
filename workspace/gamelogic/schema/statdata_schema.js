import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
// zod and lodash are available globally as `z` and `_`

/**
 * IMPORTANT:
 * Your MVU variable name is `stat_data`.
 * Therefore the schema MUST describe the VALUE of that variable directly — every root your game
 * writes has to appear in the top-level object at the bottom of this file, or it is stripped.
 */

// -------------------------
// Base atoms
// -------------------------
const strEmpty = z.string().prefault('');
const num0 = z.coerce.number().prefault(0);
const boolFalse = z.coerce.boolean().prefault(false);

// -------------------------
// "Labeled" field helper: [value, label]
// -------------------------
const labeledStr = z.tuple([strEmpty, strEmpty]).prefault(['', '']);
const labeledNum = z.tuple([num0, strEmpty]).prefault([0, '']);
const labeledBool = z.tuple([boolFalse, strEmpty]).prefault([false, '']);

// -------------------------
// Cast (Collection) — a placeholder root. Rename it, and give it your own fields.
// -------------------------
const castMemberSchema = z
  .object({
    Name: labeledStr,
    Age: labeledStr,
    Gender: labeledStr,
    Affinity: labeledNum,
    Is_present: labeledBool,
  })
  .prefault({});

const castSchema = z.record(z.string(), castMemberSchema).prefault({});

// -------------------------
// stat_data itself
//
// LOOSE, and never `.prefault({})` on this root. `z.object` drops a key it was never told about,
// and your pack is not the only writer on the card: mvu-helper keeps $mvuhelper and GameLogicPlugin,
// a plugin names its own drawer inside GameLogicPlugin, and a later artifact may add a root of its own.
// mvu_zod does re-wrap a registered root as looseObject for that reason — but only when it is
// `instanceof z.ZodObject`, and a prefault is not one, so the rewrap silently does not fire and every
// write into a root you did not name is dropped. Declaring it loose here does not depend on the rewrap.
// Closing the root ON PURPOSE is allowed — freezing the top level so nobody can invent
// stat_data.<key> at will — but only alongside the two platform-root declarations below. Rule 7b
// warns there instead of refusing: what a lock still costs is every root that arrives LATER, and
// nothing logs the loss.
// -------------------------
const StatDataSchema = z
  .looseObject({
    Cast: castSchema,
    // The plugins' platform root. DECLARED so tooling sees it exists, OPEN because its keys belong
    // to installed plugins, which name them at install time. A strict shape here would silently
    // strip every plugin state on the next write.
    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
    // mvu-helper's own platform root: what each character wears, the character registry. OPEN because
    // mvu-helper names its parts as it grows; the leading $ keeps it out of TavernHelper's variable macros.
    $mvuhelper: z.record(z.string(), z.any()).prefault({}),
  });

// -------------------------
// Register — WITHOUT this call nothing above is ever used.
// -------------------------
$(() => {
  registerMvuSchema(StatDataSchema);
});
