// features/mvu-bootstrap/mvu-bootstrap-ui.js — the Main tab's MVU status: the "Install MVU" notice
// (#mvuh_mvu_install_offer in settings.html) and the page header's pill, "MVU ready" or "MVU not installed".
// The pills and the notice start hidden; every status (mvuStatusAfter) decides which show.

import { mvuStatusAfter } from './mvu-bootstrap-core.js';

// Paint the MVU status for one bootstrap result. A result that says nothing about MVU ('unavailable') leaves
// it as it is. A missing settings panel (it failed to build) selects nothing, so this is a no-op then.
//   global    — green pill, no notice.
//   elsewhere — green pill; a neutral notice keeps the Install button for a user who wants MVU Helper's own.
//   missing   — warning pill; a warning notice with the Install button.
export function paintMvuStatusFor(result, isMvuRunning) {
    const status = mvuStatusAfter(result, isMvuRunning);
    if (status === 'keep') return;
    const isMissing = status === 'missing';
    $('#mvuh_mvu_missing_pill').toggle(isMissing);
    $('#mvuh_mvu_ready_pill').toggle(!isMissing);
    const offer = $('#mvuh_mvu_install_offer');
    offer.toggle(status !== 'global').toggleClass('is-warning', isMissing);
    offer.find('[data-mvuh-mvu-notice="missing"]').toggle(isMissing);
    offer.find('[data-mvuh-mvu-notice="elsewhere"]').toggle(status === 'elsewhere');
}

// Bind the notice's button to `install` (ensureGlobalMvuImport with the user's request, passed in by
// mvu-bootstrap.js so this file never imports it back).
export function wireInstallOfferButton(install) {
    $('#mvuh_mvu_install').on('click', () => void install());
}
