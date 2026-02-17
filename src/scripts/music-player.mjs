const id = "enhanced-audio-resources";
const log = (arg) => console.info(id, arg);
log("Initialized");

const controls = {};
const playHistory = [];
const path = "#playlists .currently-playing .playlist-sounds .sound";
let showRemaining = false;
let handleDirectoryTimer = null;

let interactionLock = false;
let seekingIds = new Set();

const PlaylistDir = foundry.applications.sidebar.tabs.PlaylistDirectory;

const playlistModes = [
    { value: -1, icon: "fa-solid fa-ban", locKey: "EAR.ModeDisabled" },
    { value: 0, icon: "fa-regular fa-circle-right", locKey: "EAR.ModeSequential" },
    { value: 1, icon: "fa-solid fa-shuffle", locKey: "EAR.ModeShuffle" },
    { value: 2, icon: "fa-solid fa-minimize", locKey: "EAR.ModeSimultaneous" }
];

const modeOrder = [-1, 0, 1, 2];

function loc(key, fallback) {
    return game.i18n?.localize(key) ?? fallback ?? key;
}

function getModeData(mode) {
    return playlistModes.find(m => m.value === mode) || playlistModes[0];
}

function getModeLabel(mode) {
    return loc(getModeData(mode).locKey);
}

function getNextMode(current) {
    const idx = modeOrder.indexOf(current);
    if (idx < 0) return modeOrder[0];
    return modeOrder[(idx + 1) % modeOrder.length];
}

function canControl() {
    return game.user.isGM || game.user.hasPermission("SETTINGS_MODIFY");
}

function getDisplayName(ps) {
    if (game.user.isGM) return ps.name;
    const playlist = ps.parent;
    if (!playlist) return ps.name;
    const level = playlist.ownership?.[game.user.id] ?? playlist.ownership?.default ?? 0;
    if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) return ps.name;
    const channel = playlist.channel || "music";
    const keys = {
        music: "AUDIO.CHANNELS.MUSIC.label",
        environment: "AUDIO.CHANNELS.ENVIRONMENT.label",
        interface: "AUDIO.CHANNELS.INTERFACE.label"
    };
    const key = keys[channel];
    if (key) return game.i18n.localize(key);
    return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function resetControl(soundId) {
    if (!controls[soundId]) return;
    const ctrl = controls[soundId];
    if (ctrl.cleanup) ctrl.cleanup();
    if (ctrl.wrapper?.parentNode) ctrl.wrapper.remove();
    delete controls[soundId];
}

function getAudioNode(ps) {
    const s = ps.sound;
    if (!s) return null;
    return s.sourceNode ?? null;
}

function getCurrentTime(ps) {
    try {
        const s = ps.sound;
        if (!s) return ps.pausedTime ?? 0;
        if (s.currentTime !== undefined && Number.isFinite(s.currentTime)) return s.currentTime;
        const n = getAudioNode(ps);
        if (n && typeof n.currentTime === "number" && Number.isFinite(n.currentTime)) return n.currentTime;
    } catch (e) {}
    return ps.pausedTime ?? 0;
}

function getDuration(ps, fb) {
    try {
        const s = ps.sound;
        if (!s) return fb;
        if (s.duration !== undefined && Number.isFinite(s.duration) && s.duration > 0) return s.duration;
        const n = getAudioNode(ps);
        if (n && typeof n.duration === "number" && Number.isFinite(n.duration) && n.duration > 0) return n.duration;
    } catch (e) {}
    return fb;
}

