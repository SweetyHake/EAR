# EAR Module — Development History & Bug Log

## Session 1: Per-playlist volume + architecture refactoring

### Volume system: global → per-playlist
- `localVolume` (одна переменная) → `playlistVolumes[playlistId]`
- Тип настройки: `Number` → `Object {playlistId: volume}`
- Миграция старых данных: если настройка была `Number`, при чтении размазывается на все существующие плейлисты

### Архитектурные изменения
- `common.mjs` — общие константы, log с уровнями, DOM-селекторы, общие утилиты
- `music-player.mjs` — классы `EarState` и `EarPlayerWidget`, тонкий `handleDirectory`
- `name-hiding.mjs` — один MutationObserver, без каскадов setTimeout

### Починено
- CSS `.sound-controls` — `flex: 0 0 32px` от Foundry (кнопки не влезали)
- StopEvent блокировал фокус — `btn.blur()` добавлен
- `_startLiveUpdate` не вызывался для новых виджетов — перенесён в конструктор
- `_startLiveUpdate` дублировался в `mount()` — удалён из mount
- Первый tick завершался без `setTimeout` — добавлен `setTimeout(tick, 250)` при ранних return
- Ленивый destroy использовал stale `activeIds` — заменён на `document.querySelector`
- Double-fade в `fadeGain` — добавлены `_fadeTimers`

---

## Session 2: Fade, crossfade, preview, normalization

### Добавлено
- **Fade in/out** — `gainNode.linearRampToValueAtTime`, настройки `fadeDuration`
- **Crossfade** — одновременный ramp out/in при next/prev
- **Preview** — `HTMLAudioElement` для локального предпрослушивания
- **Normalization** — fetch → `OfflineAudioContext.decodeAudioData` → peak → gain multiplier
- **Track interval** — пауза между треками

### Починено
- Preview не учитывал `ps.volume` (собственная громкость звука) — добавлен во все 6 мест
- Preview не учитывал глобальные каналы (`globalPlaylistVolume` и т.д.) — добавлен `_getGlobalChannelVolume`
- Interval: Foundry асинхронно перезаписывал gainNode после хука — добавлены отложенные `setTimeout(applyLocalVolume, [50, 150, 400])`
- Interval: `fadingSounds` не устанавливался — liveUpdate обнулял тишину
- Fade-out: `onComplete` убивал свежезапущенный звук — `if (ps.playing) return;`
- Локализация заменена на Foundry-ключи (`PLAYLIST.SoundPlay`, `PLAYLIST.ModeSequential` и т.д.)

---

## Session 3: Код-ревью — критические баги

| Баг | Причина | Фикс |
|---|---|---|
| Утечка в `fadingSounds` | `crossfade` вручную добавлял id, а `fadeGain` в early-return ветках не удалял → id навсегда блокировал контроль громкости | `fadeGain` — единственный владелец add/delete; чистка во всех exit-путях (common.mjs) |
| Пустая строка при close с fade | Виджет уничтожался сразу, звук ещё «играл» (fade), нативные контролы скрыты | Отложенный teardown до завершения fade + `_teardown()` |
| Манки-патч `render` возвращал `this` | `ApplicationV2#render` — async, возвращает Promise | `return Promise.resolve(this)` |

---

## Session 4: Ревью — оставшиеся проблемы

- **Пустые строки для streaming/незагруженных треков** — нативные контролы скрывались до проверок `streaming`/`dur <= 0`; теперь скрываются только когда виджет есть или будет
- **Name-hiding observer** — `m.target.closest?.()` на текстовых нодах не работает → срабатывал на каждый тик виджета; фикс: `parentElement`
- **`AUDIO_CACHE` держал до 40 МБ/файл** — кэшируется пик (число), не семплы
- **`getNormalizationGain` читал настройку каждый тик** — кэш + `invalidateNormGains()` (onChange)
- **Двойной скан при рендере** — `renderPlaylistDirectory` + `renderSidebarTab` дублировались (parentClassHooks=true); убран `renderSidebarTab`
- **`ps.synchronize()` — мёртвый код** (в v14 метода нет) — удалён
- **Unbounded normalization gain** (425 для тихого трека) — `MAX_NORM_GAIN = 4`
- **Тултип repeat всегда одинаковый** — `EAR.RepeatOn/Off`
- **`setLogLevel` не использовался** — настройка «Log level» (позже убрана из UI)

---

## Session 5: Два блока на трек (регрессия)

| Баг | Причина | Фикс |
|---|---|---|
| Двойной виджет на трек | Проверка `S.controls.get` стояла ДО `await ps.load()`; два конкурентных `handleDirectory` (хук + дебаунс) оба проходили проверку и оба создавали виджет | Проверка существующего виджета ПОСЛЕ `await` — создание атомарно |

---

## Session 6: Только EAR — без вспышек нативного UI

`handleDirectory` переписан на три прохода:
1. **Pass 1 (синхронно)** — скрыть нативные контролы всех не-streaming звуков (нет вспышки во время загрузки)
2. **Pass 2 (синхронно)** — создать/перемонтировать виджеты сразу (длительность 0, live-цикл заполнит) — без пустых строк
3. **Pass 3** — `await ps.load()` (идемпотентно)

Streaming-треки оставляют нативный UI (не бывает пустых строк). Гонка из Session 5 не вернулась: pass 2 полностью синхронный.

---

## Session 7: Убраны задержки взаимодействия

- Interaction lock: после volume-драга 100 → **30мс**, после seek 400 → **120мс**
- Seek: объединён `{playing:false, pausedTime}` в один апдейт (2 round-trip вместо 3)
- Дебаунс `refreshDirectory`: 80 → **16мс**
- Live-цикл: 250 → **150мс**
- Колесо: троттл 600 → **250мс**, `wheelActive` 150 → **50мс**
- Оптимистичный отклик кнопок play/mode/repeat (live-цикл корректирует при сбое)
- `injectPreviewControls`: 50 → 16мс

