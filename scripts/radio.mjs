import { MODULE_ID } from "./common.mjs";
import { SETTING_NOISE_VOLUME } from "./radio-common.mjs";
import { patchAmbientSync, scanPlaylist } from "./radio-engine.mjs";
import { injectRadioConfig, refreshOpenConfig, closeConfigIfOpen } from "./radio-config.mjs";

let legacyRadioActive = false;
const playlistSyncTimers = new Map();

Hooks.once("init", () => {
    legacyRadioActive = game.modules.get("ag-radio")?.active === true;
    game.settings.register(MODULE_ID, SETTING_NOISE_VOLUME, {
        name: "EAR.Radio.Settings.NoiseVolume.Name", hint: "EAR.Radio.Settings.NoiseVolume.Hint",
        scope: "world", config: true, type: Number, default: 0.35,
        range: { min: 0, max: 1, step: 0.05 }
    });
    if (!legacyRadioActive) patchAmbientSync();
});

Hooks.once("ready", () => {
    if (legacyRadioActive && game.user.isGM) {
        ui.notifications.warn(game.i18n.localize("EAR.Radio.LegacyWarning"), { permanent: true });
    }
});

Hooks.on("updateAmbientSound", (doc, changed) => {
    if (legacyRadioActive) return;
    if (["flags", "path", "hidden", "volume", "name"].some(key => key in changed)) refreshOpenConfig(doc.id);
});
Hooks.on("deleteAmbientSound", doc => {
    if (legacyRadioActive) return;
    closeConfigIfOpen(doc.id);
});
Hooks.on("renderAmbientSoundConfig", (app, element) => {
    if (!legacyRadioActive) injectRadioConfig(app, element);
});

for (const hook of ["createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound"]) {
    Hooks.on(hook, sound => schedulePlaylistSync(sound.parent?.id));
}
for (const hook of ["createPlaylist", "updatePlaylist", "deletePlaylist"]) {
    Hooks.on(hook, playlist => {
        refreshOpenConfig();
        schedulePlaylistSync(playlist.id);
    });
}

function schedulePlaylistSync(playlistId) {
    if (legacyRadioActive || !game.user.isGM || !playlistId) return;
    clearTimeout(playlistSyncTimers.get(playlistId));
    playlistSyncTimers.set(playlistId, setTimeout(async () => {
        playlistSyncTimers.delete(playlistId);
        const tracks = scanPlaylist(playlistId);
        for (const scene of game.scenes) {
            for (const sound of scene.sounds) {
                const radio = sound.flags?.["ag-radio"];
                if (!radio || radio.playlist !== playlistId) continue;
                const current = radio.tracks?.[radio.index];
                const index = tracks.findIndex(track => current?.id ? track.id === current.id : track.path === sound.path);
                const path = index >= 0 ? tracks[index].path : sound.path;
                await sound.update({
                    path,
                    "flags.ag-radio.tracks": tracks,
                    "flags.ag-radio.index": index
                });
            }
        }
    }, 150));
}
