const PlaylistDir = foundry.applications.sidebar.tabs.PlaylistDirectory;

const CHANNEL_KEYS = {
    music: "AUDIO.CHANNELS.MUSIC.label",
    environment: "AUDIO.CHANNELS.ENVIRONMENT.label",
    interface: "AUDIO.CHANNELS.INTERFACE.label"
};

function shouldHideName(playlist) {
    if (game.user.isGM) return false;
    const level = playlist.ownership?.[game.user.id] ?? playlist.ownership?.default ?? 0;
    return level < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
}

function getReplacementName(playlist) {
    const channel = playlist.channel || "music";
    const key = CHANNEL_KEYS[channel];
    if (key) return game.i18n.localize(key);
    return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function hideNamesForPlayers() {
    if (game.user.isGM) return;

    document.querySelectorAll("#playlists .sound").forEach(el => {
        let playlistId = el.dataset.playlistId;
        if (!playlistId) {
            const parent = el.closest("[data-playlist-id]");
            if (parent) playlistId = parent.dataset.playlistId;
        }
        if (!playlistId) {
            const soundId = el.dataset.soundId;
            if (soundId) {
                for (const pl of game.playlists) {
                    if (pl.sounds.get(soundId)) {
                        playlistId = pl.id;
                        break;
                    }
                }
            }
        }
        if (!playlistId) return;

        const playlist = game.playlists.get(playlistId);
        if (!playlist || !shouldHideName(playlist)) return;

        const replacement = getReplacementName(playlist);

        el.querySelectorAll(".sound-name, h4, .ear-track-name, header .name, header span, a.sound-name").forEach(nameEl => {
            if (nameEl.textContent.trim() !== replacement) {
                nameEl.textContent = replacement;
                nameEl.title = "";
                if (nameEl.dataset) {
                    nameEl.dataset.tooltip = "";
                }
            }
        });

        el.querySelectorAll("*").forEach(child => {
            if (child.children.length === 0 && child.textContent.trim().length > 0) {
                const tag = child.tagName.toLowerCase();
                if (tag === "i" || tag === "button" || tag === "input" || tag === "select") return;
                if (child.classList.contains("ear-time-label") || child.classList.contains("ear-time-right")) return;
                if (child.closest(".ear-transport") || child.closest(".ear-volume-row") || child.closest(".ear-slider-row")) return;
                if (child.classList.contains("sound-name") || child.classList.contains("ear-track-name")) return;

                const soundId = el.dataset.soundId;
                if (soundId) {
                    for (const pl of game.playlists) {
                        const ps = pl.sounds.get(soundId);
                        if (ps && child.textContent.trim() === ps.name) {
                            child.textContent = replacement;
                            child.title = "";
                            if (child.dataset) child.dataset.tooltip = "";
                        }
                    }
                }
            }
        });
    });
}

function startObserver() {
    if (game.user.isGM) return;

    const target = document.querySelector("#sidebar");
    if (!target || target.dataset.earNameObserver) return;
    target.dataset.earNameObserver = "1";

    const observer = new MutationObserver((mutations) => {
        let shouldRun = false;
        for (const m of mutations) {
            if (m.type === "childList" && m.addedNodes.length > 0) {
                shouldRun = true;
                break;
            }
            if (m.type === "characterData") {
                shouldRun = true;
                break;
            }
        }
        if (shouldRun) {
            hideNamesForPlayers();
        }
    });

    observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

Hooks.on("ready", () => {
    if (!game.user.isGM) {
        setTimeout(() => {
            hideNamesForPlayers();
            startObserver();
        }, 1000);
    }
});

Hooks.on("renderPlaylistDirectory", () => {
    setTimeout(hideNamesForPlayers, 50);
    setTimeout(hideNamesForPlayers, 150);
    setTimeout(hideNamesForPlayers, 300);
    setTimeout(hideNamesForPlayers, 600);
    setTimeout(hideNamesForPlayers, 1200);
});

Hooks.on("renderSidebarTab", app => {
    if (app instanceof PlaylistDir) {
        setTimeout(hideNamesForPlayers, 50);
        setTimeout(hideNamesForPlayers, 150);
        setTimeout(hideNamesForPlayers, 300);
        setTimeout(hideNamesForPlayers, 600);
    }
});

Hooks.on("updatePlaylistSound", () => {
    setTimeout(hideNamesForPlayers, 100);
    setTimeout(hideNamesForPlayers, 300);
    setTimeout(hideNamesForPlayers, 700);
});

Hooks.on("updatePlaylist", () => {
    setTimeout(hideNamesForPlayers, 100);
    setTimeout(hideNamesForPlayers, 300);
    setTimeout(hideNamesForPlayers, 700);
});

Hooks.on("globalPlaylistVolumeChanged", () => {
    setTimeout(hideNamesForPlayers, 100);
    setTimeout(hideNamesForPlayers, 400);
});