# The menu engine

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](../gamelogic_engine/technical.md#a-general-design-with-one-real-example).

The menu engine is the code behind your menu. It answers 3 questions:

- **Formatters** > what does this cell show?
- **Actions** > what does this button do?
- **Inputs** > what does this button need to ask first?

It's one script, put together from the files in `engine/` in `engineOrder` order. It runs in the same locked sandbox as the game engine: no DOM, no `window`, no network. Anything it needs, it defines itself.

## What it exports

```js
const ENGINE_VERSION = 'v1.0';

module.exports = {
    ENGINE_VERSION,
    formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS },
    actions: { /* what each button does */ },
    inputs: { /* what a button asks before it runs */ },
};
```

`ENGINE_VERSION` has to be a real `const ENGINE_VERSION = '…'` line. A version written only in a comment doesn't count. MVU Helper reports it and logs it, and never compares it.

## Formatters: what a cell shows

A formatter is `(stat, root, scopePath) => value`. It works out what one cell shows:

- `root` is the whole `stat_data`.
- `scopePath` is where the cell sits. Inside a list of the cast, that's the one character the row is drawing, like `Classmate.Airi`.
- `stat` is the value at `scopePath`.

```js
formatters: {
    moneyDisplay: (stat, root) => '¥' + getV(root, 'Mainchar.Money', 0),
},
```

`getV` isn't built in. It's a small helper at the top of the file that reads a path and takes the value out of a `[value, label]` pair. The engine defines everything it uses, and the builder's starter `statusMenuLogic.cjs` comes with `getRaw`, `getV`, `getL` and `setPatch` already written.

**Formatters only read.** They work out what to show and never write anything.

Most formatters you never write by hand. You type the cell's formula in the builder, and the builder turns it into a formatter in `layoutFormatters.cjs`.

## Actions: what a button does

In the builder, an Action Button cell names an action and the arguments it sends. A list cell can carry row actions too, one button on every row. ArtificKoi's inventory list has an "⚔ Equip" button on each item.

When the player clicks, MVU Helper runs that action in your engine. An action is `(args, root) => changes`:

- `args` is what the button sent: its own arguments, plus `scopePath`, the item it sits in (`''` outside every block). A row button also sends which row it was: `listPath` and `itemKey`.
- `root` is the whole `stat_data`.
- It returns a list of changes: `{ op: 'set', path, value }` or `{ op: 'delete', path }`, with dotted paths. `setPatch(root, path, value)` builds the `set` one for you, see [Keep a pair a pair](#keep-a-pair-a-pair) below.

```js
actions: {
    // The Rest button: back to full energy.
    rest(args, root) {
        const max = getV(root, 'Mainchar.MaxEnergy', 100);
        return [setPatch(root, 'Mainchar.Energy', max)];
    },

    // A row button on any list: delete that one row.
    deleteListItem(args, root) {
        if (!getRaw(root, args.listPath + '.' + args.itemKey, null)) {
            throw new Error('"' + args.itemKey + '" is not in ' + args.listPath);
        }
        return [{ op: 'delete', path: args.listPath + '.' + args.itemKey }];
    },
},
```

**An action never writes anything itself.** It hands back the list, and MVU Helper applies it through MVU. Your schema checks every change, same as any other.

- One broken change refuses the whole action. Nothing half-applies.
- A thrown `Error` refuses the action, and MVU Helper reports its message.

**A click starts no turn.** Your GameLogic Engine doesn't run after a menu click, so nothing recalculates afterwards. An action returns every change its click means, including values that are worked out from others.

It's like a self-checkout. Nobody recounts the bill afterwards, so the machine has to get the total right by itself.

### Keep a pair a pair

If your game stores `[value, label]` pairs, write the whole pair back. A bare value over a pair is a shape change your schema refuses, and the old value stays. That's what the starter's `setPatch` is for: give it the bare value, and it carries the label over.

```js
addMoney(args, root) {
    const path = 'Mainchar.Money';
    return [setPatch(root, path, Number(getV(root, path, 0)) + (Number(args.amount) || 1))];
},
```

## Inputs: when a button has to ask first

Some buttons need a choice before they can run. Equip this sword, but on whom?

An input is `(args, root) => [{ name, kind, label, options }]`. MVU Helper asks it the moment the player clicks. The menu shows the question, a pick as a dropdown, a number as a number box, and the answer goes to the action in `args`.

ArtificKoi's `equip` asks "Give to", with everyone who has a Belongings container as the options. Cut down:

```js
inputs: {
    equip(args, root) {
        const options = [{ value: 'Mainchar', label: getV(root, 'Mainchar.Name', 'Mainchar') }];
        // ... plus every classmate who keeps Belongings
        return [{ name: 'charPath', kind: 'pick', label: 'Give to', options }];
    },
},
```

The menu never keeps its own list of who can receive what. It draws whatever your input answers, so your game's rules stay in your engine.

## The 2 engine files

| File | Owner | What it holds |
| --- | --- | --- |
| `engine/layoutFormatters.cjs` | the builder. Every layout export rewrites it | one formatter per cell formula, and the helpers they use, all inside one function. It declares ONE name, `LAYOUT_FORMATTERS` |
| `engine/statusMenuLogic.cjs` | you. The builder writes it once, as a starter | `ENGINE_VERSION`, your actions, your inputs, and `HAND_FORMATTERS`. It exports `formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS }` |

`engineOrder` is `["layoutFormatters.cjs", "statusMenuLogic.cjs"]`. The builder's file loads first, because yours uses what it defines.

The rules:

- **Never edit `layoutFormatters.cjs`.** The next export replaces it. Change the cell's formula in the builder and export again.
- **A formatter you write by hand goes in `HAND_FORMATTERS`.** A name the layout also computes is refused when the engine loads, and the error names both files. 2 formatters for one cell would leave one of them silently dead.
- **`ENGINE_VERSION` lives in `statusMenuLogic.cjs` only.** The builder's file declares none.

The 2 files run as one script. A name declared at the top of one file is visible in the next one, and the same top-level name in both files stops the whole engine from loading. That's why the builder keeps all its helpers inside one function, and declares only `LAYOUT_FORMATTERS` outside it.

That's the whole reason for 2 files. The builder rewrites its file as often as you redraw the menu, and never touches yours. You change your menu logic without touching the layout, and redraw the layout without losing your logic.

[Back to How the Status Menu Engine works](technical.md) · [Back to index](../../README.md)
