# Regex

Your pack's regexes are Tavern Helper regex objects, installed on the card. A GameLogic regex hides or restyles text. That's all it's allowed to do.

## An example from ArtificKoi

ArtificKoi's `MinimizeUpdateVar` folds the narrator's `<UpdateVariable>` block into a small "Narrate Update Variables" button on screen, so the player isn't staring at JSON:

```json
{
  "script_name": "MinimizeUpdateVar",
  "find_regex": "/<UpdateVariable>((?:(?!<UpdateVariable>)[\\s\\S])*?)<\\/UpdateVariable>/gm",
  "replace_string": "<details class=\"uv\"><summary>✨ Narrate Update Variables</summary><pre>$1</pre></details>",
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": true, "prompt": false }
}
```

(The real `replace_string` carries inline styles too.) `destination.display: true` with `prompt: false` means it only changes what the player sees. The model still reads the original.

## The rules

- **`script_name` is the regex's identity.** Required, and unique within the pack. Install, Upgrade and Uninstall find a regex by it.
- **`find_regex` is required.** One that doesn't compile the way SillyTavern reads it is warned.
- **No documents.** A `replace_string` containing `html>`, `<head>` or `<body` would make Tavern Helper render a whole web page, with full access to your SillyTavern page. So the pack is refused. Styling markup like `<div>`, `<details>` or `<span style>` is fine, like the example above. If you really need a page, ship it in a StatusMenu Pack, whose install moves it into a locked frame. See [What is Status Menu Engine](../statusmenu_engine/README.md).
- **Set every `source` flag you need.** A regex without `source.ai_output: true` never runs on the narrator's replies.

## Regexes that change what the model reads

`destination.prompt: true` rewrites what the MODEL reads, not just the screen. Declare `prompt_rewrite_intended: true` on such a regex, or it's warned.

ArtificKoi's `PromptDeTagRESVariable` is one of these. It removes the engine's receipts from the prompt, so the narrator never sees them and never copies them into its own reply:

```json
{
  "script_name": "PromptDeTagRESVariable",
  "find_regex": "/<(RES_Variable|RES_POST_Variable)>(?:(?!<\\1>)[\\s\\S])*?<\\/\\1>\\n?/g",
  "replace_string": "",
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": false, "prompt": true },
  "prompt_rewrite_intended": true
}
```

## The order

`regex/regex-order.json` lists every `script_name` in your pack exactly once, in the order they apply. It becomes `regexOrder`.

Order matters, because each regex works on what the one before it produced. Like an assembly line, every station gets what the previous station handed over.

It only orders your pack's own regexes.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