function clampRatio(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function trackPlaying(plId, sId) {
    const last = playHistory[playHistory.length - 1];
    if (last && last.playlistId === plId && last.soundId === sId) return;
    playHistory.push({ playlistId: plId, soundId: sId });
    if (playHistory.length > 50) playHistory.shift();
}

function getLastPlayedSound(plId, curId) {
    for (let i = playHistory.length - 1; i >= 0; i--) {
        const e = playHistory[i];
        if (e.playlistId === plId && e.soundId !== curId) {
            const pl = game.playlists.get(e.playlistId);
            if (pl) { const ps = pl.sounds.get(e.soundId); if (ps) return ps; }
        }
    }
    return null;
}

function getPlaybackOrder(pl) {
    if (!pl) return [];
    try {
        if (typeof pl._getPlaybackOrder === "function") return pl._getPlaybackOrder();
    } catch (e) {}
    try {
        if (typeof pl.getPlaybackOrder === "function") return pl.getPlaybackOrder();
    } catch (e) {}
    try {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pl), "playbackOrder");
        if (desc && desc.get) return desc.get.call(pl) || [];
    } catch (e) {}
    return Array.from(pl.sounds.keys());
}

function getNextSoundFromOrder(pl, currentSoundId) {
    if (!pl) return null;
    const order = getPlaybackOrder(pl);
    if (!order.length) return null;
    const idx = order.indexOf(currentSoundId);
    if (idx < 0) return pl.sounds.get(order[0]) || null;
    const nextIdx = (idx + 1) % order.length;
    return pl.sounds.get(order[nextIdx]) || null;
}

function getPrevSoundFromOrder(pl, currentSoundId) {
    if (!pl) return null;
    const order = getPlaybackOrder(pl);
    if (!order.length) return null;
    const idx = order.indexOf(currentSoundId);
    if (idx <= 0) return pl.sounds.get(order[order.length - 1]) || null;
    return pl.sounds.get(order[idx - 1]) || null;
}

function getVolumeIcon(v) {
    if (v <= 0) return "fa-solid fa-volume-xmark";
    if (v < 0.33) return "fa-solid fa-volume-off";
    if (v < 0.66) return "fa-solid fa-volume-low";
    return "fa-solid fa-volume-high";
}

function updateVolumeSliderFill(slider, value) {
    slider.style.setProperty("--ear-vol-pct", (value * 100) + "%");
}

function applyLocalVolume(ps, vol) {
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
        if (n && typeof n.volume === "number") {
            n.volume = vol;
        }
    } catch (e) {
        log("Volume err: " + e.message);
    }
}

function setTooltip(el, text) {
    el.dataset.tooltip = text;
    el.dataset.tooltipDirection = "UP";
}

function stopEvent(el) {
    el.addEventListener("mousedown", e => e.stopPropagation());
    el.addEventListener("pointerdown", e => e.stopPropagation());
}

function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const ts = Math.floor(s);
    const h = Math.floor(ts / 3600);
    const m = Math.floor((ts % 3600) / 60);
    const sec = ts % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    return `${m}:${String(sec).padStart(2,"0")}`;
}

function refreshDirectory() {
    if (interactionLock) return;
    if (handleDirectoryTimer) clearTimeout(handleDirectoryTimer);
    handleDirectoryTimer = setTimeout(() => {
        handleDirectoryTimer = null;
        if (!interactionLock) handleDirectory(game.playlists?.directory);
    }, 80);
}

async function safeUpdate(doc, data) {
    try {
        await doc.update(data);
    } catch (e) {
        log("Update error: " + e.message);
    }
}

async function seekSound(ps, time, soundId) {
    seekingIds.add(soundId);
    interactionLock = true;
    const w = ps.playing;
    if (w) await safeUpdate(ps, { playing: false });
    await safeUpdate(ps, { pausedTime: time });
    if (w) await safeUpdate(ps, { playing: true });
    try { ps.synchronize(); } catch(err) {}
    setTimeout(() => {
        seekingIds.delete(soundId);
        interactionLock = false;
        refreshDirectory();
    }, 400);
}

async function playNextInPlaylist(pl, currentSoundId) {
    if (!pl) return;
    try {
        if (typeof pl.playNext === "function") {
            await pl.playNext(currentSoundId, { direction: 1 });
            return;
        }
    } catch (e) {
        log("playNext native error: " + e.message);
    }
    const next = getNextSoundFromOrder(pl, currentSoundId);
    if (next && next.id !== currentSoundId) {
        const current = pl.sounds.get(currentSoundId);
        if (current) await safeUpdate(current, { playing: false, pausedTime: null });
        await safeUpdate(next, { pausedTime: 0.001, playing: true });
        try { next.synchronize(); } catch(err) {}
    }
}

