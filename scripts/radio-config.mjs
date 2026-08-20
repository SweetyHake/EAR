import { formatTime } from "./common.mjs";
import { getRadioFlags, writeRadioFlags, defaultRadioFlags } from "./radio-common.mjs";
import { playTrack, radioStep, seekRadio, setRadioPower, scanPlaylist } from "./radio-engine.mjs";

const SECTION_CLASS = "ear-radio-config";
const TEMPLATE = "modules/ear/templates/radio-config.hbs";
const durations = new Map();
const tickTimers = new Map();
const renderQueues = new Map();

function buildContext(doc) {
    const stored = getRadioFlags(doc);
    const radio = stored ?? defaultRadioFlags();
    const tracks = (radio.tracks ?? []).map((track, index) => ({
        ...track,
        isCurrent: index === (radio.index ?? -1)
    }));
    return {
        enabled: !!stored && stored.enabled !== false,
        radio,
        powered: !doc.hidden,
        noise: radio.noise !== false,
        tracks,
        currentTrack: tracks.find(track => track.isCurrent) ?? null,
        playlists: game.playlists.contents
            .map(playlist => ({ id: playlist.id, name: playlist.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        playlistId: radio.playlist ?? "",
        modeChoices: {
            manual: "PLAYLIST.ModeDisabled",
            sequential: "PLAYLIST.ModeSequential",
            shuffle: "PLAYLIST.ModeShuffle",
            repeat: "EAR.Radio.Mode.Repeat"
        }
    };
}

export async function injectRadioConfig(app, element) {
    if (app.constructor.name === "AmbientSoundPalette") return;
    const previous = renderQueues.get(app.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => inject(app, element));
    renderQueues.set(app.id, pending);
    try { await pending; }
    finally { if (renderQueues.get(app.id) === pending) renderQueues.delete(app.id); }
}

async function inject(app, element) {
    const form = element.querySelector(".standard-form.scrollable") ?? element.querySelector(".standard-form, form");
    if (!form || !app.document?.id) return;
    let fieldset = form.querySelector(`.${SECTION_CLASS}`);
    if (!fieldset) {
        fieldset = document.createElement("fieldset");
        fieldset.className = SECTION_CLASS;
        const anchor = form.querySelector("fieldset:nth-of-type(2)");
        anchor ? form.insertBefore(fieldset, anchor) : form.appendChild(fieldset);
        wireSection(fieldset, app);
    }
    const html = await renderTemplate(TEMPLATE, buildContext(app.document));
    if (!element.isConnected || !fieldset.isConnected) return;
    const scrollState = captureScrollState(element, form);
    const list = fieldset.querySelector(".ear-radio-tracks");
    const listScroll = { top: list?.scrollTop ?? 0, left: list?.scrollLeft ?? 0 };
    fieldset.innerHTML = html;
    const restore = () => {
        restoreScrollState(scrollState, element);
        const newList = fieldset.querySelector(".ear-radio-tracks");
        if (newList) {
            newList.scrollTop = listScroll.top;
            newList.scrollLeft = listScroll.left;
        }
    };
    restore();
    requestAnimationFrame(() => requestAnimationFrame(restore));
    measureDurations(fieldset, app.document);
    startTick(app);
}

function captureScrollState(element, form) {
    const state = [];
    let node = form;
    while (node && node !== element.parentElement) {
        state.push({ node, top: node.scrollTop, left: node.scrollLeft });
        node = node.parentElement;
    }
    return {
        ancestors: state,
        elementTop: element.scrollTop,
        elementLeft: element.scrollLeft
    };
}

function restoreScrollState(state, element) {
    for (const entry of state.ancestors) {
        if (entry.node.isConnected) {
            entry.node.scrollTop = entry.top;
            entry.node.scrollLeft = entry.left;
        }
    }
    element.scrollTop = state.elementTop;
    element.scrollLeft = state.elementLeft;
}

function wireSection(section, app) {
    section.addEventListener("click", async event => {
        const button = event.target.closest("[data-radio-action]");
        if (!button || button.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        button.blur();
        const doc = app.document;
        button.disabled = true;
        try {
            switch (button.dataset.radioAction) {
                case "play": await playTrack(doc.id, Number(button.dataset.index)); break;
                case "next": await radioStep(doc.id, 1); break;
                case "prev": await radioStep(doc.id, -1); break;
                case "power": await setRadioPower(doc.id, doc.hidden); break;
            }
        } finally { if (button.isConnected) button.disabled = false; }
    });
    section.addEventListener("change", async event => {
        const target = event.target;
        const doc = app.document;
        if (target.matches("[data-radio-enable]")) {
            await writeRadioFlags(doc, target.checked ? defaultRadioFlags() : null);
        } else if (target.matches("[data-radio-playlist]")) {
            await writeRadioFlags(doc, { playlist: target.value, tracks: scanPlaylist(target.value), index: -1 });
        } else if (target.matches("[data-radio-mode]")) {
            await writeRadioFlags(doc, { mode: target.value });
        } else if (target.matches("[data-radio-noise]")) {
            await writeRadioFlags(doc, { noise: target.checked });
        } else if (target.matches("[data-radio-seek]")) {
            await seekRadio(doc.id, Number(target.value));
        }
    });
    section.addEventListener("input", event => {
        const slider = event.target.closest("[data-radio-seek]");
        if (!slider) return;
        const current = section.querySelector("[data-radio-current-time]");
        const fill = Math.max(0, Math.min(1, Number(slider.value) / Math.max(1, Number(slider.max))));
        slider.style.setProperty("--ear-radio-seek-pct", `${fill * 100}%`);
        if (current) current.textContent = formatTime(Number(slider.value));
    });
}

export function refreshOpenConfig(soundId) {
    for (const app of foundry.applications.instances.values()) {
        if (app.constructor.name !== "AmbientSoundConfig" || !app.rendered) continue;
        if (soundId && app.document?.id !== soundId) continue;
        injectRadioConfig(app, app.element);
    }
}

export function closeConfigIfOpen(soundId) {
    for (const app of foundry.applications.instances.values()) {
        if (app.constructor.name === "AmbientSoundConfig" && app.document?.id === soundId) app.close();
    }
}

function startTick(app) {
    clearTimeout(tickTimers.get(app.id));
    tickTimers.delete(app.id);
    if (!app.element?.isConnected) return;
    const current = app.element.querySelector("[data-radio-current-time]");
    const duration = app.element.querySelector("[data-radio-track-duration]");
    const slider = app.element.querySelector("[data-radio-seek]");
    if (!current && !duration && !slider) return;
    const sound = canvas.sounds?.get(app.document.id)?.sound;
    const source = sound?.sourceNode;
    const radio = getRadioFlags(app.document);
    const track = radio?.tracks?.[radio.index ?? -1];
    const liveTime = firstFinite(sound?.currentTime, source?.currentTime, source?.mediaElement?.currentTime);
    const seek = radio?.seek?.trackIndex === radio?.index ? radio.seek : null;
    const now = game.time?.serverTime ?? Date.now();
    const virtualTime = seek ? Math.max(0, seek.offset + (now - seek.requestedAt) / 1000) : 0;
    const currentTime = sound?.playing ? liveTime : virtualTime;
    const maxTime = firstPositive(sound?.duration, source?.duration, source?.mediaElement?.duration,
        durations.get(track?.path), 0);
    if (current) current.textContent = formatTime(currentTime);
    if (duration) duration.textContent = maxTime > 0 ? formatTime(maxTime) : "--:--";
    if (slider && document.activeElement !== slider) {
        slider.disabled = maxTime <= 0 || !track;
        slider.max = Math.max(1, maxTime);
        slider.value = Math.min(currentTime, maxTime || 0);
        slider.style.setProperty("--ear-radio-seek-pct", `${maxTime > 0 ? currentTime / maxTime * 100 : 0}%`);
    }
    tickTimers.set(app.id, setTimeout(() => startTick(app), 250));
}

function firstFinite(...values) {
    return values.find(value => Number.isFinite(value) && value >= 0) ?? 0;
}

function firstPositive(...values) {
    return values.find(value => Number.isFinite(value) && value > 0) ?? 0;
}

function measureDurations(section, doc) {
    for (const row of section.querySelectorAll(".ear-radio-track")) {
        const cell = row.querySelector(".ear-radio-track-duration");
        const index = Number(row.dataset.index);
        const track = getRadioFlags(doc)?.tracks?.[index];
        if (!cell || !track?.path) continue;
        if (durations.has(track.path)) {
            cell.textContent = durations.get(track.path) ? formatTime(durations.get(track.path)) : "--:--";
            continue;
        }
        cell.textContent = "…";
        const audio = new Audio();
        audio.preload = "metadata";
        const finish = duration => {
            durations.set(track.path, duration);
            const target = section.querySelector(`.ear-radio-track[data-index="${index}"] .ear-radio-track-duration`);
            if (target) target.textContent = duration ? formatTime(duration) : "--:--";
            audio.removeAttribute("src");
            audio.load();
        };
        audio.addEventListener("loadedmetadata", () => finish(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
        audio.addEventListener("error", () => finish(0), { once: true });
        audio.src = track.path;
    }
}
