import {
    MODULE_ID, log, DOM, loc, canControl, clampRatio, formatTime, setTooltip, stopEvent,
    getAudioNode, getCurrentTime, getDuration, applyLocalVolume, getVolumeIcon,
    updateVolumeSliderFill, getPlaybackOrder, getNextSoundFromOrder, getPrevSoundFromOrder,
    safeUpdate, getDisplayName,
    fadeGain, fadingSounds, cancelGainRamps, crossfade,
    previewSound, stopPreview, isPreviewing, stopAllPreviews,
    getNormalizationGain,
    analyzePlaylist, setNormalizationGains, clearNormalization, invalidateNormGains, NORM_SETTING,
    VOLUME_TARGET_SETTING, VOLUME_TARGET, getVolumeTarget, invalidateVolumeTarget,
} from "./common.mjs";

log.info("Initialized");

// ── Constants ───────────────────────────────────────────────────────────────
const SETTING_PLAYLIST_VOLUMES = "playlistVolumes";
const SETTING_FADE_DURATION    = "fadeDuration";
const SETTING_XFADE_DURATION   = "crossfadeDuration";
const SETTING_FADE_ENABLED     = "fadeEnabled";
const SETTING_XFADE_ENABLED    = "crossfadeEnabled";
const SETTING_TRACK_INTERVAL   = "trackInterval";
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
    savedPlaylistVolumes = {};          // playlistId → last non-zero
    savedTrackVolumes    = {};          // soundId → last non-zero track volume
    savedGlobalVolume    = undefined;   // last non-zero core.globalPlaylistVolume
    playHistory          = [];          // [{playlistId, soundId}]
    showRemaining        = false;
    trackEnded           = {};          // playlistId → true (natural end, awaiting interval)
    intervalWait         = new Set();   // soundId → playing but held silent (track interval)
    _userStopped         = {};          // soundId → true (clicked stop, skip interval)
    _pendingDelete       = new Map();   // soundId → setTimeout id (lazy destroy)
    closing              = new Set();   // soundId → fade-out in progress, row hidden

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
            if (fadingSounds.has(ps.id)) continue;
            // A track waiting out the silence interval must stay silent.
            if (this.intervalWait.has(ps.id)) { applyLocalVolume(ps, 0.0001); continue; }
            const gain = getNormalizationGain(ps);
            applyLocalVolume(ps, clampRatio(vol * (ps.volume ?? 1) * gain));
        }
    }

    applyAllVolumes() {
        for (const pl of game.playlists?.contents ?? []) {
            this.applyVolumeToPlaylist(pl.id);
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

// ── EarPlayerWidget ─────────────────────────────────────────────────────────
class EarPlayerWidget {
    #abort;         // AbortController for DOM listeners
    #docAbort;      // AbortController for document-level listeners
    #soundId;
    #playlistId;
    #state;
    #volDragging  = false;
    #seekDragging = false;
    #seekOnMove   = null;
    #seekOnUp     = null;
    #updating     = false;
    #prevTimeVal  = -1;
    #lastAudioCheck = 0;
    #updateTimer  = null;

    // Cached states to avoid redundant DOM writes
    #cachedPlay   = null;
    #cachedMode   = null;
    #cachedRepeat = null;

    // DOM refs
    #wrapper; #playIcon; #trackName;
    #volIcon; #volText; #volSlider;
    #curTime; #totalTime; #seekFill; #seekHandle;
    #modeBtn; #modeIcon; #repeatBtn;

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

    // ── Public API ──────────────────────────────────────────────────────
    get wrapper()     { return this.#wrapper; }
    get playlistId()  { return this.#playlistId; }
    get soundId()     { return this.#soundId; }

    // Sync the slider to a playlist volume — only meaningful when the slider
    // targets the whole playlist (other targets show their own values).
    syncVolumeUI(v) {
        if (getVolumeTarget() !== VOLUME_TARGET.PLAYLIST) return;
        if (!this.#volDragging && !this.#state.wheelActive) this._applyVolVisual(v);
    }

    // Sync the slider to the global music volume (used when targeting all music).
    syncGlobalVolumeUI() {
        if (getVolumeTarget() !== VOLUME_TARGET.MUSIC) return;
        if (this.#volDragging || this.#state.wheelActive) return;
        this._applyVolVisual(game.settings.get("core", "globalPlaylistVolume") ?? 1);
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
        const initSlider = this._getSliderValue(ps, plVolume);
        // Apply the full effective volume (playlist × track × normalization),
        // regardless of what the slider controls — unless the track is waiting
        // out the silence interval, in which case it must stay silent.
        const eff = clampRatio(plVolume * (ps.volume ?? 1) * getNormalizationGain(ps));
        applyLocalVolume(ps, S.intervalWait.has(this.#soundId) ? 0.0001 : eff);

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
            const divider = document.createElement("div"); divider.classList.add("ear-divider");

            this.#repeatBtn = c("button", "ear-transport-btn");
            this.#repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
            setTooltip(this.#repeatBtn, game.i18n.localize(ps.repeat ? "EAR.RepeatOn" : "EAR.RepeatOff"));
            if (ps.repeat) this.#repeatBtn.classList.add("ear-active");

            const md = getModeData(pl?.mode ?? 0);
            this.#modeBtn = c("button", "ear-transport-btn");
            this.#modeIcon = document.createElement("i");
            this.#modeIcon.className = md.icon;
            this.#modeBtn.appendChild(this.#modeIcon);
            setTooltip(this.#modeBtn, getModeLabel(pl?.mode ?? 0));

            cg.appendChild(prevBtn); cg.appendChild(nextBtn);
            cg.appendChild(divider);
            cg.appendChild(this.#repeatBtn); cg.appendChild(this.#modeBtn);
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
                    // If the track was closing (fade-out close in progress, row hidden),
                    // starting it again cancels the close: stop the fade and re-show the row.
                    if (S.closing.has(this.#soundId)) {
                        S.closing.delete(this.#soundId);
                        cancelGainRamps(ps);
                        const row = this.#wrapper.closest(".sound");
                        if (row) row.style.display = "";
                    }
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

        // Stop/close (with optional fade-out)
        const closeBtn = this.#wrapper.querySelector(".ear-close-btn");
        if (closeBtn) {
            closeBtn.addEventListener("click", async e => {
                e.stopPropagation(); e.preventDefault();
                S._userStopped[this.#soundId] = true;
                stopPreview(this.#soundId);

                const fadeOn  = game.settings.get(MODULE_ID, SETTING_FADE_ENABLED);
                const fadeDur = game.settings.get(MODULE_ID, SETTING_FADE_DURATION);
                if (fadeOn && ps.playing && ps.sound?.gainNode) {
                    // Instant UI feedback: hide the whole row right away. The audio
                    // still fades out in the background; once it reaches silence the
                    // sound is stopped and Foundry drops the (hidden) row.
                    // The id stays in `S.closing` until the fade completes, so
                    // handleDirectory re-hides the row if Foundry re-renders it
                    // (e.g. when another closing track finishes and the directory
                    // is rebuilt) — otherwise the row flickers back into view.
                    S.closing.add(this.#soundId);
                    const row = this.#wrapper.closest(".sound");
                    if (row) row.style.display = "none";
                    fadeGain(ps, 0, fadeDur, async () => {
                        // If the track was started again during the fade, the play
                        // handler has already cleared the closing marker — leave it.
                        if (!S.closing.has(this.#soundId)) return;
                        S.closing.delete(this.#soundId);
                        // If the track was paused or stopped during the fade, leave it as-is
                        // (Foundry already handles its teardown in that case).
                        if (!ps.playing) return;
                        await safeUpdate(ps, { playing: false, pausedTime: null });
                        this._teardown();
                    });
                    this.#playIcon && (this.#playIcon.className = "fa-solid fa-play");
                } else {
                    await safeUpdate(ps, { playing: false, pausedTime: null });
                    this._teardown();
                }
            }, { signal });
        }

        // Volume slider
        stopEvent(this.#volSlider);
        this.#volSlider.addEventListener("click", e => e.stopPropagation(), { signal });
        this.#volSlider.addEventListener("mousedown", e => {
            e.stopPropagation(); this.#volDragging = true; S.setInteractionLock(true);
        }, { signal });
        this.#volSlider.addEventListener("touchstart", () => {
            this.#volDragging = true; S.setInteractionLock(true);
        }, { signal, passive: true });

        const finishVolDrag = async () => {
            if (!this.#volDragging) return;
            this.#volDragging = false;
            const v = parseFloat(this.#volSlider.value);
            const mode = getVolumeTarget();
            if (mode === VOLUME_TARGET.TRACK) {
                // Foundry's debounced per-track update lands shortly after the last input.
                try { ps.debounceVolume?.(v); } catch (_) {}
            } else if (mode === VOLUME_TARGET.MUSIC) {
                await game.settings.set("core", "globalPlaylistVolume", v);
            } else {
                await S.setPlaylistVolume(this.#playlistId, v);
            }
            setTimeout(() => S.setInteractionLock(false), 30);
        };
        document.addEventListener("mouseup",   () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });
        document.addEventListener("touchend",  () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });
        document.addEventListener("touchcancel", () => { if (this.#volDragging) finishVolDrag(); }, { signal: this.#docAbort.signal });

        this.#volSlider.addEventListener("input", e => {
            e.stopPropagation();
            const v = parseFloat(this.#volSlider.value);
            this._applyVolVisual(v);
            const mode = getVolumeTarget();
            if (mode === VOLUME_TARGET.TRACK) {
                // Apply to this track's gain immediately; the server update is
                // debounced by Foundry's `PlaylistSound#debounceVolume`.
                applyLocalVolume(ps, clampRatio(S.getPlaylistVolume(this.#playlistId) * v * getNormalizationGain(ps)));
                try { ps.debounceVolume?.(v); } catch (_) {}
            } else if (mode === VOLUME_TARGET.MUSIC) {
                game.settings.set("core", "globalPlaylistVolume", v);
            } else {
                S.playlistVolumes[this.#playlistId] = v;
                if (v > 0) S.savedPlaylistVolumes[this.#playlistId] = v;
                S.applyVolumeToPlaylist(this.#playlistId);
                for (const [sid, ctrl] of S.controls) {
                    if (sid !== this.#soundId && ctrl.playlistId === this.#playlistId) ctrl.syncVolumeUI(v);
                }
            }
        }, { signal });

        // Mute toggle
        setTooltip(this.#volIcon, game.i18n.localize("HOTBAR.ACTIONS.Unmute"));
        this.#volIcon.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const mode = getVolumeTarget();
            if (mode === VOLUME_TARGET.TRACK) {
                const cur = clampRatio(ps.volume ?? 1);
                const next = cur > 0 ? 0 : (S.savedTrackVolumes[this.#soundId] ?? 1);
                if (cur > 0) S.savedTrackVolumes[this.#soundId] = cur;
                await safeUpdate(ps, { volume: next });
            } else if (mode === VOLUME_TARGET.MUSIC) {
                const cur = clampRatio(game.settings.get("core", "globalPlaylistVolume") ?? 1);
                const next = cur > 0 ? 0 : (S.savedGlobalVolume ?? 1);
                if (cur > 0) S.savedGlobalVolume = cur;
                await game.settings.set("core", "globalPlaylistVolume", next);
            } else {
                const cur = S.getPlaylistVolume(this.#playlistId);
                await S.setPlaylistVolume(this.#playlistId, cur > 0 ? 0 : (S.savedPlaylistVolumes[this.#playlistId] || 1));
            }
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
            seekTrack.addEventListener("pointerdown", e => this.#seekStart(e, ps), { signal });
            this.#seekHandle.addEventListener("pointerdown", e => this.#seekStart(e, ps), { signal });
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
            const ct = getCurrentTime(ps);
            if (ct >= 3) { await this.#seekTo(ps, 0.001); }
            else if (pl && pl.mode !== 2 && pl.mode !== -1) { await playPrevInPlaylist(pl, this.#soundId); }
            else { await this.#seekTo(ps, 0.001); }
        }, { signal });
        if (nextBtn) nextBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (!pl || pl.mode === -1 || pl.mode === 2) { await this.#seekTo(ps, 0.001); return; }
            await playNextInPlaylist(pl, this.#soundId);
        }, { signal });
        if (this.#repeatBtn) this.#repeatBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const next = !ps.repeat;
            // Optimistic feedback — corrected by the live-update loop on failure.
            if (this.#repeatBtn) {
                this.#repeatBtn.classList.toggle("ear-active", next);
                this.#cachedRepeat = next;
                setTooltip(this.#repeatBtn, game.i18n.localize(next ? "EAR.RepeatOn" : "EAR.RepeatOff"));
            }
            await safeUpdate(ps, { repeat: next });
        }, { signal });
        if (this.#modeBtn) this.#modeBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (!pl) return;
            const next = getNextMode(pl.mode);
            // Optimistic feedback — corrected by the live-update loop on failure.
            if (this.#modeIcon) {
                const md = getModeData(next);
                this.#modeIcon.className = md.icon;
                this.#cachedMode = md.icon;
                setTooltip(this.#modeBtn, getModeLabel(next));
            }
            await safeUpdate(pl, { mode: next });
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

    #seekStart(e, ps) {
        e.stopPropagation(); e.preventDefault();
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
    // The value the volume slider should display, based on the selected target.
    _getSliderValue(ps, plVolume) {
        switch (getVolumeTarget()) {
            case VOLUME_TARGET.TRACK:  return clampRatio(ps.volume ?? 1);
            case VOLUME_TARGET.MUSIC:  return clampRatio(game.settings.get("core", "globalPlaylistVolume") ?? 1);
            default:                   return plVolume;
        }
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

            // Volume enforcement (defense against Foundry resetting gainNode;
            // skip during active fades to avoid fighting the scheduled ramp).
            if (!fadingSounds.has(this.#soundId)) {
                // A track waiting out the silence interval is held silent every
                // tick — far more robust than one-shot re-applies.
                if (S.intervalWait.has(this.#soundId)) {
                    applyLocalVolume(ps, 0.0001);
                } else {
                    const curPlVol = S.getPlaylistVolume(this.#playlistId);
                    const normGain = getNormalizationGain(ps);
                    const effective = clampRatio(curPlVol * (ps?.volume ?? 1) * normGain);
                    applyLocalVolume(ps, effective);

                    // Sync volume slider (if not being dragged) to the target's value.
                    if (!this.#volDragging && !S.interactionLock && !S.wheelActive) {
                        const target = this._getSliderValue(ps, curPlVol);
                        if (Math.abs(parseFloat(this.#volSlider.value) - target) > 0.009) {
                            this._applyVolVisual(target);
                        }
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
                                if (!fadingSounds.has(this.#soundId) && sound.gainNode) {
                                    // A track waiting out the silence interval must stay silent.
                                    if (S.intervalWait.has(this.#soundId)) {
                                        sound.gainNode.gain.value = 0.0001;
                                    } else {
                                        const eff = clampRatio(S.getPlaylistVolume(this.#playlistId) * (ps?.volume ?? 1) * getNormalizationGain(ps));
                                        if (Math.abs(sound.gainNode.gain.value - eff) > 0.01) {
                                            sound.gainNode.gain.value = eff;
                                        }
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

            // Mode icon
            if (pl && this.#modeIcon) {
                const md = getModeData(pl.mode);
                if (this.#cachedMode !== md.icon) {
                    this.#cachedMode = md.icon;
                    this.#modeIcon.className = md.icon;
                    setTooltip(this.#modeBtn, getModeLabel(pl.mode));
                }
            }

            // Repeat state
            const isRepeat = ps.repeat;
            if (this.#cachedRepeat !== isRepeat) {
                this.#cachedRepeat = isRepeat;
                if (this.#repeatBtn) {
                    this.#repeatBtn.classList.toggle("ear-active", isRepeat);
                    setTooltip(this.#repeatBtn, game.i18n.localize(isRepeat ? "EAR.RepeatOn" : "EAR.RepeatOff"));
                }
            }

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

function _getCFadeVol(ps) {
    const plId = ps.parent?.id;
    const base = plId ? S.getPlaylistVolume(plId) : 1;
    const norm = getNormalizationGain(ps);
    return clampRatio(base * (ps.volume ?? 1) * norm);
}

async function playNextInPlaylist(pl, curId) {
    if (!pl) return;
    const next = getNextSoundFromOrder(pl, curId);
    if (!next || next.id === curId) return;

    const cur = pl.sounds.get(curId);
    const xfOn  = game.settings.get(MODULE_ID, SETTING_XFADE_ENABLED);
    const xfDur = game.settings.get(MODULE_ID, SETTING_XFADE_DURATION);

    // The current track is being skipped on purpose — it must not count as a
    // natural end, otherwise the silence interval would kick in.
    if (cur) S._userStopped[cur.id] = true;

    if (xfOn && cur?.playing && cur?.sound?.gainNode) {
        // Crossfade: start next silently, then ramp both
        await safeUpdate(next, { pausedTime: 0.001, playing: true });
        const toVol = _getCFadeVol(next);
        if (toVol < 0.0001) { await safeUpdate(cur, { playing: false, pausedTime: null }); return; }
        setTimeout(() => {
            if (cur.sound?.gainNode) crossfade(cur, next, _getCFadeVol(cur), toVol, xfDur);
        }, 100);
    } else {
        if (cur) await safeUpdate(cur, { playing: false, pausedTime: null });
        await safeUpdate(next, { pausedTime: 0.001, playing: true });
    }
}

async function playPrevInPlaylist(pl, curId) {
    if (!pl) return;
    const prev = S.getLastPlayedSound(pl.id, curId) || getPrevSoundFromOrder(pl, curId);
    if (!prev || prev.id === curId) return;

    const cur = pl.sounds.get(curId);
    const xfOn  = game.settings.get(MODULE_ID, SETTING_XFADE_ENABLED);
    const xfDur = game.settings.get(MODULE_ID, SETTING_XFADE_DURATION);

    if (cur) S._userStopped[cur.id] = true;

    if (xfOn && cur?.playing && cur?.sound?.gainNode) {
        await safeUpdate(prev, { pausedTime: 0.001, playing: true });
        const toVol = _getCFadeVol(prev);
        if (toVol < 0.0001) { await safeUpdate(cur, { playing: false, pausedTime: null }); return; }
        setTimeout(() => {
            if (cur.sound?.gainNode) crossfade(cur, prev, _getCFadeVol(cur), toVol, xfDur);
        }, 100);
    } else {
        if (cur) await safeUpdate(cur, { playing: false, pausedTime: null });
        await safeUpdate(prev, { pausedTime: 0.001, playing: true });
    }
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

    // Drop closing markers for tracks that already left the directory (stopped
    // or deleted while their fade-out was still in progress).
    for (const sid of S.closing) {
        if (!activeIds.has(sid)) S.closing.delete(sid);
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
    // Tracks that are fading out after a close keep their whole row hidden —
    // a directory re-render would otherwise rebuild it visible and the row
    // would flicker back into view until its fade completes.
    for (const s of sounds) {
        const sid = s.element.dataset.soundId;
        if (S.closing.has(sid)) {
            s.element.style.display = "none";
            continue;
        }
        if (!s.ps.streaming) hideNativeControls(s.element);
    }

    // Pass 2 — create or re-mount the EAR widget for every sound right away.
    // The widget starts with duration 0 and fills in real values via its own
    // live-update loop once the sound loads. This pass is fully synchronous:
    // concurrent handleDirectory runs (render hook + debounced refresh) cannot
    // interleave here, so only one widget is ever created per track.
    for (const s of sounds) {
        if (s.ps.streaming || S.closing.has(s.element.dataset.soundId)) continue;
        const soundId = s.element.dataset.soundId;
        const ps = s.ps;
        const plId = s.element.dataset.playlistId;
        const pl = game.playlists.get(plId);

        const existing = S.controls.get(soundId);
        if (existing) {
            if (!s.element.contains(existing.wrapper)) existing.mount(s.element);
            existing.updateName(getDisplayName(ps));
            continue;
        }

        const widget = new EarPlayerWidget(soundId, plId, ps, pl, getDuration(ps, 0));
        S.controls.set(soundId, widget);
        s.element.appendChild(widget.wrapper);
    }

    // Pass 3 — ensure every sound is loaded (idempotent; Foundry also loads
    // playing sounds on its own).
    for (const s of sounds) {
        if (s.ps.streaming || S.closing.has(s.element.dataset.soundId)) continue;
        const ps = s.ps;
        if (!ps.sound || !ps.sound.loaded) {
            try { await ps.load(); } catch (e) { log.error("Load:", e.message); }
        }
    }
    setTimeout(injectPreviewControls, 16);
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
    // ── User-facing settings (config: true) ───────────────────────────────
    game.settings.register(MODULE_ID, VOLUME_TARGET_SETTING, {
        name: "EAR.VolumeTarget", hint: "EAR.VolumeTargetHint",
        scope: "client", config: true, type: String, default: VOLUME_TARGET.PLAYLIST,
        choices: {
            [VOLUME_TARGET.TRACK]:    "EAR.VolumeTargetTrack",
            [VOLUME_TARGET.PLAYLIST]: "EAR.VolumeTargetPlaylist",
            [VOLUME_TARGET.MUSIC]:    "EAR.VolumeTargetMusic",
        },
        onChange: () => invalidateVolumeTarget(),
    });
    game.settings.register(MODULE_ID, SETTING_FADE_ENABLED, {
        name: "EAR.FadeEnabled", hint: "EAR.FadeEnabledHint",
        scope: "client", config: true, type: Boolean, default: true,
    });
    game.settings.register(MODULE_ID, SETTING_XFADE_ENABLED, {
        name: "EAR.CrossfadeEnabled", hint: "EAR.CrossfadeEnabledHint",
        scope: "client", config: true, type: Boolean, default: true,
    });
    game.settings.register(MODULE_ID, SETTING_TRACK_INTERVAL, {
        name: "EAR.TrackInterval", hint: "EAR.TrackIntervalHint",
        scope: "client", config: true, type: Number, default: 0, range: { min: 0, max: 30, step: 0.5 },
    });

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
            }
            for (const [, w] of S.controls) {
                const vol = S.getPlaylistVolume(w.playlistId);
                w.syncVolumeUI(vol);
            }
        },
    });
    // Hidden but still stored — preserves values tuned by existing users.
    game.settings.register(MODULE_ID, SETTING_FADE_DURATION, {
        scope: "client", config: false, type: Number, default: 0.8,
    });
    game.settings.register(MODULE_ID, SETTING_XFADE_DURATION, {
        scope: "client", config: false, type: Number, default: 2.0,
    });
    game.settings.register(MODULE_ID, NORM_SETTING, {
        scope: "client", config: false, type: Object, default: {},
        onChange: () => invalidateNormGains(),
    });
});

Hooks.once("ready", () => {
    S.loadVolumesFromSettings();
    if (game.user.isGM) ensurePreviewObserver();
});

// When the slider targets all music, keep every widget's slider in sync with the
// global playlist volume (also fires for Foundry's own volume control changes).
// Debounced: slider drags fire this hook on every input event.
let _globalVolumeSyncTimer = null;
Hooks.on("globalPlaylistVolumeChanged", () => {
    if (getVolumeTarget() !== VOLUME_TARGET.MUSIC) return;
    clearTimeout(_globalVolumeSyncTimer);
    _globalVolumeSyncTimer = setTimeout(() => {
        _globalVolumeSyncTimer = null;
        for (const [, w] of S.controls) w.syncGlobalVolumeUI();
    }, 50);
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

    // Natural end detection (not triggered by user close)
    const stopped = changes.playing === false && (changes.pausedTime === undefined || changes.pausedTime === null);
    if (stopped) {
        stopPreview(sound.id);
        S.closing.delete(sound.id);
        S.intervalWait.delete(sound.id);
        const userStopped = !!S._userStopped[sound.id];
        delete S._userStopped[sound.id];

        if (!fadingSounds.has(sound.id)) {
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

        // Mark as natural end for interval tracking (only if auto-advancing playlist)
        if (plId && !userStopped) {
            const pl = game.playlists.get(plId);
            if (pl && (pl.mode === 0 || pl.mode === 1)) S.trackEnded[plId] = true;
        }
    }

    if (changes.playing === true || changes.volume !== undefined) {
        if (plId) {
            const vol = S.getPlaylistVolume(plId);
            S.playlistVolumes[plId] = vol;

            const fadeOn  = game.settings.get(MODULE_ID, SETTING_FADE_ENABLED);
            const fadeDur = game.settings.get(MODULE_ID, SETTING_FADE_DURATION);
            const interval = game.settings.get(MODULE_ID, SETTING_TRACK_INTERVAL);
            const normGain = getNormalizationGain(sound);
            const target = clampRatio(vol * (sound.volume ?? 1) * normGain);

            // Track interval: if the previous track ended naturally, hold the new
            // one silent for `interval` seconds before fading it in.
            // The decision is deferred by a macrotask because the natural-end
            // hook for the previous track may fire AFTER this one within the same
            // socket response (hook order follows the track order in the playlist,
            // so it is reversed in shuffle mode or when wrapping to the first track).
            if (changes.playing === true && !fadingSounds.has(sound.id)) {
                setTimeout(() => {
                    if (fadingSounds.has(sound.id)) return;
                    const pending = !!S.trackEnded[plId];
                    if (pending) S.trackEnded[plId] = false;

                    if (pending && interval > 0) {
                        // Start silent; the live-update loop keeps re-applying the
                        // silence until the interval elapses, then fade in.
                        applyLocalVolume(sound, 0.0001);
                        S.intervalWait.add(sound.id);
                        setTimeout(() => {
                            S.intervalWait.delete(sound.id);
                            if (!sound.playing) return; // stopped during the pause
                            if (fadeOn) {
                                fadeGain(sound, target, fadeDur);
                            } else {
                                applyLocalVolume(sound, target);
                            }
                        }, interval * 1000);
                    } else if (fadeOn) {
                        applyLocalVolume(sound, 0.0001);
                        fadeGain(sound, target, fadeDur);
                    } else {
                        applyLocalVolume(sound, target);
                    }
                }, 0);
            } else if (changes.volume !== undefined) {
                const applyVol = () => {
                    if (S.intervalWait.has(sound.id)) applyLocalVolume(sound, 0.0001);
                    else applyLocalVolume(sound, target);
                };
                setTimeout(applyVol, 50);
                setTimeout(applyVol, 400);
            }
        }
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
                previewSound(ps, clampRatio(S.getPlaylistVolume(plId) * (ps.volume ?? 1) * getNormalizationGain(ps) * _getGlobalChannelVolume(ps)));
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

// ── Global wheel handler ────────────────────────────────────────────────────
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
    const mode = getVolumeTarget();
    if (mode === VOLUME_TARGET.TRACK) {
        if (ps) applyLocalVolume(ps, clampRatio(S.getPlaylistVolume(plId) * nv * getNormalizationGain(ps)));
    } else if (mode === VOLUME_TARGET.MUSIC) {
        game.settings.set("core", "globalPlaylistVolume", nv);
    } else {
        S.playlistVolumes[plId] = nv;
        if (nv > 0) S.savedPlaylistVolumes[plId] = nv;
        S.applyVolumeToPlaylist(plId);
        for (const [sid, ctrl] of S.controls) {
            if (sid !== soundId && ctrl.playlistId === plId) ctrl.syncVolumeUI(nv);
        }
    }

    clearTimeout(S.wheelThrottle);
    S.wheelThrottle = setTimeout(async () => {
        S.wheelThrottle = null;
        const final = parseFloat(slider.value);
        if (mode === VOLUME_TARGET.TRACK) {
            try { ps?.debounceVolume?.(final); } catch (_) {}
        } else if (mode === VOLUME_TARGET.MUSIC) {
            await game.settings.set("core", "globalPlaylistVolume", final);
        } else {
            await S.setPlaylistVolume(plId, final);
        }
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
