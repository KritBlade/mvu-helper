// shared/rendered-region.js — every user-facing region mvu-helper draws SAYS where it begins and
// ends, so other code can find it instead of guessing.
//
// WHY. Extensions that reshape a rendered reply have to decide which part of it is theirs. Two in
// live use decide it by inference: one walks `.mes_text` backwards from `lastChild` crediting text
// length until the numbers add up, another lifts prose with `$('.mes_text').text()`. Neither can see
// where our content starts, so both approximate it — and an approximation off by one node hides the
// menu or swallows its source into someone else's prose. Nothing here BLOCKS either of them. It
// publishes the boundary they are already guessing at. Moving our region, hiding it or skipping it
// all become one selector; none of them need to be right about anything else.
//
// WHAT COUNTS AS A REGION. Anything user-facing this extension draws, wherever it lands: the status
// menu inside `.mes_text`, and the side panel and its toggle, which mount as direct children of
// `<body>`. Two entry points, chosen by how the content REACHES the page rather than by where it
// ends up — `wrapRenderedRegion` for what we emit as markdown, `applyRegionAttributes` for what we
// build in the DOM. Both publish the same names.
//
// TWO STAGES NEED TWO MARKERS, because neither marker survives the other's stage.
//
//   TEXT — the raw message string, before SillyTavern renders it. Readers: anything consuming
//   `chat[i].mes` (the galgame script's primary path does), and any card-scoped regex ordered after
//   ours. The marker is an HTML COMMENT PAIR. Comments are the right shape here precisely BECAUSE
//   DOMPurify drops them at render (its default tag allowance is `['#text']`, so `#comment` is
//   force-removed): they are legible to the whole text chain and leave no residue in the DOM.
//
//   DOM — after render. The comment pair is gone by then, and a start/end pair would be the wrong
//   shape anyway: the DOM is a tree, so anything wrapping a span that crosses one marker leaves the
//   halves in different parents with no way back to each other. That is the exact failure this whole
//   contract exists to answer. A CONTAINER cannot be half-matched, and it is the only shape that
//   makes "move our region" a single atomic operation.
//
// THE REGION IS ALSO THE LIFT BOUNDARY. A regex row that carries a fenced document inside this
// wrapper is what the StatusMenu lane lifts apart at install (plans/executed/statusmenu-containment.md M1/M2):
// `unwrapRenderedRegion` takes the ONE fence out, the document goes to a silent worldbook entry, and
// the row written to the card keeps the container and the marker pair with NO fence. TavernHelper
// renders every `<pre>` whose text carries one of `isTavernHelperFrontendText`'s tokens; a row with no
// fence makes no `<pre>`, so nothing renders uncontained, and mvu-helper mounts its own sandboxed
// frame into the container instead. Measured through SillyTavern's own sanitizer: DOMPurify keeps
// `class` and `data-*` (ALLOW_DATA_ATTR defaults true, and SillyTavern passes no tag override), so the
// container and its attributes are what survive to the DOM and what the mount finds.
//
// THE NAMES ARE A PUBLISHED CONTRACT. Other extensions are meant to match on them, so they cannot
// drift after release the way an internal constant can.

// The attribute carries the region's NAME, so a reader can target one kind of region or all of them.
// The class carries no information the attribute lacks — it exists because a CSS author reaching for
// a class is not going to be talked out of it, and a second spelling of the same boundary is better
// than a hand-rolled third.
export const REGION_ATTRIBUTE = 'data-mvu-helper';
export const REGION_CLASS = 'mvu-helper-region';

// The instruction, carried in BOTH stages because neither marker survives the other's.
//
// An extension author debugging this is looking at devtools, where the comments below are already
// gone — so the container states its own terms in an attribute that survives sanitize. The comment
// says the same thing at length for whoever is reading the raw message or our regex row instead.
//
// Both are prose, deliberately kept OUT of the machine tokens above: those are matched by strangers
// and must never change, while this wording can be improved without breaking anyone's grep.
export const REGION_CONTRACT_ATTRIBUTE = 'data-mvu-helper-contract';
export const REGION_CONTRACT_NOTE = 'move or hide this element whole - do not walk into it';

