// shared/latest-reply.js — which message is the live reply, and which of its swipes is showing.
//
// Ownerless primitive (P3): the turn runner keys the resolve on it, the StatusMenu writes the live
// menu with it, and the stat box finds the reply an MVU parse builds its box in. The identity is kept
// identical to the card CALL_INJECT's computation (latest non-user chat index + that message's swipe),
// because the ENGINE's own Intent.resolvedFor stamp is written with it: a card whose stat_data was resolved
// under the baked iframe must key the same way here or its first hosted turn would read as unresolved.

export function latestAiMessageId(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user) return i;
    }
    return -1;
}

export function swipeOf(chat, mid) {
    const m = Array.isArray(chat) ? chat[mid] : null;
    return (m && m.swipe_id != null) ? m.swipe_id : 0;
}
