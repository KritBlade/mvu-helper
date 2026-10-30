// features/reply-redraw — one write per finished reply per turn. Every stage that edits a finished reply
// hands the edit over with redrawReply (or saveRedrawnReply for an edit outside the text), and a stage whose
// edit is still being made when the turn ends announces it first (announceReplyEdit). The post-reply phase
// opens the reply's record when the reply arrives, marks it when the phase reaches its end
// (noteReplyRedrawEnding) and closes it when it ends, and the close writes once. A reader that would redraw
// something inside a reply whose write is due waits for that write (isReplyWriteDue, dueReplyWriteEnded).
// Other extensions' edits join the same write (devdoc/reply-redraw-api.md).
// See reply-redraw.js and devdoc/editing-a-finished-reply.md.
export {
    openReplyRedraw, redrawReply, saveRedrawnReply, announceReplyEdit, isReplyRedrawLive, noteReplyRedrawEnding, closeReplyRedraw,
    isReplyWriteDue, dueReplyWriteEnded,
} from './reply-redraw.js';
