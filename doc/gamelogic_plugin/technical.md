# How a GameLogic Plugin works

A GameLogic Plugin is a file with up to 4 parts: prompt entries, a one-line schema, an engine and a side panel. Only the entries and the schema are required.

This page builds the Weather plugin from [What is GameLogic Plugin](README.md), one part at a time. Then it points you to the pages with the details.

## Written for any game

A plugin is general by nature. It's written once, and installed on games its author never saw. ArtificKoi shows up on these pages as a real host, because it's the first game built on MVU Helper and it publishes every interface there is. But nothing a plugin does should depend on ArtificKoi.

What a plugin can count on is only what MVU Helper itself provides: the 3 tokens, the 3 windows, the drawer, `resolveRelay`, the engine's name and `exposes`. Everything else about a game is that game's own vocabulary. Each page says which is which.

## The parts

| Part | Required | What it does |
| --- | --- | --- |
| entries | yes | Lorebook entries, what the models read: the narrator, a PRE call or a POST call |
| schema | yes | one line that keeps the plugin drawers open |
| engine | no | `resolveRelay`, code that runs once every reply, after the game is done with it |
| panel | no | one slot in MVU Helper's side panel |

A plugin has no starting state and no regexes. It creates what it keeps, when it starts keeping it. The file format is on [The plugin file](file.md).

## Example: the Weather plugin

The whole plugin is one folder with 5 files:

```
plugin-weather/
├── pack.json                  # id "weather", engineOrder ["weather.cjs"], optionalUses ["clock@1"]
├── entries/
│   ├── weather.json           # the entry's fields, with its name in "comment"
│   └── weather.txt            # the entry's text, the EJS in step 1
├── engine/
│   └── weather.cjs            # resolveRelay, step 3
└── schema/
    └── plugin_root_schema.js  # declares GameLogicPlugin open, see The schema
```

