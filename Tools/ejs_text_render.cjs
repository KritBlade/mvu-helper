/*
 * ejs_text_render.cjs — render an entry's `<%_ … _%>` EJS to the text the model is handed. v0.1
 *
 * A minimal EJS covering the one scriptlet form the card's prose entries use: every `<%_ … _%>` is
 * code, everything between is printed. Rendering the real entry (rather than grepping it) is the point
 * of every caller: a branch that throws or falls through prints nothing at all, and a rule that prints
 * nothing is the failure those tests exist to catch.
 *
 * `globals` adds names the entry reads besides `getvar` (e.g. `globalThis` for an entry that logs
 * through MvuHelper). Pass the SAME template text several entries concatenated to compile them in one
 * scope, the way ST-Prompt-Template does within a render pass.
 */

function render(template, getvar, globals) {
    let code = 'const __out = [];\n';
    let rest = template;
    const TAG = /<%_([\s\S]*?)_%>\r?\n?/;
    let m;
    while ((m = TAG.exec(rest))) {
        code += '__out.push(' + JSON.stringify(rest.slice(0, m.index)) + ');\n' + m[1] + '\n';
        rest = rest.slice(m.index + m[0].length);
    }
    code += '__out.push(' + JSON.stringify(rest) + ');\nreturn __out.join("");';
    const names = Object.keys(globals || {});
    return new Function('getvar', ...names, code)(getvar, ...names.map((n) => globals[n]));
}

module.exports = { render };