// Region names are matched by strangers in selectors and regexes, so they stay to the character set
// that is safe in both without quoting or escaping.
const REGION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Throws rather than coercing: a malformed name compiles to a selector that silently matches nothing,
// which is the failure mode this whole file exists to remove. Composition happens at module load and
// in tests, so a throw surfaces immediately and never reaches a rendered message.
function assertRegionName(regionName) {
    // typeof first: String(null) is the perfectly valid-looking name `null`, and a region called
    // null is a boundary nobody meant to publish.
    if (typeof regionName !== 'string' || !REGION_NAME_PATTERN.test(regionName)) {
        throw new TypeError(`rendered-region: region name must match ${REGION_NAME_PATTERN} — got ${JSON.stringify(regionName)}`);
    }
}

// The selector a reader uses to find our region — one kind by name, or every region when called with
// no name. Published so nobody has to reconstruct it from the two constants above.
export function regionSelector(regionName) {
    if (regionName === undefined) return `[${REGION_ATTRIBUTE}]`;
    assertRegionName(regionName);
    return `[${REGION_ATTRIBUTE}="${regionName}"]`;
}

// The same boundary, put on an element we BUILD instead of one we emit as markdown — the side panel
// and its toggle, both of which mount as direct children of `<body>`.
//
// Only the attributes carry over, and that is not an omission. The comment pair exists to be legible
// at the TEXT stage; an element constructed in JavaScript never has one, so a comment beside it would
// reach no reader the attributes do not already reach.
//
// Duck-typed on `setAttribute` rather than `instanceof Element`, so the decision stays testable
// without a DOM (L6) and this file stays free of host coupling. `classList` is feature-detected for
// the same reason — and added to rather than assigned, so it never clobbers a caller's own classes.
export function applyRegionAttributes(element, regionName) {
    assertRegionName(regionName);
    if (!element || typeof element.setAttribute !== 'function') {
        throw new TypeError('rendered-region: applyRegionAttributes needs an element with setAttribute');
    }
    element.setAttribute(REGION_ATTRIBUTE, regionName);
    element.setAttribute(REGION_CONTRACT_ATTRIBUTE, REGION_CONTRACT_NOTE);
    if (element.classList && typeof element.classList.add === 'function') {
        element.classList.add(REGION_CLASS);
    }
    return element;
}

// The TEXT-stage pair. Greppable as a literal string, and symmetrical so a reader can cut the region
// out with one non-greedy match between them.
export function textRegionBegin(regionName) {
    assertRegionName(regionName);
    return `<!-- mvu-helper:begin ${regionName} -->`;
}

export function textRegionEnd(regionName) {
    assertRegionName(regionName);
    return `<!-- mvu-helper:end ${regionName} -->`;
}

// Spelled out for a human who has just found this in a raw message and wants to know what to do
// about it. Names the selector so nobody has to reconstruct it from the attribute.
const CONTRACT_COMMENT = `<!-- mvu-helper: this region is drawn by the mvu-helper extension. To move,
     hide or skip it, match [${REGION_ATTRIBUTE}] and take the whole element. Please do not infer our
     boundary by walking the DOM - that is what this marker exists to spare you. -->`;

// Extra container attributes are `data-*` only — the one namespace DOMPurify keeps without a tag
// override — and the value is escaped, so a pack id can never close the attribute or the tag.
const EXTRA_ATTRIBUTE_PATTERN = /^data-[a-z][a-z0-9-]*$/;
function extraAttributeText(extraAttributes) {
    if (extraAttributes == null) return '';
    return Object.entries(extraAttributes).map(([name, value]) => {
        if (!EXTRA_ATTRIBUTE_PATTERN.test(name)) {
            throw new TypeError(`rendered-region: extra attribute name must match ${EXTRA_ATTRIBUTE_PATTERN} — got ${JSON.stringify(name)}`);
        }
        const escaped = String(value == null ? '' : value).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
        return ` ${name}="${escaped}"`;
    }).join('');
}

