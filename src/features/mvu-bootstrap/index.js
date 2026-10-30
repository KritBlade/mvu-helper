// features/mvu-bootstrap — public API (P6: cross-feature imports stop here).
// mvu-helper installs MVU (MagVarUpdate) itself, globally and with consent, because every state feature
// here is built on it. See mvu-bootstrap.js for why.

export { ensureGlobalMvuImport, ensureGlobalMvuImportAtLoad, neutralizeCardMvuDuplicates, isMvuPresent, wireMvuInstallOffer } from './mvu-bootstrap.js';
