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
| **Profiles** | Separate setups like the Modrinth App. Each has its own Minecraft version (releases, snapshots, betas, alphas), loader, mods, worlds, resource packs, memory, Java, colour and custom icon. Duplicate, edit, open folder, delete. |
| **Playtime** | Total time played per profile and a seven-day activity graph on each card. |
| **Modpacks** | Install Modrinth modpacks straight from Browse. Each one becomes its own profile. |
| **Import and share** | Bring in profiles from the Modrinth App, Prism Launcher, CurseForge, or a `.mrpack` file. Share any profile as a `.mrpack` that Auroria, the Modrinth App and Prism can import. |
| **Mods** | Installed list with on/off switches, update checks and Update all. Browse Modrinth for mods, resource packs and shaders with sorting and endless scrolling. Required dependencies install with the mod, and Auroria warns before you remove or turn off a mod that others need. Mods you drop into the folder appear straight away. |
| **Snapshots** | Save a profile's mods and their configs and roll back later. Auroria takes one by itself before updating mods, so a bad update can be undone. |
| **Performance presets** | Low-end PC, Balanced or Max FPS: one click sets memory, Java garbage-collector flags and video settings. |
| **Packs and shaders** | Turn resource packs on and off and drag them into load order. Pick the active shader for Iris or OptiFine. |
| **Worlds** | List each profile's worlds, back them up in one click and restore any backup. Restoring backs up the current world first. |
| **Screenshots** | Browse each profile's screenshots in the launcher. |
| **Servers** | Save servers per profile with live ping, player count and MOTD, and join one directly. |
| **Settings sync** | Copy key binds, video settings and sound volumes from one profile to another. |
| **Java** | Automatic by default (the right Java for each version, downloaded for you), or pick any Java installed on your PC per profile. |
| **Launch check** | Before Play, Auroria scans the mods and warns about ones that do not support your Minecraft version, missing dependencies and duplicates, with a Delete button per mod. |
| **Crash help** | If the game exits unexpectedly, Auroria reads the crash, tells you the likely cause and can upload the log to mclo.gs. |
| **Game logs** | A live log page (shown only while the game runs) with search, level filters, wrap, copy, save, and one-click **upload to mclo.gs** for sharing. |
| **Desktop shortcuts** | Put a shortcut for any profile on the desktop. It opens Auroria and starts that profile. |
| **Themes** | Eight accent colours plus a custom picker. The flame, the title and the background mood follow the colour, and the character is lit to match. |
| **Discord and notifications** | Shows what you are playing on Discord, and Windows notifications when Minecraft closes or crashes, a modpack is installed or an update is ready. |
| **Accounts** | Multiple Microsoft accounts with a quick switcher. |
| **Skins** | Real 3D player model with idle, walk, run, wave and crouch animations. Upload skins, wear them, switch capes. |
| **Updates** | Auroria checks GitHub for a new version on start and updates itself in one click, after checking the download's SHA-256. |
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

Needs Rust 1.88 or newer with the MSVC toolchain, on Windows.

```bash
cargo build --release
```

Output: `target/release/Auroria.exe`. The build fails if that exe is running, so close it first, or set `CARGO_TARGET_DIR` to build somewhere else.

For development without a window, and without touching the Start menu or desktop:

```bash
AURORIA_NO_WINDOW=1 AURORIA_DEV=1 target/release/Auroria.exe
```

then open the printed URL. Set `APPDATA` to a scratch folder to keep your real profiles out of it.

## How it works

Auroria is one Rust executable. A small local HTTP server handles launching, downloads and the Mojang, Microsoft and Modrinth APIs, and the interface (plain HTML, CSS and JS, built into the exe) runs in a native WebView2 window. The window host is a small C# program that Auroria compiles once with the `csc.exe` that ships with Windows.

## Uninstall

1. Close Auroria.
2. Delete `Auroria.exe`.
3. Delete the folder `%APPDATA%\Auroria`. This removes your profiles, worlds and settings, so back up any worlds you want to keep first.
4. If you turned notifications on, delete **Auroria** from the Start menu (right-click it, then Uninstall, or delete `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Auroria.lnk`).
5. Delete any profile shortcuts you put on your desktop.

## Privacy

Auroria has no telemetry. It only contacts the services it needs, such as Microsoft for sign-in, Mojang for game files and Modrinth for mods. See the [privacy policy](PRIVACY.md) for each one and how to turn the optional ones off.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Arnxld-afk](https://github.com/Arnxld-afk)
- Approvers: [Arnxld-afk](https://github.com/Arnxld-afk)

Every release is built from this repository by [GitHub Actions](.github/workflows/build.yml) and signed only after a manual approval.

Privacy policy: [PRIVACY.md](PRIVACY.md). This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it, apart from what the privacy policy lists.

## License

Auroria is released under the [MIT License](LICENSE). Bundled fonts and libraries keep their own licenses, listed below.

## Credits

Not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang Studios.

Fonts: [Monocraft](https://github.com/IdreesInc/Monocraft), Oxanium and Plus Jakarta Sans (SIL OFL). 3D skins: [skinview3d](https://github.com/bs-community/skinview3d) (MIT). Window: Microsoft Edge WebView2 SDK, downloaded from NuGet on first start (not bundled).
