const id = "enhanced-audio-resources";
const log = (arg) => console.info(id, arg);
log("Initialized");

const controls = {};
const playHistory = [];
const coverCache = {};
const path = "#playlists .currently-playing .playlist-sounds .sound";
let showRemaining = false;
let handleDirectoryTimer = null;

const PlaylistDir = foundry.applications.sidebar.tabs.PlaylistDirectory;

const playlistModes = [
    { value: -1, icon: "fa-solid fa-ban", locKey: "PLAYLIST.ModeDisabled" },
    { value: 0, icon: "fa-regular fa-circle-right", locKey: "PLAYLIST.ModeSequential" },
    { value: 1, icon: "fa-solid fa-shuffle", locKey: "PLAYLIST.ModeShuffle" },
    { value: 2, icon: "fa-solid fa-minimize", locKey: "PLAYLIST.ModeSimultaneous" }
];

const modeOrder = [-1, 0, 1, 2];

function getModeData(mode) {
    return playlistModes.find(m => m.value === mode) || playlistModes[0];
}

function getModeLabel(mode) {
    const data = getModeData(mode);
    return game.i18n?.localize(data.locKey) ?? data.locKey;
}

function getNextMode(current) {
    const idx = modeOrder.indexOf(current);
    if (idx < 0) return modeOrder[0];
    return modeOrder[(idx + 1) % modeOrder.length];
}

function getRepeatLabel() {
    return game.i18n?.localize("PLAYLIST.SoundLoop") ?? "Loop";
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
    if (handleDirectoryTimer) clearTimeout(handleDirectoryTimer);
    handleDirectoryTimer = setTimeout(() => {
        handleDirectoryTimer = null;
        handleDirectory(game.playlists?.directory);
    }, 80);
}

async function safeUpdate(doc, data) {
    try {
        await doc.update(data);
    } catch (e) {
        log("Update error: " + e.message);
    }
}

