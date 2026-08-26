import {
    MODULE_ID, log, clampRatio, getRadioFlags, isRadio
} from "./radio-common.mjs";

// Loudness of the static burst played when the radio switches tracks
// (relative to Foundry's interface volume).
const NOISE_VOLUME = 0.2;
const NOISE_SRC = `modules/${MODULE_ID}/radio-static.generated`;
const NOISE_BUFFER_COUNT = 6;
const handledSounds = new WeakMap();
const lastTrackByPlaceable = new WeakMap();
let patched = false;
let noiseSequence = 0;

export function scanPlaylist(playlistId) {
    const playlist = game.playlists.get(playlistId);
    if (!playlist) return [];
    return playlist.sounds.contents.map(sound => ({ id: sound.id, name: sound.name, path: sound.path, start: 0 }));
}

function getPlaceable(soundId) {
    return canvas?.sounds?.get(soundId) ?? null;
}

function isPrimaryGM() {
    const activeGM = game.users?.activeGM;
    return game.user.isGM && (!activeGM || activeGM.id === game.user.id);
}

export function getNextIndex(radio, direction = 1) {
    const count = radio?.tracks?.length ?? 0;
    if (!count) return -1;
    if (radio.mode === "shuffle") {
        if (count === 1) return 0;
        let next;
        do next = Math.floor(Math.random() * count);
        while (next === radio.index);
        return next;
    }
    if (radio.mode === "repeat") return radio.index >= 0 ? radio.index : 0;
    return ((radio.index ?? -1) + direction + count) % count;
}

export async function playTrack(soundId, index) {
    if (!game.user.isGM) return;
    const placeable = getPlaceable(soundId);
    const doc = placeable?.document;
    const radio = getRadioFlags(doc);
    const track = radio?.tracks?.[index];
    if (!placeable || !track?.path) return;
    if (track.path === doc.path) {
        if (radio.index !== index) await doc.update({ [`flags.ag-radio.index`]: index });
        await seekRadio(soundId, track.start ?? 0);
        return;
    }
    await doc.update({
        path: track.path,
        [`flags.ag-radio.index`]: index,
        [`flags.ag-radio.seek`]: { offset: 0, trackIndex: index, requestedAt: game.time?.serverTime ?? Date.now() }
    });
}

export async function radioStep(soundId, direction = 1) {
    const radio = getRadioFlags(getPlaceable(soundId)?.document);
    const index = getNextIndex(radio, direction);
    if (index >= 0) await playTrack(soundId, index);
}

export async function setRadioPower(soundId, on) {
    if (!game.user.isGM) return;
    const doc = canvas.scene?.sounds.get(soundId);
    if (doc) await doc.update({ hidden: !on });
}

export async function radioSeek(placeable, offset) {
    const sound = placeable?.sound;
    if (!sound?.playing) return;
    const volume = clampRatio(sound.volume ?? 1);
    try {
        await sound.stop({ fade: 0 });
        await sound.play({ offset: Math.max(0, offset), volume, fade: 250, loop: true });
        scheduleAdvance(placeable, getRadioFlags(placeable.document));
    } catch (error) {
        log.warn("Radio seek:", error.message);
    }
}

export async function seekRadio(soundId, offset) {
    if (!game.user.isGM) return;
    const doc = getPlaceable(soundId)?.document;
    const radio = getRadioFlags(doc);
    if (!doc || !radio) return;
    await doc.update({
        [`flags.ag-radio.seek`]: {
            offset: Math.max(0, Number(offset) || 0),
            trackIndex: radio.index ?? -1,
            requestedAt: game.time?.serverTime ?? Date.now()
        }
    });
}

function clearAdvance(placeable) {
    if (!placeable?._earRadioAdvance) return;
    try { placeable.sound?.unschedule(placeable._earRadioAdvance); } catch (_) {}
    placeable._earRadioAdvance = null;
}

function scheduleAdvance(placeable, radio) {
    clearAdvance(placeable);
    const sound = placeable.sound;
    if (!sound?.playing || !["sequential", "shuffle"].includes(radio?.mode)) return;
    const duration = sound.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const currentTime = Number.isFinite(sound.currentTime) ? sound.currentTime : 0;
    placeable._earRadioAdvance = sound.schedule(() => {
        placeable._earRadioAdvance = null;
        if (!isPrimaryGM()) return;
        const current = getRadioFlags(placeable.document);
        if (!["sequential", "shuffle"].includes(current?.mode)) return;
        playTrack(placeable.id, getNextIndex(current));
    }, Math.max(0, duration - currentTime - 0.25));
}

