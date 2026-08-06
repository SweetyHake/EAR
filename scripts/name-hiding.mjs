import { log, MODULE_ID, HIDE_NAMES_SETTING, invalidateHideNamesCache, shouldHideName, getChannelName } from "./common.mjs";

const PlaylistDir = foundry.applications.sidebar.tabs.PlaylistDirectory;

// ── Core name-hiding logic ──────────────────────────────────────────────────
// Hides track names (replacing them with the channel name) or, when the module
// setting is off, restores the original names that this module replaced.
function hideSoundNames() {
    if (game.user.isGM) return;

    for (const el of document.querySelectorAll("#playlists .sound")) {
        const playlist = resolvePlaylist(el);
        if (!playlist) continue;
        const ps = playlist.sounds.get(el.dataset.soundId);
        if (!ps) continue;

        const hide = shouldHideName(playlist);
        const replacement = hide ? getChannelName(playlist) : ps.name;

        // Named elements in Foundry's native UI
        for (const nameEl of el.querySelectorAll(".sound-name, h4, header .name, header span, a.sound-name")) {
            if (nameEl.textContent.trim() !== replacement) {
                nameEl.textContent = replacement;
                nameEl.title = "";
                if (nameEl.dataset) nameEl.dataset.tooltip = "";
            }
        }

        // EAR player track name
        for (const earEl of el.querySelectorAll(".ear-track-name")) {
            earEl.textContent = replacement;
            earEl.title = "";
            if (earEl.dataset) earEl.dataset.tooltip = "";
        }

        // Walk leaf text nodes to catch any other mention of the track name.
        // Replaced nodes are marked so they can be restored when hiding is off.
        for (const child of el.querySelectorAll("*")) {
            if (child.children.length > 0) continue;
            if (child.closest(".ear-player")) continue; // EAR widgets handle names themselves
            const tag = child.tagName.toLowerCase();
            if (tag === "i" || tag === "button" || tag === "input" || tag === "select") continue;
            if (child.dataset.earHidden || child.textContent.trim() === ps.name) {
                child.textContent = replacement;
                child.title = "";
                if (child.dataset) child.dataset.tooltip = "";
                if (hide) child.dataset.earHidden = "1";
                else delete child.dataset.earHidden;
            }
        }
    }
}

function resolvePlaylist(el) {
    let plId = el.dataset.playlistId;
    if (!plId) {
        const parent = el.closest("[data-playlist-id]");
        if (parent) plId = parent.dataset.playlistId;
    }
    if (!plId) {
        const sid = el.dataset.soundId;
        if (sid) {
            for (const pl of game.playlists) {
                if (pl.sounds.get(sid)) { plId = pl.id; break; }
            }
        }
    }
    return plId ? game.playlists.get(plId) : null;
}

// ── Single MutationObserver (replaces setTimeout cascades) ──────────────────
let observer = null;
let debounce = null;
let hookDebounce = null;

// Debounced variant for high-frequency hooks (volume changes, sound updates)
// — a full DOM scan on every one of them would lag big playlists.
function scheduleHideNames() {
    if (game.user.isGM) return;
    clearTimeout(hookDebounce);
    hookDebounce = setTimeout(() => { hookDebounce = null; hideSoundNames(); }, 60);
}

function ensureObserver() {
    if (game.user.isGM || observer) return;
    const sidebar = document.querySelector("#sidebar");
    if (!sidebar) return;

    observer = new MutationObserver(mutations => {
        let relevant = false;
        for (const m of mutations) {
            // Text nodes have no `.closest` — resolve to their parent element so the
            // `.ear-player` filter works and EAR's own time updates are ignored.
            const el = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
            if (el?.closest?.(".ear-player")) continue;
            if (m.type === "childList" && m.addedNodes.length) { relevant = true; break; }
            if (m.type === "characterData") { relevant = true; break; }
        }
        if (!relevant) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { debounce = null; hideSoundNames(); }, 80);
    });

    observer.observe(sidebar, { childList: true, subtree: true, characterData: true });
    log.debug("Name-hiding observer started");
}

// ── Hooks ───────────────────────────────────────────────────────────────────
Hooks.once("init", () => {
    game.settings.register(MODULE_ID, HIDE_NAMES_SETTING, {
        name: "EAR.HideTrackNames",
        hint: "EAR.HideTrackNamesHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: () => {
            invalidateHideNamesCache();
            hideSoundNames();
        },
    });
});

Hooks.once("ready", () => {
    if (!game.user.isGM) {
        hideSoundNames();
        setTimeout(ensureObserver, 1000);
    }
});

// Reactive: render hooks run immediately (renders are infrequent), the rest are
// debounced — the observer + debounce handles de-duplication.
Hooks.on("renderPlaylistDirectory", () => { hideSoundNames(); ensureObserver(); });
Hooks.on("renderSidebarTab",        app => { if (app instanceof PlaylistDir) { hideSoundNames(); ensureObserver(); } });
Hooks.on("updatePlaylistSound",     () => scheduleHideNames());
Hooks.on("updatePlaylist",          () => scheduleHideNames());
Hooks.on("globalPlaylistVolumeChanged", () => scheduleHideNames());