const handleDirectory = async (directory) => {
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
        if (!activeSoundIds.has(sId)) resetControl(sId);
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

        const closeBtn = document.createElement("button");
        closeBtn.classList.add("ear-close-btn");
        closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
        setTooltip(closeBtn, "Stop");
        stopEvent(closeBtn);
        closeBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            await safeUpdate(ps, { playing: false, pausedTime: null });
            try { ps.synchronize(); } catch(e) {}
            resetControl(soundId);
        });
        player.appendChild(closeBtn);

        const right = document.createElement("div");
        right.classList.add("ear-right");

        const trackName = document.createElement("div");
        trackName.classList.add("ear-track-name");
        trackName.textContent = displayName;
        setTooltip(trackName, displayName);

        const volRow = document.createElement("div");
        volRow.classList.add("ear-volume-row");

        const volIcon = document.createElement("i");
        volIcon.className = getVolumeIcon(ps.volume) + " ear-volume-icon";
        stopEvent(volIcon);
        let savedVol = ps.volume || 1;
        let volThrottleTimer = null;

        volIcon.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (ps.volume > 0) {
                savedVol = ps.volume;
                await safeUpdate(ps, { volume: 0 });
                volSlider.value = 0;
                updateVolumeSliderFill(volSlider, 0);
                volIcon.className = getVolumeIcon(0) + " ear-volume-icon";
                applyLocalVolume(ps, 0);
            } else {
                await safeUpdate(ps, { volume: savedVol });
                volSlider.value = savedVol;
                updateVolumeSliderFill(volSlider, savedVol);
                volIcon.className = getVolumeIcon(savedVol) + " ear-volume-icon";
                applyLocalVolume(ps, savedVol);
            }
        });

        const volSlider = document.createElement("input");
        volSlider.type = "range"; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.01;
        volSlider.value = ps.volume;
        volSlider.classList.add("ear-volume-slider");
        updateVolumeSliderFill(volSlider, ps.volume);
        stopEvent(volSlider);
        volSlider.addEventListener("click", e => e.stopPropagation());

        volSlider.addEventListener("input", e => {
            e.stopPropagation();
            const v = parseFloat(volSlider.value);
            updateVolumeSliderFill(volSlider, v);
            volIcon.className = getVolumeIcon(v) + " ear-volume-icon";
            applyLocalVolume(ps, v);
            if (!volThrottleTimer) {
                volThrottleTimer = setTimeout(async () => {
                    volThrottleTimer = null;
                    const current = parseFloat(volSlider.value);
                    await safeUpdate(ps, { volume: current });
                    if (current > 0) savedVol = current;
                }, 100);
            }
        });

        volSlider.addEventListener("change", async e => {
            e.stopPropagation();
            if (volThrottleTimer) {
                clearTimeout(volThrottleTimer);
                volThrottleTimer = null;
            }
            const v = parseFloat(volSlider.value);
            await safeUpdate(ps, { volume: v });
            if (v > 0) savedVol = v;
        });

        volRow.appendChild(volIcon);
        volRow.appendChild(volSlider);

        const transport = document.createElement("div");
        transport.classList.add("ear-transport");

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

        const prevBtn = document.createElement("button");
        prevBtn.classList.add("ear-transport-btn");
        prevBtn.innerHTML = `<i class="fa-solid fa-backward-step"></i>`;
        setTooltip(prevBtn, "Previous");
        stopEvent(prevBtn);
        prevBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const ct = getCurrentTime(ps);
            if (ct >= 2) {
                const w = ps.playing;
                if (w) await safeUpdate(ps, { playing: false });
                await safeUpdate(ps, { pausedTime: 0.001 });
                if (w) await safeUpdate(ps, { playing: true });
                try { ps.synchronize(); } catch(e) {}
            } else {
                const prev = getLastPlayedSound(plId, soundId);
                if (prev) {
                    await safeUpdate(ps, { playing: false, pausedTime: null });
                    await safeUpdate(prev, { pausedTime: 0.001, playing: true });
                    try { prev.synchronize(); } catch(e) {}
                } else {
                    const w = ps.playing;
                    if (w) await safeUpdate(ps, { playing: false });
                    await safeUpdate(ps, { pausedTime: 0.001 });
                    if (w) await safeUpdate(ps, { playing: true });
                    try { ps.synchronize(); } catch(e) {}
                }
            }
        });

        const playBtn = document.createElement("button");
        playBtn.classList.add("ear-play-btn");
        playBtn.innerHTML = ps.playing ? `<i class="fa-solid fa-pause"></i>` : `<i class="fa-solid fa-play"></i>`;
        stopEvent(playBtn);
        playBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            if (ps.playing) {
                const ct = getCurrentTime(ps);
                await safeUpdate(ps, { pausedTime: ct || 0.001, playing: false });
            } else {
                if (e.shiftKey && pl) {
                    const prevMode = pl.mode;
                    if (prevMode !== 2) {
                        await safeUpdate(pl, { mode: 2 });
                    }
                    await safeUpdate(ps, { playing: true });
                    try { ps.synchronize(); } catch(e) {}
                    if (prevMode !== 2) {
                        setTimeout(async () => {
                            await safeUpdate(pl, { mode: prevMode });
                        }, 500);
                    }
                    return;
                }
                await safeUpdate(ps, { playing: true });
            }
            try { ps.synchronize(); } catch(e) {}
        });

        const nextBtn = document.createElement("button");
        nextBtn.classList.add("ear-transport-btn");
        nextBtn.innerHTML = `<i class="fa-solid fa-forward-step"></i>`;
        setTooltip(nextBtn, "Next");
        stopEvent(nextBtn);
        nextBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            const dur = getDuration(ps, duration);
            const w = ps.playing;
            if (w) await safeUpdate(ps, { playing: false });
            await safeUpdate(ps, { pausedTime: dur - 0.001 });
            if (w) await safeUpdate(ps, { playing: true });
            try { ps.synchronize(); } catch(e) {}
        });

        const repeatBtn = document.createElement("button");
        repeatBtn.classList.add("ear-transport-btn");
        repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
        setTooltip(repeatBtn, getRepeatLabel() + ": " + (ps.repeat ? "ON" : "OFF"));
        if (ps.repeat) repeatBtn.classList.add("ear-active");
        stopEvent(repeatBtn);
        repeatBtn.addEventListener("click", async e => {
            e.stopPropagation(); e.preventDefault();
            await safeUpdate(ps, { repeat: !ps.repeat });
        });

        transport.appendChild(modeBtn);
        transport.appendChild(prevBtn);
        transport.appendChild(playBtn);
        transport.appendChild(nextBtn);
        transport.appendChild(repeatBtn);

        const sliderRow = document.createElement("div");
        sliderRow.classList.add("ear-slider-row");

        const curLabel = document.createElement("span");
        curLabel.classList.add("ear-time-label");
        curLabel.textContent = formatTime(getCurrentTime(ps));

        const rightLabel = document.createElement("span");
        rightLabel.classList.add("ear-time-right");
        setTooltip(rightLabel, "Toggle remaining");
        const initT = getCurrentTime(ps);
        rightLabel.textContent = showRemaining ? "-" + formatTime(duration - initT) : formatTime(duration);
        rightLabel.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); showRemaining = !showRemaining; });
        stopEvent(rightLabel);

        const seekTrack = document.createElement("div");
        seekTrack.classList.add("ear-seek-track");
        const seekFill = document.createElement("div");
        seekFill.classList.add("ear-seek-fill");
        const seekHandle = document.createElement("div");
        seekHandle.classList.add("ear-seek-handle");

        const ir = clampRatio(duration > 0 ? initT / duration : 0);
        seekFill.style.width = (ir * 100).toFixed(2) + "%";
        seekHandle.style.left = (ir * 100).toFixed(2) + "%";

        seekTrack.appendChild(seekFill);
        seekTrack.appendChild(seekHandle);
        sliderRow.appendChild(curLabel);
        sliderRow.appendChild(seekTrack);
        sliderRow.appendChild(rightLabel);

        right.appendChild(trackName);
        right.appendChild(volRow);
        right.appendChild(transport);
        right.appendChild(sliderRow);

        player.appendChild(right);

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
            curLabel.textContent = formatTime(t);
            rightLabel.textContent = showRemaining ? "-" + formatTime(dur - t) : formatTime(dur);
        };

        seekTrack.addEventListener("pointerdown", e => {
            e.stopPropagation(); e.preventDefault();
            dragging = true;
            seekHandle.classList.add("ear-dragging");
            seekHandle.setPointerCapture(e.pointerId);
            updateVis(getProgress(e));
        });
        seekHandle.addEventListener("pointerdown", e => {
            e.stopPropagation(); e.preventDefault();
            dragging = true;
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
            const w = ps.playing;
            if (w) await safeUpdate(ps, { playing: false });
            await safeUpdate(ps, { pausedTime: time });
            if (w) await safeUpdate(ps, { playing: true });
            updating = false;
            try { ps.synchronize(); } catch(e) {}
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
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

                if (ps.playing && !updating && !dragging) {
                    const ct = getCurrentTime(ps);
                    const dur = getDuration(ps, duration);
                    if (ct < prevTimeVal - 1) log(`Loop: ${soundId}`);
                    prevTimeVal = ct;
                    setPos(clampRatio(dur > 0 ? ct / dur : 0));
                    curLabel.textContent = formatTime(ct);
                    rightLabel.textContent = showRemaining ? "-" + formatTime(dur - ct) : formatTime(dur);
                } else if (!ps.playing && !updating && !dragging) {
                    const pt = ps.pausedTime ?? 0;
                    const dur = getDuration(ps, duration);
                    setPos(clampRatio(dur > 0 ? pt / dur : 0));
                    curLabel.textContent = formatTime(pt);
                    rightLabel.textContent = showRemaining ? "-" + formatTime(dur - pt) : formatTime(dur);
                    prevTimeVal = -1;
                }

                if (pl) {
                    const md = getModeData(pl.mode);
                    modeBtn.innerHTML = `<i class="${md.icon}"></i>`;
                    setTooltip(modeBtn, getModeLabel(pl.mode));
                }

                if (ps.repeat) {
                    repeatBtn.classList.add("ear-active");
                    setTooltip(repeatBtn, getRepeatLabel() + ": ON");
                } else {
                    repeatBtn.classList.remove("ear-active");
                    setTooltip(repeatBtn, getRepeatLabel() + ": OFF");
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
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
                if (volThrottleTimer) { clearTimeout(volThrottleTimer); volThrottleTimer = null; }
            }
        };

        sound.element.appendChild(player);
    }
};

Hooks.on("renderPlaylistDirectory", handleDirectory);

Hooks.on("renderSidebarTab", app => {
    if (app instanceof PlaylistDir) handleDirectory(app);
});

Hooks.on("updatePlaylistSound", (sound, changes) => {
    const stopped = changes.playing === false && (changes.pausedTime === undefined || changes.pausedTime === null);
    if (stopped) resetControl(sound.id);
    refreshDirectory();
});

Hooks.on("updatePlaylist", () => refreshDirectory());

Hooks.on("preUpdatePlaylistSound", (doc, changes) => {
    if (changes.pausedTime === 0) changes.pausedTime = 0.001;
});