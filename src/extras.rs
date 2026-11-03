// Profile extras: import from other launchers, modpacks, export, worlds and backups, screenshots, options sync, snapshots, presets, packs and shaders.
use crate::game::{instance_dir, mods_dir, pick_loader_version};
use crate::mods::MR;
use crate::net::*;
use crate::state::*;
use crate::util::*;
use crate::{win, zipx};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn re(s: &str) -> Regex { Regex::new(s).unwrap() }

// ---------- import profiles from other launchers ----------
pub const IMPORT_SKIP: &[&str] = &["logs", "crash-reports", ".fabric", ".mixin.out", "natives", "versions", "libraries", "assets", "runtime", "webcache2", "cache", ".cache", "downloads"];
fn norm_loader(x: &str) -> &'static str {
    let l = x.to_lowercase();
    if l.contains("neoforge") { "neoforge" } else if l.contains("quilt") { "quilt" } else if l.contains("fabric") { "fabric" } else if l.contains("forge") { "forge" } else { "vanilla" }
}
fn png_data_url(f: &Path) -> String {
    match fs::read(f) { Ok(b) if b.len() <= 150000 && b.get(1..4) == Some(b"PNG") => format!("data:image/png;base64,{}", b64_encode(&b)), _ => String::new() }
}
pub struct ImportSrc { pub id: String, pub source: String, pub dir: PathBuf, pub name: String, pub version: String, pub loader: String, pub loader_version: String, pub icon: String }
pub fn scan_imports() -> Vec<ImportSrc> {
    let mut out = Vec::new();
    let roam = roaming();
    let mut add = |source: &str, dir: PathBuf, name: &str, version: &str, loader: &str, lv: &str, icon: String| {
        if name.is_empty() || version.is_empty() { return; }
        let l = norm_loader(loader);
        out.push(ImportSrc { id: sha1_hex(path_str(&dir).as_bytes())[..12].to_string(), source: source.into(), name: slice_chars(name, 48), version: version.into(), loader: l.into(), loader_version: if l == "vanilla" { String::new() } else { lv.into() }, icon, dir });
    };
    // Modrinth App keeps its profiles in a SQLite database next to the profile folders.
    let db = roam.join("ModrinthApp").join("app.db");
    if exists(&db) {
        match win::sqlite_rows(&db, "select i.path, i.name, i.icon_path, c.game_version, c.loader, c.loader_version from instances i join instance_content_sets c on c.id = i.applied_content_set_id order by i.last_played desc", 6) {
            Ok(rows) => for r in rows {
                let dir = roam.join("ModrinthApp").join("profiles").join(r[0].clone().unwrap_or_else(|| "null".into()));
                if exists(&dir) {
                    let icon = r[2].as_ref().filter(|x| !x.is_empty()).map(|x| png_data_url(Path::new(x))).unwrap_or_default();
                    add("Modrinth App", dir, r[1].as_deref().unwrap_or(""), r[3].as_deref().unwrap_or(""), r[4].as_deref().unwrap_or(""), r[5].as_deref().unwrap_or(""), icon);
                }
            },
            Err(e) => log_line(&format!("import scan: Modrinth App {}", e.msg)),
        }
    }
    // Prism Launcher, PolyMC and MultiMC share one instance format.
    for base in ["PrismLauncher", "PolyMC", "MultiMC"] {
        let root = roam.join(base).join("instances");
        let Ok(dirs) = read_dir(&root) else { continue };
        for (d, is_dir) in dirs {
            if !is_dir { continue; }
            let inst = root.join(&d);
            let Some(pack) = read_json(&inst.join("mmc-pack.json")) else { continue };
            let Some(comps) = pack["components"].as_array() else { continue };
            let comp = |uid: &str| comps.iter().find(|c| g(c, "uid").as_str() == Some(uid));
            let Some(mc) = comp("net.minecraft") else { continue };
            let lo = [("neoforge", "net.neoforged"), ("quilt", "org.quiltmc.quilt-loader"), ("fabric", "net.fabricmc.fabric-loader"), ("forge", "net.minecraftforge")].iter().find_map(|(l, u)| comp(u).map(|c| (*l, gs(c, "version")))).unwrap_or(("vanilla", String::new()));
            let mut name = d.clone();
            if let Some(c) = re(r"(?mR)^name=(.*)$").captures(&read_text(&inst.join("instance.cfg"))) { let n = c[1].trim(); if !n.is_empty() { name = n.to_string(); } }
            let game = [inst.join(".minecraft"), inst.join("minecraft")].into_iter().find(|p| exists(p));
            if let Some(game) = game { add(if base == "PrismLauncher" { "Prism Launcher" } else { base }, game, &name, &str_or(g(mc, "version")), lo.0, &lo.1, String::new()); }
        }
    }
    // CurseForge app.
    let root = home().join("curseforge").join("minecraft").join("Instances");
    if let Ok(dirs) = read_dir(&root) {
        for (d, is_dir) in dirs {
            if !is_dir { continue; }
            let inst = root.join(&d);
            let Some(j) = read_json(&inst.join("minecraftinstance.json")) else { continue };
            let bl = if truthy(g(&j["baseModLoader"], "name")) { js_string(&j["baseModLoader"]["name"]) } else { String::new() };
            // "fabric-0.15.7-1.20.1" or "forge-47.2.0"
            let lv = re(r"(?i)^[a-z]+-(\d[^-]*)").captures(&bl).map(|c| c[1].to_string()).unwrap_or_default();
            let name = if truthy(g(&j, "name")) { js_string(&j["name"]) } else { d.clone() };
            add("CurseForge", inst, &name, &str_or(g(&j, "gameVersion")), &bl, &lv, String::new());
        }
    }
    // The official Minecraft Launcher's folder: worlds, packs and options of its most recently used profile.
    let mc_dir = roam.join(".minecraft");
    if let Some(lp) = read_json(&mc_dir.join("launcher_profiles.json")) {
        if let Some(profs) = lp["profiles"].as_object() {
            let vre = re(r"^(\d|fabric-loader|quilt-loader)");
            let mut list: Vec<&Value> = profs.values().filter(|p| vre.is_match(&str_or(g(p, "lastVersionId")))).collect();
            list.sort_by(|a, b| str_or(g(b, "lastUsed")).cmp(&str_or(g(a, "lastUsed"))));
            if let Some(p0) = list.first() {
                let v = js_string(g(p0, "lastVersionId"));
                match re(r"^(fabric|quilt)-loader-([^-]+)-(.+)$").captures(&v) {
                    Some(m) => add("Minecraft Launcher", mc_dir.clone(), "Minecraft Launcher worlds", &m[3], &m[1], &m[2], String::new()),
                    None => add("Minecraft Launcher", mc_dir.clone(), "Minecraft Launcher worlds", &v, "vanilla", "", String::new()),
                }
            }
        }
    }
    out
}
pub fn new_profile_entry(name: &str, version: &str, loader: &str, loader_version: &str, icon: &str, description: &str) -> Value {
    let n = { let t = slice_chars(js_trim(if name.is_empty() { "Imported profile" } else { name }), 48); if t.is_empty() { "Imported profile".to_string() } else { t } };
    let mut id = slug_id(&n, "profile");
    let s = st();
    while s.servers().iter().any(|x| g(x, "id").as_str() == Some(&id)) { id = format!("{}-{}", id, random_hex(2)); }
    json!({ "id": id, "client": true, "name": n, "address": "", "version": version, "loader": loader, "loaderVersion": loader_version, "mods": [], "color": "#f07f2a", "icon": icon, "ramGB": 0, "description": slice_chars(description, 120), "tags": [], "badge": "", "created": now_ms() })
}
pub fn commit_profile(entry: Value) -> R<Value> {
    let mut s = st();
    let id = entry["id"].clone();
    s.servers_mut().push(entry);
    s.save_servers()?;
    Ok(json!({ "servers": s.servers(), "id": id }))
}
// Modrinth modpack (.mrpack): a zip with modrinth.index.json plus override folders.
pub fn import_mrpack(buf: &[u8]) -> R<Value> {
    let files = zipx::entries(buf)?;
    let Some(ie) = zipx::find(&files, "modrinth.index.json") else { bail!("That is not a Modrinth modpack (.mrpack): modrinth.index.json is missing.") };
    let idx: Value = serde_json::from_str(&ie.read_str(buf)?)?;
    let dep = g(&idx, "dependencies");
    if !truthy(g(dep, "minecraft")) { bail!("The modpack does not name a Minecraft version."); }
    let loader = if truthy(g(dep, "neoforge")) { "neoforge" } else if truthy(g(dep, "quilt-loader")) { "quilt" } else if truthy(g(dep, "fabric-loader")) { "fabric" } else if truthy(g(dep, "forge")) { "forge" } else { "vanilla" };
    let key = match loader { "neoforge" => "neoforge", "quilt" => "quilt-loader", "fabric" => "fabric-loader", "forge" => "forge", _ => "" };
    let lv = if loader == "vanilla" { String::new() } else { str_or(g(dep, key)) };
    let pname = str_or(g(&idx, "name"));
    let desc = if truthy(g(&idx, "summary")) { js_string(&idx["summary"]) } else { format!("Imported from {}", if pname.is_empty() { "a modpack" } else { &pname }) };
    let entry = new_profile_entry(&pname, &js_string(g(dep, "minecraft")), loader, &lv, "", &desc);
    let dest = instance_dir(&entry);
    ensure_dir(&dest)?;
    for prefix in ["overrides/", "client-overrides/"] {
        for f in &files {
            if !f.name.starts_with(prefix) || f.name.ends_with('/') { continue; }
            let Some(t) = resolve_under(&dest, &f.name[prefix.len()..]) else { bail!("Unsafe path in modpack: {}", &f.name[prefix.len()..]) };
            ensure_dir(t.parent().unwrap())?;
            fs::write(&t, f.read(buf)?)?;
        }
    }
    let list: Vec<Value> = arr(g(&idx, "files")).iter().filter(|f| !truthy(g(f, "env")) || gs(&f["env"], "client") != "unsupported").cloned().collect();
    let failed = std::sync::atomic::AtomicUsize::new(0);
    pool(&list, 4, |f| {
        let r: R<()> = (|| {
            let Some(t) = resolve_under(&dest, &gs(f, "path")) else { bail!("Unsafe path in modpack: {}", gs(f, "path")) };
            let url = arr(g(f, "downloads")).first().map(js_string).unwrap_or_else(|| "undefined".into());
            download(&url, &t, f["hashes"]["sha1"].as_str(), as_u64(&f["fileSize"]))?;
            Ok(())
        })();
        if let Err(e) = r { failed.fetch_add(1, std::sync::atomic::Ordering::SeqCst); log_line(&format!("mrpack file failed {} {}", gs(f, "path"), e.msg)); }
        Ok(())
    })?;
    let mut out = obj(commit_profile(entry)?);
    out.insert("failed".into(), json!(failed.into_inner()));
    Ok(Value::Object(out))
}
fn check_project_id(id: &str) -> R<()> {
    if id.len() < 2 || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) { bail!("Unknown modpack."); }
    Ok(())
}
fn has_mrpack(v: &Value) -> bool { arr(g(v, "files")).iter().any(|f| gs(f, "filename").ends_with(".mrpack")) }
// Versions of a modpack that can be installed, newest first, with the Minecraft versions each one targets.
pub fn modpack_versions(project_id: &str) -> R<Value> {
    check_project_id(project_id)?;
    let versions = get_json(&format!("{}/project/{}/version", MR, project_id))?;
    Ok(Value::Array(arr(&versions).iter().filter(|v| has_mrpack(v)).map(|v| json!({
        "id": v["id"], "name": v["name"], "number": v["version_number"], "gameVersions": if truthy(g(v, "game_versions")) { v["game_versions"].clone() } else { json!([]) },
        "loaders": if truthy(g(v, "loaders")) { v["loaders"].clone() } else { json!([]) }, "date": v["date_published"],
    })).collect()))
}
// Modrinth modpack from Browse: chosen version's .mrpack, then the same import path as a dropped file.
pub fn install_modpack(project_id: &str, version_id: &str, game_version: &str) -> R<Value> {
    check_project_id(project_id)?;
    let (project, versions) = std::thread::scope(|sc| {
        let a = sc.spawn(|| get_json(&format!("{}/project/{}", MR, project_id)));
        let b = sc.spawn(|| get_json(&format!("{}/project/{}/version", MR, project_id)));
        (a.join().unwrap(), b.join().unwrap())
    });
    let (project, versions) = (project?, versions?);
    let packs: Vec<&Value> = arr(&versions).iter().filter(|v| has_mrpack(v)).collect();
    let ver = if !version_id.is_empty() { packs.iter().find(|v| gs(v, "id") == version_id).copied() } else if !game_version.is_empty() { packs.iter().find(|v| arr(g(v, "game_versions")).iter().any(|x| x.as_str() == Some(game_version))).copied() } else { packs.first().copied() };
    let Some(ver) = ver else {
        if !version_id.is_empty() { bail!("That version of the modpack is no longer available."); }
        if !game_version.is_empty() { bail!("That modpack has no version for Minecraft {}.", game_version); }
        bail!("That modpack has no downloadable version.");
    };
    let vf = arr(&ver["files"]);
    let file = vf.iter().find(|f| truthy(g(f, "primary")) && gs(f, "filename").ends_with(".mrpack")).or_else(|| vf.iter().find(|f| gs(f, "filename").ends_with(".mrpack"))).unwrap();
    let res = get_bytes(&gs(file, "url"), None)?;
    if !res.ok() { bail!("Modpack download failed (HTTP {}).", res.status); }
    let want = gs(&file["hashes"], "sha1");
    if !want.is_empty() && sha1_hex(&res.body) != want { bail!("The modpack download was corrupted. Try again."); }
    let r = import_mrpack(&res.body)?;
    let id = gs(&r, "id");
    let icon_url = gs(&project, "icon_url");
    if !icon_url.is_empty() && st().find_server(&id).is_some() {
        if let Ok(ir) = get_bytes(&icon_url, Some(std::time::Duration::from_secs(8))) {
            let typ = ir.ctype.split(';').next().unwrap_or("").trim().to_string();
            if ir.ok() && ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&typ.as_str()) && ir.body.len() <= 150000 {
                let mut s = st();
                if let Some(e) = s.server_mut(&id) { e["icon"] = json!(format!("data:{};base64,{}", typ, b64_encode(&ir.body))); }
                let _ = s.save_servers();
            }
        }
    }
    let mut s = st();
    if truthy(g(&project, "description")) {
        if let Some(e) = s.server_mut(&id) { e["description"] = json!(slice_chars(&js_string(&project["description"]), 120)); }
        s.save_servers()?;
    }
    let mut out = obj(r);
    out.insert("servers".into(), Value::Array(s.servers().clone()));
    Ok(Value::Object(out))
}

