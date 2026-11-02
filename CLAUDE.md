# Auroria

Minecraft: Java Edition launcher for Windows. One file, `Auroria.exe`: a Node single-executable app (SEA) with an HTML/CSS/JS UI shown in a WebView2 window.

- Repo: https://github.com/Arnxld-afk/auroria (public, MIT). Site: https://arnxld-afk.github.io/auroria/ (GitHub Pages from `docs/`).
- Owner's GitHub account: `Arnxld-afk`. `gh` is not on PATH: use `C:\Users\arnxl\.tools\gh\bin\gh.exe`.

## Layout

- `src/main.js`: the whole backend. Local HTTP server on 127.0.0.1 with a per-run token, all `/api/*` routes in the `routes` object, game install and launch, Modrinth, auth, Discord, notifications, self-update, and the PowerShell scripts that host the window (`HOST_PS`) and create shortcuts.
- `src/ui/`: `index.html` (splash, SVG icon defs, theme function `window.auroriaAccent`), `app.js` (state `S`, `render()`, pages, `actions` map for `data-action` buttons), `styles.css` (later rules override earlier ones; new sections are appended).
- `build.mjs`: makes the SEA. Embedded assets are listed at the top.
- `docs/`: the website. `docs/assets/flame/<hex>.png` are the themed flames Discord loads by URL.
- `.github/workflows/build.yml`: builds `Auroria.exe` from source (needed for SignPath).

## Build

```
node build.mjs "C:\Program Files\nodejs\node.exe"
```

- Writes `dist/Auroria.exe`. Fails with EBUSY if that exe is running: set `AURORIA_OUT=Auroria-new.exe` to write another name. Never close the owner's running Auroria without asking.
- Bump the version in three places together: `VERSION` in `src/main.js`, `package.json`, and the version numbers in `build.mjs`.

## Test without touching the owner's data

Run with a throwaway data folder and no window, then drive the API or the browser pane:

- `APPDATA=<scratch>\ad2`, `AURORIA_NO_WINDOW=1`, `AURORIA_PORT=47911`; token is in `<scratch>\ad2\Auroria\instance.json`.
- The UI reads the token from the URL hash: open `http://127.0.0.1:47911/#<token>`, or set `sessionStorage['auroria-token']` and reload.
- `node src/main.js` runs the same server unpackaged. Some features only work from the exe (`IS_SEA`): self-update, shortcuts, notifications.
- Do not override `USERPROFILE` when testing shortcuts or the Start menu: the Desktop path then resolves to nothing.

## Release

1. Bump version, build, smoke-test the exe.
2. Commit, push, then `gh release create vX.Y.Z dist\...\Auroria.exe --notes-file notes.md`. The asset must be named `Auroria.exe`: the in-app updater looks for that name and checks the SHA-256 digest GitHub publishes.
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
