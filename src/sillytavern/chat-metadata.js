// sillytavern/chat-metadata.js — mvu-helper's OWN per-chat storage.
//
// WHY IT EXISTS: some bookkeeping is per-SAVE (this chat has already had card payload v1.2 applied)
// rather than per-card or per-machine, so neither settings scope in settings-store.js fits. The
// obvious-looking home — a key inside the card's `stat_data` — is the one place it must NOT go: that
// tree belongs to the CONSUMER, and a platform writing into it (worse, `ensurePath`-CREATING a root
// the card never declared) is the exact violation plans/platform-genre-blindness.md exists to end.
// A card's strict Zod schema is also entitled to strip a root it never declared, which would make the
// stamp vanish silently on some cards and not others.
//
// ST's `chat_metadata` is the right home: per-chat, persisted with the chat file, copied on branch,
// and completely outside any consumer's schema. Everything mvu-helper keeps there lives under ONE
// namespace key it owns, so the extension's whole footprint in a stranger's chat file is greppable.
//
// PERSISTENCE: `chat_metadata` is a live module binding ST REASSIGNS on chat load, so it is read
// fresh on every call — never cached at import time. Writes mark the chat dirty via
// saveMetadataDebounced(); a caller that is about to save the chat anyway (an MVU blob write) gets
// the stamp carried along for free, and the debounce makes the redundant save a no-op.
import { chat_metadata, updateChatMetadata } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { createModuleLog } from './log.js';

const log = createModuleLog('chat-metadata');

// The single top-level key mvu-helper owns inside chat_metadata.
export const CHAT_METADATA_NAMESPACE = 'mvuHelper';

/** This chat's mvu-helper record (a copy — mutate via writeChatRecord). `{}` when absent/unreadable. */
export function readChatRecord() {
    try {
        const rec = chat_metadata && chat_metadata[CHAT_METADATA_NAMESPACE];
        return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? { ...rec } : {};
    } catch (e) {
        log.warn('could not read the chat record (treating it as empty):', e);
        return {};
    }
}

/**
 * Merge `fields` into this chat's mvu-helper record and mark the chat for save.
 * Returns true when the write landed, false when ST's metadata API was unreachable (never throws —
 * a failed stamp must degrade to "this bookkeeping re-runs next load", not take the caller down).
 */
export function writeChatRecord(fields) {
    try {
        const next = { ...readChatRecord(), ...(fields || {}) };
        updateChatMetadata({ [CHAT_METADATA_NAMESPACE]: next });
        saveMetadataDebounced();
        return true;
    } catch (e) {
        log.warn('could not write the chat record (the work it stamps will re-run next load):', e);
        return false;
    }
}
