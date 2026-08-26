import {
    MODULE_ID, log, DOM, loc, canControl, clampRatio, formatTime, setTooltip, stopEvent,
    getAudioNode, getCurrentTime, getDuration, applyLocalVolume, getVolumeIcon,
    updateVolumeSliderFill, getPlaybackOrder, getNextSoundFromOrder, getPrevSoundFromOrder,
    safeUpdate, getDisplayName,
    cancelGainRamps,
    previewSound, stopPreview, isPreviewing, stopAllPreviews,
    getNormalizationGain,
    analyzePlaylist, setNormalizationGains, clearNormalization, invalidateNormGains, NORM_SETTING,
} from "./common.mjs";

log.info("Initialized");

// ── Constants ───────────────────────────────────────────────────────────────
const SETTING_PLAYLIST_VOLUMES = "playlistVolumes";
const SETTING_TRACK_VOLUMES    = "trackVolumes";
const PLAYLIST_MODES = Object.freeze([
    { value: -1, icon: "fa-solid fa-ban",             locKey: "PLAYLIST.ModeDisabled" },
    { value:  0, icon: "fa-regular fa-circle-right",  locKey: "PLAYLIST.ModeSequential" },
    { value:  1, icon: "fa-solid fa-shuffle",         locKey: "PLAYLIST.ModeShuffle" },
    { value:  2, icon: "fa-solid fa-minimize",        locKey: "PLAYLIST.ModeSimultaneous" },
]);
const MODE_ORDER = Object.freeze([-1, 0, 1, 2]);

function getModeData(mode) { return PLAYLIST_MODES.find(m => m.value === mode) || PLAYLIST_MODES[0]; }
function getModeLabel(mode) { return loc(getModeData(mode).locKey); }
function getNextMode(cur)  { const i = MODE_ORDER.indexOf(cur); return i < 0 ? MODE_ORDER[0] : MODE_ORDER[(i + 1) % MODE_ORDER.length]; }

// ── EarState singleton ──────────────────────────────────────────────────────
class EarState {
    controls             = new Map();   // soundId → EarPlayerWidget
    playlistVolumes      = {};          // playlistId → 0..1
    trackVolumes         = {};          // soundId → 0..1 LOCAL per-user track volume
    savedPlaylistVolumes = {};          // playlistId → last non-zero
    savedTrackVolumes    = {};          // soundId → last non-zero track volume
    savedGlobalVolume    = undefined;   // last non-zero core.globalPlaylistVolume
    playHistory          = [];          // [{playlistId, soundId}]
    showRemaining        = false;
    _pendingDelete       = new Map();   // soundId → setTimeout id (lazy destroy)
    plHeaders            = new Map();   // playlistId → group header refs {root, icon, slider, text}
    collapsedPls         = new Set();   // playlistIds collapsed in the player (session-scoped)

    // Interaction lock
    #interactionLock      = false;
    #interactionLockTimer = null;
    #seekingIds           = new Set();
    #wheelActive          = false;
    #wheelThrottle        = null;
    #directoryTimer       = null;

