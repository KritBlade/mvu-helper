// side-panel/index.js — public barrel (P6). The panel is wired once at composition time, and its profile
// template joins the composition root's; the render model lives in side-panel-core.js for its tests.
export { wireSidePanel } from './side-panel.js';
export { sidePanelProfileDefaults } from './side-panel-core.js';
