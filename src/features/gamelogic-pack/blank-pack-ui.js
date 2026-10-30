// gamelogic-pack/blank-pack-ui.js — the Development tab's "Add New Blank Packs" card: a ready source folder for a new
// artifact of any type, as a ZIP to extract at the workspace root.
//
// The SAME pipeline the dev loop and the import run — skeleton members through the one assembler, then the one validator —
// before any bytes are offered. A skeleton that fails its own pipeline is a bug HERE, and the report says so instead of
// letting the download teach a broken format.

import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { buildBlankArtifactMembers, artifactRootMembers, deriveArtifactId, BLANK_ARTIFACT_TYPES } from '../../shared/artifact-skeletons.js';
import { assembleArtifactSource } from '../../shared/artifact-source-assembler.js';
import { buildStoredZip } from '../../shared/stored-zip.js';
import { saveGeneratedFile } from '../../shared/save-file.js';
import { resultList, selectOption } from '../settings-panel/index.js';
import { validatePack } from './gamelogic-pack-core.js';
import { blankPackReportView } from './artifact-tabs-core.js';

const log = createModuleLog('gamelogic-pack');

// 'mvu-helper <version>' for the skeleton's builtWith stamp — read once from our own manifest,
// resolved relative to this module so the path never hardcodes the extension folder. A failed read
// stamps 'mvu-helper' alone and says so; the stamp is provenance, not behavior.
let builtWithStamp = '';
async function readBuiltWithStamp() {
    if (builtWithStamp) return builtWithStamp;
    try {
        const res = await fetch(new URL('../../../manifest.json', import.meta.url));
        const manifest = await res.json();
        builtWithStamp = 'mvu-helper' + (manifest && manifest.version ? ' ' + manifest.version : '');
    } catch (e) {
        log.child('tab').warn('could not read our own manifest for the builtWith stamp:', e);
        builtWithStamp = 'mvu-helper';
    }
    return builtWithStamp;
}

// The id field auto-derives from the name until the user edits it by hand — then their spelling is
// theirs (the builder's habit). Tracked by comparing against the last derivation, not a flag, so
// deleting the hand edit back to the derived value re-links the two.
let lastDerivedId = '';

async function onCreateBlankArtifact() {
    const packType = String($('#mvuh_blank_type').val() || '');
    const name = String($('#mvuh_blank_name').val() || '').trim();
    const id = String($('#mvuh_blank_id').val() || '').trim();
    const description = String($('#mvuh_blank_description').val() || '').trim();
    const $report = $('#mvuh_blank_report');

    const built = buildBlankArtifactMembers({ packType, id, name, description, builtWith: await readBuiltWithStamp() });
    const showErrors = (errors) => {
        $report.html(resultList(blankPackReportView({ errors })));
        void applyHelperLocale();
    };
    if (built.errors.length) { showErrors(built.errors); return; }

    // The same-pipeline guarantee, run live: the skeleton through the one assembler and the one validator.
    const assembled = assembleArtifactSource(artifactRootMembers(built.members, built.folder));
    const verdict = assembled.pack ? validatePack(assembled.pack) : { ok: false, errors: assembled.errors, warnings: [] };
    const problems = [...assembled.errors, ...(verdict.ok ? [] : verdict.errors)];
    if (problems.length) { showErrors(problems); return; }

    const bytes = buildStoredZip(built.members);
    saveGeneratedFile(built.folder + '.zip', bytes, 'application/zip');
    $report.html(resultList(blankPackReportView({ fileName: built.folder + '.zip' })));
    void applyHelperLocale();
    log.lifecycle('blank ' + packType + ' skeleton "' + built.folder + '" — ' + built.members.length + ' member(s), ' + bytes.length + ' bytes');
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function wireBlankPackCard() {
    // The type list comes from the DATA table (a fourth artifact type is one table entry).
    $('#mvuh_blank_type').html(BLANK_ARTIFACT_TYPES.map((t) => selectOption({ value: t.packType, text: t.label })).join(''));
    $('#mvuh_blank_name').on('input', function () {
        const $id = $('#mvuh_blank_id');
        if (!String($id.val() || '').trim() || String($id.val()) === lastDerivedId) {
            lastDerivedId = deriveArtifactId(String($(this).val() || ''));
            $id.val(lastDerivedId);
        }
    });
    $('#mvuh_blank_create').on('click', () => void onCreateBlankArtifact());
}