async function createNoiseBuffer() {
    try {
        const context = game.audio.environment;
        const duration = 0.8 + Math.random() * 0.55;
        const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
        const data = buffer.getChannelData(0);
        let brown = Math.random() * 0.15;
        let pink0 = Math.random() * 0.1;
        let pink1 = Math.random() * 0.1;
        let burst = 0;
        const pattern = Math.floor(Math.random() * 5);
        const carrierHz = 850 + Math.random() * 2200;
        const flutterHz = 6 + Math.random() * 3;
        const flutterDepth = 0.16 + Math.random() * 0.18;
        const pulseHz = 3 + Math.random() * 9;
        const phase = Math.random() * Math.PI * 2;
        const gain = 0.28 + Math.random() * 0.28;
        for (let i = 0; i < data.length; i++) {
            const t = i / context.sampleRate;
            const white = Math.random() * 2 - 1;
            brown = (brown + (0.012 + Math.random() * 0.025) * white) / 1.025;
            pink0 = 0.994 * pink0 + 0.02 * white;
            pink1 = 0.975 * pink1 + 0.07 * white;
            if (Math.random() < 0.0012 + pattern * 0.00035) burst = 0.2 + Math.random() * 1.2;
            burst *= 0.986 + pattern * 0.0015;

            const carrier = Math.sin(2 * Math.PI * (carrierHz + 500 * Math.sin(2 * Math.PI * flutterHz * t)) * t);
            const flutter = 1 - flutterDepth * 0.5 + flutterDepth * Math.sin(2 * Math.PI * flutterHz * t);
            const attack = Math.min(1, t / (0.02 + pattern * 0.008));
            const release = Math.min(1, (duration - t) / (0.16 + pattern * 0.035));
            const envelope = Math.max(0, attack * release);
            const patternGate = [
                0.55 + 0.45 * Math.abs(Math.sin(Math.PI * pulseHz * t + phase)),
                Math.sin(2 * Math.PI * pulseHz * t + phase) > 0.35 ? 1 : 0.22,
                0.7 + 0.3 * Math.sin(2 * Math.PI * (pulseHz * 0.35) * t + phase),
                Math.sin(2 * Math.PI * pulseHz * t + phase) > 0.82 ? 0.18 : 1,
                0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * pulseHz * t + phase) * Math.sin(Math.PI * 2.3 * t))
            ][pattern];
            const tonalMix = pattern === 1 || pattern === 4 ? 0.1 : 0.035;
            const mixed = (white * (0.22 + pattern * 0.025) + pink0 * 0.9 + pink1 * 0.55
                + brown * (1.2 + pattern * 0.2) + carrier * tonalMix + white * burst * (0.8 + pattern * 0.25))
                * flutter * patternGate * envelope;
            data[i] = Math.tanh(mixed * (1.1 + Math.random() * 0.8)) * gain;
        }
        const slot = noiseSequence++ % NOISE_BUFFER_COUNT;
        const src = `${NOISE_SRC}.${slot}`;
        game.audio.buffers.setBuffer(src, buffer);
        if (noiseSequence <= NOISE_BUFFER_COUNT) game.audio.buffers.lock(src);
        return { src, duration };
    } catch (error) {
        log.warn("Radio noise:", error.message);
        return false;
    }
}

async function playSwitchNoise(placeable, radio) {
    if (radio?.noise === false) return;
    const doc = placeable.document;
    try {
        const noise = await createNoiseBuffer();
        if (!noise) return;
        const interfaceVolume = clampRatio(game.settings.get("core", "globalInterfaceVolume") ?? 1);
        const volume = NOISE_VOLUME * interfaceVolume * (0.24 + Math.random() * 0.1);
        const sound = await canvas.sounds.playAtPosition(noise.src,
            { x: doc.x, y: doc.y, elevation: doc.elevation }, doc.radius,
            { walls: doc.walls, easing: doc.easing, playbackOptions: {
                volume, fade: 20 + Math.random() * 80, loop: false
            }});
        sound?.schedule(() => sound.stop({ fade: 80 + Math.random() * 260 }), noise.duration);
    } catch (error) { log.warn("Radio noise playback:", error.message); }
}

export function patchAmbientSync() {
    if (patched) return;
    patched = true;
    const cls = CONFIG.AmbientSound.objectClass;
    const original = cls.prototype.sync;
    cls.prototype.sync = async function(isAudible, volume, options = {}) {
        const radio = getRadioFlags(this.document);
        if (!isRadio(this.document)) return original.call(this, isAudible, volume, options);
        if (!isAudible) {
            clearAdvance(this);
            if (this.sound) handledSounds.delete(this.sound);
            return original.call(this, isAudible, volume, options);
        }
        await original.call(this, isAudible, volume, options);
        const sound = this.sound;
        if (!sound?.playing) return;
        const seek = radio.seek?.trackIndex === radio.index ? radio.seek : null;
        const signature = `${this.document.path}|${radio.index}|${seek?.requestedAt ?? ""}`;
        if (handledSounds.get(sound) === signature) return;
        const previousTrack = lastTrackByPlaceable.get(this);
        const isSwitch = previousTrack !== undefined && previousTrack !== signature;
        handledSounds.set(sound, signature);
        lastTrackByPlaceable.set(this, signature);
        const now = game.time?.serverTime ?? Date.now();
        const elapsed = seek ? Math.max(0, (now - seek.requestedAt) / 1000) : 0;
        const offset = Math.max(0, seek ? seek.offset + elapsed : (radio.tracks?.[radio.index]?.start ?? 0));
        if (Math.abs((sound.currentTime ?? 0) - offset) > 0.75) {
            try {
                const targetVolume = clampRatio(sound.volume ?? volume);
                await sound.stop({ fade: 0 });
                await sound.play({ offset, volume: targetVolume, fade: 250, loop: true });
            } catch (error) { log.warn("Radio offset:", error.message); }
        }
        if (isSwitch) playSwitchNoise(this, radio);
        scheduleAdvance(this, radio);
    };
}
