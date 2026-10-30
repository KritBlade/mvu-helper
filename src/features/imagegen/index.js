// features/imagegen — DRAWING: <pic> tag detection, the /sd generation queue, prompt assembly,
// and attaching the finished image to the message. The cast it draws lives in character-roster.
export { imageDefaults, auditRenderedImagesAfterForeignWrites, wornOutfitWriteTask, deleteGlobalPromptInjection } from './image-gen.js';
export { imagegenProfileDefaults } from './imagegen-profile-core.js';
// The Image-tab settings panel is its own file (P5a); the barrel re-exports it from there.
export { wireImageSettings, updateImageUI } from './image-settings-ui.js';
export { seedComfyBustPlaceholder } from './comfy-placeholder-seed.js';
