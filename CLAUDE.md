# Auroria

Minecraft: Java Edition launcher for Windows. One file, `Auroria.exe` (about 4 MB): a Rust program with an HTML/CSS/JS UI shown in a WebView2 window.

- Repo: https://github.com/Arnxld-afk/auroria (public, MIT). Site: https://arnxld-afk.github.io/auroria/ (GitHub Pages from `docs/`).
- Owner's GitHub account: `Arnxld-afk`. `gh` is not on PATH: use `C:\Users\arnxl\.tools\gh\bin\gh.exe`.

## Layout

- `src/*.rs`: the backend. `server.rs` is the local HTTP server on 127.0.0.1 with a per-run token and the SSE stream; `routes.rs` holds every `/api/*` route; `state.rs` settings, profiles, accounts, running games and `broadcast`; `auth.rs` Microsoft sign-in; `game.rs` Java runtimes, manifests, loaders, install and launch; `mods.rs` Modrinth, Auroria Client mods and skin, launch check, crash diagnosis; `extras.rs` imports, modpacks, export, worlds, snapshots, presets, packs; `win.rs` window host, Edge fallback, notifications, shortcuts, Discord, self-update, server ping and Win32 calls (including `winsqlite3.dll` for the Modrinth App import); `zipx.rs` zip and PNG; `net.rs` HTTP client (ureq with Windows' own TLS).
- Several profiles can play at once, each with its own account: `State.games` holds each game's state, process and log; a thread-local launch context ties `set_progress` to the launch it runs in (`util::pool` carries it into worker threads). The UI reads a profile's state with `G(id)`; logs are kept per profile in `S.logBufs`.
- `src/host/`: the C# WebView2 host (compiled once with Windows' `csc.exe` into `cache/auroria-host-<hash>.exe`) and the PowerShell scripts. Kept LF-only by `.gitattributes` so the hash is stable.
- `src/ui/`: `index.html` (splash, SVG icon defs, theme function `window.auroriaAccent`), `app.js` (state `S`, `render()`, pages, `actions` map for `data-action` buttons), `styles.css` (later rules override earlier ones; new sections are appended). Embedded into the exe by `src/assets.rs`.
- `build.rs`: icon, version info and manifest. The version comes from `Cargo.toml` only.
- `docs/`: the website. `docs/assets/flame/<hex>.png` are the themed flames Discord loads by URL.
- `.github/workflows/build.yml`: builds `Auroria.exe` from source (needed for SignPath).

## Build

```
cargo build --release
```

- Cargo is not on PATH: use `C:\Users\arnxl\.cargo\bin\cargo.exe`. Writes `target/release/Auroria.exe`; fails if that exe is running.
- Bump the version in `Cargo.toml` only (`VERSION` and the exe's version info read it).

## Test without touching the owner's data

Run with a throwaway data folder and no window, then drive the API or the browser pane:

- `APPDATA=<scratch>\ad2`, `AURORIA_NO_WINDOW=1`, `AURORIA_PORT=47911`, `AURORIA_DEV=1`; token is in `<scratch>\ad2\Auroria\instance.json`.
- `AURORIA_DEV=1` switches off self-update, shortcuts and notifications, which would touch the real Start menu and desktop.
- The UI reads the token from the URL hash: open `http://127.0.0.1:47911/#<token>`, or set `sessionStorage['auroria-token']` and reload.
- Stop a test instance by the `pid` in its own `instance.json`, never by image name: that also kills the owner's Auroria.
- Do not override `USERPROFILE` when testing shortcuts or the Start menu: the Desktop path then resolves to nothing.

## Release

1. Bump version, build, smoke-test the exe.
2. Commit, push, then `gh release create vX.Y.Z target\release\Auroria.exe --notes-file notes.md`. The asset must be named `Auroria.exe`: the in-app updater looks for that name and checks the SHA-256 digest GitHub publishes.
3. Ask the owner before publishing a release; each one goes to users through the updater.

## Gotchas learned the hard way

- Never rewrite source files with PowerShell `Get-Content -Raw | Set-Content`: Windows PowerShell 5.1 reads UTF-8 as ANSI and garbles every non-ASCII character (`×` became `Ã—` in 1.1.0). Use the Edit tool, `sed`, or Python with `encoding='utf-8'`. Keep files without a BOM.
- PowerShell 5.1 mangles quotes in native arguments: pass release notes with `--notes-file`, not `--notes`.
- Pushing `.github/workflows/*` needs the `workflow` token scope (`gh auth refresh -s workflow`).
- Windows notifications need a Start-menu shortcut that carries the app ID `Auroria.Launcher`; a registry-only app ID does not work. The owner's PC has notifications switched off globally, so toasts cannot be seen there.
- Discord presence must wait for Discord's `READY` reply before `SET_ACTIVITY`, or the first update is dropped. App ID `1566706607197266031`.
- The launch check treats `mixinextras` as built in (Fabric Loader 0.15+) and counts jar-in-jar mods.

## Decisions

- CurseForge as a mod source: skipped (needs an API key). Browse is Modrinth only.
- Code signing: applying to the SignPath Foundation (free for OSS). The WebView2 SDK is downloaded from NuGet at first start with a pinned SHA-256, not bundled, because SignPath forbids proprietary code in signed files.
- Style: Monocraft pixel font everywhere, rounded buttons (not square Minecraft bevels), accent theme drives the flame, title, icons and a background mood.
