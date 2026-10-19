# Build, install and uninstall

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A plugin goes into the library first, and from the library onto a card. Both happen on MVU Helper's GameLogic Packs tab, same as a GameLogic Pack, since a plugin works with the game's engine.

## Get a starting point

There are 2 ways to start:

- **The template workspace.** It comes with 2 sample plugins that already work, next to a blank GameLogic Pack and the other pack types. See [The template workspace](../gamelogic_engine/install.md#the-template-workspace).
- **A blank plugin.** Development tab > Add New Blank Packs > type GameLogic Plugin, then a name, a kebab-case id and a one-line description > Create archive. You get a ZIP of a `plugin-<id>/` folder that already passes every check. Unpack it into your workspace.

The blank plugin's PRE and POST entries are empty shells with no call token yet. So nothing routes them, and install asks for no call. Add the token to the comment when you write one, or delete the ones your plugin doesn't need. The tokens are on [The plugin file](file.md#the-3-tokens).

The 2 samples in the template:

| Folder | What it shows |
| --- | --- |
| `plugin-lane-probe/` | a test harness: all 3 windows, its own dice pool, and a drawer that records what each window managed to do |
| `plugin-standalone-probe/` | the shape a standalone plugin should have: a narrate entry that only shows state, one POST entry, a resolver and a panel |

Both are standalone. Install either one, play a few replies, and read its drawer. It tells you which parts work on that card.

## Develop against a live card

1. Keep your `plugin-<id>/` folder in your workspace, `c:\dev\my-game\workspace`. Then open CMD in `c:\dev\my-game` and run `npm run dev`. It watches `workspace/`.
2. In SillyTavern: Development tab > Artifact dev loop > Watch the local dev server. The loop puts the folder together and adds it to the library.
3. The first time it applies to a card, it asks whether to install the dev workspace on that card: **Install all** or **Not here**. From then on it applies every save to it, with no reload.

How to set it up is on [Development Environment and Dev Loops](../dev_env/README.md).

**Install it once by hand.** The dev loop never picks your call bindings for you. So the first install is Install to this card on the plugin's library row, where the dialog asks you (see below). From then on, every save reuses those answers.

## Install

On the plugin's library row: Install to this card. The dialog asks for:

- **State root,** the drawer name. It's filled in from your id. Letters, digits and `_`, starting with a letter.
- **One call per phase your entries use.** Only the phases whose token you used. When exactly one call fits, it's picked for you.

Then the entries, the engine and the panel are written, the card's registry records every answer, and the plugin's empty drawer shows up in the open chat right away.

The player picks the drawer name so 2 copies of one plugin can sit side by side. Install the Weather plugin twice, as `WeatherTown` and `WeatherCity`, and each copy keeps its own weather.

The success message tells the player what they need to know:

- the interfaces the plugin matched, like `uses cast@1 → Classmate`,
- the ones it runs without,
- what happened to the card's schema, see [The schema](writing.md#the-schema),
- and where its panel is.

## Upgrade and Repair

The plugin's card row offers Upgrade when the library holds a newer version, and Repair when pieces are missing from the card.

Both reinstall from the library copy:

1. The entries the last install recorded are deleted first. So an entry you renamed can't survive under its old name.
2. The new entries are written.
3. The form opens again with the drawer name locked and the calls already picked. The player just clicks **Upgrade** or **Repair**.

The drawer can't move, because what's inside it is a live game.

An install touches no state. A version 2 that keeps new keys simply starts writing them.

An older library copy offers no button. Installing an older version is Uninstall, then Install.

## Uninstall

Uninstall asks twice. First, remove the plugin. Then, also delete its saved state?

The default keeps the state, so a reinstall picks up where it left off. Nothing outside the plugin's drawer is touched.

The plugin's schema is removed only if its own install wrote it, and the card still carries exactly that text.

## When the card changes under it

The player can rename or delete the call your entries are bound to. Then your entries route to nothing.

When that happens, every chat load warns and names the missing call, and the plugin's row gets a **Drift** pill, with a line naming the call that's gone. A **Rebind PRE call** or **Rebind POST call** button on the row rewrites your entries' comments to another call. Pick the call, then **Rebind**.

An interface the plugin uses that the game stops exposing gets the **Drift** pill too, with a line naming it. There's no Rebind for that one.

## Import someone else's plugin

- **The single file:** Import, paste the file or Load file, Validate, then Add to library.
- **The folder:** Import source folder, or Import source ZIP.

Then Install to this card. Every refusal names the rule it broke.

## Ship it

Export on the plugin's card row writes the single file from what's on the card. The call names go back to being tokens, so the file works on the next player's card too.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