// Composes both markers around a region's markdown body.
//
// The blank lines are load-bearing, not formatting. Markdown treats a raw block-level tag as an HTML
// block that runs to the next blank line; without them a fenced body risks being absorbed into that
// block instead of becoming a `<pre>`.
//
// The comment pair sits INSIDE the container so that removing the container removes the region
// whole, with nothing of ours left behind at either stage.
//
// `extraAttributes` ({ 'data-x': value }) land on the container: the StatusMenu lane's marker-form
// row names the pack it was lifted from this way, so the frame mount can find the region by attribute.
export function wrapRenderedRegion(regionName, body, extraAttributes) {
    assertRegionName(regionName);
    return [
        `<div class="${REGION_CLASS}" ${REGION_ATTRIBUTE}="${regionName}" ${REGION_CONTRACT_ATTRIBUTE}="${REGION_CONTRACT_NOTE}"${extraAttributeText(extraAttributes)}>`,
        '',
        textRegionBegin(regionName),
        CONTRACT_COMMENT,
        '',
        String(body == null ? '' : body),
        '',
        textRegionEnd(regionName),
        '',
        '</div>',
    ].join('\n');
}

// ── the inverse: the ONE fence out of a wrapped row ──────────────────────────

// HTML comments are the only thing allowed beside the markers and the fence — the contract comment
// above, and whatever a builder adds in the same spirit.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const onlyCommentsAndSpace = (text) => /^\s*$/.test(String(text).replace(HTML_COMMENT, ''));

// The inverse of `wrapRenderedRegion`, accepting exactly the shape it (and the builder that vendors
// it) emits: the container, the begin marker, comments, ONE fenced block, the end marker, `</div>`.
//
// Returns { body, problem }: `body` is the fence's content byte for byte, or null with `problem`
// naming the violation. The fence is the unit — not `<html>`, not a document: what TavernHelper
// renders is the `<pre>` a fence becomes, so what leaves the row is the fence, whatever it holds.
// A `</html>` inside the document's own script therefore stays inside the body.
//
// Strict on purpose. Two fences, text outside the fence, a second marker pair, anything past the
// container close — each is refused rather than guessed at, because the row this decides about is
// written to a card where TavernHelper renders anything the guess left behind (M2 refuses the install
// on `problem`; a bare marker-form row with no fence is a `problem` too, and its caller knows why).
export function unwrapRenderedRegion(text, regionName) {
    assertRegionName(regionName);
    const s = String(text == null ? '' : text);
    const begin = textRegionBegin(regionName);
    const end = textRegionEnd(regionName);
    const b = s.indexOf(begin);
    const e = b === -1 ? -1 : s.indexOf(end, b + begin.length);
    if (b === -1 || e === -1) return { body: null, problem: `no "${regionName}" marker pair` };
    if (s.indexOf(begin, b + begin.length) !== -1 || s.indexOf(end, e + end.length) !== -1) {
        return { body: null, problem: `more than one "${regionName}" marker pair` };
    }

    const containerOpen = new RegExp(`^\\s*<div\\b[^>]*\\s${REGION_ATTRIBUTE}="${regionName}"[^>]*>\\s*$`);
    if (!containerOpen.test(s.slice(0, b).replace(HTML_COMMENT, ''))) {
        return { body: null, problem: 'the text before the begin marker is not the region container' };
    }
    if (!/^\s*<\/div>\s*$/.test(s.slice(e + end.length).replace(HTML_COMMENT, ''))) {
        return { body: null, problem: 'text after the end marker other than the container close' };
    }

    // Fence lines at column 0 — where the wrapper and the builder put them. Counted, not searched:
    // a second fenced block is a second thing TavernHelper would render, and it is refused, not merged.
    const lines = s.slice(b + begin.length, e).split('\n');
    const fenceAt = [];
    lines.forEach((line, i) => { if (line.startsWith('```')) fenceAt.push(i); });
    if (fenceAt.length !== 2) {
        return { body: null, problem: `expected exactly one fenced block between the markers, found ${fenceAt.length} fence line(s)` };
    }
    const [open, close] = fenceAt;
    if (!onlyCommentsAndSpace(lines.slice(0, open).join('\n')) || !onlyCommentsAndSpace(lines.slice(close + 1).join('\n'))) {
        return { body: null, problem: 'text between the markers that is outside the fence' };
    }
    return { body: lines.slice(open + 1, close).join('\n'), problem: null };
}

