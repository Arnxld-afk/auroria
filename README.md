<div align="center">

<img src="src/ui/icon-256.png" alt="Auroria" width="120">

# Auroria

**A fast, good-looking Minecraft: Java Edition launcher for Windows.**
One file. No installer. Profiles, mods, skins and logs in one place.

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-f07f2a)
![Loaders](https://img.shields.io/badge/loaders-Fabric%20%7C%20Quilt%20%7C%20Forge%20%7C%20NeoForge-f07f2a)
![Minecraft](https://img.shields.io/badge/minecraft-1.0%20to%20latest-f07f2a)

</div>

---

## Why Auroria

- **One exe.** Download `Auroria.exe`, double-click, play. Nothing to install.
- **Opens fully drawn.** The window only appears once the fonts, background and 3D character have loaded, about a second on a warm start.
- **Every loader.** Vanilla, Fabric, Quilt, Forge (1.8 and up) and NeoForge.
- **Built for modded play.** Modrinth browser, update checks, and a pre-launch check that catches outdated, conflicting and duplicate mods before the game crashes.
- **Pixel-themed.** Dark and orange, set in the Monocraft font.

## Features

| | |
|---|---|
| **Profiles** | Separate setups like the Modrinth App. Each has its own Minecraft version (releases, snapshots, betas, alphas), loader, mods, worlds, resource packs, memory, colour and custom icon. Duplicate, edit, open folder, delete. |
| **Import** | Bring in profiles from the Modrinth App, Prism Launcher, CurseForge, or a `.mrpack` file. |
| **Mods** | Installed list with on/off switches, update checks and Update all. Browse Modrinth for mods, resource packs and shaders with sorting and endless scrolling. The folder is watched, so mods you drop in appear straight away. |
| **Launch check** | Before Play, Auroria scans the mods and warns about ones that do not support your Minecraft version, missing dependencies and duplicates, with a Delete button per mod. |
| **Crash help** | If the game exits unexpectedly, Auroria reads the crash and tells you the likely cause. |
| **Game logs** | A live log page (shown only while the game runs) with search, level filters, wrap, copy, save, and one-click **upload to mclo.gs** for sharing. |
| **Accounts** | Multiple Microsoft accounts with a quick switcher. |
| **Skins** | Real 3D player model with idle, walk, run, wave and crouch animations. Upload skins, wear them, switch capes. |
| **Settings** | Memory, window size, fullscreen, custom Java path, keep launcher open. |

Play downloads the right Java runtime, game files, libraries and assets from Mojang automatically, then starts Minecraft. If a profile has a server set, it joins it directly (Quick Play on 1.20+).

## Install

1. Download `Auroria.exe` from the [Releases](../../releases) page.
2. Double-click it. Windows may show **Windows protected your PC** because the exe is not code-signed yet: choose **More info, then Run anyway**.
3. Sign in and press **PLAY**.

Auroria uses the WebView2 engine that ships with Windows 10 and 11. If it is missing, Auroria falls back to a Microsoft Edge app window.

Your data lives in `%APPDATA%\Auroria`: settings, accounts, game files, Java, and one folder per profile under `instances`.

## Signing in

Click **Sign in with Microsoft**, open microsoft.com/link and type the code Auroria shows. No setup needed.

By default Auroria signs in through the Minecraft Launcher's public app ID, so Microsoft's page names the Minecraft Launcher. Microsoft does not officially allow other launchers to use that ID and could block it at any time. To sign in as your own app instead, register an Azure app (personal Microsoft accounts only, public client flows allowed), get it approved at <https://aka.ms/mce-reviewappid>, and paste its client ID in **Settings, Account, Sign-in app**.

## Version support

| Loader | Minecraft versions |
|---|---|
| Vanilla | all |
| Fabric / Quilt | 1.14 and up |
| Forge | 1.8 and up |
| NeoForge | 1.20.2 and up |

- Forge and NeoForge run their official installer on the first Play. That needs an internet connection and a minute.
- Versions before 1.6 use the legacy asset layout Mojang provides, and some show the old login quirks of that era.

## Configuration

`%APPDATA%\Auroria\config.json` is created on first run. Fields: `brand`, `microsoftClientId`, `remoteConfigUrl` (optional URL of a JSON file with `servers`, to push profile updates to players). Restart Auroria after editing.

## Build from source

Needs Node 22 on any OS.

```bash
npm install
npm pack node-win-x64@22.20.0 && tar xzf node-win-x64-22.20.0.tgz
node build.mjs package/bin/node.exe
```

Output: `dist/Auroria.exe`. The build fails if that exe is running, so close it first. Set `AURORIA_OUT` to write a different file name.

For development without a window:

```bash
AURORIA_NO_WINDOW=1 node src/main.js
```

then open the printed URL.

## How it works

Auroria is a Node single-executable app. A small local HTTP server handles launching, downloads and the Mojang, Microsoft and Modrinth APIs, and the interface (plain HTML, CSS and JS) runs in a native WebView2 window.

## Credits

Not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang Studios.

Fonts: [Monocraft](https://github.com/IdreesInc/Monocraft), Oxanium and Plus Jakarta Sans (SIL OFL). 3D skins: [skinview3d](https://github.com/bs-community/skinview3d) (MIT). Window: Microsoft Edge WebView2 SDK.
