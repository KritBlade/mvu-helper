// shared/save-file.js — hand the browser a generated file to save. v0.1
//
// One anchor-click download, shared by W8's skeleton archive and W6's three export buttons (P3:
// earned by the fourth consumer, not speculative). Pure browser platform — no host imports.

export function saveGeneratedFile(fileName, data, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime || 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(fileName);
    anchor.click();
    URL.revokeObjectURL(url);
}
