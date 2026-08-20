import { MODULE_ID, log, loc, clampRatio } from "./common.mjs";

export { MODULE_ID, log, loc, clampRatio };
export const FLAGS_KEY = "ag-radio";
export const SETTING_NOISE_VOLUME = "radioNoiseVolume";

export function getRadioFlags(doc) {
    const flags = doc?.flags?.[FLAGS_KEY];
    return flags && typeof flags === "object" ? flags : null;
}

export function isRadio(doc) {
    const flags = getRadioFlags(doc);
    return !!flags && flags.enabled !== false;
}

export function defaultRadioFlags() {
    return { enabled: true, playlist: "", tracks: [], index: -1, mode: "manual", noise: true };
}

export async function writeRadioFlags(doc, changes) {
    try {
        if (changes === null) await doc.update({ [`flags.-=${FLAGS_KEY}`]: null });
        else {
            const current = getRadioFlags(doc) ?? defaultRadioFlags();
            const next = foundry.utils.mergeObject(current, changes, { inplace: false });
            await doc.update({ [`flags.${FLAGS_KEY}`]: next });
        }
        return true;
    } catch (error) {
        log.error("Radio update:", error.message);
        return false;
    }
}