    get interactionLock()           { return this.#interactionLock; }
    get seekingIds()                { return this.#seekingIds; }
    get wheelActive()               { return this.#wheelActive; }
    set wheelActive(v)              { this.#wheelActive = v; }
    get wheelThrottle()             { return this.#wheelThrottle; }
    set wheelThrottle(v)            { this.#wheelThrottle = v; }

    setInteractionLock(val) {
        this.#interactionLock = val;
        clearTimeout(this.#interactionLockTimer);
        this.#interactionLockTimer = null;
        if (val) {
            this.#interactionLockTimer = setTimeout(() => {
                this.#interactionLock = false;
                this.#interactionLockTimer = null;
                log.warn("InteractionLock safety release");
                this.refreshDirectory();
            }, 8000);
        }
    }

    refreshDirectory() {
        if (this.#interactionLock) return;
        clearTimeout(this.#directoryTimer);
        this.#directoryTimer = setTimeout(() => {
            this.#directoryTimer = null;
            if (!this.#interactionLock) handleDirectory(game.playlists?.directory);
        }, 16);
    }

    // ── Volume helpers ──────────────────────────────────────────────────
    getPlaylistVolume(plId) {
        return this.playlistVolumes[plId] ?? 1;
    }

    // Track volume is LOCAL: it lives in a client-scope setting and is never
    // written to the PlaylistSound document (ps.volume is shared with every
    // client — using it leaked one user's mixing into everyone else's).
    getTrackVolume(sId) {
        return clampRatio(this.trackVolumes[sId] ?? 1);
    }

    #trackVolumeSaveTimer = null;
    scheduleTrackVolumeSave() {
        clearTimeout(this.#trackVolumeSaveTimer);
        this.#trackVolumeSaveTimer = setTimeout(() => {
            this.#trackVolumeSaveTimer = null;
            try {
                game.settings.set(MODULE_ID, SETTING_TRACK_VOLUMES, { ...this.trackVolumes });
            } catch (e) { log.error("Track volume save:", e.message); }
        }, 400);
    }

    loadTrackVolumesFromSettings() {
        try {
            const raw = game.settings.get(MODULE_ID, SETTING_TRACK_VOLUMES);
            if (typeof raw === "object" && raw !== null) {
                for (const [sId, v] of Object.entries(raw)) {
                    this.trackVolumes[sId] = clampRatio(Number(v) || 0);
                }
            }
        } catch (e) {}
    }

    async setPlaylistVolume(plId, v) {
        v = clampRatio(Number(v) || 0);
        this.playlistVolumes[plId] = v;
        if (v > 0) this.savedPlaylistVolumes[plId] = v;
        try {
            await game.settings.set(MODULE_ID, SETTING_PLAYLIST_VOLUMES, { ...this.playlistVolumes });
        } catch (e) { log.error("Settings save:", e.message); }
        this.applyVolumeToPlaylist(plId);
    }

    applyVolumeToPlaylist(plId) {
        const vol = this.getPlaylistVolume(plId);
        this.playlistVolumes[plId] = vol;
        const pl = game.playlists.get(plId);
        if (!pl) return;
        for (const ps of pl.sounds) {
            if (!ps.playing && !ps.sound) continue;
            const gain = getNormalizationGain(ps);
            // Cancel any scheduled ramp (e.g. Foundry's 500ms fade to server
            // volume) so the playlist slider takes effect immediately.
            cancelGainRamps(ps);
            applyLocalVolume(ps, clampRatio(vol * S.getTrackVolume(ps.id) * gain));
        }
    }

    applyAllVolumes() {
        for (const pl of game.playlists?.contents ?? []) {
            this.applyVolumeToPlaylist(pl.id);
        }
    }

    // Sync a group header's slider visuals to the playlist volume.
    syncPlaylistHeader(plId, v) {
        const hdr = this.plHeaders.get(plId);
        if (!hdr || !hdr.root.isConnected) return;
        if (hdr.dragging) return;
        updateVolumeSliderFill(hdr.slider, v);
        hdr.slider.value = v;
        hdr.icon.className = getVolumeIcon(v) + " ear-volume-icon";
        hdr.text.textContent = Math.round(v * 100) + "%";
    }

    syncAllPlaylistHeaders() {
        for (const plId of this.plHeaders.keys()) {
            this.syncPlaylistHeader(plId, this.getPlaylistVolume(plId));
        }
    }

    // Sync the playlist-level Repeat / Mode buttons of a group header.
    // Called from widget ticks (150ms), so all writes are cache-guarded.
    syncPlaylistHeaderControls(plId) {
        const hdr = this.plHeaders.get(plId);
        if (!hdr?.modeBtn || !hdr.root.isConnected) return;
        const pl = game.playlists.get(plId);
        if (!pl) return;

        // Repeat is a per-sound flag; at playlist level it reflects (and
        // toggles) the currently playing sounds. With nothing playing the
        // whole playlist is the pool, so the state stays visible and the
        // button keeps working — the next started track honors it.
        const playingSounds = pl.sounds.filter(s => s.playing);
        const pool = playingSounds.length ? playingSounds : pl.sounds;
        const rep = pool.some(s => s.repeat);
        if (hdr.cachedRepeat !== rep) {
            hdr.cachedRepeat = rep;
            hdr.repeatBtn.classList.toggle("ear-active", rep);
            setTooltip(hdr.repeatBtn, game.i18n.localize(rep ? "EAR.RepeatOn" : "EAR.RepeatOff"));
        }

        const md = getModeData(pl.mode);
        if (hdr.cachedMode !== md.icon) {
            hdr.cachedMode = md.icon;
            hdr.modeIcon.className = md.icon;
            setTooltip(hdr.modeBtn, getModeLabel(pl.mode));
        }
    }

    loadVolumesFromSettings() {
        try {
            const raw = game.settings.get(MODULE_ID, SETTING_PLAYLIST_VOLUMES);
            if (typeof raw === "object" && raw !== null) {
                for (const [plId, v] of Object.entries(raw)) {
                    const nv = clampRatio(Number(v) || 0);
                    this.playlistVolumes[plId] = nv;
                    if (nv > 0) this.savedPlaylistVolumes[plId] = nv;
                }
            } else if (Number.isFinite(raw)) {
                for (const pl of game.playlists?.contents ?? []) {
                    this.playlistVolumes[pl.id] = clampRatio(raw);
                    if (raw > 0) this.savedPlaylistVolumes[pl.id] = raw;
                }
            }
        } catch (e) {}
    }

    // ── Play history ────────────────────────────────────────────────────
    trackPlaying(plId, sId) {
        const last = this.playHistory[this.playHistory.length - 1];
        if (last?.playlistId === plId && last?.soundId === sId) return;
        this.playHistory.push({ playlistId: plId, soundId: sId });
        if (this.playHistory.length > 50) this.playHistory.shift();
    }

    getLastPlayedSound(plId, curId) {
        for (let i = this.playHistory.length - 1; i >= 0; i--) {
            const e = this.playHistory[i];
            if (e.playlistId === plId && e.soundId !== curId) {
                const pl = game.playlists.get(e.playlistId);
                if (pl) { const ps = pl.sounds.get(e.soundId); if (ps) return ps; }
            }
        }
        return null;
    }
}

const S = new EarState();

// ── VolumeController ────────────────────────────────────────────────────────
// Single owner of volume semantics. Effective loudness is a chain:
//   core global channel × playlist volume (EAR, client) × track volume (LOCAL
//   client setting) × normalization. NOTHING here writes ps.volume — that is a
//   server-side document field shared by all clients; per-track mixing must
//   stay local to the user who tuned it.
class VolumeController {
    // ── Track stage (local) ─────────────────────────────────────────────
    getTrackVolume(ps) { return S.getTrackVolume(ps.id); }

    // Live apply (no persistence) — safe to call on every input event.
    setTrackVolumeLive(ps, v) {
        v = clampRatio(v);
        S.trackVolumes[ps.id] = v;
        // User intent wins: kill any scheduled automation before writing.
        cancelGainRamps(ps);
        const eff = clampRatio(S.getPlaylistVolume(ps.parent?.id) * v * getNormalizationGain(ps));
        applyLocalVolume(ps, eff);
    }

    // Persist locally: immediate apply + debounced client-setting write.
    async setTrackVolume(ps, v) {
        v = clampRatio(v);
        if (v > 0) S.savedTrackVolumes[ps.id] = v;
        this.setTrackVolumeLive(ps, v);
        S.scheduleTrackVolumeSave();
    }

    async toggleTrackMute(ps) {
        const cur = this.getTrackVolume(ps);
        if (cur > 0) S.savedTrackVolumes[ps.id] = cur;
        await this.setTrackVolume(ps, cur > 0 ? 0 : (S.savedTrackVolumes[ps.id] ?? 1));
    }

    // ── Playlist stage (client setting) ─────────────────────────────────
    getPlaylistVolume(plId) { return S.getPlaylistVolume(plId); }

    // Live apply — updates every playing sound of the playlist + sibling UIs.
    setPlaylistVolumeLive(plId, v) {
        v = clampRatio(v);
        S.playlistVolumes[plId] = v;
        if (v > 0) S.savedPlaylistVolumes[plId] = v;
        S.applyVolumeToPlaylist(plId);
        S.syncPlaylistHeader(plId, v);
    }

    async setPlaylistVolume(plId, v) {
        await S.setPlaylistVolume(plId, v);
        S.syncPlaylistHeader(plId, clampRatio(Number(v) || 0));
    }

    async togglePlaylistMute(plId) {
        const cur = this.getPlaylistVolume(plId);
        await S.setPlaylistVolume(plId, cur > 0 ? 0 : (S.savedPlaylistVolumes[plId] || 1));
    }
}

const VC = new VolumeController();

// ── EarPlayerWidget ─────────────────────────────────────────────────────────
class EarPlayerWidget {
    #abort;         // AbortController for DOM listeners
    #docAbort;      // AbortController for document-level listeners
    #soundId;
    #playlistId;
    #state;
    #volDragging  = false;
    #volAlt       = false;
    #seekDragging = false;
    #seekOnMove   = null;
    #seekOnUp     = null;
    #updating     = false;
    #prevTimeVal  = -1;
    #lastAudioCheck = 0;
    #updateTimer  = null;
    #volHoldUntil = 0;   // timestamp: skip gain enforcement until doc catches up

    // Cached states to avoid redundant DOM writes
    #cachedPlay   = null;

    // DOM refs
    #wrapper; #playIcon; #trackName;
    #volIcon; #volText; #volSlider;
    #curTime; #totalTime; #seekFill; #seekHandle;

    constructor(soundId, playlistId, ps, pl, duration) {
        this.#soundId = soundId;
        this.#playlistId = playlistId;
        this.#state = S;   // reference singleton
        this.#abort = new AbortController();
        this.#docAbort = new AbortController();
        this._buildDOM(ps, pl, duration);
        this._wireEvents(ps, pl);
        this._startLiveUpdate();
    }

    // Public API ──────────────────────────────────────────────────────
    get wrapper()     { return this.#wrapper; }
    get playlistId()  { return this.#playlistId; }
    get soundId()     { return this.#soundId; }

    // Suppress gain enforcement for a while (covers Foundry's own gainNode
    // resets while the user is adjusting the local volume).
    holdVolume(ms) { this.#volHoldUntil = Math.max(this.#volHoldUntil, Date.now() + ms); }

    // Fresh document references. Handlers must NOT use the ps/pl captured at
    // construction time: Foundry can re-create embedded documents, and updating
    // a stale reference fails silently (e.g. "next track" leaving the old one
    // playing).
    #docs() {
        const pl = game.playlists.get(this.#playlistId);
        return { pl, ps: pl?.sounds.get(this.#soundId) };
    }

    updateName(name) {
        if (this.#trackName.textContent !== name) {
            this.#trackName.textContent = name;
            setTooltip(this.#trackName, name);
        }
    }

    mount(parent) {
        if (!parent.contains(this.#wrapper)) parent.appendChild(this.#wrapper);
    }

    // Remove the widget from EAR state and the DOM.
    // Safe to call multiple times — the underlying destroy() is idempotent.
    _teardown() {
        S.controls.delete(this.#soundId);
        if (S._pendingDelete.has(this.#soundId)) {
            clearTimeout(S._pendingDelete.get(this.#soundId));
            S._pendingDelete.delete(this.#soundId);
        }
        this.destroy();
    }

    destroy() {
        this.#abort.abort();
        this.#docAbort.abort();
        if (this.#seekOnMove) document.removeEventListener("pointermove", this.#seekOnMove, true);
        if (this.#seekOnUp)   document.removeEventListener("pointerup",   this.#seekOnUp,   true);
        this.#seekOnMove = null;
        this.#seekOnUp   = null;
        clearTimeout(this.#updateTimer);
        this.#updateTimer = null;
        if (this.#wrapper?.parentNode) this.#wrapper.remove();
    }

    // ── DOM construction ────────────────────────────────────────────────
    _buildDOM(ps, pl, duration) {
        const hasCtrl = canControl();
        const displayName = getDisplayName(ps);
        const plVolume = this.#state.getPlaylistVolume(this.#playlistId);
        this.#state.playlistVolumes[this.#playlistId] = plVolume;
        const initSlider = this._getSliderValue(ps);
        // Apply the full effective volume (playlist × track × normalization),
        // regardless of what the slider controls.
        const eff = clampRatio(plVolume * S.getTrackVolume(this.#soundId) * getNormalizationGain(ps));
        applyLocalVolume(ps, eff);

        // Root + data attrs
        const player = document.createElement("div");
        player.classList.add("ear-player");
        if (!hasCtrl) player.classList.add("ear-readonly");
        player.dataset.earSoundId = this.#soundId;
        player.dataset.earPlaylistId = this.#playlistId;

        // ── Top row ─────────────────────────────────────────────────────
        const topRow = document.createElement("div");
        topRow.classList.add("ear-top-row");

        if (hasCtrl) {
            const playBtn = document.createElement("button");
            playBtn.classList.add("ear-play-btn");
            this.#playIcon = document.createElement("i");
            this.#playIcon.className = ps.playing ? "fa-solid fa-pause" : "fa-solid fa-play";
            playBtn.appendChild(this.#playIcon);
            setTooltip(playBtn, game.i18n.localize(ps.playing ? "PLAYLIST.SoundPause" : "PLAYLIST.SoundPlay"));
            stopEvent(playBtn);
            topRow.appendChild(playBtn);
        }

        this.#trackName = document.createElement("div");
        this.#trackName.classList.add("ear-track-name");
        this.#trackName.textContent = displayName;
        setTooltip(this.#trackName, displayName);
        topRow.appendChild(this.#trackName);

        // Volume block
        const volC = document.createElement("div");
        volC.classList.add("ear-volume-container");
        this.#volIcon = document.createElement("i");
        this.#volIcon.className = getVolumeIcon(initSlider) + " ear-volume-icon";
        this.#volSlider = document.createElement("input");
        this.#volSlider.type = "range"; this.#volSlider.min = 0; this.#volSlider.max = 1;
        this.#volSlider.step = 0.005; this.#volSlider.value = initSlider;
        this.#volSlider.classList.add("ear-volume-slider");
        updateVolumeSliderFill(this.#volSlider, initSlider);
        this.#volText = document.createElement("span");
        this.#volText.classList.add("ear-vol-text");
        this.#volText.textContent = Math.round(initSlider * 100) + "%";
        volC.appendChild(this.#volIcon);
        volC.appendChild(this.#volSlider);
        volC.appendChild(this.#volText);
        topRow.appendChild(volC);

        if (hasCtrl) {
            const closeBtn = document.createElement("button");
            closeBtn.classList.add("ear-close-btn");
            closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
            setTooltip(closeBtn, game.i18n.localize("PLAYLIST.SoundStop"));
            stopEvent(closeBtn);
            topRow.appendChild(closeBtn);
        }

        // ── Bottom row ──────────────────────────────────────────────────
        const bottomRow = document.createElement("div");
        bottomRow.classList.add("ear-bottom-row");

        const initT = getCurrentTime(ps);
        this.#curTime = document.createElement("span");
        this.#curTime.classList.add("ear-time");
        this.#curTime.textContent = formatTime(initT);

        const seekTrack = document.createElement("div");
        seekTrack.classList.add("ear-seek-track");
        this.#seekFill = document.createElement("div");
        this.#seekFill.classList.add("ear-seek-fill");
        this.#seekHandle = document.createElement("div");
        this.#seekHandle.classList.add("ear-seek-handle");
        const ir = clampRatio(duration > 0 ? initT / duration : 0);
        this.#seekFill.style.width = (ir * 100).toFixed(2) + "%";
        this.#seekHandle.style.left = (ir * 100).toFixed(2) + "%";
        seekTrack.appendChild(this.#seekFill);
        seekTrack.appendChild(this.#seekHandle);

        this.#totalTime = document.createElement("span");
        this.#totalTime.classList.add("ear-time", "right");
        setTooltip(this.#totalTime, loc("EAR.ToggleRemaining"));
        const st = S.showRemaining;
        this.#totalTime.textContent = duration > 0
            ? (st ? "-" + formatTime(duration - initT) : formatTime(duration))
            : "--:--";

        bottomRow.appendChild(this.#curTime);
        bottomRow.appendChild(seekTrack);
        bottomRow.appendChild(this.#totalTime);

        // Controls group
        if (hasCtrl) {
            const cg = document.createElement("div");
            cg.classList.add("ear-controls-group");

            const prevBtn = c("button", "ear-transport-btn", `<i class="fa-solid fa-backward-step"></i>`, game.i18n.localize("PLAYLIST.Backward"));
            const nextBtn = c("button", "ear-transport-btn", `<i class="fa-solid fa-forward-step"></i>`, game.i18n.localize("PLAYLIST.Forward"));

            cg.appendChild(prevBtn); cg.appendChild(nextBtn);
            bottomRow.appendChild(cg);
        }

        player.appendChild(topRow);
        player.appendChild(bottomRow);
        this.#wrapper = player;

        function c(tag, cls, html, tip) {
            const el = document.createElement(tag);
            if (cls) el.classList.add(...cls.split(" "));
            if (html) el.innerHTML = html;
            if (tip) setTooltip(el, tip);
            stopEvent(el);
            return el;
        }
    }

    // ── Event wiring ────────────────────────────────────────────────────
    _wireEvents(ps, pl) {
        const { signal } = this.#abort;

        // Play/Pause
        const playBtn = this.#wrapper.querySelector(".ear-play-btn");
        if (playBtn) {
            playBtn.addEventListener("click", async e => {
                e.stopPropagation(); e.preventDefault();
                const { ps, pl } = this.#docs();
                if (!ps) return;
                const wasPlaying = ps.playing;
                // Optimistic visual feedback — the live-update loop corrects the
                // icon if the update fails or another client changes the state.
                if (this.#playIcon) {
                    this.#playIcon.className = wasPlaying ? "fa-solid fa-play" : "fa-solid fa-pause";
                    this.#cachedPlay = !wasPlaying;
                    setTooltip(this.#playIcon.parentNode, game.i18n.localize(wasPlaying ? "PLAYLIST.SoundPlay" : "PLAYLIST.SoundPause"));
                }
                if (wasPlaying) {
                    await safeUpdate(ps, { pausedTime: getCurrentTime(ps) || 0.001, playing: false });
                } else {
                    if (e.shiftKey && pl) {
                        const pm = pl.mode;
                        if (pm !== 2) await safeUpdate(pl, { mode: 2 });
                        await safeUpdate(ps, { playing: true });
                        if (pm !== 2) setTimeout(() => safeUpdate(pl, { mode: pm }), 500);
                        return;
                    }
                    await safeUpdate(ps, { playing: true });
                }
            }, { signal });
        }

        // Stop/close
        const closeBtn = this.#wrapper.querySelector(".ear-close-btn");
        if (closeBtn) {
            closeBtn.addEventListener("click", async e => {
                e.stopPropagation(); e.preventDefault();
                const { ps } = this.#docs();
                if (!ps) return;
                stopPreview(this.#soundId);
                await safeUpdate(ps, { playing: false, pausedTime: null });
                this._teardown();
            }, { signal });
        }

        // Volume slider
        stopEvent(this.#volSlider);
        this.#volSlider.addEventListener("click", e => e.stopPropagation(), { signal });
        this.#volSlider.addEventListener("mousedown", e => {
            e.stopPropagation(); this.#volDragging = true; this.#volAlt = e.altKey; S.setInteractionLock(true);
        }, { signal });
        this.#volSlider.addEventListener("touchstart", () => {
            this.#volDragging = true; S.setInteractionLock(true);
        }, { signal, passive: true });

        const finishVolDrag = async () => {
            if (!this.#volDragging) return;
            this.#volDragging = false;
            const { ps } = this.#docs();
            const v = parseFloat(this.#volSlider.value);
            if (this.#volAlt || !ps) {
                await VC.setPlaylistVolume(this.#playlistId, v);
            } else {
                await VC.setTrackVolume(ps, v);
            }
            // The local volume is applied instantly; this short hold only
            // covers Foundry's own gainNode resets around the update.
            this.holdVolume(400);
            setTimeout(() => S.setInteractionLock(false), 30);
        };
        document.addEventListener("mouseup",   () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });
        document.addEventListener("touchend",  () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });
        document.addEventListener("touchcancel", () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });

        this.#volSlider.addEventListener("input", e => {
            e.stopPropagation();
            const { ps } = this.#docs();
            const v = parseFloat(this.#volSlider.value);
            this._applyVolVisual(v);
            if (e.altKey || !ps) {
                // Alt = quick playlist-level adjustment from the track row.
                VC.setPlaylistVolumeLive(this.#playlistId, v);
            } else {
                VC.setTrackVolume(ps, v);
            }
        }, { signal });

        // Mute toggle: track by default, Alt = whole playlist.
        setTooltip(this.#volIcon, game.i18n.localize("HOTBAR.ACTIONS.Unmute"));
        this.#volIcon.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const { ps } = this.#docs();
            if (e.altKey || !ps) await VC.togglePlaylistMute(this.#playlistId);
            else await VC.toggleTrackMute(ps);
        }, { signal });

        // Total/remaining toggle
        this.#totalTime.addEventListener("click", e => {
            e.stopPropagation(); e.preventDefault();
            S.showRemaining = !S.showRemaining;
        }, { signal });
        stopEvent(this.#totalTime);

        // Seek
        const seekTrack = this.#wrapper.querySelector(".ear-seek-track");
        const hasCtrl = canControl();
        if (hasCtrl) {
            seekTrack.addEventListener("pointerdown", e => this.#seekStart(e), { signal });
            this.#seekHandle.addEventListener("pointerdown", e => this.#seekStart(e), { signal });
            this.#seekHandle.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); }, { signal });
        } else {
            this.#seekHandle.style.display = "none";
            seekTrack.style.cursor = "default";
        }
        seekTrack.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); }, { signal });
        seekTrack.addEventListener("dblclick", e => { e.stopPropagation(); e.preventDefault(); }, { signal });

        // Transport buttons
        const byClass = sel => this.#wrapper.querySelector(sel);
        const prevBtn = byClass(".fa-backward-step")?.parentNode;
        const nextBtn = byClass(".fa-forward-step")?.parentNode;
        if (prevBtn) prevBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const { ps, pl } = this.#docs();
            if (!ps) return;
            const ct = getCurrentTime(ps);
            if (ct >= 3) { await this.#seekTo(ps, 0.001); }
            else if (pl && pl.mode !== 2 && pl.mode !== -1) { await playPrevInPlaylist(pl, this.#soundId); }
            else { await this.#seekTo(ps, 0.001); }
        }, { signal });
        if (nextBtn) nextBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const { ps, pl } = this.#docs();
            if (!ps) return;
            if (!pl || pl.mode === -1 || pl.mode === 2) { await this.#seekTo(ps, 0.001); return; }
            await playNextInPlaylist(pl, this.#soundId);
        }, { signal });
    }

    // ── Seek helpers ────────────────────────────────────────────────────
    _getProgress(e) {
        const seekTrack = this.#wrapper.querySelector(".ear-seek-track");
        const rect = seekTrack.getBoundingClientRect();
        return clampRatio((e.clientX - rect.left) / rect.width);
    }
    _setPos(r) {
        const p = (clampRatio(r) * 100).toFixed(2);
        this.#seekFill.style.width = p + "%";
        this.#seekHandle.style.left = p + "%";
    }
    _updateVis(r, ps, duration) {
        this._setPos(r);
        const dur = getDuration(ps, duration);
        const t = clampRatio(r) * dur;
        this.#curTime.textContent = formatTime(t);
        this.#totalTime.textContent = S.showRemaining ? "-" + formatTime(dur - t) : formatTime(dur);
    }

    #seekStart(e) {
        e.stopPropagation(); e.preventDefault();
        const { ps } = this.#docs();
        if (!ps) return;
        this.#seekDragging = true;
        S.setInteractionLock(true);
        this.#seekHandle.classList.add("ear-dragging");
        this.#seekHandle.setPointerCapture(e.pointerId);
        this.#seekOnMove = ev => { if (!this.#seekDragging) return; ev.stopPropagation(); this._updateVis(this._getProgress(ev), ps, 0); };
        this.#seekOnUp = async ev => {
            if (!this.#seekDragging) return;
            this.#seekDragging = false; ev.stopPropagation();
            this.#seekHandle.classList.remove("ear-dragging");
            document.removeEventListener("pointermove", this.#seekOnMove, true);
            document.removeEventListener("pointerup",   this.#seekOnUp,   true);
            this.#seekOnMove = null;
            this.#seekOnUp   = null;
            this.#updating = true;
            const dur = getDuration(ps, 0);
            let time = clampRatio(this._getProgress(ev)) * dur;
            if (time < 0.5) time = 0.001;
            await this.#seekTo(ps, time);
            this.#updating = false;
        };
        document.addEventListener("pointermove", this.#seekOnMove, true);
        document.addEventListener("pointerup",   this.#seekOnUp,   true);
        this._updateVis(this._getProgress(e), ps, 0);
    }

    async #seekTo(ps, time) {
        S.seekingIds.add(this.#soundId);
        S.setInteractionLock(true);
        const safety = setTimeout(() => { S.seekingIds.delete(this.#soundId); S.setInteractionLock(false); S.refreshDirectory(); }, 5000);
        const wasPlaying = ps.playing;
        // Combine pause + position into one update to halve the round-trips.
        if (wasPlaying) await safeUpdate(ps, { playing: false, pausedTime: time });
        else await safeUpdate(ps, { pausedTime: time });
        if (wasPlaying) await safeUpdate(ps, { playing: true });
        clearTimeout(safety);
        setTimeout(() => { S.seekingIds.delete(this.#soundId); S.setInteractionLock(false); S.refreshDirectory(); }, 120);
    }

    // ── Volume visual ───────────────────────────────────────────────────
    // The slider always displays the track's LOCAL volume.
    _getSliderValue(ps) {
        return VC.getTrackVolume(ps);
    }

    _applyVolVisual(v) {
        this.#volSlider.value = v;
        updateVolumeSliderFill(this.#volSlider, v);
        this.#volIcon.className = getVolumeIcon(v) + " ear-volume-icon";
        this.#volText.textContent = Math.round(v * 100) + "%";
        const muteKey = v > 0 ? "HOTBAR.ACTIONS.Mute" : "HOTBAR.ACTIONS.Unmute";
        setTooltip(this.#volIcon, game.i18n.localize(muteKey));
    }

    // ── Live update loop ────────────────────────────────────────────────
    _startLiveUpdate() {
        const tick = () => {
            if (!S.controls.has(this.#soundId)) {
                this.#updateTimer = setTimeout(tick, 150);
                return;
            }

            const ps = game.playlists.get(this.#playlistId)?.sounds.get(this.#soundId);
            if (!ps) {
                this.#updateTimer = setTimeout(tick, 150);
                return;
            }
            const pl = game.playlists.get(this.#playlistId);
            const dur = getDuration(ps, 0);

            // Play/pause icon + tooltip
            const playing = ps.playing;
            if (this.#cachedPlay !== playing) {
                this.#cachedPlay = playing;
                if (this.#playIcon) {
                    this.#playIcon.className = playing ? "fa-solid fa-pause" : "fa-solid fa-play";
                    const playBtn = this.#playIcon.parentNode;
                    setTooltip(playBtn, game.i18n.localize(playing ? "PLAYLIST.SoundPause" : "PLAYLIST.SoundPlay"));
                }
            }

            // Track name
            this.updateName(getDisplayName(ps));

            // Volume enforcement (defense against Foundry resetting gainNode).
            // Skipped while the user is adjusting this track's volume or
            // shortly after: Foundry's sync can momentarily rewrite the
            // gainNode, and re-asserting mid-adjustment audibly jumps.
            if (!this.#volDragging && !S.wheelActive && Date.now() >= this.#volHoldUntil) {
                const curPlVol = S.getPlaylistVolume(this.#playlistId);
                const normGain = getNormalizationGain(ps);
                const effective = clampRatio(curPlVol * S.getTrackVolume(this.#soundId) * normGain);
                // Write only on a real deviation: re-asserting the same
                // value every tick is wasted work and can click. Cancel any
                // scheduled ramp first (Foundry schedules 500ms fades to
                // the server volume on every document update — writing
                // `.value` during an active ramp is silently ignored).
                try {
                    const cur = ps.sound?.gainNode?.gain?.value;
                    if (!(typeof cur === "number" && Math.abs(cur - effective) < 0.003)) {
                        cancelGainRamps(ps);
                        applyLocalVolume(ps, effective);
                    }
                } catch (_) {
                    applyLocalVolume(ps, effective);
                }

                // Sync volume slider (if not being dragged) to the track's own volume.
                if (!this.#volDragging && !S.interactionLock && !S.wheelActive) {
                    const target = this._getSliderValue(ps);
                    if (Math.abs(parseFloat(this.#volSlider.value) - target) > 0.009) {
                        this._applyVolVisual(target);
                    }
                }
            }

            // Time display
            if (playing && !this.#updating && !this.#seekDragging) {
                const ct = getCurrentTime(ps);
                if (ct < this.#prevTimeVal - 1) log.debug("Loop:", this.#soundId);
                this.#prevTimeVal = ct;
                if (dur > 0) {
                    this._setPos(clampRatio(ct / dur));
                    this.#curTime.textContent = formatTime(ct);
                    this.#totalTime.textContent = S.showRemaining ? "-" + formatTime(dur - ct) : formatTime(dur);
                } else {
                    this.#curTime.textContent = formatTime(ct);
                    this.#totalTime.textContent = "--:--";
                }

                // GM only: periodic audio health check
                if (game.user.isGM) {
                    const now = Date.now();
                    if (now - this.#lastAudioCheck > 30000) {
                        this.#lastAudioCheck = now;
                        try {
                            const sound = ps.sound;
                            if (sound) {
                                const ctx = sound.context || sound._context;
                                if (ctx?.state === "suspended") { ctx.resume().catch(() => {}); log.debug("Resumed AudioContext", this.#soundId); }
                                const node = getAudioNode(ps);
                                if (node?.context?.state === "suspended") { node.context.resume().catch(() => {}); }
                                if (!this.#volDragging && !S.wheelActive && Date.now() >= this.#volHoldUntil && sound.gainNode) {
                                    const eff = clampRatio(S.getPlaylistVolume(this.#playlistId) * S.getTrackVolume(this.#soundId) * getNormalizationGain(ps));
                                    if (Math.abs(sound.gainNode.gain.value - eff) > 0.01) {
                                        cancelGainRamps(ps);
                                        sound.gainNode.gain.value = eff;
                                    }
                                }
                            }
                        } catch (_) {}
                    }
                }
            } else if (!playing && !this.#updating && !this.#seekDragging) {
                const pt = ps.pausedTime ?? 0;
                if (dur > 0) {
                    this._setPos(clampRatio(pt / dur));
                    this.#curTime.textContent = formatTime(pt);
                    this.#totalTime.textContent = S.showRemaining ? "-" + formatTime(dur - pt) : formatTime(dur);
                } else {
                    this._setPos(0);
                    this.#curTime.textContent = formatTime(pt);
                    this.#totalTime.textContent = "--:--";
                }
                this.#prevTimeVal = -1;
            }

            // Header controls (mode / repeat) live at playlist level now.
            S.syncPlaylistHeaderControls(this.#playlistId);

            if (ps.pausedTime !== null || ps.playing) this.#updateTimer = setTimeout(tick, 150);
        };
        tick();
    }
}

// ── Playlist navigation ─────────────────────────────────────────────────────
function _getGlobalChannelVolume(ps) {
    const ch = ps.channel || ps.parent?.channel || "music";
    if (ch === "music") return game.settings.get("core", "globalPlaylistVolume");
    if (ch === "environment") return game.settings.get("core", "globalAmbientVolume");
    if (ch === "interface") return game.settings.get("core", "globalInterfaceVolume");
    return 1;
}

async function playNextInPlaylist(pl, curId) {
    await skipToSound(pl, curId, getNextSoundFromOrder(pl, curId));
}

async function playPrevInPlaylist(pl, curId) {
    const plFresh = game.playlists.get(pl?.id) ?? pl;
    const prev = S.getLastPlayedSound(plFresh?.id, curId) || getPrevSoundFromOrder(plFresh, curId);
    await skipToSound(plFresh, curId, prev);
}

// Shared skip logic for next/prev. Foundry does NOT stop sibling sounds when a
// PlaylistSound is updated directly (only Playlist#playSound does), so the
// skipped track is stopped here — with a hard safety net, because a silent
// failure (stale doc) used to leave BOTH tracks playing.
async function skipToSound(pl, curId, target) {
    if (!pl) return;
    // Fresh documents: captured references can be stale after re-renders.
    pl = game.playlists.get(pl.id) ?? pl;
    const cur = pl.sounds.get(curId);
    if (!target || target.id === curId) return;

    if (cur) await safeUpdate(cur, { playing: false, pausedTime: null });
    await safeUpdate(target, { pausedTime: 0.001, playing: true });

    // Hard safety: shortly after the switch, the skipped track must not still be
    // playing alongside the target. Re-fetches fresh docs before acting.
    setTimeout(() => {
        if (pl.mode === 2) return; // simultaneous mode: coexistence is legal
        const plNow = game.playlists.get(pl.id);
        const curNow = plNow?.sounds.get(curId);
        const targetNow = plNow?.sounds.get(target.id);
        if (curNow?.playing && targetNow?.playing) {
            safeUpdate(curNow, { playing: false, pausedTime: null });
        }
    }, 800);
}

// ── handleDirectory ─────────────────────────────────────────────────────────
async function handleDirectory(directory) {
    if (S.interactionLock) return;
    if (!(directory instanceof foundry.applications.sidebar.tabs.PlaylistDirectory)) return;

    const soundEls = Array.from(document.querySelectorAll(DOM.activeSound))
        .filter(el => el.dataset.playlistId && el.dataset.soundId);

    const activeIds = new Set();
    const sounds = soundEls.map(el => ({
        element: el,
        ps: game.playlists.get(el.dataset.playlistId)?.sounds.get(el.dataset.soundId),
    })).filter(s => s.ps);

    for (const s of sounds) {
        activeIds.add(s.element.dataset.soundId);
        if (s.ps.playing) S.trackPlaying(s.element.dataset.playlistId, s.element.dataset.soundId);
    }

    // Lazy destroy: schedule removal, but cancel if sound reappears within 500ms
    for (const [sid, widget] of S.controls) {
        if (S.seekingIds.has(sid)) continue;
        if (activeIds.has(sid)) {
            // Sound is back — cancel pending delete
            if (S._pendingDelete.has(sid)) {
                clearTimeout(S._pendingDelete.get(sid));
                S._pendingDelete.delete(sid);
            }
            continue;
        }
        // Not in activeIds — schedule destroy if not already pending
        if (!S._pendingDelete.has(sid)) {
            const timer = setTimeout(() => {
                S._pendingDelete.delete(sid);
                const w = S.controls.get(sid);
                if (w && !document.querySelector(`[data-sound-id="${sid}"]`)) {
                    w.destroy();
                    S.controls.delete(sid);
                }
            }, 500);
            S._pendingDelete.set(sid, timer);
        }
    }
    // Also clean up stale pending timers for sounds that no longer exist in game
    for (const [sid, timer] of S._pendingDelete) {
        if (!game.playlists.get(S.controls.get(sid)?.playlistId)?.sounds.get(sid)) {
            clearTimeout(timer);
            S._pendingDelete.delete(sid);
        }
    }

    // Pass 1 — hide Foundry's native controls for every non-streaming sound
    // immediately (synchronously), so its UI never flashes while a track is
    // loading or switching. Streaming tracks keep their native controls.
    for (const s of sounds) {
        if (!s.ps.streaming) hideNativeControls(s.element);
    }

    // Pass 2 — create or re-mount the EAR widget for every sound right away.
    // The widget starts with duration 0 and fills in real values via its own
    // live-update loop once the sound loads. This pass is fully synchronous:
    // concurrent handleDirectory runs (render hook + debounced refresh) cannot
    // interleave here, so only one widget is ever created per track.
    for (const s of sounds) {
        if (s.ps.streaming) continue;
        const soundId = s.element.dataset.soundId;
        const ps = s.ps;
        const plId = s.element.dataset.playlistId;
        const pl = game.playlists.get(plId);

        const existing = S.controls.get(soundId);
        if (existing) {
            existing.wrapper.classList.add("ear-grouped");
            if (!s.element.contains(existing.wrapper)) existing.mount(s.element);
            existing.updateName(getDisplayName(ps));
            continue;
        }

        const widget = new EarPlayerWidget(soundId, plId, ps, pl, getDuration(ps, 0));
        widget.wrapper.classList.add("ear-grouped");
        S.controls.set(soundId, widget);
        s.element.appendChild(widget.wrapper);
    }

    // Pass 2b — group headers: one bar per playlist, inserted before its first
    // playing track. The header owns the PLAYLIST volume stage.
    syncGroupHeaders(sounds);

    // Pass 3 — ensure every sound is loaded (idempotent; Foundry also loads
    // playing sounds on its own).
    for (const s of sounds) {
        if (s.ps.streaming) continue;
        const ps = s.ps;
        if (!ps.sound || !ps.sound.loaded) {
            try { await ps.load(); } catch (e) { log.error("Load:", e.message); }
        }
    }
    setTimeout(injectPreviewControls, 16);
}

// ── Playlist group headers ──────────────────────────────────────────────────
// Insert (or move) one header bar per active playlist before its first track,
// and drop headers whose playlist no longer has playing tracks. Idempotent:
// safe to run on every directory render.
function syncGroupHeaders(sounds) {
    const seen = new Set();
    const lastOfGroup = new Map(); // plId → soundId of the group's last track
    for (const s of sounds) {
        const plId = s.element.dataset.playlistId;
        if (!plId) continue;
        lastOfGroup.set(plId, s.element.dataset.soundId);
        if (seen.has(plId)) continue;
        seen.add(plId);

        let hdr = S.plHeaders.get(plId);
        if (!hdr || !hdr.root.isConnected) {
            if (hdr) { hdr.ac?.abort(); hdr.root.remove(); }
            hdr = buildPlaylistHeader(plId);
            if (!hdr) continue;
            S.plHeaders.set(plId, hdr);
        }
        // insertBefore moves an already-connected node — keeps the header glued
        // to the first track of the playlist even after Foundry re-renders.
        s.element.parentNode.insertBefore(hdr.root, s.element);
        S.syncPlaylistHeader(plId, S.getPlaylistVolume(plId));
        S.syncPlaylistHeaderControls(plId);
    }
    // Mark the last track of each group so CSS can close its bottom corners
    // and end the guide line (":last-child" is unusable — .sound siblings mix
    // playlists in the DOM).
    for (const [plId, sid] of lastOfGroup) {
        for (const [ctrlId, w] of S.controls) {
            w.wrapper.classList.toggle("ear-group-end", ctrlId === sid && w.playlistId === plId);
        }
    }
    // Collapse state — animated. hdr.appliedCollapse tracks the applied state:
    // the first sync applies instantly (fresh render), a state change runs the
    // height/opacity animation.
    for (const [plId, hdr] of S.plHeaders) {
        if (!seen.has(plId)) { hdr.ac?.abort(); hdr.root.remove(); S.plHeaders.delete(plId); continue; }
        const collapsed = S.collapsedPls.has(plId);
        hdr.root.classList.toggle("ear-collapsed", collapsed);
        if (hdr.collapseIcon) {
            hdr.collapseIcon.className = collapsed ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-up";
            setTooltip(hdr.collapseBtn, loc(collapsed ? "EAR.Expand" : "EAR.Collapse"));
        }
        const rows = sounds.filter(s => s.element.dataset.playlistId === plId);
        if (hdr.appliedCollapse === undefined) {
            for (const s of rows) s.element.style.display = collapsed ? "none" : "";
            hdr.appliedCollapse = collapsed;
        } else if (hdr.appliedCollapse !== collapsed) {
            hdr.appliedCollapse = collapsed;
            animateGroupCollapse(plId, hdr, rows, collapsed);
        }
        syncRailHeight(plId, hdr);
    }
}

// Exact rail height: from the header top to the bottom of the group's last
// track. Collapsed groups wrap just the header.
function syncRailHeight(plId, hdr) {
    if (S.collapsedPls.has(plId) || !hdr.root.isConnected) {
        hdr.root.style.setProperty("--ear-group-h", hdr.root.offsetHeight + "px");
        return;
    }
    let lastEl = null;
    for (const [, w] of S.controls) {
        if (w.playlistId === plId && w.wrapper.classList.contains("ear-group-end")) {
            lastEl = w.wrapper.closest(".sound");
            break;
        }
    }
    if (!lastEl) return;
    const h = lastEl.getBoundingClientRect().bottom - hdr.root.getBoundingClientRect().top;
    if (h > 0) hdr.root.style.setProperty("--ear-group-h", h + "px");
}

// Smooth collapse/expand: rows animate height+opacity, then collapse to
// display:none (expand: the reverse). The rail follows via its own CSS
// height transition and is re-measured exactly at the end.
function animateGroupCollapse(plId, hdr, rows, collapse) {
    const DUR = 250;
    if (!rows.length) { syncRailHeight(plId, hdr); return; }

    if (!collapse) {
        // Rail target upfront: header + full row content heights.
        const targetH = hdr.root.offsetHeight + rows.reduce((a, s) => a + (s.element.scrollHeight || 0), 0);
        hdr.root.style.setProperty("--ear-group-h", targetH + "px");
    }

    if (collapse) {
        for (const s of rows) {
            const el = s.element;
            el.style.overflow = "hidden";
            el.style.height = el.offsetHeight + "px";
            el.style.opacity = "1";
        }
        void document.body.offsetHeight; // commit start values
        for (const s of rows) {
            const el = s.element;
            el.classList.add("ear-animating");
            el.style.height = "0px";
            el.style.opacity = "0";
        }
    } else {
        for (const s of rows) {
            const el = s.element;
            el.style.display = "";
            el.classList.add("ear-animating");
            el.style.overflow = "hidden";
            el.style.height = "0px";
            el.style.opacity = "0";
        }
        void document.body.offsetHeight; // commit start values
        for (const s of rows) {
            const el = s.element;
            el.style.height = el.scrollHeight + "px";
            el.style.opacity = "1";
        }
    }

    setTimeout(() => {
        for (const s of rows) {
            const el = s.element;
            if (collapse) el.style.display = "none";
            el.classList.remove("ear-animating");
            el.style.overflow = "";
            el.style.height = "";
            el.style.opacity = "";
        }
        syncRailHeight(plId, hdr);
    }, DUR + 30);
}

function buildPlaylistHeader(plId) {
    const pl = game.playlists.get(plId);
    if (!pl) return null;

    const root = document.createElement("div");
    root.classList.add("ear-pl-header");
    root.dataset.playlistId = plId;

    // Collapse toggle — hides every track of the group.
    const collapseBtn = document.createElement("button");
    collapseBtn.classList.add("ear-transport-btn", "ear-collapse-btn");
    const collapseIcon = document.createElement("i");
    collapseIcon.className = "fa-solid fa-chevron-up";
    collapseBtn.appendChild(collapseIcon);
    setTooltip(collapseBtn, loc("EAR.Collapse"));
    stopEvent(collapseBtn);
    collapseBtn.addEventListener("click", e => {
        e.stopPropagation(); e.preventDefault();
        if (S.collapsedPls.has(plId)) S.collapsedPls.delete(plId);
        else S.collapsedPls.add(plId);
        S.refreshDirectory();
    });
    root.appendChild(collapseBtn);

    const name = document.createElement("div");
    name.classList.add("ear-pl-name");
    name.textContent = pl.name;
    setTooltip(name, pl.name);
    root.appendChild(name);

    // Volume block pinned to the right edge, mirroring the track rows.
    const volC = document.createElement("div");
    volC.classList.add("ear-volume-container");
    const icon = document.createElement("i");
    const slider = document.createElement("input");
    const text = document.createElement("span");

    volC.appendChild(icon);
    volC.appendChild(slider);
    volC.appendChild(text);
    root.appendChild(volC);

    icon.className = getVolumeIcon(S.getPlaylistVolume(plId)) + " ear-volume-icon";
    slider.type = "range"; slider.min = 0; slider.max = 1; slider.step = 0.005;
    slider.value = S.getPlaylistVolume(plId);
    slider.classList.add("ear-volume-slider");
    updateVolumeSliderFill(slider, parseFloat(slider.value));
    text.classList.add("ear-vol-text");
    text.textContent = Math.round(parseFloat(slider.value) * 100) + "%";
    setTooltip(slider, loc("EAR.PlaylistVolume"));
    stopEvent(slider);

    let dragging = false;
    let altDrag = false;

    slider.addEventListener("mousedown", e => {
        e.stopPropagation();
        dragging = true;
        altDrag = e.altKey;
        const hdr = S.plHeaders.get(plId);
        if (hdr) hdr.dragging = true;
        S.setInteractionLock(true);
    });
    slider.addEventListener("touchstart", () => {
        dragging = true;
        const hdr = S.plHeaders.get(plId);
        if (hdr) hdr.dragging = true;
        S.setInteractionLock(true);
    }, { passive: true });

    // AbortController so the document-level drag listeners die with the header.
    const ac = new AbortController();

    const finish = async () => {
        if (!dragging) return;
        dragging = false;
        const hdr = S.plHeaders.get(plId);
        if (hdr) hdr.dragging = false;
        const v = parseFloat(slider.value);
        // Alt on a header slider targets the global music channel instead.
        if (altDrag) await game.settings.set("core", "globalPlaylistVolume", v);
        else await VC.setPlaylistVolume(plId, v);
        altDrag = false;
        setTimeout(() => S.setInteractionLock(false), 30);
    };
    document.addEventListener("mouseup", finish, { signal: ac.signal });
    document.addEventListener("touchend", finish, { signal: ac.signal });
    document.addEventListener("touchcancel", finish, { signal: ac.signal });

    slider.addEventListener("input", e => {
        e.stopPropagation();
        const v = parseFloat(slider.value);
        updateVolumeSliderFill(slider, v);
        icon.className = getVolumeIcon(v) + " ear-volume-icon";
        text.textContent = Math.round(v * 100) + "%";
        if (altDrag || e.altKey) { altDrag = true; game.settings.set("core", "globalPlaylistVolume", v); }
        else VC.setPlaylistVolumeLive(plId, v);
    });

    icon.addEventListener("click", async e => {
        e.stopPropagation(); e.preventDefault();
        if (e.altKey) {
            const cur = clampRatio(game.settings.get("core", "globalPlaylistVolume") ?? 1);
            S.savedGlobalVolume ??= cur;
            await game.settings.set("core", "globalPlaylistVolume", cur > 0 ? 0 : (S.savedGlobalVolume || 1));
            if (cur > 0) S.savedGlobalVolume = cur;
        } else {
            await VC.togglePlaylistMute(plId);
        }
    });

    // ── Playlist-level transport: Repeat / Mode ───────────────────────
    let repeatBtn = null, modeBtn = null, modeIcon = null;
    if (canControl()) {
        const cg = document.createElement("div");
        cg.classList.add("ear-controls-group");

        repeatBtn = document.createElement("button");
        repeatBtn.classList.add("ear-transport-btn");
        repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
        setTooltip(repeatBtn, game.i18n.localize("EAR.RepeatOff"));
        stopEvent(repeatBtn);
        repeatBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            // Playing sounds if any, otherwise the whole playlist — the button
            // must work while nothing is playing too.
            const playing = pl.sounds.filter(s => s.playing);
            const pool = playing.length ? playing : pl.sounds;
            // Optimistic feedback — corrected by syncPlaylistHeaderControls.
            const next = !pool.some(s => s.repeat);
            repeatBtn.classList.toggle("ear-active", next);
            hdrCache.cachedRepeat = next;
            setTooltip(repeatBtn, game.i18n.localize(next ? "EAR.RepeatOn" : "EAR.RepeatOff"));
            await Promise.all(pool.map(s => safeUpdate(s, { repeat: next })));
        });

        modeBtn = document.createElement("button");
        modeBtn.classList.add("ear-transport-btn");
        modeIcon = document.createElement("i");
        modeIcon.className = getModeData(pl.mode).icon;
        modeBtn.appendChild(modeIcon);
        setTooltip(modeBtn, getModeLabel(pl.mode));
        stopEvent(modeBtn);
        modeBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const next = getNextMode(pl.mode);
            // Optimistic feedback — corrected by syncPlaylistHeaderControls.
            modeIcon.className = getModeData(next).icon;
            hdrCache.cachedMode = getModeData(next).icon;
            setTooltip(modeBtn, getModeLabel(next));
            await safeUpdate(pl, { mode: next });
        });

        cg.appendChild(repeatBtn);
        cg.appendChild(modeBtn);
        root.appendChild(cg);
    }

    const hdrCache = { cachedRepeat: undefined, cachedMode: undefined };
    return { root, icon, slider, text, collapseBtn, collapseIcon, repeatBtn, modeBtn, modeIcon, ac, dragging: false, ...hdrCache };
}

function hideNativeControls(el) {
    const hdr = el.querySelector("header");
    if (hdr) hdr.style.display = "none";
    const pb = el.querySelector(".sound-playback.flexrow");
    if (pb) pb.style.display = "none";
    const nt = el.querySelector(".sound-timer");
    if (nt) nt.style.display = "none";
}

// ── Monkey-patch PlaylistDirectory.render ────────────────────────────────────
// ApplicationV2#render is async and resolves to the Application instance, so the
// short-circuited return must preserve that contract (a bare `this` would break
// callers that chain `.then()` on the render Promise).
const PlaylistDir = foundry.applications.sidebar.tabs.PlaylistDirectory;
const _origRender = PlaylistDir.prototype.render;
PlaylistDir.prototype.render = function (...args) {
    if (S.interactionLock) return Promise.resolve(this);
    return _origRender.apply(this, args);
};

// ── Foundry hooks ───────────────────────────────────────────────────────────
Hooks.once("init", () => {
    // ── Internal settings (config: false, no UI) ──────────────────────────
    game.settings.register(MODULE_ID, SETTING_PLAYLIST_VOLUMES, {
        scope: "client",
        config: false,
        type: Object,
        default: {},
        onChange: all => {
            if (typeof all !== "object" || all === null) return;
            for (const [plId, v] of Object.entries(all)) {
                const nv = clampRatio(Number(v) || 0);
                S.playlistVolumes[plId] = nv;
                if (nv > 0) S.savedPlaylistVolumes[plId] = nv;
                S.applyVolumeToPlaylist(plId);
                S.syncPlaylistHeader(plId, nv);
            }
        },
    });
    // Per-user track mixing — client scope, never touches the shared document.
    game.settings.register(MODULE_ID, SETTING_TRACK_VOLUMES, {
        scope: "client",
        config: false,
        type: Object,
        default: {},
        onChange: all => {
            if (typeof all !== "object" || all === null) return;
            for (const [sId, v] of Object.entries(all)) {
                S.trackVolumes[sId] = clampRatio(Number(v) || 0);
            }
            S.applyAllVolumes();
        },
    });
    game.settings.register(MODULE_ID, NORM_SETTING, {
        scope: "client", config: false, type: Object, default: {},
        onChange: () => invalidateNormGains(),
    });
});

Hooks.once("ready", () => {
    S.loadVolumesFromSettings();
    S.loadTrackVolumesFromSettings();
    if (game.user.isGM) ensurePreviewObserver();
});

// `renderPlaylistDirectory` fires for every PlaylistDirectory render; the generic
// `renderSidebarTab` hook would fire for the same render again, so it is not subscribed.
Hooks.on("renderPlaylistDirectory", dir => {
    if (!S.interactionLock) handleDirectory(dir);
    setTimeout(injectPreviewControls, 16);
});

Hooks.on("updatePlaylistSound", (sound, changes) => {
    if (S.seekingIds.has(sound.id)) return;
    if (S.interactionLock) return;

    // Stop preview when a track starts playing natively
    if (changes.playing === true) stopPreview(sound.id);

    const plId = sound.parent?.id;

    // Foundry's own sync rewrites the gainNode to channel × track volume,
    // silently dropping the EAR playlist stage. This happens on EVERY document
    // update (repeat toggle, pausedTime syncs, …) and was audible as a volume
    // dip. Foundry applies its audio sync AFTER this hook runs, so a single
    // synchronous re-assert is not enough — re-assert now and at short
    // deferred checkpoints until Foundry settles. Starting tracks are excluded:
    // their dedicated branch below owns the initial volume.
    if (plId && changes.playing !== true) {
        // Recompute the target at each checkpoint: the user may move the local
        // volume slider between timers. Foundry's sync() answers EVERY update
        // of a playing sound with `sound.fade(volume, {duration: 500})` — a
        // scheduled Web Audio ramp to the server-side volume. Writing `.value`
        // alone cannot beat an active ramp, so each checkpoint cancels the
        // scheduled automation first.
        const reassert = () => {
            cancelGainRamps(sound);
            const t = clampRatio(S.getPlaylistVolume(plId) * S.getTrackVolume(sound.id) * getNormalizationGain(sound));
            applyLocalVolume(sound, t);
        };
        reassert();
        setTimeout(reassert, 0);
        setTimeout(reassert, 50);
        setTimeout(reassert, 250);
    }

    // Natural end detection
    const stopped = changes.playing === false && (changes.pausedTime === undefined || changes.pausedTime === null);
    if (stopped) {
        stopPreview(sound.id);

        const w = S.controls.get(sound.id);
        if (w) {
            if (S._pendingDelete.has(sound.id)) {
                clearTimeout(S._pendingDelete.get(sound.id));
                S._pendingDelete.delete(sound.id);
            }
            w.destroy();
            S.controls.delete(sound.id);
        }
    }

    // A starting track must come up at EAR's effective volume right away:
    // Foundry's own sync only knows channel × document volume. As above,
    // short deferred checkpoints outlast Foundry's post-hook sync + ramp.
    if (changes.playing === true && plId) {
        const assert = () => {
            cancelGainRamps(sound);
            const t = clampRatio(S.getPlaylistVolume(plId) * S.getTrackVolume(sound.id) * getNormalizationGain(sound));
            applyLocalVolume(sound, t);
        };
        assert();
        setTimeout(assert, 0);
        setTimeout(assert, 50);
        setTimeout(assert, 250);
    }
    S.refreshDirectory();
});

// ── Preview injection on ALL sound list items ───────────────────────────────
function injectPreviewControls() {
    if (!game.user.isGM) return;

    for (const el of document.querySelectorAll("#playlists .sound")) {
        if (el.closest(".currently-playing")) continue;
        if (el.querySelector("[data-ear-preview]")) continue;

        const sId = el.dataset.soundId;
        const plId = el.dataset.playlistId
            || el.closest("[data-playlist-id]")?.dataset?.playlistId;
        if (!sId || !plId) continue;

        const ps = game.playlists.get(plId)?.sounds.get(sId);
        if (!ps) continue;

        // Create preview button with same classes as native controls.
        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add("inline-control", "sound-control", "icon", "fa-solid", "fa-headphones");
        btn.dataset.earPreview = "true";
        setTooltip(btn, loc("EAR.Preview"));
        stopEvent(btn);

        btn.addEventListener("click", e => {
            e.stopPropagation(); e.preventDefault();
            btn.blur();
            if (isPreviewing(sId)) {
                stopPreview(sId);
                btn.classList.remove("ear-active");
            } else {
                previewSound(ps, clampRatio(S.getPlaylistVolume(plId) * S.getTrackVolume(sId) * getNormalizationGain(ps) * _getGlobalChannelVolume(ps)));
                btn.classList.add("ear-active");
            }
        });

        if (isPreviewing(sId)) btn.classList.add("ear-active");

        const controls = el.querySelector(".sound-controls");
        if (controls) {
            controls.insertBefore(btn, controls.firstChild);
        } else {
            el.appendChild(btn);
        }
    }
}

// Observe #playlists for DOM mutations and re-apply preview buttons / flex styles.
let _previewObserver = null;
let _previewObserverTimer = null;

function ensurePreviewObserver() {
    if (!game.user.isGM || _previewObserver) return;
    const target = document.querySelector("#playlists");
    if (!target) return;

    _previewObserver = new MutationObserver(() => {
        // Debounce: DOM churn (widget mounts, re-renders) can fire this often.
        clearTimeout(_previewObserverTimer);
        _previewObserverTimer = setTimeout(() => {
            _previewObserverTimer = null;
            for (const el of document.querySelectorAll("#playlists .sound")) {
                if (el.closest(".currently-playing")) continue;
                if (el.querySelector("[data-ear-preview]")) continue;

                const sId = el.dataset.soundId;
                const plId = el.dataset.playlistId || el.closest("[data-playlist-id]")?.dataset?.playlistId;
                if (!sId || !plId) continue;
                if (!game.playlists.get(plId)?.sounds.get(sId)) continue;

                injectPreviewControls();
                break;
            }
        }, 50);
    });

    _previewObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sound-id"] });
    log.debug("Preview MutationObserver started");
}

Hooks.on("updatePlaylist", () => { if (!S.interactionLock) S.refreshDirectory(); injectPreviewControls(); });

Hooks.on("preUpdatePlaylistSound", (doc, changes) => {
    if (changes.pausedTime === 0) changes.pausedTime = 0.001;
});

// ── Global wheel handler (track rows) ───────────────────────────────────────
document.addEventListener("wheel", e => {
    const earEl = e.target.closest(DOM.player);
    if (!earEl) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

    const soundId = earEl.dataset.earSoundId;
    const plId = earEl.dataset.earPlaylistId;
    if (!soundId || !plId) return;

    const slider = earEl.querySelector(DOM.volSlider);
    if (!slider) return;

    S.wheelActive = true;
    const cur = parseFloat(slider.value);
    const nv = clampRatio(cur + (e.deltaY < 0 ? 0.01 : -0.01));

    slider.value = nv;
    updateVolumeSliderFill(slider, nv);
    const icon = earEl.querySelector(DOM.volIcon);
    if (icon) icon.className = getVolumeIcon(nv) + " ear-volume-icon";
    const text = earEl.querySelector(DOM.volText);
    if (text) text.textContent = Math.round(nv * 100) + "%";

    const ps = game.playlists.get(plId)?.sounds.get(soundId);
    // Default: this track only. Alt: whole playlist.
    if (e.altKey) {
        VC.setPlaylistVolumeLive(plId, nv);
    } else if (ps) {
        VC.setTrackVolume(ps, nv);
    }

    clearTimeout(S.wheelThrottle);
    S.wheelThrottle = setTimeout(async () => {
        S.wheelThrottle = null;
        const final = parseFloat(slider.value);
        if (!ps) return;
        if (e.altKey) await VC.setPlaylistVolume(plId, final);
        else await VC.setTrackVolume(ps, final);
        S.controls.get(soundId)?.holdVolume(400);
        setTimeout(() => { S.wheelActive = false; }, 50);
    }, 250);
}, { passive: false, capture: true });

// ── Module API (accessible via game.modules.get("ear").api) ──────────────────
Hooks.once("ready", () => {
    game.modules.get(MODULE_ID).api = {
        /** Analyze all tracks in a playlist and set per-track normalization gains. */
        async normalizePlaylist(plId) {
            if (!game.user.isGM) return ui.notifications.warn("GM only.");
            const pl = game.playlists.get(plId);
            if (!pl) return ui.notifications.error("Playlist not found.");

            const n = ui.notifications.info(loc("EAR.NormalizeProgress", { name: pl.name, cur: 0, total: "?" }), { permanent: true });
            try {
                const gains = await analyzePlaylist(plId, (done, total, name) => {
                    n.textContent = loc("EAR.NormalizeProgress", { name: pl.name, cur: done, total: total });
                });
                if (gains && Object.keys(gains).length > 0) {
                    await setNormalizationGains(plId, gains);
                    S.applyVolumeToPlaylist(plId);
                    n.textContent = loc("EAR.NormalizeDone", { name: pl.name, count: Object.keys(gains).length });
                    setTimeout(() => n.remove(), 3000);
                } else {
                    n.remove();
                    ui.notifications.warn(loc("EAR.NormalizeEmpty"));
                }
            } catch (e) {
                n.remove();
                log.error("Normalization failed:", e.message);
                ui.notifications.error(e.message);
            }
        },

        /** Remove normalization from a playlist. */
        resetNormalization(plId) {
            clearNormalization(plId);
            S.applyVolumeToPlaylist(plId);
            ui.notifications.info(loc("EAR.NormalizeCleared"));
        },

        /** Stop all local previews. */
        stopAllPreviews,
    };
});