// ---------- profile sharing: export as a Modrinth .mrpack that Auroria, the Modrinth App and Prism can import ----------
pub fn export_profile(s: &Value) -> R<Value> {
    let dir = instance_dir(s);
    let version = gs(s, "version");
    let mut dependencies = obj(json!({ "minecraft": g(s, "version") }));
    let loader = gs(s, "loader");
    let key = match loader.as_str() { "fabric" => "fabric-loader", "quilt" => "quilt-loader", "forge" => "forge", "neoforge" => "neoforge", _ => "" };
    if !key.is_empty() {
        let mut lv = { let l = gs(s, "loaderVersion"); if l.is_empty() { pick_loader_version(s).unwrap_or_default() } else { l } };
        if let Some(r) = lv.strip_prefix(&format!("{}-", version)) { lv = r.to_string(); }
        if let Some(r) = lv.strip_suffix(&format!("-{}", version)) { lv = r.to_string(); }
        if lv.is_empty() { bail!("Auroria could not work out which loader version this profile uses. Check your connection and try again."); }
        dependencies.insert(key.into(), json!(lv));
    }
    let mut local: Vec<(String, Vec<u8>, String)> = Vec::new();
    let pk = re(r"(?i)\.(jar|zip)$");
    for sub in ["mods", "resourcepacks", "shaderpacks"] {
        for (n, _) in read_dir(&dir.join(sub)).unwrap_or_default() {
            if pk.is_match(&n) { let buf = fs::read(dir.join(sub).join(&n))?; let h = sha1_hex(&buf); local.push((format!("{}/{}", sub, n), buf, h)); }
        }
    }
    let known = if local.is_empty() { json!({}) } else { post_json(&format!("{}/version_files", MR), &json!({ "hashes": local.iter().map(|f| &f.2).collect::<Vec<_>>(), "algorithm": "sha1" })).unwrap_or(json!({})) };
    let (mut files, mut zip): (Vec<Value>, Vec<(String, Vec<u8>)>) = (Vec::new(), Vec::new());
    for (rel, buf, hash) in local {
        let v = &known[&hash];
        let mf = arr(g(v, "files")).iter().find(|x| gs(&x["hashes"], "sha1") == hash);
        match mf {
            Some(mf) => files.push(json!({ "path": rel, "hashes": { "sha1": hash, "sha512": mf["hashes"]["sha512"] }, "downloads": [mf["url"]], "fileSize": mf["size"], "env": { "client": "required", "server": "optional" } })),
            None => zip.push((format!("overrides/{}", rel), buf)),
        }
    }
    fn walk(dir: &Path, rel: &str, zip: &mut Vec<(String, Vec<u8>)>) -> R<()> {
        for (name, is_dir) in read_dir(&join_rel(dir, rel)).unwrap_or_default() {
            let r = format!("{}/{}", rel, name);
            if is_dir { walk(dir, &r, zip)?; } else { zip.push((format!("overrides/{}", r), fs::read(join_rel(dir, &r))?)); }
        }
        Ok(())
    }
    walk(&dir, "config", &mut zip)?;
    if exists(&dir.join("options.txt")) { zip.push(("overrides/options.txt".into(), fs::read(dir.join("options.txt"))?)); }
    let linked = files.len();
    let index = json!({ "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": g(s, "name"), "summary": if truthy(g(s, "description")) { s["description"].clone() } else { json!("Shared from Auroria") }, "files": files, "dependencies": dependencies });
    zip.insert(0, ("modrinth.index.json".into(), to_pretty(&index, b"  ")));
    let out_dir = home().join("Downloads");
    ensure_dir(&out_dir)?;
    let base = { let b = safe_file_name(&gs(s, "name")); if b.is_empty() { "profile".to_string() } else { b } };
    let mut out = out_dir.join(format!("{}.mrpack", base));
    let mut n = 2;
    while exists(&out) { out = out_dir.join(format!("{} ({}).mrpack", base, n)); n += 1; }
    fs::write(&out, zipx::write_zip(&zip))?;
    win::reveal(&out);
    Ok(json!({ "file": path_str(&out), "linked": linked, "bundled": zip.len() - 1 }))
}

