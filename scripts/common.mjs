export const MODULE_ID = "ear";

// ── Logging ──────────────────────────────────────────────────────────────────
export const LOG_LEVEL = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 });

let _level = LOG_LEVEL.INFO;

export function setLogLevel(lv) { _level = lv; }

export const log = {
    debug: (...a) => { if (_level <= LOG_LEVEL.DEBUG) console.debug(`[${MODULE_ID}]`, ...a); },
    info:  (...a) => { if (_level <= LOG_LEVEL.INFO)  console.info(`[${MODULE_ID}]`, ...a); },
    warn:  (...a) => { if (_level <= LOG_LEVEL.WARN)  console.warn(`[${MODULE_ID}]`, ...a); },
    error: (...a) => { if (_level <= LOG_LEVEL.ERROR) console.error(`[${MODULE_ID}]`, ...a); },
};

// ── CSS selectors used to target Foundry's DOM ──────────────────────────────
export const DOM = Object.freeze({
    activeSound: "#playlists .currently-playing .playlist-sounds .sound",
    player:      ".ear-player",
    volSlider:   ".ear-volume-slider",
    volIcon:     ".ear-volume-icon",
    volText:     ".ear-vol-text",
});

// ── Channel display names ───────────────────────────────────────────────────
export const CHANNEL_KEYS = Object.freeze({
    music:       "AUDIO.CHANNELS.MUSIC.label",
    environment: "AUDIO.CHANNELS.ENVIRONMENT.label",
    interface:   "AUDIO.CHANNELS.INTERFACE.label",
});

export function getChannelName(playlist) {
    const channel = playlist?.channel || "music";
    const key = CHANNEL_KEYS[channel];
    if (key) return game.i18n.localize(key);
    return channel.charAt(0).toUpperCase() + channel.slice(1);
}

// ── Name hiding setting ──────────────────────────────────────────────────────
export const HIDE_NAMES_SETTING = "hideTrackNames";

// Cached value of the setting — `shouldHideName` runs on every live-update tick.
let _hideNamesCache = undefined;

function getHideNamesEnabled() {
    if (_hideNamesCache === undefined) {
        try { _hideNamesCache = !!game.settings.get(MODULE_ID, HIDE_NAMES_SETTING); }
        catch (_) { _hideNamesCache = true; }
    }
    return _hideNamesCache;
}

export function invalidateHideNamesCache() { _hideNamesCache = undefined; }

export function shouldHideName(playlist) {
    if (game.user.isGM) return false;
    if (!getHideNamesEnabled()) return false;
    const level = playlist?.ownership?.[game.user.id] ?? playlist?.ownership?.default ?? 0;
    return level < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
}

export function getDisplayName(ps) {
    if (game.user.isGM) return ps.name;
    const playlist = ps.parent;
    if (!playlist) return ps.name;
    if (!shouldHideName(playlist)) return ps.name;
    return getChannelName(playlist);
}

// ── General utilities ───────────────────────────────────────────────────────
export function loc(key, fallback) {
    return game.i18n?.localize(key) ?? fallback ?? key;
}

export function canControl() {
    return game.user.isGM || game.user.hasPermission("SETTINGS_MODIFY");
}

export function clampRatio(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

export function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const ts = Math.floor(s);
    const h = Math.floor(ts / 3600);
    const m = Math.floor((ts % 3600) / 60);
    const sec = ts % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
}

export function setTooltip(el, text) {
    el.dataset.tooltip = text;
    el.dataset.tooltipDirection = "UP";
}

export function stopEvent(el) {
    el.addEventListener("mousedown", e => e.stopPropagation());
    el.addEventListener("pointerdown", e => e.stopPropagation());
}

// ── Audio helpers ───────────────────────────────────────────────────────────
export function getAudioNode(ps) {
    const s = ps.sound;
    if (!s) return null;
    return s.sourceNode ?? null;
}

export function getCurrentTime(ps) {
    try {
        const s = ps.sound;
        if (!s) return ps.pausedTime ?? 0;
        if (s.currentTime !== undefined && Number.isFinite(s.currentTime)) return s.currentTime;
        const n = getAudioNode(ps);
        if (n && typeof n.currentTime === "number" && Number.isFinite(n.currentTime)) return n.currentTime;
    } catch (e) {}
    return ps.pausedTime ?? 0;
}