---

## Session 8: Задержка при остановке

Close-кнопка: строка скрывается **мгновенно** (`display:none`), аудио затухает в фоне, после fade звук останавливается и Foundry удаляет скрытую строку.

---

## Session 9: Освежение настроек

В UI осталось 5 ключевых параметров: Volume slider controls, Smooth start and stop, Crossfade between tracks, Silence between tracks, Hide track names from players.
`fadeDuration`/`crossfadeDuration` — скрыты (config:false, значения сохраняются), `logLevel` — удалён.

---

## Session 10: Перевод

en/ru обновлены: человечнее, короче; подсказки без точек в конце; «Предпрослушивание» для preview.

---

## Session 11: Настройка скрытия названий

`hideTrackNames` (toggle, по умолчанию вкл): `shouldHideName` проверяет настройку (кэш); при выключении названия **восстанавливаются** (leaf-узлы помечаются `data-ear-hidden`).

---

## Session 12: Цель слайдера громкости

> **Устарело (Session 15):** настройка `volumeTarget` удалена. См. Session 15.

`volumeTarget` (select): только трек (`ps.volume`, через `debounceVolume`) / весь плейлист (как раньше) / вся музыка (`core.globalPlaylistVolume`, синк через хук `globalPlaylistVolumeChanged`).
Заодно: `_buildDOM` применяет полную эффективную громкость (`playlist × track × norm`).

---

## Session 15: Разделение громкости плейлиста и трека (issue: per-track volume)

Модель: `effective = core global × playlist (EAR) × track (ps.volume) × normalization`. Каждая ступень хранится и регулируется независимо.

- **VolumeController** (`VC`) — единственный владелец семантики громкости: `setTrackVolume(Live)`, `setPlaylistVolume(Live)`, `toggleTrackMute`, `togglePlaylistMute`. Убрана мультиплексация одного слайдера между целями.
- **Слайдер в строке трека** теперь всегда показывает и меняет только `ps.volume`.
- **Заголовки групп**: `syncGroupHeaders` вставляет перед первым играющим треком каждого плейлиста бар `.ear-pl-header` (имя + слайдер + мьют), управляющий ступенью playlist; рефы в `S.plHeaders`, пересоздание при потере `isConnected`.
- Alt = быстрое управление соседней ступенью (Alt на треке → плейлист, Alt на заголовке → вся музыка).
- Настройка `volumeTarget`, хук `globalPlaylistVolumeChanged`, методы `syncVolumeUI/syncGlobalVolumeUI` удалены.

---

## Session 13: Пауза между треками не работала

| Баг | Причина | Фикс |
|---|---|---|
| Интервал не срабатывал в shuffle / при wrap-around | Флаг `trackEnded` ставился хуком завершившегося трека, а хуки идут в порядке коллекции — `playing:true` следующего мог прийти раньше | Решение отложено на макротаск (`setTimeout(0)`) — оба хука успевают отработать |
| Тишина не держалась при медленной загрузке | Разовые таймеры [50,150,400]мс | `S.intervalWait` + удержание 0.0001 live-циклом каждый тик |

---

## Session 14: Финальная тщательная проверка

| Баг | Причина | Фикс |
|---|---|---|
| **Crossfade не работал на v14** | `if (typeof pl.playNext === "function")` — в v14 метод существует, fallback с кроссфейдом никогда не выполнялся | Убран short-circuit; next/prev всегда идут через логику EAR (`playbackOrder` + crossfade) |
| Ложная пауза после ручного next/prev | `_userStopped[cur.id]` не ставился в playNext-пути → остановка трека выглядела естественным концом | Флаг ставится всегда, в т.ч. в crossfade-ветке |
| Шторм `globalPlaylistVolumeChanged` | Каждый input-event драга дёргал синк всех виджетов | Дебаунс 50мс |
| Полный скан name-hiding на каждый хук | `updatePlaylistSound`/`updatePlaylist`/`globalPlaylistVolumeChanged` без дебаунса | `scheduleHideNames()` 60мс |
| Observer предпросмотра без дебаунса | Полный скан на каждую DOM-мутацию | Дебаунс 50мс |
| Перезапуск трека во время close-fade убивал его | Колбэк фейда не отличал «не останавливался» от «перезапущен» | Маркер `S.closing`: play-обработчик снимает его и отменяет фейд (`cancelGainRamps`) |
| Health-check GM (30с) ломал тишину интервала | Выставлял полную громкость, игнорируя `intervalWait` | Health-check уважает `intervalWait` |

---

## Session 15: Мерцание при закрытии двух треков

| Баг | Причина | Фикс |
|---|---|---|
| Строки «багаются и мерцают» при закрытии двух треков | Завершение fade первого трека → ре-рендер Foundry → строка второго (ещё затухающего) пересоздавалась видимой (inline `display:none` терялся) | `S.closing` (Set): pass 1 `handleDirectory` прячет строку заново на каждом запуске; маркер чистится в fade-cb, stop-ветке хука и по выходу из `.currently-playing` |

## Session 16: Локальная громкость трека

ps.volume — серверное поле документа, пишется всем клиентам. Слайдер трека теперь пишет ТОЛЬКО локальный слой: S.trackVolumes (клиентская настройка trackVolumes, дебаунс 400 мс). Эффективная громкость = global × playlist (EAR) × track (локальный) × norm. Все ps.volume/sound.volume в music-player заменены на S.getTrackVolume(id); debounceVolume и ветка changes.volume в updatePlaylistSound удалены. radio-engine не тронут (там серверная громкость осознанна).

