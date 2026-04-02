# Enhanced Audio Resources (EAR)

A Foundry VTT v13 module that replaces default playlist controls with a compact, modern audio player — right in the sidebar.

![Foundry VTT](https://img.shields.io/badge/Foundry%20VTT-v13-orange)

<img width="420" height="150" alt="EAR Demo" src="https://raw.githubusercontent.com/SweetyHake/EAR/refs/heads/main/screenshots/demo1.png" />

---

## What it does

Each playing track gets a sleek player card with transport controls, seek bar, and volume — replacing the stock Foundry UI entirely.

**Player** — play/pause, previous/next, repeat, playlist mode cycling (Disabled → Sequential → Shuffle → Simultaneous). Restart on previous if more than 2 seconds in, otherwise skip back.

**Seek bar** — drag to jump anywhere in the track. Current time updates live. Click the duration label to toggle remaining time.

**Volume** — slider with visual fill, mute toggle (remembers previous level), mouse wheel support.

**Name hiding** — players without Observer permission see the channel type (Music, Environment, etc.) instead of the track name. GM always sees everything.

---

## Installation

1. In Foundry VTT go to **Settings → Manage Modules → Install Module**
2. Paste the manifest URL:
https://raw.githubusercontent.com/SweetyHake/EAR/refs/heads/main/module.json
3. Enable **Enhanced Audio Resources** in your world's module settings.