export function getDuration(ps, fb) {
    try {
        const s = ps.sound;
        if (!s) return fb;
        if (s.duration !== undefined && Number.isFinite(s.duration) && s.duration > 0) return s.duration;
        const n = getAudioNode(ps);
        if (n && typeof n.duration === "number" && Number.isFinite(n.duration) && n.duration > 0) return n.duration;
    } catch (e) {}
    return fb;
}

export function applyLocalVolume(ps, vol) {
    try {
        const sound = ps.sound;
        if (!sound) return;
        if (sound.gainNode) {
            sound.gainNode.gain.value = vol;
            return;
        }
        if (sound.gain !== undefined) {
            if (typeof sound.gain === "object" && sound.gain.value !== undefined) {
                sound.gain.value = vol;
            }
            return;
        }
        const n = getAudioNode(ps);
        if (n && typeof n.volume === "number") n.volume = vol;
    } catch (e) {
        log.error("Volume apply:", e.message);
    }
}

export function getVolumeIcon(v) {
    if (v <= 0) return "fa-solid fa-volume-xmark";
    if (v < 0.33) return "fa-solid fa-volume-off";
    if (v < 0.66) return "fa-solid fa-volume-low";
    return "fa-solid fa-volume-high";
}

export function updateVolumeSliderFill(slider, value) {
    slider.style.setProperty("--ear-vol-pct", (value * 100) + "%");
}

// ── Playlist helpers ────────────────────────────────────────────────────────
export function getPlaybackOrder(pl) {
    if (!pl) return [];
    try { if (typeof pl._getPlaybackOrder === "function") return pl._getPlaybackOrder(); } catch (e) {}
    try { if (typeof pl.getPlaybackOrder === "function") return pl.getPlaybackOrder(); } catch (e) {}
    try {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pl), "playbackOrder");
        if (desc?.get) return desc.get.call(pl) || [];
    } catch (e) {}
    return Array.from(pl.sounds.keys());
}

export function getNextSoundFromOrder(pl, currentSoundId) {
    if (!pl) return null;
    const order = getPlaybackOrder(pl);
    if (!order.length) return null;
    const idx = order.indexOf(currentSoundId);
    if (idx < 0) return pl.sounds.get(order[0]) || null;
    return pl.sounds.get(order[(idx + 1) % order.length]) || null;
}

export function getPrevSoundFromOrder(pl, currentSoundId) {
    if (!pl) return null;
    const order = getPlaybackOrder(pl);
    if (!order.length) return null;
    const idx = order.indexOf(currentSoundId);
    if (idx <= 0) return pl.sounds.get(order[order.length - 1]) || null;
    return pl.sounds.get(order[idx - 1]) || null;
}

export async function safeUpdate(doc, data) {
    try { await doc.update(data); } catch (e) { log.error("Update:", e.message); }
}

// ── Scheduled-gain cancellation ──────────────────────────────────────────────
// Foundry schedules its own 500ms Web Audio ramp to the server volume on every
// document update — writing `.value` during an active ramp is silently ignored,
// so callers cancel it first when they need an immediate volume change.
export function cancelGainRamps(ps) {
    try {
        const s = ps.sound;
        if (!s?.gainNode) return;
        const ctx = s.context || s._context;
        if (!ctx) return;
        s.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    } catch (_) {}
}

// ── Preview (local-only playback) ────────────────────────────────────────────
const _activePreviews = new Map(); // soundId → HTMLAudioElement

export function previewSound(ps, volume) {
    // Stop existing preview for this sound
    stopPreview(ps.id);

    const src = ps.sound?.src || ps.path;
    if (!src) return null;

    const audio = new Audio(src);
    audio.volume = clampRatio(volume);
    audio.loop = false;
    audio.play().catch(e => log.warn("Preview play:", e.message));

    audio.addEventListener("ended", () => { _activePreviews.delete(ps.id); });
    _activePreviews.set(ps.id, audio);
    return audio;
}

export function stopPreview(soundId) {
    const a = _activePreviews.get(soundId);
    if (a) {
        a.pause();
        a.src = "";
        a.load();
        _activePreviews.delete(soundId);
    }
}

export function isPreviewing(soundId) { return _activePreviews.has(soundId); }

export function stopAllPreviews() {
    for (const [id] of _activePreviews) stopPreview(id);
}

