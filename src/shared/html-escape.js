// shared/html-escape.js — ownerless primitive: no host imports, no feature knowledge.
// Used by every tab that builds markup from card/user text.

/**
 * Escapes characters for safe inclusion inside HTML attribute values.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Exact inverse of escapeHtmlAttribute — recovers the original text from an attribute value
 * it produced (e.g. imagegen's data-rawtag round-trip). Entity order mirrors the escape in
 * reverse: named/numeric entities first, &amp; LAST, so "&amp;lt;" correctly yields "&lt;".
 * @param {string} value
 * @returns {string}
 */
export function unescapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
