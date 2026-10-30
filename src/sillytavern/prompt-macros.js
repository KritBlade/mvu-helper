// sillytavern/prompt-macros.js — SillyTavern's macros ({{user}}, {{char}} …) expanded in a block mvu-helper writes into
// a prompt. SillyTavern expands them in the prompt it assembles, but never in a block added at
// CHAT_COMPLETION_PROMPT_READY, and a PRE/POST call's {{mvuhelper::…}} token is resolved after that call's own decode,
// so the text it inserts is read as written. Without this a model reads "{{user}}" where the user's character's name
// belongs. Only SillyTavern's substituteParams runs: a card's regex scripts are for the card's text, not mvu-helper's.
//
// Model prose (a reply, a call's output) never comes through here: it is not mvu-helper's text, and a "{{" in it is
// part of the story.
import { chatContext } from './chat-context.js';
import { createModuleLog } from './log.js';
import { substituteMacrosBlock } from './prompt-macros-core.js';

const log = createModuleLog('prompt-macros');
let hasWarnedNoEngine = false;

export function expandPromptMacros(text, caller) {
    const ctx = chatContext(caller);
    const substitute = ctx && typeof ctx.substituteParams === 'function' ? (block) => ctx.substituteParams(block) : null;
    return substituteMacrosBlock(substitute, text, {
        onMissing: () => {
            if (hasWarnedNoEngine) return;
            hasWarnedNoEngine = true;
            log.child(caller).warn("SillyTavern's substituteParams is not available — mvu-helper's prompt blocks are sent with their macros as written");
        },
        onError: (e) => log.child(caller).warn('the macros in a prompt block could not be expanded — it is sent as written:', e),
    });
}