// ── Volume normalization ─────────────────────────────────────────────────────
const NORM_SETTING = "normalizationGains"; // {playlistId: {soundId: gainMultiplier}}
const DEFAULT_TARGET_PEAK = 0.85;
// Cap the stored boost so very quiet tracks don't write huge multipliers
// (a value like 425 gets clamped to 1 on apply anyway — store something sane).
const MAX_NORM_GAIN = 4;

// url → measured peak (0..1). Stores a single number per source rather than the
// raw Float32Array of samples, which could hold tens of MB per file indefinitely.
const AUDIO_CACHE = new Map();

// Cache of the normalization gains object. `game.settings.get` deserializes the
// setting on every call, and this is a hot path (live-update loop, 250ms per widget),
// so we cache the value and invalidate it on any write.
let _normGainsRaw = undefined;

function getNormGainsRaw() {
    if (_normGainsRaw === undefined) _normGainsRaw = game.settings.get(MODULE_ID, NORM_SETTING);
    return _normGainsRaw;
}

export function invalidateNormGains() { _normGainsRaw = undefined; }

/**
 * Analyze all sounds in a playlist and compute per-track gain multipliers
 * so all tracks peak at roughly the same level.
 * Returns {soundId: multiplier} map.  Multiplier ≈ targetPeak / measuredPeak.
 */
export async function analyzePlaylist(plId, onProgress) {
    const pl = game.playlists.get(plId);
    if (!pl) return null;

    const gains = {};
    const sounds = Array.from(pl.sounds.values()).filter(s => !s.streaming);
    let done = 0;

    for (const ps of sounds) {
        try {
            const peak = await measurePeak(ps);
            if (peak > 0.001) {
                gains[ps.id] = +Math.min(MAX_NORM_GAIN, DEFAULT_TARGET_PEAK / peak).toFixed(3);
            } else {
                gains[ps.id] = 1;
            }
        } catch (e) {
            log.warn("Analyze failed for", ps.name, e.message);
            gains[ps.id] = 1;
        }
        done++;
        if (onProgress) onProgress(done, sounds.length, ps.name);
    }

    return gains;
}

/** Fetch + decode audio, return peak absolute sample value (0..1). */
async function measurePeak(ps) {
    const src = ps.sound?.src || ps.path;
    if (!src) throw new Error("No source");

    const cached = AUDIO_CACHE.get(src);
    if (cached !== undefined) return cached;

    const response = await fetch(src);
    if (!response.ok) throw new Error("Fetch failed: " + response.status);
    const arrayBuffer = await response.arrayBuffer();

    // Use offline context for fast decode (no playback)
    const offlineCtx = new OfflineAudioContext(1, 2, 44100);
    const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
    const samples = audioBuffer.getChannelData(0);

    const peak = peakFromBuffer(samples);
    AUDIO_CACHE.set(src, peak);
    return peak;
}

function peakFromBuffer(samples) {
    let peak = 0;
    // Sample every 4th sample for speed (negligible accuracy loss)
    for (let i = 0; i < samples.length; i += 4) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
    }
    return peak;
}

/**
 * Apply normalization gains to a playing sound.
 * The final volume = playlistVolume * normalizationGain.
 */
export function applyNormalization(ps, baseVol) {
    try {
        const plId = ps.parent?.id;
        if (!plId) return;
        const gain = getNormGainsRaw()?.[plId]?.[ps.id];
        if (!Number.isFinite(gain) || gain === 1) return;
        const finalVol = clampRatio(baseVol * gain);
        applyLocalVolume(ps, finalVol);
    } catch (_) {}
}

export function getNormalizationGain(ps) {
    try {
        return getNormGainsRaw()?.[ps.parent?.id]?.[ps.id] ?? 1;
    } catch (_) { return 1; }
}

export async function setNormalizationGains(plId, gains) {
    try {
        const raw = { ...(getNormGainsRaw() || {}) };
        raw[plId] = gains;
        await game.settings.set(MODULE_ID, NORM_SETTING, raw);
    } catch (e) { log.error("Norm save:", e.message); }
    invalidateNormGains();
}

export function clearNormalization(plId) {
    try {
        const raw = { ...(getNormGainsRaw() || {}) };
        delete raw[plId];
        game.settings.set(MODULE_ID, NORM_SETTING, raw);
    } catch (_) {}
    invalidateNormGains();
}

export { NORM_SETTING };
