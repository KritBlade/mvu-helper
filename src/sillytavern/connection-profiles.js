// sillytavern/connection-profiles.js — reads ST's connection-manager profiles for the per-call API dropdown, and
// says when that list changes. One level below the extension root, so ST-core imports gain one `../`.
import { getContext } from '../../../../../extensions.js';
import { eventSource, event_types } from '../../../../../../script.js';
import { createModuleLog } from './log.js';

const log = createModuleLog('connection-profiles');

// ST connection-manager profiles, for the per-call dropdown. [{id, name}, …]
export function getConnectionProfiles() {
    try {
        const ctx =
            typeof getContext === 'function'
                ? getContext()
                : (window.SillyTavern && window.SillyTavern.getContext());
        const cm = ctx && ctx.extensionSettings && ctx.extensionSettings.connectionManager;
        return cm && Array.isArray(cm.profiles) ? cm.profiles : [];
    } catch (e) {
        log.warn(`could not read connection profiles:`, e);
        return [];
    }
}

// The connection-manager events that change the list getConnectionProfiles() returns: a profile added, removed, or
// renamed. LOADED is not one of them — switching the active profile leaves the list as it was.
const PROFILE_LIST_EVENTS = ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_UPDATED'];

// Calls `listener` after each change to the profile list, so a dropdown painted from it can repaint.
export function onConnectionProfilesChanged(listener) {
    for (const name of PROFILE_LIST_EVENTS) {
        const type = event_types && event_types[name];
        if (!type) {
            log.warn(`this SillyTavern has no ${name} event — a connection profile added, removed or renamed reaches the Extra LLM Calls dropdown only after F5.`);
            continue;
        }
        eventSource.on(type, () => listener());
    }
}
