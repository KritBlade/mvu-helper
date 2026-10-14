// tools/menu-engine-exports-in-process.mjs — the Node dev server's reader for the pack gates' G-C.
//
// gateArtifactSource never runs an engine text; its caller reads a menu engine's exports and passes them
// in (menuEngineExports). On the page that read runs in the engine frame's throwaway Worker
// (logic-engine readMenuEngineExportsInWorker). Here — `npm run dev`, a developer's own workspace on
// their own machine — it runs in this process. This file lives in tools/ so it never ships: nothing in
// src/ can reach an in-process reader, so no page path can run a picked engine on the page.
//
// It drives the engine Worker's OWN runtime (createEngineWorkerRuntime + executeEngineText), so the
// export list it reports is the one the Worker's load reports — the two readers cannot disagree.

import { createEngineWorkerRuntime, executeEngineText } from '../src/features/logic-engine/logic-engine-core.js';
import { menuEngineExportsFromScope } from '../src/shared/artifact-source-gates.js';

const SCOPE = 'artifact-check';

export function readMenuEngineExportsInProcess(engineText) {
    let loaded = null;
    const runtime = createEngineWorkerRuntime({
        post: (msg) => { if (msg && msg.t === 'loaded') loaded = msg; },
        execute: executeEngineText,
        buildHost: () => ({}),
        getBlockReport: null,
    });
    runtime.handle({ t: 'load', texts: [{ scope: SCOPE, code: String(engineText == null ? '' : engineText) }], host: null, engine: null });
    if (!loaded) throw new Error('menu-engine-exports-in-process: the engine runtime posted no load report');
    return menuEngineExportsFromScope((loaded.scopes || {})[SCOPE]);
}
