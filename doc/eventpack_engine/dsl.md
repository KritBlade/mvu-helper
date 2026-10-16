# The condition language

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [Written for any game](technical.md#written-for-any-game).

Every condition in an event pack is written in one small language, the WHEN-DSL. `Wkd=Saturday & T>=10:00 & Aff(Mitsuki)>=40` is one.

The builder writes it for you, so most people never type it. This page is what's behind the GUI: how each condition is read, how the engine checks it, and how to write one by hand.

## The shape

A condition string is a list of tokens joined by ` & `. All of them must hold.

```
Wkd=Saturday & T>=10:00 & Aff(Mitsuki)>=40
```

That's 3 tokens: it's Saturday, AND it's 10:00 or later, AND Mitsuki's affection is 40 or more.

A row has 3 places for condition strings:

| Field | Shape | Means |
| --- | --- | --- |
| `prereq` | one string | is the event on the table. AND only |
| `when` | one string | is this the moment |
| `whenAny` | a list of strings | is this the moment, with OR. Any one string is enough |

An empty string, or `-`, means no condition: always true.

## Every token

| Token | Example | True when |
| --- | --- | --- |
| compare | `Aff(Mitsuki)>=40` · `T>=16:00` · `Loc=School_Classroom` | the left side compared with the right side holds. Operators: `>=` `<=` `>` `<` `=` `==` |
| in set | `Wkd in {Saturday,Sunday}` | the left side equals any value in the set |
| Present | `Present(Mitsuki)` | that character is in the scene right now |
| flag | `flag:paulk_beach_arc_invite` | that event has fired |
| contains | `contains(Classmate.*.Mood, "Excited")` | the value holds this text. Case-sensitive |
| has | `has(Mainchar.Inventory, "camera")` | the collection holds this entry |
| `!` | `!Present(Mitsuki)` | NOT. Flips one token |

`=` and `==` are the same thing. A `*` in a path means "any entry", see [Wildcards](#wildcards).

## The left side: what a name means

The left side of a compare, an `in`, a `contains` or a `has` is a name the engine has to turn into a value. It tries 5 things, in this order:

1. **`DaysSince(<path>)`**, the library's own. Whole game days since the clock stamp stored at that path.
2. **A shortcut your game declares.** `Aff(Mitsuki)` is ArtificKoi's spelling of `Classmate.Mitsuki.Affection`.
3. **A computed value your game declares.** A party size, a count. Optional, and ArtificKoi has none.
4. **A raw path** into `stat_data`, like `Mainchar.Money`. No `stat_data.` in front.
5. **Anything else** is the text itself.

A `[value, label]` pair is unwrapped on the way, so `Mainchar.Money` reads the money, not the pair.

**The shortcuts are just spellings.** You can always write the raw path instead. `Aff(Mitsuki)>=40` and `Classmate.Mitsuki.Affection>=40` are the same condition.

ArtificKoi's shortcuts:

| Shortcut | Stands for |
| --- | --- |
| `Date` | `EngineDerived.DayDate`, the game day being played |
| `Wkd` | `World.Weekday` |
| `T` | `World.Time` |
| `Mode` | `EngineDerived.Mode` |
| `Loc` | `World.Location` |
| `Grade` | `EngineDerived.Grade` |
| `Loop` | `EngineDerived.ArcLoop` |
| `MC.*` | `Mainchar.*` |
| `Aff(*)` | `Classmate.*.Affection` |
| `Stage(*)` | `Classmate.*.RelationshipStage` |
| `Trait(*).*` | `Classmate.*.*` |
| `Quest(*).Step` | `Mainchar.Quests.*.Step` |
| `SpineDone(*)` | `EventSpine.fired.*.Status` |

A `*` in a shortcut is the part you fill in. `Trait(Mitsuki).Mood` becomes `Classmate.Mitsuki.Mood`.

## How a compare works

**A number on the right means a number compare.** `Aff(Mitsuki)>=40` compares numbers. A number is digits, with an optional `-` and decimals.

**Anything else on the right means a text compare.** That's why `T>=16:00` works: times like `09:30` and `16:00`, and dates like `2026-04-11`, sort correctly as text.

**A name that doesn't exist never errors, but it's not simply false either.** In a number compare it reads as 0. In a text compare it reads as its own text. So `Unknown>=1` never holds, and `Unknown<=3` ALWAYS holds. That's why the builder warns about a path the card doesn't declare.

It's like a form with a blank box. The clerk doesn't send it back. They just read the blank as zero, and carry on.

## Wildcards

A `*` in a path is "any entry" of a collection. `Classmate.*.Mood` is every classmate's mood.

- A token with a `*` holds when AT LEAST ONE entry matches. `contains(Classmate.*.Mood, "Excited")` is true when any classmate is excited.
- **Zero entries is false, never true.** An event must not fire in an empty room.
- A `[value, label]` pair is a value, not a collection. A `*` never walks into one.

## contains and has

**`contains(<path>, "<text>")`** holds when the value has that text in it. Case-sensitive: `"excited"` doesn't match `Excited`.

**`has(<path>, "<entry>")`** holds when the collection has that entry:

- on a record, it looks at the KEYS. `has(Classmate, "Mitsuki")` is true when `Classmate.Mitsuki` exists.
- on a list, it looks at the VALUES. `has(Mainchar.Tags, "rich")` is true when the list has `rich` in it.

The text always goes in double quotes. Inside the quotes, write `\"` for a quote and `\\` for a backslash. Commas and parentheses are fine as they are.

**`has` vs `Present`.** `has(Classmate, "Mitsuki")` asks if she exists at all, like after a transfer student event added her. `Present(Mitsuki)` asks if she's in the scene right now. Being on the roster usually goes in `prereq`. Being in the scene usually goes in `when`.

**`in` is for values, not collections.** `Classmate in {Mitsuki}` can never be true, because `Classmate` is a collection. Membership is `has`.

## Present

`Present(<key>)` holds when that character is in the scene. The game declares which field says so. ArtificKoi's is `Classmate.<key>.Is_present`, and it has to be `true`.

It takes the KEY the character is stored under, never the display name. `Present(Mitsuki)` works. `Present(Mitsuki Tachibana)` never fires.

## flag

`flag:<key>` holds when that event has fired. It reads the done-marker at `EventPack.fired.<key>`, which the engine writes itself and never deletes.

That's how a series chains, and how one pack can wait on another, without reading a single game variable. `flag:<key>=<state>` checks a different state, but the format only ever writes `done`, so you never need it.

## DaysSince

`DaysSince(<path>)` is a number: whole game days from the clock stamp stored at that path, to the day being played.

A cooldown reads the done-marker's own stamp:

```
flag:paulk_beach_arc_invite & DaysSince(EventPack.fired.paulk_beach_arc_invite.at)>=1
```

That makes step 2 wait for the next game day after step 1. Never read a stamp on a record a step wrote, like a quest's `LastUpdated`. The record can be deleted, and the stamp goes with it.

- **An empty stamp reads as never.** A `>=N` cooldown opens, and a `<=N` "recently" check stays shut.
- **A path that exists nowhere also reads as never,** and the engine warns. So put `DaysSince` AFTER the token that proves the record exists, like the `flag:` above.

What a game day is belongs to the game. ArtificKoi's day doesn't change at midnight, so its engine works the days out itself.

## OR

`prereq` and `when` are AND only. For OR, give the row `whenAny` instead of `when`:

```json
"whenAny": [
  "Aff(Mitsuki)>=30",
  "has(Mainchar.Inventory, \"camera\") & T>=10:00"
]
```

Any one string holding is enough. Inside each string, it's still AND. So this reads: Mitsuki's affection is 30 or more, OR you carry a camera and it's 10:00 or later.

That's the whole OR. One level, no brackets, no precedence to learn. Every condition you'll ever need can be written this way.

A row can't have both `when` and `whenAny`. MVU Helper refuses it.

## Spelling rules

The engine reads `A>=1`, `A >= 1` and `  A >= 1 ` the same. But the builder always writes one spelling:

- no spaces around an operator: `T>=16:00`,
- one space each side of `&`: `Loc=Beach & Present(Mitsuki)`,
- `flag:<key>`, without `=done`,
- `in` sets without spaces: `Wkd in {Saturday,Sunday}`.

Some values can't be spelled at all, because they would break the token:

| Can't contain | Where | Because |
| --- | --- | --- |
| `&` | anywhere | it splits the token in 2 |
| a leading `!` | any value | it reads as NOT |
| `<` `>` `=` | either side of a compare, or a left side | it reads as a second operator |
| `{` `}` `(` `)` | the right side of a compare | it reads as another token shape |
| `,` `{` `}` | an item in an `in` set | it splits or closes the set |
| `(` `)` | a `Present()` name | it closes the brackets |
| a line break | anywhere | a token is one line |

`!!` isn't allowed either. Write the token without any `!`.

**A token can parse fine and still be one the builder can't write back.** Load that pack into the builder, and Generate refuses it. So stick to the spellings on this page.

## When a token doesn't parse

A token that doesn't parse is false. Always.

Even with a `!` in front, it stays false. A typo can only ever keep an event shut, never open one by accident. MVU Helper warns about a token's shape at install, so you hear about it before it happens.

What MVU Helper can't check is whether a name means something in your game. `Aff(Mitsukii)` parses fine. It just never fires.

## Examples

| Condition | Reads as |
| --- | --- |
| `T>=16:00 & Loc=School_Classroom` | after 16:00, in the classroom |
| `Wkd in {Saturday,Sunday} & Aff(Mitsuki)>=40` | a weekend, and Mitsuki's affection is 40 or more |
| `Present(Mitsuki) & !Present(Airi)` | Mitsuki is here, and Airi isn't |
| `Mainchar.Money>=500` | you have 500 or more, read straight off the raw path |
| `flag:paulk_beach_arc_invite` | the invite already fired |
| `has(Classmate, "Mitsuki") & Stage(Mitsuki)=Friend` | Mitsuki exists, and her stage is Friend |
| `contains(Classmate.*.Mood, "Excited")` | any classmate is excited |
| `flag:paulk_beach_arc_invite & DaysSince(EventPack.fired.paulk_beach_arc_invite.at)>=1` | the invite fired at least a game day ago |

## The same grammar in 3 places

The engine checks these conditions, MVU Helper checks their shape at install, and the builder reads and writes them in the GUI. So the grammar is copied into all 3, and kept identical. Which files, and how they stay in sync, is on [Why the grammar lives in 3 places](technical.md#why-the-grammar-lives-in-3-places).

[Back to How the EventPack Engine works](technical.md) · [Back to index](../../README.md)