async function playPrevInPlaylist(pl, currentSoundId) {
    if (!pl) return;
    try {
        if (typeof pl.playNext === "function") {
            await pl.playNext(currentSoundId, { direction: -1 });
            return;
        }
    } catch (e) {
        log("playNext(-1) native error: " + e.message);
    }
    const prev = getLastPlayedSound(pl.id, currentSoundId) || getPrevSoundFromOrder(pl, currentSoundId);
    if (prev && prev.id !== currentSoundId) {
        const current = pl.sounds.get(currentSoundId);
        if (current) await safeUpdate(current, { playing: false, pausedTime: null });
        await safeUpdate(prev, { pausedTime: 0.001, playing: true });
        try { prev.synchronize(); } catch(err) {}
    }
}

const origRender = PlaylistDir.prototype.render;
PlaylistDir.prototype.render = function(...args) {
    if (interactionLock) return this;
    return origRender.apply(this, args);
};

const handleDirectory = async (directory) => {
    if (interactionLock) return;
    if (!(directory instanceof PlaylistDir)) return;
    if (!canControl()) return;

    const soundElements = Array.from(document.querySelectorAll(path))
        .filter(el => el.dataset.playlistId && el.dataset.soundId);

    const activeSoundIds = new Set();
    const sounds = soundElements
        .map(el => ({
            element: el,
            playlist_sound: game.playlists.get(el.dataset.playlistId)?.sounds.get(el.dataset.soundId)
        }))
        .filter(s => s.playlist_sound);

    for (const s of sounds) {
        activeSoundIds.add(s.element.dataset.soundId);
        if (s.playlist_sound.playing) trackPlaying(s.element.dataset.playlistId, s.element.dataset.soundId);
    }

    for (const sId of Object.keys(controls)) {
        if (!activeSoundIds.has(sId) && !seekingIds.has(sId)) resetControl(sId);
    }

    for (const sound of sounds) {
        const soundId = sound.element.dataset.soundId;
        const ps = sound.playlist_sound;
        const plId = sound.element.dataset.playlistId;
        const pl = game.playlists.get(plId);

        const hdr = sound.element.querySelector("header");
        if (hdr) hdr.style.display = "none";
        const pb = sound.element.querySelector(".sound-playback.flexrow");
        if (pb) pb.style.display = "none";
        const nt = sound.element.querySelector(".sound-timer");
        if (nt) nt.style.display = "none";

        if (seekingIds.has(soundId)) {
            if (controls[soundId] && !sound.element.contains(controls[soundId].wrapper)) {
                sound.element.appendChild(controls[soundId].wrapper);
            }
            continue;
        }

        if (ps.streaming) continue;

        if (!ps.sound || !ps.sound.loaded) {
            try { await ps.load(); } catch (e) { log("Load err: " + e.message); continue; }
        }

        const duration = getDuration(ps, 0);
        if (duration <= 0) continue;

        if (controls[soundId]) {
            if (!sound.element.contains(controls[soundId].wrapper)) {
                sound.element.appendChild(controls[soundId].wrapper);
            }
            const ctrl = controls[soundId];
            if (ctrl.trackNameEl) {
                const displayName = getDisplayName(ps);
                ctrl.trackNameEl.textContent = displayName;
                setTooltip(ctrl.trackNameEl, displayName);
            }
            continue;
        }

        const displayName = getDisplayName(ps);

        const player = document.createElement("div");
        player.classList.add("ear-player");
        player.dataset.earSoundId = soundId;
        player.dataset.earPlaylistId = plId;

        const topRow = document.createElement("div");
        topRow.classList.add("ear-top-row");

        const playBtn = document.createElement("button");
        playBtn.classList.add("ear-play-btn");
        playBtn.innerHTML = ps.playing ? `<i class="fa-solid fa-pause"></i>` : `<i class="fa-solid fa-play"></i>`;
        setTooltip(playBtn, loc("EAR.PlayPause"));
        stopEvent(playBtn);
        playBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (ps.playing) {
                const ct = getCurrentTime(ps);
                await safeUpdate(ps, { pausedTime: ct || 0.001, playing: false });
            } else {
                if (e.shiftKey && pl) {
                    const prevMode = pl.mode;
                    if (prevMode !== 2) await safeUpdate(pl, { mode: 2 });
                    await safeUpdate(ps, { playing: true });
                    try { ps.synchronize(); } catch(err) {}
                    if (prevMode !== 2) setTimeout(async () => { await safeUpdate(pl, { mode: prevMode }); }, 500);
                    return;
                }
                await safeUpdate(ps, { playing: true });
            }
            try { ps.synchronize(); } catch(err) {}
        });

        const trackName = document.createElement("div");
        trackName.classList.add("ear-track-name");
        trackName.textContent = displayName;
        setTooltip(trackName, displayName);

        const volContainer = document.createElement("div");
        volContainer.classList.add("ear-volume-container");

        const volIcon = document.createElement("i");
        volIcon.className = getVolumeIcon(ps.volume) + " ear-volume-icon";

        const volText = document.createElement("span");
        volText.classList.add("ear-vol-text");
        volText.textContent = Math.round(ps.volume * 100) + "%";

        const volSlider = document.createElement("input");
        volSlider.type = "range"; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.005;
        volSlider.value = ps.volume;
        volSlider.classList.add("ear-volume-slider");
        updateVolumeSliderFill(volSlider, ps.volume);

        let savedVol = ps.volume || 1;
        let volThrottleTimer = null;
        let volDragging = false;

        const applyVolVisual = (v) => {
            volSlider.value = v;
            updateVolumeSliderFill(volSlider, v);
            volIcon.className = getVolumeIcon(v) + " ear-volume-icon";
            volText.textContent = Math.round(v * 100) + "%";
        };

        stopEvent(volContainer);
        stopEvent(volSlider);
        volSlider.addEventListener("click", e => e.stopPropagation());

        volSlider.addEventListener("mousedown", e => {
            e.stopPropagation();
            volDragging = true;
            interactionLock = true;
        });

        volSlider.addEventListener("touchstart", e => {
            volDragging = true;
            interactionLock = true;
        }, { passive: true });

        const finishVolDrag = async () => {
            if (!volDragging) return;
            volDragging = false;
            if (volThrottleTimer) {
                clearTimeout(volThrottleTimer);
                volThrottleTimer = null;
            }
            const v = parseFloat(volSlider.value);
            await safeUpdate(ps, { volume: v });
            if (v > 0) savedVol = v;
            setTimeout(() => { interactionLock = false; }, 100);
        };

        document.addEventListener("mouseup", () => { if (volDragging) finishVolDrag(); });
        document.addEventListener("touchend", () => { if (volDragging) finishVolDrag(); });
        document.addEventListener("touchcancel", () => { if (volDragging) finishVolDrag(); });

        setTooltip(volIcon, loc("EAR.Mute"));
        volIcon.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (ps.volume > 0) {
                savedVol = ps.volume;
                await safeUpdate(ps, { volume: 0 });
                applyVolVisual(0);
                applyLocalVolume(ps, 0);
            } else {
                await safeUpdate(ps, { volume: savedVol });
                applyVolVisual(savedVol);
                applyLocalVolume(ps, savedVol);
            }
        });

        volSlider.addEventListener("input", e => {
            e.stopPropagation();
            const v = parseFloat(volSlider.value);
            updateVolumeSliderFill(volSlider, v);
            volIcon.className = getVolumeIcon(v) + " ear-volume-icon";
            volText.textContent = Math.round(v * 100) + "%";
            applyLocalVolume(ps, v);
        });

        volContainer.appendChild(volIcon);
        volContainer.appendChild(volSlider);
        volContainer.appendChild(volText);

        const closeBtn = document.createElement("button");
        closeBtn.classList.add("ear-close-btn");
        closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
        setTooltip(closeBtn, loc("EAR.Stop"));
        stopEvent(closeBtn);
        closeBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            await safeUpdate(ps, { playing: false, pausedTime: null });
            try { ps.synchronize(); } catch(err) {}
            resetControl(soundId);
        });

        topRow.appendChild(playBtn);
        topRow.appendChild(trackName);
        topRow.appendChild(volContainer);
        topRow.appendChild(closeBtn);

        const bottomRow = document.createElement("div");
        bottomRow.classList.add("ear-bottom-row");

        const curTimeLabel = document.createElement("span");
        curTimeLabel.classList.add("ear-time");
        curTimeLabel.textContent = formatTime(getCurrentTime(ps));

        const seekTrack = document.createElement("div");
        seekTrack.classList.add("ear-seek-track");
        const seekFill = document.createElement("div");
        seekFill.classList.add("ear-seek-fill");
        const seekHandle = document.createElement("div");
        seekHandle.classList.add("ear-seek-handle");

        const initT = getCurrentTime(ps);
        const ir = clampRatio(duration > 0 ? initT / duration : 0);
        seekFill.style.width = (ir * 100).toFixed(2) + "%";
        seekHandle.style.left = (ir * 100).toFixed(2) + "%";

        seekTrack.appendChild(seekFill);
        seekTrack.appendChild(seekHandle);

        const totalTimeLabel = document.createElement("span");
        totalTimeLabel.classList.add("ear-time", "right");
        setTooltip(totalTimeLabel, loc("EAR.ToggleRemaining"));
        totalTimeLabel.textContent = showRemaining ? "-" + formatTime(duration - initT) : formatTime(duration);
        totalTimeLabel.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); showRemaining = !showRemaining; });
        stopEvent(totalTimeLabel);

        const controlsGroup = document.createElement("div");
        controlsGroup.classList.add("ear-controls-group");

        const prevBtn = document.createElement("button");
        prevBtn.classList.add("ear-transport-btn");
        prevBtn.innerHTML = `<i class="fa-solid fa-backward-step"></i>`;
        setTooltip(prevBtn, loc("EAR.Previous"));
        stopEvent(prevBtn);
        prevBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const ct = getCurrentTime(ps);
            if (ct >= 3) {
                await seekSound(ps, 0.001, soundId);
            } else {
                if (pl && pl.mode !== 2 && pl.mode !== -1) {
                    await playPrevInPlaylist(pl, soundId);
                } else {
                    await seekSound(ps, 0.001, soundId);
                }
            }
        });

        const nextBtn = document.createElement("button");
        nextBtn.classList.add("ear-transport-btn");
        nextBtn.innerHTML = `<i class="fa-solid fa-forward-step"></i>`;
        setTooltip(nextBtn, loc("EAR.Next"));
        stopEvent(nextBtn);
        nextBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (!pl || pl.mode === -1 || pl.mode === 2) {
                await seekSound(ps, 0.001, soundId);
                return;
            }
            await playNextInPlaylist(pl, soundId);
        });

        const divider = document.createElement("div");
        divider.classList.add("ear-divider");

        const repeatBtn = document.createElement("button");
        repeatBtn.classList.add("ear-transport-btn");
        repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
        setTooltip(repeatBtn, ps.repeat ? loc("EAR.LoopOn") : loc("EAR.LoopOff"));
        if (ps.repeat) repeatBtn.classList.add("ear-active");
        stopEvent(repeatBtn);
        repeatBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            await safeUpdate(ps, { repeat: !ps.repeat });
        });

        const modeData = getModeData(pl ? pl.mode : 0);
        const modeBtn = document.createElement("button");
        modeBtn.classList.add("ear-transport-btn");
        modeBtn.innerHTML = `<i class="${modeData.icon}"></i>`;
        setTooltip(modeBtn, getModeLabel(pl ? pl.mode : 0));
        stopEvent(modeBtn);
        modeBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (!pl) return;
            const nx = getNextMode(pl.mode);
            await safeUpdate(pl, { mode: nx });
        });

        controlsGroup.appendChild(prevBtn);
        controlsGroup.appendChild(nextBtn);
        controlsGroup.appendChild(divider);
        controlsGroup.appendChild(repeatBtn);
        controlsGroup.appendChild(modeBtn);

        bottomRow.appendChild(curTimeLabel);
        bottomRow.appendChild(seekTrack);
        bottomRow.appendChild(totalTimeLabel);
        bottomRow.appendChild(controlsGroup);

        player.appendChild(topRow);
        player.appendChild(bottomRow);

        let dragging = false, updating = false, prevTimeVal = -1;

        const getProgress = e => {
            const rect = seekTrack.getBoundingClientRect();
            return clampRatio((e.clientX - rect.left) / rect.width);
        };
        const setPos = r => {
            const p = (clampRatio(r) * 100).toFixed(2);
            seekFill.style.width = p + "%";
            seekHandle.style.left = p + "%";
        };
        const updateVis = r => {
            setPos(r);
            const dur = getDuration(ps, duration);
            const t = clampRatio(r) * dur;
            curTimeLabel.textContent = formatTime(t);
            totalTimeLabel.textContent = showRemaining ? "-" + formatTime(dur - t) : formatTime(dur);
        };

        seekTrack.addEventListener("pointerdown", e => {
            e.stopPropagation(); e.preventDefault();
            dragging = true;
            interactionLock = true;
            seekHandle.classList.add("ear-dragging");
            seekHandle.setPointerCapture(e.pointerId);
            updateVis(getProgress(e));
        });
        seekHandle.addEventListener("pointerdown", e => {
            e.stopPropagation(); e.preventDefault();
            dragging = true;
            interactionLock = true;
            seekHandle.classList.add("ear-dragging");
            seekHandle.setPointerCapture(e.pointerId);
        });

        const onMove = e => { if (!dragging) return; e.stopPropagation(); updateVis(getProgress(e)); };
        const onUp = async e => {
            if (!dragging) return;
            dragging = false; e.stopPropagation();
            seekHandle.classList.remove("ear-dragging");
            updating = true;
            const dur = getDuration(ps, duration);
            let time = clampRatio(getProgress(e)) * dur;
            if (time < 0.5) time = 0.001;
            await seekSound(ps, time, soundId);
            updating = false;
        };

        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onUp, true);
        seekTrack.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); });
        seekTrack.addEventListener("dblclick", e => { e.stopPropagation(); e.preventDefault(); });
        seekHandle.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); });

        let updateTimer = null;
        const liveUpdate = () => {
            updateTimer = setTimeout(() => {
                if (!controls[soundId]) return;
                playBtn.innerHTML = ps.playing ? `<i class="fa-solid fa-pause"></i>` : `<i class="fa-solid fa-play"></i>`;

                const dn = getDisplayName(ps);
                if (trackName.textContent !== dn) {
                    trackName.textContent = dn;
                    setTooltip(trackName, dn);
                }

                if (!volDragging && !interactionLock && !wheelActive)  {
                    const cv = ps.volume;
                    if (Math.abs(parseFloat(volSlider.value) - cv) > 0.009) {
                        applyVolVisual(cv);
                    }
                }

                if (ps.playing && !updating && !dragging) {
                    const ct = getCurrentTime(ps);
                    const dur = getDuration(ps, duration);
                    if (ct < prevTimeVal - 1) log(`Loop: ${soundId}`);
                    prevTimeVal = ct;
                    setPos(clampRatio(dur > 0 ? ct / dur : 0));
                    curTimeLabel.textContent = formatTime(ct);
                    totalTimeLabel.textContent = showRemaining ? "-" + formatTime(dur - ct) : formatTime(dur);
                } else if (!ps.playing && !updating && !dragging) {
                    const pt = ps.pausedTime ?? 0;
                    const dur = getDuration(ps, duration);
                    setPos(clampRatio(dur > 0 ? pt / dur : 0));
                    curTimeLabel.textContent = formatTime(pt);
                    totalTimeLabel.textContent = showRemaining ? "-" + formatTime(dur - pt) : formatTime(dur);
                    prevTimeVal = -1;
                }

                if (pl) {
                    const md = getModeData(pl.mode);
                    modeBtn.innerHTML = `<i class="${md.icon}"></i>`;
                    setTooltip(modeBtn, getModeLabel(pl.mode));
                }

                if (ps.repeat) {
                    repeatBtn.classList.add("ear-active");
                    setTooltip(repeatBtn, loc("EAR.LoopOn"));
                } else {
                    repeatBtn.classList.remove("ear-active");
                    setTooltip(repeatBtn, loc("EAR.LoopOff"));
                }

                if (ps.pausedTime !== null || ps.playing) liveUpdate();
            }, 250);
        };
        liveUpdate();

        controls[soundId] = {
            wrapper: player,
            playlistId: plId,
            trackNameEl: trackName,
            cleanup: () => {
                document.removeEventListener("pointermove", onMove, true);
                document.removeEventListener("pointerup", onUp, true);
                if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
                if (volThrottleTimer) { clearTimeout(volThrottleTimer); volThrottleTimer = null; }
            }
        };

        sound.element.appendChild(player);
    }
};

