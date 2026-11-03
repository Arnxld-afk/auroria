"""Runs the Node backend (src/main.js) and the Rust build side by side against copies of the same throwaway data folder,
replays the same API calls on both and reports every answer that differs.

    python tools/parity.py <scratch-dir> [path-to-rust-exe]

Nothing touches the real %APPDATA%\\Auroria: both run with APPDATA and USERPROFILE pointed into <scratch-dir>,
AURORIA_NO_WINDOW set, and the Rust build with AURORIA_DEV so it behaves like the unpackaged Node script.
"""
import base64, io, json, os, re, shutil, sqlite3, struct, subprocess, sys, threading, time, urllib.request, zipfile, zlib

NODE = r"C:\Program Files\nodejs\node.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH = os.path.abspath(sys.argv[1])
RUST = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(ROOT, "target", "release", "Auroria.exe")


def png(w, h, rgba=(200, 100, 50, 255)):
    raw = b"".join(b"\x00" + bytes(rgba) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def jar(path, files):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in files.items():
            z.writestr(n, d if isinstance(d, bytes) else json.dumps(d) if isinstance(d, (dict, list)) else d)


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def seed(base):
    roam, home = os.path.join(base, "roam"), os.path.join(base, "home")
    d = os.path.join(roam, "Auroria")
    write(os.path.join(d, "account.json"), json.dumps({"active": "0123456789abcdef0123456789abcdef", "list": [
        {"mode": "launcher", "msRefresh": "x", "mcToken": "tok", "mcExpires": 4102444800000, "xuid": "1", "profile": {"id": "0123456789abcdef0123456789abcdef", "name": "Tester",
         "skins": [{"id": "s1", "state": "ACTIVE", "url": "http://textures.minecraft.net/texture/3b60a1f6d562f52aaebbf1434f1de147933a3affe0e764fa49ea057536623cd3", "variant": "slim"}],
         "capes": [{"id": "c1", "state": "ACTIVE", "url": "http://textures.minecraft.net/texture/2340c0e03dd24a11b15a8b33c2a7e9e32abb2051b2481d0ba7defd635ca7a933", "alias": "Migrator"}]}},
        {"mode": "launcher", "msRefresh": "y", "mcToken": "tok2", "mcExpires": 4102444800000, "xuid": "2", "profile": {"id": "fedcba9876543210fedcba9876543210", "name": "Alt", "skins": [], "capes": []}},
    ]}, indent=2))
    write(os.path.join(d, "settings.json"), json.dumps({"ramGB": 3, "selectedServer": "survival", "extraKey": 1}))
    write(os.path.join(d, "client", "auroria-client-1.20.1.jar"), b"")
    jar(os.path.join(d, "client", "auroria-client-1.20.1.jar"), {"fabric.mod.json": {"id": "auroria-client", "version": "0.1.0+1.20.1", "custom": {"auroria:minecraft": ["1.20.1"]}}})
    inst = os.path.join(d, "instances", "survival")
    m = os.path.join(inst, "mods")
    jar(os.path.join(m, "moda-1.0.jar"), {"fabric.mod.json": {"id": "moda", "name": "Mod A", "version": "1.0", "depends": {"fabricloader": ">=0.14", "minecraft": "1.19.x", "missingdep": "*", "fabric-api": "*"}}})
    jar(os.path.join(m, "moda-copy.jar"), {"fabric.mod.json": {"id": "moda", "name": "Mod A", "version": "1.1", "depends": {"minecraft": ["1.20", "1.20.1"]}}})
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("fabric.mod.json", json.dumps({"id": "innerlib", "provides": ["innerprov"]}))
    jar(os.path.join(m, "modb.jar"), {"fabric.mod.json": {"id": "modb", "name": "Mod B", "version": "2", "jars": [{"file": "META-INF/jars/inner.jar"}], "depends": {"innerprov": "*", "minecraft": ">=1.20 <1.21", "mixinextras": "*"}}, "META-INF/jars/inner.jar": inner.getvalue()})
    jar(os.path.join(m, "quilty.jar"), {"quilt.mod.json": {"quilt_loader": {"id": "quilty", "version": "3", "metadata": {"name": "Quilty"}, "depends": [{"id": "nothere", "versions": "*"}, {"id": "opt", "optional": True}]}}})
    jar(os.path.join(m, "off.jar.disabled"), {"fabric.mod.json": {"id": "off"}})
    write(os.path.join(m, "broken.jar"), b"not a zip")
    jar(os.path.join(m, "auroria-client.jar"), {"fabric.mod.json": {"id": "auroria-client", "version": "0.1.0+1.20.1", "custom": {"auroria:minecraft": ["1.20.1"]}}})
    write(os.path.join(inst, "auroria-mods.json"), json.dumps({"AAAA": {"file": "moda-1.0.jar", "versionId": "v1", "type": "mod", "slug": "moda", "client": True}}, indent=2))
    write(os.path.join(inst, "options.txt"), 'version:3465\nrenderDistance:12\nfov:0.5\nkey_key.jump:key.keyboard.space\nsoundCategory_master:0.7\nresourcePacks:["vanilla","file/PackB.zip"]\nmouseSensitivity:0.4\n')
    jar(os.path.join(inst, "resourcepacks", "PackA.zip"), {"pack.mcmeta": "{}"})
    jar(os.path.join(inst, "resourcepacks", "PackB.zip"), {"pack.mcmeta": "{}"})
    write(os.path.join(inst, "resourcepacks", "FolderPack", "pack.mcmeta"), "{}")
    write(os.path.join(inst, "resourcepacks", "notes.txt"), "x")
    jar(os.path.join(inst, "shaderpacks", "Shader1.zip"), {"shaders/x": "1"})
    jar(os.path.join(inst, "shaderpacks", "Shader2.zip"), {"shaders/x": "1"})
    write(os.path.join(inst, "config", "iris.properties"), "shaderPack=Shader1.zip\nenableShaders=true\n")
    write(os.path.join(inst, "config", "sodium.json"), "{}")
    for w in ["World One", "World Two"]:
        write(os.path.join(inst, "saves", w, "level.dat"), os.urandom(300))
        write(os.path.join(inst, "saves", w, "region", "r.0.0.mca"), os.urandom(5000))
        write(os.path.join(inst, "saves", w, "session.lock"), b"x")
    write(os.path.join(inst, "saves", "World One", "icon.png"), png(4, 4))
    write(os.path.join(inst, "screenshots", "2024-01-01_10.00.00.png"), png(8, 8))
    write(os.path.join(inst, "screenshots", "b.jpg"), b"\xff\xd8\xff")
    write(os.path.join(inst, "screenshots", "readme.txt"), "x")
    write(os.path.join(d, "instances", "skyblock", "options.txt"), "version:2000\nkey_key.jump:57\nfov:0.0\nrenderDistance:4\n")
    write(os.path.join(d, "skins", "aaaaaaaaaaaa.png"), png(64, 64))
    write(os.path.join(d, "skins", "library.json"), json.dumps([{"id": "aaaaaaaaaaaa", "name": "Mine", "variant": "CLASSIC"}], indent=2))
    # Other launchers to import from.
    pi = os.path.join(roam, "PrismLauncher", "instances", "MyPrism")
    write(os.path.join(pi, "mmc-pack.json"), json.dumps({"components": [{"uid": "net.minecraft", "version": "1.20.1"}, {"uid": "net.fabricmc.fabric-loader", "version": "0.15.11"}]}))
    write(os.path.join(pi, "instance.cfg"), "InstanceType=OneSix\r\nname=Prism Pack\r\n")
    write(os.path.join(pi, ".minecraft", "options.txt"), "fov:0.2\n")
    write(os.path.join(pi, ".minecraft", "logs", "latest.log"), "skip me")
    write(os.path.join(pi, ".minecraft", "config", "cache", "x"), "skip me too")
    write(os.path.join(pi, ".minecraft", "config", "keep.json"), "{}")
    write(os.path.join(roam, "PolyMC", "instances", "Bad", "mmc-pack.json"), "{broken")
    cf = os.path.join(home, "curseforge", "minecraft", "Instances", "CF One")
    write(os.path.join(cf, "minecraftinstance.json"), json.dumps({"name": "CF One", "gameVersion": "1.19.2", "baseModLoader": {"name": "forge-43.2.0"}}))
    write(os.path.join(roam, ".minecraft", "launcher_profiles.json"), json.dumps({"profiles": {"a": {"lastVersionId": "1.20.4", "lastUsed": "2024-01-01T00:00:00.000Z"}, "b": {"lastVersionId": "fabric-loader-0.15.3-1.20.2", "lastUsed": "2024-05-01T00:00:00.000Z"}, "c": {"lastVersionId": "latest-release", "lastUsed": "2025-01-01T00:00:00.000Z"}}}))
    mdir = os.path.join(roam, "ModrinthApp")
    os.makedirs(os.path.join(mdir, "profiles", "Fabulous"), exist_ok=True)
    write(os.path.join(mdir, "icon.png"), png(16, 16))
    db = sqlite3.connect(os.path.join(mdir, "app.db"))
    db.executescript("create table instances (path text, name text, icon_path text, last_played integer, applied_content_set_id integer);"
                     "create table instance_content_sets (id integer, game_version text, loader text, loader_version text);")
    db.execute("insert into instances values ('Fabulous', 'Fabulously Optimized', ?, 5, 1)", (os.path.join(mdir, "icon.png"),))
    db.execute("insert into instances values ('Missing', 'Gone', null, 9, 2)")
    db.execute("insert into instance_content_sets values (1, '1.21.1', 'fabric', '0.16.5'), (2, '1.20', 'vanilla', null)")
    db.commit(); db.close()
    os.makedirs(os.path.join(home, "Downloads"), exist_ok=True)


class Backend:
    def __init__(self, name, cmd, base, port, extra_env):
        self.name, self.base, self.port = name, base, port
        env = dict(os.environ, APPDATA=os.path.join(base, "roam"), USERPROFILE=os.path.join(base, "home"), AURORIA_NO_WINDOW="1", AURORIA_PORT=str(port), **extra_env)
        self.proc = subprocess.Popen(cmd, env=env, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        lock = os.path.join(base, "roam", "Auroria", "instance.json")
        for _ in range(100):
            try:
                self.token = json.load(open(lock))["token"]; break
            except Exception:
                time.sleep(0.1)
        self.events = []
        threading.Thread(target=self._sse, daemon=True).start()
        time.sleep(0.5)

    def _sse(self):
        r = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/events?token={self.token}")
        for line in r:
            line = line.decode("utf-8").strip()
            if line.startswith("data: "):
                self.events.append(json.loads(line[6:]))

    def call(self, method, path, body=None, headers=None, host=None):
        h = {"x-auroria-token": self.token, "Content-Type": "application/json"}
        h.update(headers or {})
        if host: h["Host"] = host
        data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            r = urllib.request.urlopen(req, timeout=180)
            code, raw, ctype = r.status, r.read(), r.headers.get("content-type", "")
        except urllib.error.HTTPError as e:
            code, raw, ctype = e.code, e.read(), e.headers.get("content-type", "")
        try:
            return code, json.loads(raw) if "json" in ctype else raw.decode("utf-8", "replace")[:200], ctype.split(";")[0]
        except Exception:
            return code, raw[:200], ctype


def norm(v, b):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("latency", "players", "userCode", "expiresIn", "verificationUri", "downloads", "follows", "total"): x = "<live>"
            # Zips are compressed by different deflate code; their contents are compared file by file in tree().
            if k == "size" and str(v.get("file", "")).endswith(".zip"): x = "<zip size>"
            out[k] = norm(x, b)
        return out
    if isinstance(v, list): return [norm(x, b) for x in v]
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 1.6e12 < v < 2.2e12 and v != 4102444800000: return "<ts>"
    if isinstance(v, str):
        for p in (b.base, b.base.replace("\\", "/")):
            v = v.replace(p, "<BASE>")
        v = re.sub(r"\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d", "<stamp>", v)
        # Random parts: new skin ids, import ids (a hash of each copy's own folder) and "-1a2b" suffixes that keep profile ids unique.
        if re.fullmatch(r"[0-9a-f]{12}", v) and v != "aaaaaaaaaaaa": v = "<rid>"
        v = re.sub(r"^([a-z0-9-]+)-[0-9a-f]{4}$", r"\1-<rnd>", v)
        v = v.replace(b.token, "<token>").replace(str(b.port), "<port>")
        return v
    return v


def tree(base):
    out = {}
    root = os.path.join(base, "roam", "Auroria")
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, root).replace("\\", "/")
            if rel in ("instance.json", "launcher.log") or rel.startswith(("cache/", "versions/")): continue
            rel = re.sub(r"\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d", "<stamp>", rel)
            rel = re.sub(r"(?<![0-9a-f])[0-9a-f]{12}(?=\.png$)", "<rid>", rel)
            data = open(p, "rb").read()
            if rel.endswith(".json") or rel.endswith(".txt") or rel.endswith(".properties"):
                t = data.decode("utf-8", "replace")
                t = re.sub(r"\b1[6-9]\d{11}\b|\b2[01]\d{11}\b", "<ts>", t).replace(base, "<BASE>").replace(base.replace("\\", "\\\\"), "<BASE>")
                t = re.sub(r'"(?!aaaaaaaaaaaa)[0-9a-f]{12}"', '"<rid>"', t)
                t = re.sub(r'"([a-z0-9-]+)-[0-9a-f]{4}"', r'"\1-<rnd>"', t)
                out[rel] = t
            elif rel.endswith((".zip", ".mrpack", ".jar")) and not rel.startswith("instances/survival/mods/broken"):
                try:
                    with zipfile.ZipFile(p) as z: out[rel] = sorted((i.filename, zlib.crc32(z.read(i))) for i in z.infolist())
                except Exception as e: out[rel] = "bad zip " + str(e)
            else:
                out[rel] = len(data)
    return out


def main():
    if os.path.exists(SCRATCH): shutil.rmtree(SCRATCH)
    s = os.path.join(SCRATCH, "seed"); seed(s)
    a, b = os.path.join(SCRATCH, "node"), os.path.join(SCRATCH, "rust")
    shutil.copytree(s, a); shutil.copytree(s, b)
    node = Backend("node", [NODE, os.path.join(ROOT, "src", "main.js")], a, 47921, {})
    rust = Backend("rust", [RUST], b, 47922, {"AURORIA_DEV": "1"})
    mrpack = io.BytesIO()
    with zipfile.ZipFile(mrpack, "w") as z:
        z.writestr("modrinth.index.json", json.dumps({"formatVersion": 1, "game": "minecraft", "versionId": "1", "name": "Tiny Pack", "summary": "A tiny pack", "dependencies": {"minecraft": "1.20.1", "fabric-loader": "0.15.11"},
            "files": [{"path": "mods/lithium.jar", "hashes": {"sha1": "7fe5d07ee1ee4a7d68a2b30d4f6bd6b7f7a6e2c5"}, "downloads": ["https://cdn.modrinth.com/data/gvQqBUqZ/versions/ZSNsJrPI/lithium-fabric-mc1.20.1-0.11.2.jar"], "fileSize": 1}, {"path": "../evil.jar", "downloads": ["https://example.invalid/x"]}, {"path": "mods/server.jar", "env": {"client": "unsupported"}}]}))
        z.writestr("overrides/config/tiny.json", "{}")
        z.writestr("client-overrides/options.txt", "fov:1.0\n")
    calls = [
        ("GET", "/api/ping"), ("GET", "/api/state"), ("GET", "/api/presets"), ("GET", "/api/versions"),
        ("GET", "/api/loader-versions?loader=fabric&mc=1.20.1"), ("GET", "/api/loader-versions?loader=quilt&mc=1.20.1"), ("GET", "/api/loader-versions?loader=forge&mc=1.20.1"),
        ("GET", "/api/loader-versions?loader=forge&mc=1.8.9"), ("GET", "/api/loader-versions?loader=neoforge&mc=1.21.1"), ("GET", "/api/loader-versions?loader=vanilla&mc=1.21"), ("GET", "/api/loader-versions?loader=fabric&mc=nope"),
        ("GET", "/api/import/scan"), ("GET", "/api/java?server=survival"), ("GET", "/api/java?server=creative"),
        ("GET", "/api/mods?server=survival&fast=1"), ("GET", "/api/mods?server=survival"), ("GET", "/api/mods/sig?server=survival"), ("GET", "/api/launch-check?server=survival"),
        ("GET", "/api/launch-check?server=creative"), ("GET", "/api/worlds?server=survival"), ("GET", "/api/shots?server=survival"), ("GET", "/api/packs?server=survival"),
        ("GET", "/api/packs?server=survival&type=shader"), ("GET", "/api/snapshots?server=survival"), ("GET", "/api/skins"), ("GET", "/api/logs"), ("GET", "/api/servers/ping"),
        ("GET", "/api/servers/ping-one?address=mc.hypixel.net"), ("GET", "/api/servers/ping-one?address=127.0.0.1:1"), ("GET", "/api/servers/ping-one?address=bad%20addr"),
        ("GET", "/api/mods/search?server=survival&q=sodium"), ("GET", "/api/mods/search?server=survival&type=resourcepack&sort=downloads&offset=20"),
        ("GET", "/api/mods/search?server=survival&type=modpack&mc=1.20.1"), ("GET", "/api/mods/search?server=survival&type=shader&q=complementary"),
        ("GET", "/api/modpacks/versions?projectId=1KVo5zza"), ("GET", "/api/modpacks/versions?projectId=bad!"), ("GET", "/api/update/check"), ("GET", "/api/mods/updates?server=survival"),
        ("GET", "/api/mods/dependents?server=survival&file=moda-1.0.jar"),
        ("GET", "/api/profile-image?server=survival&kind=world&name=World%20One"), ("GET", "/api/profile-image?server=survival&name=2024-01-01_10.00.00.png"), ("GET", "/api/profile-image?server=survival&name=..%5Cx"),
        ("GET", "/api/skin-image?id=aaaaaaaaaaaa"), ("GET", "/api/skin-image?id=nope"), ("GET", "/api/cape-image?url=bad"), ("GET", "/api/nope"), ("POST", "/api/nope", {}),
        ("GET", "/nope"), ("GET", "/fonts/monocraft.ttf"), ("GET", "/skinview3d.js"),
        ("POST", "/api/ui-ready", {"ms": 123.6}),
        ("POST", "/api/settings", {"ramGB": "6", "accent": "#12ab56", "width": 100, "notifications": 0, "bogus": 1}),
        ("POST", "/api/settings", {"ramGB": 99, "accent": "nope", "height": "abc", "discordPresence": False}),
        ("POST", "/api/servers/save", {"name": "  Test Pack  ", "version": "1.20.1", "loader": "fabric", "mods": "Sodium, lithium x  ab_c", "tag": "  PVP ", "color": "#AABBCC", "ramGB": "40", "description": "Hello"}),
        ("POST", "/api/servers/save", {"name": "Test Pack", "version": "1.20.1", "loader": "quilt"}),
        ("POST", "/api/servers/save", {"id": "survival", "name": "Survival", "version": "1.20.1", "loader": "fabric", "loaderVersion": "0.15.11", "icon": "data:image/png;base64,AAAA", "accountId": "fedcba9876543210fedcba9876543210", "javaPath": ""}),
        ("POST", "/api/servers/save", {"id": "skyblock", "name": "Sky", "version": "1.20.4", "loader": "vanilla", "mods": "a b", "icon": "nope", "accountId": "nobody", "address": "play.example.com:25566"}),
        ("POST", "/api/servers/save", {"name": "", "version": "1.20"}), ("POST", "/api/servers/save", {"name": "X", "version": "!"}), ("POST", "/api/servers/save", {"name": "X", "version": "1.20", "address": "a b"}),
        ("POST", "/api/servers/save", {"name": "X", "version": "1.20", "javaPath": "C:\\nope\\java.exe"}),
        ("POST", "/api/servers/duplicate", {"id": "survival"}), ("POST", "/api/servers/duplicate", {"id": "nope"}),
        ("POST", "/api/profile/preset", {"server": "survival", "preset": "balanced"}), ("POST", "/api/profile/preset", {"server": "skyblock", "preset": "low"}),
        ("POST", "/api/profile/preset", {"server": "survival", "preset": "bad"}), ("POST", "/api/profile/preset", {"server": "nope", "preset": "max"}),
        ("POST", "/api/packs/order", {"server": "survival", "order": ["PackA.zip", "FolderPack", "Missing.zip"]}), ("POST", "/api/packs/shader", {"server": "survival", "name": "Shader2.zip"}),
        ("POST", "/api/packs/shader", {"server": "skyblock", "name": ""}), ("POST", "/api/packs/delete", {"server": "survival", "type": "resourcepack", "name": "FolderPack"}),
        ("POST", "/api/packs/delete", {"server": "survival", "type": "shader", "name": ".."}),
        ("POST", "/api/snapshots/take", {"server": "survival", "label": "My Snap!"}), ("POST", "/api/snapshots/delete", {"server": "survival", "file": "bad.zip"}),
        ("POST", "/api/worlds/backup", {"server": "survival", "world": "World One"}), ("POST", "/api/worlds/backup", {"server": "survival", "world": "Nope"}),
        ("POST", "/api/worlds/restore", {"server": "survival", "file": "bad.zip"}), ("POST", "/api/worlds/delete-backup", {"server": "survival", "file": "x.zip"}),
        ("POST", "/api/options/sync", {"from": "survival", "to": "skyblock", "groups": ["video", "sound", "controls"]}), ("POST", "/api/options/sync", {"from": "survival", "to": "creative", "groups": ["video", "controls"]}),
        ("POST", "/api/options/sync", {"from": "creative", "to": "survival", "groups": ["video"]}), ("POST", "/api/options/sync", {"from": "survival", "to": "survival", "groups": ["video"]}),
        ("POST", "/api/options/sync", {"from": "survival", "to": "skyblock", "groups": ["nope"]}),
        ("POST", "/api/profile/servers", {"server": "survival", "list": [{"name": " Hyp ", "address": "mc.hypixel.net"}, {"address": "bad addr"}, {"name": "", "address": "1.2.3.4:25565"}]}),
        ("POST", "/api/mods/toggle", {"server": "survival", "file": "moda-copy.jar"}), ("POST", "/api/mods/toggle", {"server": "survival", "file": "off.jar.disabled"}),
        ("POST", "/api/mods/delete", {"server": "survival", "file": "broken.jar", "fast": True}),
        ("POST", "/api/mods/install", {"server": "survival", "projectId": "gvQqBUqZ", "withDeps": True}),
        ("POST", "/api/mods/install", {"server": "survival", "projectId": "AANobbMI", "type": "mod"}),
        ("POST", "/api/mods/install-dep", {"server": "survival", "dep": "fabric-api"}), ("POST", "/api/mods/install-dep", {"server": "survival", "dep": "bad dep"}),
        ("GET", "/api/mods?server=survival"), ("GET", "/api/mods/updates?server=survival"), ("GET", "/api/launch-check?server=survival"),
        ("GET", "/api/mods/dependents?server=survival&file=lithium-fabric-mc1.20.1-0.11.2.jar"),
        ("POST", "/api/mods/install", {"server": "survival", "projectId": "BVzZfTc1", "type": "resourcepack"}),
        ("POST", "/api/mods/install", {"server": "creative", "projectId": "AANobbMI"}),
        ("POST", "/api/mods/update", {"server": "survival", "updates": []}),
        ("POST", "/api/import/run", {"id": "nope"}),
        ("POST", "/api/import/mrpack", {"data": "data:application/octet-stream;base64," + base64.b64encode(mrpack.getvalue()).decode()}),
        ("POST", "/api/import/mrpack", {"data": "nope"}), ("POST", "/api/import/mrpack", {"data": "data:x;base64,AAAA"}),
        ("POST", "/api/skins/upload", {"data": "data:image/png;base64," + base64.b64encode(png(64, 32)).decode(), "name": "New skin", "variant": "SLIM"}),
        ("POST", "/api/skins/upload", {"data": "data:image/png;base64," + base64.b64encode(png(10, 10)).decode()}), ("POST", "/api/skins/upload", {"data": "abc"}),
        ("POST", "/api/skins/delete", {"id": "aaaaaaaaaaaa"}),
        ("POST", "/api/auth/switch", {"id": "fedcba9876543210fedcba9876543210"}), ("POST", "/api/auth/switch", {"id": "nobody"}),
        ("POST", "/api/config/client-id", {"clientId": "bad"}), ("POST", "/api/config/client-id", {"clientId": " 01234567-89ab-cdef-0123-456789abcdef "}), ("GET", "/api/state"),
        ("POST", "/api/config/client-id", {"clientId": ""}),
        ("POST", "/api/window", {"action": "min"}), ("POST", "/api/window", {"action": "rect"}), ("POST", "/api/window", {"action": "pos", "x": 10.6, "y": "4"}), ("POST", "/api/window", {"action": "bad"}),
        ("POST", "/api/autoplay", {"id": "skyblock"}), ("POST", "/api/autoplay", {"id": "nope"}),
        ("POST", "/api/logs/upload", {"content": "  \n "}), ("POST", "/api/stop", {"serverId": "survival"}),
        ("POST", "/api/profile/shortcut", {"server": "survival"}), ("POST", "/api/launch", {"serverId": "survival", "join": "bad addr"}), ("POST", "/api/launch", {"account": "nobody"}),
        ("POST", "/api/auth/logout", {}), ("POST", "/api/auth/logout", {}), ("POST", "/api/auth/logout", {}),
        ("POST", "/api/launch", {"serverId": "creative"}),
        ("POST", "/api/servers/delete", {"id": "test-pack"}), ("POST", "/api/servers/delete", {"id": "survival"}),
        ("GET", "/api/state"), ("GET", "/api/import/scan"), ("GET", "/api/snapshots?server=survival"), ("GET", "/api/worlds?server=survival"), ("GET", "/api/packs?server=survival"),
        ("GET", "/api/mods?server=tiny-pack&fast=1"), ("GET", "/api/skins"),
    ]
    diffs = 0
    for c in calls:
        method, path, body = c[0], c[1], (c[2] if len(c) > 2 else None)
        rn, rr = node.call(method, path, body), rust.call(method, path, body)
        x, y = (rn[0], norm(rn[1], node), rn[2]), (rr[0], norm(rr[1], rust), rr[2])
        if x == y:
            if json.dumps(x[1]) != json.dumps(y[1]): print(f"ORDER {method} {path}\n  node: {json.dumps(x[1])[:600]}\n  rust: {json.dumps(y[1])[:600]}"); diffs += 1
            continue
        diffs += 1
        print(f"DIFF {method} {path} {json.dumps(body)[:80] if body else ''}\n  node: {json.dumps(x)[:1500]}\n  rust: {json.dumps(y)[:1500]}")
    # Import a found profile once both lists agree, by its id.
    for be in (node, rust):
        for e in be.call("GET", "/api/import/scan")[1]: be.call("POST", "/api/import/run", {"id": e["id"]})
    time.sleep(3)
    # Odd requests: no token, wrong host.
    for be in (node, rust):
        req = urllib.request.Request(f"http://127.0.0.1:{be.port}/api/state")
        try: urllib.request.urlopen(req)
        except urllib.error.HTTPError as e: print(be.name, "no token:", e.code, e.read()[:60])
        try: be.call("GET", "/api/state", host="evil.example")
        except Exception as e: print(be.name, "bad host error", e)
        print(be.name, "bad host:", be.call("GET", "/api/state", host="evil.example")[:2])
    ev = [[norm(e, b) for e in be.events if e.get("type") != "progress"] for b, be in ((node, node), (rust, rust))]
    if ev[0] != ev[1]:
        diffs += 1
        print("EVENTS differ\n  node:", json.dumps(ev[0])[:3000], "\n  rust:", json.dumps(ev[1])[:3000])
    prog = [[(e.get("serverId"), e.get("stage")) for e in be.events if e.get("type") == "progress"] for be in (node, rust)]
    if prog[0] != prog[1]: print("PROGRESS events differ\n  node:", prog[0][:20], "\n  rust:", prog[1][:20])
    ta, tb = tree(a), tree(b)
    for k in sorted(set(ta) | set(tb)):
        if ta.get(k) != tb.get(k):
            diffs += 1
            print(f"FILE {k}\n  node: {str(ta.get(k))[:800]}\n  rust: {str(tb.get(k))[:800]}")
    for be in (node, rust): be.proc.kill()
    print(f"{len(calls)} calls, {diffs} differences")


if __name__ == "__main__":
    main()