// ---------- worlds and backups, screenshots, options sync ----------
pub fn saves_dir(s: &Value) -> PathBuf { instance_dir(s).join("saves") }
pub fn backups_dir(s: &Value) -> PathBuf { instance_dir(s).join("backups") }
pub fn safe_name(n: &Value) -> R<String> {
    let b = basename(&str_or(n));
    if b.is_empty() || b == "." || b == ".." { bail!("Bad name."); }
    Ok(b)
}
fn tree_stat(dir: &Path) -> (u64, f64) {
    let (mut size, mut mtime) = (0u64, 0f64);
    fn walk(d: &Path, size: &mut u64, mtime: &mut f64) {
        let Ok(ents) = read_dir(d) else { return };
        for (name, is_dir) in ents {
            let p = d.join(&name);
            if is_dir { walk(&p, size, mtime); } else if let Ok(m) = fs::metadata(&p) { *size += m.len(); *mtime = mtime.max(mtime_ms(&m)); }
        }
    }
    walk(dir, &mut size, &mut mtime);
    (size, mtime)
}
pub fn list_worlds(s: &Value) -> Value {
    let names: Vec<String> = read_dir(&saves_dir(s)).unwrap_or_default().into_iter().filter(|x| x.1).map(|x| x.0).collect();
    let backups: Vec<String> = read_dir(&backups_dir(s)).unwrap_or_default().into_iter().map(|x| x.0).collect();
    let mut worlds: Vec<(f64, Value)> = names.iter().map(|n| {
        let (size, mtime) = tree_stat(&saves_dir(s).join(n));
        let pre = format!("{}__", n);
        let mut mine: Vec<(f64, Value)> = backups.iter().filter(|b| b.starts_with(&pre) && b.ends_with(".zip")).filter_map(|b| {
            let m = fs::metadata(backups_dir(s).join(b)).ok()?;
            let t = mtime_ms(&m);
            Some((t, json!({ "file": b, "size": m.len(), "time": t })))
        }).collect();
        mine.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        (mtime, json!({ "name": n, "size": size, "modified": mtime, "icon": exists(&saves_dir(s).join(n).join("icon.png")), "backups": mine.into_iter().map(|x| x.1).collect::<Vec<_>>() }))
    }).collect();
    worlds.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Value::Array(worlds.into_iter().map(|x| x.1).collect())
}
pub fn backup_world(s: &Value, world: &Value) -> R<String> {
    let name = safe_name(world)?;
    let src = saves_dir(s).join(&name);
    if !exists(&src) { bail!("That world no longer exists."); }
    ensure_dir(&backups_dir(s))?;
    let file = backups_dir(s).join(format!("{}__{}.zip", name, stamp()));
    zipx::zip_folder(&src, &file, None)?;
    Ok(file.file_name().unwrap().to_string_lossy().into_owned())
}
fn backup_re() -> Regex { re(r"^(.+)__\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.zip$") }
pub fn is_backup_name(f: &str) -> bool { re(r"__\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.zip$").is_match(f) }
pub fn restore_world(s: &Value, file: &Value) -> R<()> {
    let name = safe_name(file)?;
    let Some(m) = backup_re().captures(&name) else { bail!("That is not an Auroria world backup.") };
    let zip = backups_dir(s).join(&name);
    if !exists(&zip) { bail!("That backup no longer exists."); }
    let world = m[1].to_string();
    let dest = saves_dir(s).join(&world);
    if exists(&dest) { backup_world(s, &json!(world))?; rm_rf(&dest); }
    ensure_dir(&dest)?;
    zipx::extract_zip(&zip, &dest, &[])
}
pub fn list_shots(s: &Value) -> Value {
    let dir = instance_dir(s).join("screenshots");
    let rx = re(r"(?i)\.(png|jpe?g)$");
    let mut items: Vec<(f64, Value)> = read_dir(&dir).unwrap_or_default().into_iter().map(|x| x.0).filter(|f| rx.is_match(f)).filter_map(|f| {
        let m = fs::metadata(dir.join(&f)).ok()?;
        let t = mtime_ms(&m);
        Some((t, json!({ "file": f, "time": t, "size": m.len() })))
    }).collect();
    items.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    items.truncate(400);
    Value::Array(items.into_iter().map(|x| x.1).collect())
}
fn option_group(g: &str, k: &str) -> bool {
    match g {
        "controls" => k.starts_with("key_") || ["mouseSensitivity", "invertYMouse", "toggleCrouch", "toggleSprint", "autoJump", "rawMouseInput", "discrete_mouse_scroll", "mouseWheelSensitivity"].contains(&k),
        "video" => ["renderDistance", "simulationDistance", "fov", "maxFps", "graphicsMode", "fancyGraphics", "guiScale", "gamma", "enableVsync", "fullscreen", "entityShadows", "particles", "ao", "biomeBlendRadius", "mipmapLevels", "renderClouds", "bobView", "entityDistanceScaling", "fovEffectScale", "screenEffectScale", "prioritizeChunkUpdates", "darknessEffectScale", "glintStrength", "glintSpeed"].contains(&k),
        "sound" => k.starts_with("soundCategory_") || k == "soundDevice" || k == "showSubtitles",
        _ => false,
    }
}
fn read_options(s: &Value) -> String { read_text(&instance_dir(s).join("options.txt")) }
fn split_lines(t: &str) -> Vec<&str> { t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect() }
pub fn sync_options(from: &Value, to: &Value, groups: &[Value]) -> R<Value> {
    let want: Vec<String> = groups.iter().filter_map(|x| x.as_str()).filter(|g| ["controls", "video", "sound"].contains(g)).map(String::from).collect();
    if want.is_empty() { bail!("Pick at least one group of settings."); }
    let src_text = read_options(from);
    if js_trim(&src_text).is_empty() { bail!("{} has no settings yet. Play it once first.", gs(from, "name")); }
    // Key bindings changed format in 1.13 (numbers before, key names after), so they only copy between versions on the same side.
    let keys_ok = (cmp_ver(&gs(from, "version"), "1.13") < 0) == (cmp_ver(&gs(to, "version"), "1.13") < 0);
    let mut src: indexmap::IndexMap<String, String> = indexmap::IndexMap::new();
    for line in split_lines(&src_text) { if let Some(i) = line.find(':') { if i > 0 { src.insert(line[..i].to_string(), line[i + 1..].to_string()); } } }
    let pick = |k: &str| want.iter().any(|g| option_group(g, k)) && !(k.starts_with("key_") && !keys_ok);
    let to_text = read_options(to);
    let lines: Vec<&str> = split_lines(&to_text).into_iter().filter(|l| !l.is_empty()).collect();
    let (mut seen, mut changed) = (std::collections::HashSet::new(), 0);
    let mut out: Vec<String> = lines.iter().map(|l| {
        let Some(i) = l.find(':').filter(|&i| i > 0) else { return l.to_string() };
        let k = &l[..i];
        seen.insert(k.to_string());
        if pick(k) { if let Some(v) = src.get(k) { if v != &l[i + 1..] { changed += 1; return format!("{}:{}", k, v); } } }
        l.to_string()
    }).collect();
    for (k, v) in &src { if pick(k) && !seen.contains(k) { out.push(format!("{}:{}", k, v)); changed += 1; } }
    ensure_dir(&instance_dir(to))?;
    fs::write(instance_dir(to).join("options.txt"), out.join("\n") + "\n")?;
    Ok(json!({ "changed": changed, "skippedKeys": want.iter().any(|x| x == "controls") && !keys_ok }))
}

