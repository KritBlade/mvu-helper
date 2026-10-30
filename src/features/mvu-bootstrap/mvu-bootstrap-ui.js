// features/mvu-bootstrap/mvu-bootstrap-ui.js — the Main tab's MVU status: the "Install MVU" notice
// (#mvuh_mvu_install_offer in settings.html) and the page header's pill, "MVU ready" or "MVU not installed".
// All three start hidden; every bootstrap result decides which show (installOfferAfter).

import { installOfferAfter } from './mvu-bootstrap-core.js';

// Paint the MVU status for one bootstrap result. A result that says nothing about MVU ('unavailable') leaves
// it as it is. A missing settings panel (it failed to build) selects nothing, so this is a no-op then.
export function paintMvuStatusFor(result) {
    const visibility = installOfferAfter(result);
    if (visibility === 'keep') return;
    const isMissing = visibility === 'show';
    $('#mvuh_mvu_install_offer').toggle(isMissing);
    $('#mvuh_mvu_missing_pill').toggle(isMissing);
    $('#mvuh_mvu_ready_pill').toggle(!isMissing);
}

// Bind the notice's button to `install` (ensureGlobalMvuImport with the user's request, passed in by
// mvu-bootstrap.js so this file never imports it back).
export function wireInstallOfferButton(install) {
    $('#mvuh_mvu_install').on('click', () => void install());
}