The schema file is the same one line for every plugin, see [The schema](writing.md#the-schema). The rest is below.

### 1. The entry rolls the weather and tells the narrator

The weather is just a die and a table, so it needs no LLM call at all. The entry has no call tag, so it goes straight into the narrator's prompt, for free.

An entry is 2 files with the same name in `entries/`. `weather.json` holds its fields:

```json
{
  "comment": "weather today",
  "order": 790,
  "position": "before_character_definition",
  "type": "constant",
  "enabled": true,
  "keys": []
}
```

- **`comment` is the entry's name** in the lorebook. Installed, it becomes `[GameLogicPlugin:weather] weather today`. The installer puts the prefix in front, and that's how Uninstall finds the entry later. Never write the prefix yourself.
- **No call tag in the name.** That's what sends it to the narrator. A `{PRE_CALL}` or `{POST_CALL}` in the name would send it to that call instead. Keep square brackets out of a narrator entry's name altogether. A `[name]` that matches one of the player's calls routes the entry to that call.
- **`type: "constant"`,** so it's sent every reply. A `selective` entry with no keys never shows up at all.
- **The file name is yours.** `weather.txt` and `weather.json` only have to match each other. The lorebook shows the `comment`.

`weather.txt` holds its text, the part the narrator reads:

```ejs
<%_
let _wxLine = '';
try {
    const helper = globalThis.MvuHelper || {};
    const exposes = (helper.exposes && helper.exposes()) || {};
    const sd = getvar('stat_data') || {};
    const walk = (path) => String(path || '').split('.')
        .reduce((node, key) => (node && typeof node === 'object') ? node[key] : undefined, sd);
    const unwrap = (v) => (Array.isArray(v) ? v[0] : v);
    const weatherFor = (date, die) => {
        const month = Number(date.slice(5, 7));
        const sunnyUpTo = (month >= 6 && month <= 8) ? 14 : 9;      // summer is sunnier
        return die <= sunnyUpTo ? 'Sunny' : 'Rainy';
    };

    const clock = exposes['clock@1'] ? walk(exposes['clock@1']) : null;  // where this game keeps its clock
    const today = clock ? String(unwrap(clock.Date) || '') : '';         // "2026-07-14"
    const mine = walk('{OWN_ROOT}') || {};                               // this plugin's drawer

    let weather = (today && mine.Date === today) ? mine.Today : '';      // already decided today?
    if (today && !weather) {
        const die = (helper.rollPool(1, null, 'WEATHER') || [])[0];      // one d20 from its own pool
        if (die) weather = weatherFor(today, die);
    }
    if (weather) _wxLine = 'Weather today: ' + weather + '. Write the scene in this weather.';
} catch (e) {
    globalThis.MvuHelper.log.child('weather').warn('weather entry failed:', e);
}
_%>
<%= _wxLine %>
```

In plain English:

- `{OWN_ROOT}` is a token. The installer turns it into the plugin's drawer, like `GameLogicPlugin.Weather`. The plugin can't know that name in advance, because the player picks it at install.
- It asks the card where the clock is with `MvuHelper.exposes()`, and reads today's date from it. On ArtificKoi the answer is `World`. On another game it's something else, and the entry doesn't care.
- If today's weather is already in the drawer, it uses that. If not, it rolls a die from its own pool, `WEATHER`, and picks the weather from the month.
- On a card with no clock, it prints nothing. It has nothing true to say.
- Everything sits inside `try`, and only `_wxLine` is declared at the top. That's on purpose, see [EJS in your entries](entries.md#ejs-in-your-entries).

The prompt is built more than once per reply. That's fine. A pool deals once per generation, so every build reads the same die.

On the [MVU Squad](../mvu_squad/README.md#what-pre-can-write) page, the same plugin goes through a PRE call, to show what PRE can write. That works too. But the weather is pure math, so the narrator's prompt does it for free.

### 2. The narrator writes the scene

The narrator reads "Weather today: Sunny" and writes a sunny scene. It doesn't report anything back. There's nothing to report.

### 3. `resolveRelay` saves it

The plugin's engine is a small JavaScript file, `engine/weather.cjs`, named in `engineOrder` in `pack.json`. Its `resolveRelay` runs once per reply, after the game is done with the reply:

```js
const ENGINE_VERSION = 'v1.0.0';

// the same table as the entry, so the same die gives the same weather
function weatherFor(date, die) {
    const month = Number(date.slice(5, 7));
    const sunnyUpTo = (month >= 6 && month <= 8) ? 14 : 9;
    return die <= sunnyUpTo ? 'Sunny' : 'Rainy';
}

function resolveRelay({ ownState, snapshot, dicePools, exposes, ownPointer }) {
    if (!ownState) return { patches: [], log: ['drawer missing, writing nothing'] };
    const unwrap = (v) => (Array.isArray(v) ? v[0] : v);
    const clockPath = exposes['clock@1'];
    const clock = clockPath ? clockPath.split('.')
        .reduce((node, key) => (node && typeof node === 'object') ? node[key] : undefined, snapshot) : null;
    const today = clock ? String(unwrap(clock.Date) || '') : '';

    if (!today) return { patches: [], log: ['no clock on this card, nothing to record'] };
    if (ownState.Date === today) return { patches: [], log: ['weather already set for ' + today] };

    const pool = (dicePools || []).find((p) => p.pool === 'WEATHER' && p.sides === 20);  // the die the entry rolled
    const die = pool && pool.dice[0];
    if (!die) return { patches: [], log: ['no WEATHER die this reply'] };

    const weather = weatherFor(today, die);
    return {
        patches: [
            { op: 'add', path: ownPointer + '/Date', value: today },
            { op: 'add', path: ownPointer + '/Today', value: weather },
        ],
        log: ['weather for ' + today + ': ' + weather],
    };
}

module.exports = { ENGINE_VERSION, resolveRelay };
```

In plain English:

- `exposes` holds the plugin's interfaces, already matched to this game's paths. `snapshot` is the whole game state, to read from.
- It reads the same `WEATHER` die from `dicePools`, and works out the same weather with the same table. The resolver never rolls. A die rolled after the reply is a die the narrator never saw.
- It returns patches into its own drawer. MVU Helper applies them through MVU, and the card's schema checks them like anyone else's.
- Next reply, the entry finds today's weather in the drawer and prints it. No new roll.

That's the whole plugin. One free entry, about 30 lines of code, and the game never changed.

## The 3 windows

Where an entry goes depends on a call tag in its comment:

| Window | How you ask for it | Who reads it | What it costs |
| --- | --- | --- | --- |
| narrate | no call tag | the narrator | nothing |
| PRE | `{PRE_CALL}` in the comment | the PRE call's model. Its output then reaches the narrator | one LLM call, or none when it shares the game's |
| POST | `{POST_CALL}` in the comment | the POST call's model, after the reply | one LLM call, or none when it shares the game's |

Use the narrate window for anything you can compute. Use PRE when a model's judgment is needed before the narrator writes, and POST when a model has to read the finished prose. The details are on [Entries and the 3 windows](entries.md).

## 4 ways to change the state

| Lane | What happens | How sure it is |
| --- | --- | --- |
| a request in prose | the narrator reads a request and acts on it in the story | the soft one. It needs the narrator to understand you |
| a PRE patch | the PRE model copies a block you printed | sure, once the block is in the output |
| a POST patch | the POST model copies a block you printed | sure, once the block is in the output |
| `resolveRelay` | your code runs. No model involved | always |

Put anything that must be exact in `resolveRelay`. Use the patch lanes when a model's judgment is the input. Use prose only for what has to read as story. The details are on [Writing into stat_data](writing.md).

## The technical pages

Read them in this order, or jump to the one you need:

1. [The plugin file](file.md) > the file, the folder and the 3 tokens.
2. [Build, install and uninstall](install.md) > the dev loop, the install dialog, upgrade, repair and drift.
3. [Entries and the 3 windows](entries.md) > routing, sharing the game's calls, EJS, dice and logging.
4. [Writing into stat_data](writing.md) > your drawer, the schema, and the write shapes that land on every card.
5. [The plugin engine](engine.md) > `resolveRelay`, `renderPanel` and the side panel slot.
6. [Running on any game](any_game.md) > the engine's name, `exposes`, and a card with no game at all.
7. [A real host: ArtificKoi](artifickoi.md) > what one real game offers a plugin, and its house rules.

Basically, the entries tell the models what the plugin needs, and `resolveRelay` saves what actually happened, on any game that can use it.

[Back to What is GameLogic Plugin](README.md) · [Back to index](../../README.md)