// ---------- profile snapshots: the mods and their configs, saved before updates and restorable ----------
const SNAP_PARTS: &[&str] = &["mods", "config", "auroria-mods.json"];
fn snaps_dir(s: &Value) -> PathBuf { instance_dir(s).join("snapshots") }
fn snap_re() -> Regex { re(r"^(\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d)__([a-z0-9-]{1,40})\.zip$") }
pub fn is_snapshot_name(f: &str) -> bool { snap_re().is_match(f) }
pub fn list_snapshots(s: &Value) -> Value {
    let rx = snap_re();
    let mut out: Vec<(f64, Value)> = read_dir(&snaps_dir(s)).unwrap_or_default().into_iter().filter_map(|(f, _)| {
        let label = rx.captures(&f)?[2].to_string();
        let m = fs::metadata(snaps_dir(s).join(&f)).ok()?;
        let t = mtime_ms(&m);
        Some((t, json!({ "file": f, "label": label, "time": t, "size": m.len() })))
    }).collect();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Value::Array(out.into_iter().map(|x| x.1).collect())
}
pub fn take_snapshot(s: &Value, label: &str) -> R<String> {
    let dir = instance_dir(s);
    ensure_dir(&snaps_dir(s))?;
    ensure_dir(&mods_dir(s))?;
    let lab = { let l = slice_chars(&re(r"[^a-z0-9-]+").replace_all(&label.to_lowercase(), "-"), 40); if l.is_empty() { "manual".to_string() } else { l } };
    let file = snaps_dir(s).join(format!("{}__{}.zip", stamp(), lab));
    zipx::zip_folder(&dir, &file, Some(SNAP_PARTS))?;
    // Automatic snapshots keep the newest ten; ones you take yourself stay until you delete them.
    let autos: Vec<String> = arr(&list_snapshots(s)).iter().filter(|x| gs(x, "label").starts_with("before-")).map(|x| gs(x, "file")).collect();
    for f in autos.iter().skip(10) { rm_force(&snaps_dir(s).join(f)); }
    Ok(file.file_name().unwrap().to_string_lossy().into_owned())
}
pub fn restore_snapshot(s: &Value, file: &Value) -> R<()> {
    let f = safe_name(file)?;
    if !is_snapshot_name(&f) { bail!("That is not an Auroria snapshot."); }
    let zip = snaps_dir(s).join(&f);
    if !exists(&zip) { bail!("That snapshot no longer exists."); }
    take_snapshot(s, "before-restore")?;
    for part in SNAP_PARTS { rm_rf(&instance_dir(s).join(part)); }
    zipx::extract_zip(&zip, &instance_dir(s), &[])?;
    ensure_dir(&mods_dir(s))
}
pub fn delete_snapshot(s: &Value, file: &Value) -> R<()> {
    let f = safe_name(file)?;
    if !is_snapshot_name(&f) { bail!("That is not an Auroria snapshot."); }
    rm_force(&snaps_dir(s).join(f));
    Ok(())
}