Hooks.on("renderPlaylistDirectory", dir => {
    if (!interactionLock) handleDirectory(dir);
});

Hooks.on("renderSidebarTab", app => {
    if (!interactionLock && app instanceof PlaylistDir) handleDirectory(app);
});

Hooks.on("updatePlaylistSound", (sound, changes) => {
    if (seekingIds.has(sound.id)) return;
    if (interactionLock) return;
    const stopped = changes.playing === false && (changes.pausedTime === undefined || changes.pausedTime === null);
    if (stopped) resetControl(sound.id);
    refreshDirectory();
});

Hooks.on("updatePlaylist", () => {
    if (!interactionLock) refreshDirectory();
});

Hooks.on("preUpdatePlaylistSound", (doc, changes) => {
    if (changes.pausedTime === 0) changes.pausedTime = 0.001;
});

let globalWheelThrottle = null;
let wheelActive = false;

document.addEventListener("wheel", (e) => {
    const earPlayer = e.target.closest(".ear-player");
    if (!earPlayer) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const soundId = earPlayer.dataset.earSoundId;
    const playlistId = earPlayer.dataset.earPlaylistId;
    if (!soundId || !playlistId) return;

    const pl = game.playlists.get(playlistId);
    if (!pl) return;
    const ps = pl.sounds.get(soundId);
    if (!ps) return;

    const slider = earPlayer.querySelector(".ear-volume-slider");
    if (!slider) return;

    wheelActive = true;
    const current = parseFloat(slider.value);
    const sign = e.deltaY < 0 ? 1 : -1;
    const nv = Math.max(0, Math.min(1, +(current + sign * 0.01).toFixed(3)));

    slider.value = nv;
    updateVolumeSliderFill(slider, nv);
    const icon = earPlayer.querySelector(".ear-volume-icon");
    if (icon) icon.className = getVolumeIcon(nv) + " ear-volume-icon";
    const text = earPlayer.querySelector(".ear-vol-text");
    if (text) text.textContent = Math.round(nv * 100) + "%";
    applyLocalVolume(ps, nv);

    if (globalWheelThrottle) clearTimeout(globalWheelThrottle);
    globalWheelThrottle = setTimeout(async () => {
        globalWheelThrottle = null;
        const saveVol = parseFloat(slider.value);
        interactionLock = true;
        await safeUpdate(ps, { volume: saveVol });
        setTimeout(() => {
            interactionLock = false;
            wheelActive = false;
        }, 150);
    }, 600);
}, { passive: false, capture: true });