// Which region a wrapped text belongs to, read off its begin marker — so a caller that lifts rows can
// take a row whose region it did not name. Exactly ONE distinct region name → that name; none, or
// more than one → null (a text carrying two regions is two things, and `unwrapRenderedRegion` will say
// which is wrong when asked about either).
export function detectRegionName(text) {
    const s = String(text == null ? '' : text);
    const names = new Set();
    const pattern = /<!-- mvu-helper:begin ([a-z][a-z0-9-]*) -->/g;
    let m;
    while ((m = pattern.exec(s)) !== null) names.add(m[1]);
    return names.size === 1 ? [...names][0] : null;
}

// TavernHelper's OWN render predicate (JS-Slash-Runner `src/util/is_frontend.ts`): a `<pre>` whose
// text contains any of these tokens is rendered as an iframe with the page's full authority. Applied
// here to a WHOLE regex row: a row carrying none of them cannot produce a `<pre>` that does. Vendored
// verbatim, tokens and all, so the StatusMenu lift is held to the rule TavernHelper applies and not to
// an approximation of it — and named for what it is, so a reader knows whose rule moved if it moves.
export const TAVERNHELPER_FRONTEND_TOKENS = Object.freeze(['html>', '<head>', '<body']);
export function isTavernHelperFrontendText(text) {
    const s = String(text == null ? '' : text);
    return TAVERNHELPER_FRONTEND_TOKENS.some((token) => s.includes(token));
}

// ST-Prompt-Template's template opener (its default delimiters, `src/function/ejs.ts`). It evaluates every
// message of the final prompt that carries one — chat history included — so a reply holding it is run as
// a template on the page on every later turn.
export const PROMPT_TEMPLATE_OPENER = '<%';

// What turns reply text into PAGE CODE: a TavernHelper render token (the reply renders as an unsandboxed
// frame) or the template opener (the next prompt runs it). Text mvu-helper writes into a reply on behalf of
// an engine or out of stat_data must add none of them; the model's own words are its own surface.
export const PAGE_CODE_TOKENS = Object.freeze([...TAVERNHELPER_FRONTEND_TOKENS, PROMPT_TEMPLATE_OPENER]);

// The first page-code token `text` carries, or null.
export function pageCodeTokenIn(text) {
    const s = String(text == null ? '' : text);
    return PAGE_CODE_TOKENS.find((token) => s.includes(token)) || null;
}

// `text` with every ST-Prompt-Template opener broken apart (`<%` → `< %`), and how many there were — for a
// prompt block mvu-helper builds out of stat_data, which the engine and the model write. The final prompt
// is evaluated as a template, so an opener that came in with the data would run on the page; broken, the
// block still goes out and reads the same, with nothing in it to run.
export function breakTemplateOpeners(text) {
    const parts = String(text == null ? '' : text).split(PROMPT_TEMPLATE_OPENER);
    return { text: parts.join('< %'), broken: parts.length - 1 };
}

// The first page-code token `after` holds more of than `before` — what an edit ADDED — or null. Counted
// rather than searched for in the inserted text alone, because an insert can complete a token with the
// text beside it.
export function pageCodeTokenAdded(before, after) {
    const was = String(before == null ? '' : before);
    const now = String(after == null ? '' : after);
    return PAGE_CODE_TOKENS.find((token) => now.split(token).length > was.split(token).length) || null;
}