// ---------- performance presets: memory, JVM flags and video settings in one click ----------
const G1_TUNED: &[&str] = &["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5", "-XX:SurvivorRatio=32", "-XX:+PerfDisableSharedMem", "-XX:MaxTenuringThreshold=1"];
pub fn presets() -> Vec<(&'static str, &'static str, u64, Vec<&'static str>, Value)> {
    vec![
        ("low", "Low-end PC", 2, vec!["-XX:+UseG1GC", "-XX:MaxGCPauseMillis=50", "-XX:+DisableExplicitGC"],
            json!({ "renderDistance": 6, "simulationDistance": 5, "graphics": 0, "particles": 2, "entityShadows": false, "ao": false, "maxFps": 60, "enableVsync": true, "biomeBlendRadius": 0, "mipmapLevels": 0, "renderClouds": "false", "entityDistanceScaling": 0.5 })),
        ("balanced", "Balanced", 4, G1_TUNED.to_vec(),
            json!({ "renderDistance": 10, "simulationDistance": 8, "graphics": 1, "particles": 1, "entityShadows": true, "ao": true, "maxFps": 120, "enableVsync": false, "biomeBlendRadius": 2, "mipmapLevels": 4, "renderClouds": "fast", "entityDistanceScaling": 1 })),
        ("max", "Max FPS", 6, G1_TUNED.to_vec(),
            json!({ "renderDistance": 8, "simulationDistance": 6, "graphics": 0, "particles": 2, "entityShadows": false, "ao": false, "maxFps": 260, "enableVsync": false, "biomeBlendRadius": 0, "mipmapLevels": 0, "renderClouds": "false", "entityDistanceScaling": 0.75 })),
    ]
}
pub fn ram_cap() -> u64 { ((win::total_mem() as f64 / 1024f64.powi(3) / 2.0).floor() as u64).max(1) }
pub fn presets_json() -> Value {
    json!({ "presets": presets().into_iter().map(|(k, n, ram, _, video)| json!({ "key": k, "name": n, "ramGB": ram.min(ram_cap()), "video": video })).collect::<Vec<_>>(), "totalGB": (win::total_mem() as f64 / 1024f64.powi(3)).round() as u64 })
}
fn set_options(s: &Value, kv: &[(String, String)]) -> R<()> {
    let file = instance_dir(s).join("options.txt");
    let text = read_text(&file);
    let lines: Vec<&str> = split_lines(&text).into_iter().filter(|l| !l.is_empty()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = lines.iter().map(|l| {
        let k = l.find(':').filter(|&i| i > 0).map(|i| &l[..i]).unwrap_or("");
        match kv.iter().find(|(a, _)| a == k) { Some((a, v)) => { seen.insert(a.clone()); format!("{}:{}", a, v) } None => l.to_string() }
    }).collect();
    for (k, v) in kv { if !seen.contains(k) { out.push(format!("{}:{}", k, v)); } }
    ensure_dir(&instance_dir(s))?;
    fs::write(&file, out.join("\n") + "\n")?;
    Ok(())
}
pub fn apply_preset(id: &str, key: &Value) -> R<()> {
    let key = key.as_str().unwrap_or("");
    let Some((_, _, ram, jvm, v)) = presets().into_iter().find(|p| p.0 == key) else { bail!("Unknown preset.") };
    let s = st().find_server(id).ok_or("That profile no longer exists.")?;
    let ver = gs(&s, "version");
    let mut kv: Vec<(String, String)> = Vec::new();
    let vs = |k: &str| js_string(&v[k]);
    // Option names and value types changed over the years: graphics was a boolean before 1.16, smooth lighting an int before 1.19.
    if cmp_ver(&ver, "1.16") < 0 { kv.push(("fancyGraphics".into(), (js_number(&v["graphics"]) > 0.0).to_string())); } else { kv.push(("graphicsMode".into(), vs("graphics"))); }
    kv.push(("ao".into(), if cmp_ver(&ver, "1.19") < 0 { if truthy(&v["ao"]) { "2".into() } else { "0".into() } } else { vs("ao") }));
    if cmp_ver(&ver, "1.18") >= 0 { kv.push(("simulationDistance".into(), vs("simulationDistance"))); }
    for k in ["renderDistance", "particles", "entityShadows", "maxFps", "enableVsync", "biomeBlendRadius", "mipmapLevels"] { kv.push((k.into(), vs(k))); }
    kv.push(("renderClouds".into(), format!("\"{}\"", vs("renderClouds"))));
    kv.push(("entityDistanceScaling".into(), vs("entityDistanceScaling")));
    set_options(&s, &kv)?;
    let mut st = st();
    if let Some(e) = st.server_mut(id) {
        e["preset"] = json!(key);
        e["ramGB"] = json!(ram.min(ram_cap()));
        e["jvmArgs"] = json!(jvm);
    }
    st.save_servers()
}

// ---------- resource packs and shaders ----------
pub fn list_packs(s: &Value, typ: &str) -> Value {
    let dir = instance_dir(s).join(if typ == "shader" { "shaderpacks" } else { "resourcepacks" });
    let zr = re(r"(?i)\.zip$");
    let names: Vec<String> = read_dir(&dir).unwrap_or_default().into_iter().filter(|(n, d)| *d || zr.is_match(n)).map(|x| x.0).collect();
    let opts = read_options(s);
    if typ == "shader" {
        let iris = read_text(&instance_dir(s).join("config").join("iris.properties"));
        let on = !re(r"(?mR)^enableShaders=false").is_match(&iris);
        let sp = re(r"(?mR)^shaderPack=(.*)$");
        let m = sp.captures(&iris).map(|c| c[1].to_string()).or_else(|| sp.captures(&read_text(&instance_dir(s).join("optionsshaders.txt"))).map(|c| c[1].to_string()));
        let active = match m { Some(v) if on => js_trim(&v).to_string(), _ => String::new() };
        let mut n = names.clone();
        n.sort();
        return Value::Array(n.into_iter().map(|x| { let e = x == active; json!({ "name": x, "enabled": e }) }).collect());
    }
    let list: Vec<Value> = re(r"(?mR)^resourcePacks:(.*)$").captures(&opts).and_then(|c| serde_json::from_str::<Value>(&c[1]).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut order: Vec<String> = list.iter().filter_map(|x| x.as_str()).filter(|x| x.starts_with("file/")).map(|x| x[5..].to_string()).collect();
    order.reverse();
    let enabled: Vec<String> = order.into_iter().filter(|n| names.contains(n)).collect();
    let mut rest: Vec<String> = names.iter().filter(|n| !enabled.contains(n)).cloned().collect();
    rest.sort();
    let mut out: Vec<Value> = enabled.iter().map(|n| json!({ "name": n, "enabled": true })).collect();
    out.extend(rest.into_iter().map(|n| json!({ "name": n, "enabled": false })));
    Value::Array(out)
}
// order: enabled packs, top of the list first (the top pack wins, like the in-game screen).
pub fn set_resource_packs(s: &Value, order: &[String]) -> R<()> {
    let text = read_options(s);
    let list: Vec<Value> = re(r"(?mR)^resourcePacks:(.*)$").captures(&text).and_then(|c| serde_json::from_str::<Value>(&c[1]).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let builtin: Vec<Value> = list.into_iter().filter(|x| x.as_str().map_or(false, |s| !s.starts_with("file/"))).collect();
    let have: Vec<String> = arr(&list_packs(s, "resourcepack")).iter().map(|x| gs(x, "name")).collect();
    let mut files: Vec<Value> = Vec::new();
    for n in order { let n = safe_name(&json!(n))?; if have.contains(&n) { files.push(json!(format!("file/{}", n))); } }
    files.reverse();
    let mut all = if builtin.is_empty() { vec![json!("vanilla")] } else { builtin };
    all.extend(files);
    set_options(s, &[("resourcePacks".into(), serde_json::to_string(&all)?)])
}
pub fn set_shader(s: &Value, name: &Value) -> R<()> {
    let n = if truthy(name) { safe_name(name)? } else { String::new() };
    let cfg = instance_dir(s).join("config");
    ensure_dir(&cfg)?;
    let iris_file = cfg.join("iris.properties");
    let mut iris = read_text(&iris_file);
    let mut put = |k: &str, v: &str| {
        let rx = re(&format!("(?mR)^{}=.*$", k));
        iris = match rx.find(&iris) {
            Some(m) => format!("{}{}={}{}", &iris[..m.start()], k, v, &iris[m.end()..]),
            None => format!("{}{}{}={}\n", iris, if !iris.is_empty() && !iris.ends_with('\n') { "\n" } else { "" }, k, v),
        };
    };
    put("enableShaders", if n.is_empty() { "false" } else { "true" });
    if !n.is_empty() { put("shaderPack", &n); }
    fs::write(&iris_file, &iris)?;
    let of = instance_dir(s).join("optionsshaders.txt");
    let of_text = read_text(&of);
    let val = if n.is_empty() { "OFF".to_string() } else { n };
    let rx = re(r"(?mR)^shaderPack=.*$");
    let of_text = match rx.find(&of_text) { Some(m) => format!("{}shaderPack={}{}", &of_text[..m.start()], val, &of_text[m.end()..]), None => format!("{}shaderPack={}\n", of_text, val) };
    fs::write(&of, of_text)?;
    Ok(())
}
