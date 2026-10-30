// shared/version-compare.js — ownerless primitive: "M.m.r" versions. No imports, no host, no feature.
// Every artifact lane (install / upgrade / downgrade, the card row's Upgrade button) and card-sync's
// state watermark compare versions here, and every validator checks a version's shape here, so a
// version that validates is a version that compares.

// The one version shape every artifact file declares: two or three dot-separated whole numbers
// ("1.2", "5.116.3"). Anything else — "v1.2", "1.2-beta", "1" — is refused at validation, because
// compareVersions below can only order numbers.
const VERSION_SHAPE = /^\d+\.\d+(\.\d+)?$/;

export function isVersionString(value) {
    return typeof value === 'string' && VERSION_SHAPE.test(value);
}

// Segment-wise NUMERIC compare ("1.10.0" > "1.9.9" — parseFloat would get this wrong). Missing segments
// count as 0 ("1.2" == "1.2.0"). Returns -1 / 0 / 1. Callers compare validated versions
// (isVersionString); a non-numeric segment reads as 0.
export function compareVersions(a, b) {
    const seg = (v) => String(v == null ? '' : v).split('.').map((s) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    const A = seg(a), B = seg(b);
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
        const d = (A[i] || 0) - (B[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}
