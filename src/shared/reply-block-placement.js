// shared/reply-block-placement.js — where a writer puts a block it adds ABOVE something in a finished reply. Pure.
//
// The rule: the block goes directly above the first of the writer's anchors, in the order the writer lists them,
// that the text carries (at its first occurrence), with a blank line between them. With none of them in the text,
// the block goes after the text, a blank line after its last non-space character; an empty text gains no leading
// blank line. An empty block leaves the text as it is.
//
// ⚠ FUNCTION replacement, never a string one. `String.replace` expands its `$` patterns (`$&`, `$'`, `$1`, and
// `$` before a backtick) in a replacement STRING even when the search is a plain string, and a block is model- or
// engine-authored text this module never inspects: a block containing `$&` would splice a copy of the anchor into
// the reply. A function's return value is used literally.
export function placeAboveFirstAnchor(text, block, anchors) {
    const base = String(text == null ? '' : text);
    const blk = String(block == null ? '' : block);
    if (!blk) return base;
    const anchor = (Array.isArray(anchors) ? anchors : []).find((a) => a && base.includes(a));
    if (anchor) return base.replace(anchor, () => blk + '\n\n' + anchor);
    const trimmed = base.replace(/\s+$/, '');
    return trimmed ? trimmed + '\n\n' + blk : blk;
}
