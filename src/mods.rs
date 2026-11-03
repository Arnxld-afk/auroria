// Mods: Modrinth installs and updates, the Auroria Client mods and skin, the pre-launch check, crash diagnosis, and the Java picker.
use crate::game::{instance_dir, loader_name, mods_dir};
use crate::net::*;
use crate::state::*;
use crate::util::*;
use crate::{assets, zipx};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const MR: &str = "https://api.modrinth.com/v2";
pub fn mod_loaders(s: &Value) -> Vec<String> { let l = gs(s, "loader"); if l == "quilt" { vec!["quilt".into(), "fabric".into()] } else { vec![js_string(g(s, "loader"))] } }
pub fn mod_index(s: &Value) -> Obj { read_json(&instance_dir(s).join("auroria-mods.json")).map(obj).unwrap_or_default() }
pub fn save_mod_index(s: &Value, idx: &Obj) -> R<()> { write_json(&instance_dir(s).join("auroria-mods.json"), &Value::Object(idx.clone())) }
fn re(s: &str) -> Regex { Regex::new(s).unwrap() }

pub struct PackType { pub dir: &'static str, pub label: &'static str }
pub fn pack_type(t: &str) -> Option<PackType> {
    match t {
        "mod" => Some(PackType { dir: "mods", label: "mod" }),
        "resourcepack" => Some(PackType { dir: "resourcepacks", label: "resource pack" }),
        "shader" => Some(PackType { dir: "shaderpacks", label: "shader" }),
        _ => None,
    }
}
fn type_loaders(t: &str, s: &Value) -> Vec<String> {
    match t { "resourcepack" => vec!["minecraft".into()], "shader" => vec!["iris".into(), "optifine".into()], _ => mod_loaders(s) }
}
pub fn install_mod_project(server: &Value, project_id: &str, visited: &mut Vec<String>, typ: &str, have: &HashSet<String>) -> R<()> {
    if visited.iter().any(|v| v == project_id) { return Ok(()); }
    visited.push(project_id.to_string());
    let (typ, t) = match pack_type(typ) { Some(t) => (typ, t), None => ("mod", pack_type("mod").unwrap()) };
    let q = format!("loaders={}&game_versions={}", enc_uri(&serde_json::to_string(&type_loaders(typ, server))?), enc_uri(&serde_json::to_string(&json!([g(server, "version")]))?));
    let versions = get_json(&format!("{}/project/{}/version?{}", MR, enc_uri(project_id), q))?;
    let Some(v) = arr(&versions).first() else {
        bail!("This {} has no build for Minecraft {}{}.", t.label, gs(server, "version"), if typ == "mod" { format!(" on {}", gs(server, "loader")) } else { String::new() });
    };
    let files = arr(&v["files"]);
    let Some(file) = files.iter().find(|f| truthy(g(f, "primary"))).or_else(|| files.first()) else { bail!("Cannot read properties of undefined (reading 'filename')") };
    let dir = instance_dir(server).join(t.dir);
    let mut idx = mod_index(server);
    let pid = gs(v, "project_id");
    let fname = gs(file, "filename");
    if let Some(prev) = idx.get(&pid) { if gs(prev, "file") != fname { rm_force(&join_rel(&dir, &gs(prev, "file"))); } }
    download(&gs(file, "url"), &join_rel(&dir, &fname), file["hashes"]["sha1"].as_str(), as_u64(&file["size"]))?;
    let mut e = idx.get(&pid).cloned().map(obj).unwrap_or_default();
    e.insert("file".into(), json!(fname));
    e.insert("versionId".into(), v["id"].clone());
    e.insert("type".into(), json!(typ));
    idx.insert(pid, Value::Object(e));
    save_mod_index(server, &idx)?;
    if typ != "mod" { return Ok(()); }
    for d in arr(&v["dependencies"]) {
        let dp = gs(d, "project_id");
        if gs(d, "dependency_type") == "required" && !dp.is_empty() && !idx.contains_key(&dp) && !have.contains(&dp) { install_mod_project(server, &dp, visited, "mod", have)?; }
    }
    Ok(())
}
// After installing a project, removes older jars of it that Auroria did not track (mods from imports, packs or dropped in by hand).
// A replaced jar that was switched off leaves the new one switched off too.
pub fn drop_replaced_jars(server: &Value, project_id: &str, before: &[Value]) {
    let idx = mod_index(server);
    let Some(cur) = idx.get(project_id) else { return };
    let cf = gs(cur, "file");
    if cf.is_empty() { return; }
    let dir = mods_dir(server);
    for m in before {
        if gs(m, "projectId") != project_id || strip_disabled(&gs(m, "file")) == cf { continue; }
        rm_force(&dir.join(gs(m, "file")));
        if !truthy(g(m, "enabled")) { let _ = fs::rename(dir.join(&cf), dir.join(format!("{}.disabled", cf))); }
    }
}
fn strip_disabled(f: &str) -> &str { f.strip_suffix(".disabled").unwrap_or(f) }
// Enabled mods that list this one as a required dependency on Modrinth.
pub fn mod_dependents(server: &Value, file: &str) -> R<Value> {
    let mods = list_mods(server, true)?;
    let Some(target) = mods.iter().find(|m| gs(m, "file") == file) else { return Ok(json!([])) };
    let tp = gs(target, "projectId");
    if tp.is_empty() { return Ok(json!([])); }
    let others: Vec<&Value> = mods.iter().filter(|m| truthy(g(m, "enabled")) && gs(m, "file") != file && truthy(g(m, "projectId"))).collect();
    if others.is_empty() { return Ok(json!([])); }
    let by_hash = post_json(&format!("{}/version_files", MR), &json!({ "hashes": others.iter().map(|m| g(m, "sha1").clone()).collect::<Vec<_>>(), "algorithm": "sha1" })).unwrap_or(json!({}));
    Ok(Value::Array(others.iter().filter(|m| arr(&by_hash[gs(m, "sha1")]["dependencies"]).iter().any(|d| gs(d, "dependency_type") == "required" && gs(d, "project_id") == tp)).map(|m| m["title"].clone()).collect()))
}

// ---------- Java picker: installs found on this PC plus Auroria's own runtimes ----------
fn java_release(home: &Path) -> String {
    let t = read_text(&home.join("release"));
    t.split("JAVA_VERSION=\"").nth(1).and_then(|r| r.split('"').next()).filter(|v| !v.is_empty()).unwrap_or("").to_string()
}
fn java_major(v: &str) -> i64 {
    let p: Vec<f64> = v.split(['.', '_', '-']).map(|x| x.parse::<f64>().unwrap_or(f64::NAN)).collect();
    let pick = |x: Option<&f64>| x.copied().filter(|f| !f.is_nan() && *f != 0.0).unwrap_or(0.0) as i64;
    if p.first() == Some(&1.0) { pick(p.get(1)) } else { pick(p.first()) }
}
pub fn detect_javas() -> Value {
    let exe_name = "javaw.exe";
    let mut homes: indexmap::IndexMap<String, (PathBuf, String)> = indexmap::IndexMap::new();
    fn add(homes: &mut indexmap::IndexMap<String, (PathBuf, String)>, home: &Path, source: &str) {
        let h = absolute(home);
        let k = path_str(&h).to_lowercase();
        homes.entry(k).or_insert((h, source.to_string()));
    }
    fn scan(homes: &mut indexmap::IndexMap<String, (PathBuf, String)>, root: &Path, source: &str, depth: u32) {
        let Ok(ents) = read_dir(root) else { return };
        for (name, is_dir) in ents {
            if !is_dir { continue; }
            let d = root.join(&name);
            if exists(&d.join("bin").join("javaw.exe")) { add(homes, &d, source); } else if depth > 1 { scan(homes, &d, source, depth - 1); }
        }
    }
    for pf in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramFiles(x86)").ok()].into_iter().flatten().filter(|x| !x.is_empty()) {
        for vendor in ["Java", "Eclipse Adoptium", "Eclipse Foundation", "Zulu", "Microsoft", "BellSoft", "Amazon Corretto", "Semeru", "AdoptOpenJDK", "GraalVM"] {
            scan(&mut homes, &Path::new(&pf).join(vendor), if vendor == "Java" { "Oracle / OpenJDK" } else { vendor }, 1);
        }
    }
    scan(&mut homes, &home().join(".jdks"), "IntelliJ", 1);
    if let Ok(jh) = std::env::var("JAVA_HOME") { if !jh.is_empty() && exists(&Path::new(&jh).join("bin").join(exe_name)) { add(&mut homes, Path::new(&jh), "JAVA_HOME"); } }
    scan(&mut homes, &p().runtime, "Auroria", 1);
    let mut list: Vec<(i64, String, Value)> = homes.values().map(|(home, source)| {
        let mut version = java_release(home);
        if version.is_empty() && source == "Auroria" { version = read_text(&home.join(".complete")).trim().to_string(); }
        let major = java_major(&version);
        let path = path_str(&home.join("bin").join(exe_name));
        (major, path.clone(), json!({ "path": path, "version": if version.is_empty() { "unknown".to_string() } else { version }, "major": major, "source": source }))
    }).collect();
    list.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_cmp(&a.1, &b.1)));
    Value::Array(list.into_iter().map(|x| x.2).collect())
}

// ---------- Auroria Client: curated Lunar-style mods + in-game UI pack ----------
pub const CLIENT_MODS: &[(&str, &str)] = &[
    ("fabric-api", "Fabric API"),
    ("sodium", "Faster rendering"),
    ("lithium", "Faster game logic"),
    ("ferrite-core", "Lower memory use"),
    ("entityculling", "Skips hidden entities"),
    ("immediatelyfast", "Faster HUD and text"),
    ("axolotlclient", "HUD, keystrokes, CPS, FPS, zoom, freelook"),
    ("modmenu", "In-game mod list"),
];
pub fn client_mods_json() -> Value { Value::Array(CLIENT_MODS.iter().map(|(s, w)| json!({ "slug": s, "what": w })).collect()) }
const PACK_FILE: &str = "Auroria-UI.zip";
pub fn client_modded(s: &Value) -> bool { let l = gs(s, "loader"); l == "fabric" || l == "quilt" }
fn pack_supported(v: &str) -> bool {
    if let Some(c) = re(r"^1\.(\d+)").captures(v) { return c[1].parse::<i64>().unwrap_or(0) >= 20; }
    if let Some(c) = re(r"^(\d\d)w\d\d").captures(v) { return c[1].parse::<i64>().unwrap_or(0) >= 23; }
    false
}

// ---------- Auroria Client: our own Fabric mod, used instead of AxolotlClient on the versions it supports ----------
const OWN_JAR: &str = "auroria-client.jar";
pub struct OwnClient { pub buf: Vec<u8>, pub version: String, pub mc: Vec<String> }
pub fn own_client_meta(buf: &[u8]) -> Option<(String, Vec<String>)> {
    let list = zipx::entries(buf).ok()?;
    let e = zipx::find(&list, "fabric.mod.json")?;
    let meta: Value = serde_json::from_str(&e.read_str(buf).ok()?).ok()?;
    if gs(&meta, "id") != "auroria-client" { return None; }
    Some((gs(&meta, "version"), arr(&meta["custom"]["auroria:minecraft"]).iter().map(js_string).collect()))
}
pub fn scan_own_client() -> R<Vec<OwnClient>> {
    ensure_dir(&p().client)?;
    let mut found = Vec::new();
    for (f, _) in read_dir(&p().client)? {
        if !f.ends_with(".jar") { continue; }
        match fs::read(p().client.join(&f)) {
            Ok(buf) => { if let Some((version, mc)) = own_client_meta(&buf) { found.push(OwnClient { buf, version, mc }); } }
            Err(e) => log_line(&format!("client jar unreadable {} {}", f, io_msg(&e))),
        }
    }
    let mut vs: Vec<String> = Vec::new();
    for x in &found { for m in &x.mc { if !vs.contains(m) { vs.push(m.clone()); } } }
    st().own_client_versions = vs;
    Ok(found)
}
// Finds an Auroria Client jar for this Minecraft version in %APPDATA%\Auroria\client, or downloads one from config.clientModUrls.
pub fn own_client_jar(mc: &str) -> R<Option<OwnClient>> {
    let pick = |list: Vec<OwnClient>| -> Option<OwnClient> {
        let mut l: Vec<OwnClient> = list.into_iter().filter(|x| x.mc.iter().any(|m| m == mc)).collect();
        l.sort_by(|a, b| cmp_ver(b.version.split('+').next().unwrap_or(""), a.version.split('+').next().unwrap_or("")).cmp(&0));
        l.into_iter().next()
    };
    let mut hit = pick(scan_own_client()?);
    let url = st().config.get("clientModUrls").map(|u| gs(u, mc)).unwrap_or_default();
    if hit.is_none() && !url.is_empty() {
        set_progress("Downloading Auroria Client", 0, 1);
        match download(&url, &p().client.join(format!("auroria-client-{}.jar", mc)), None, None) {
            Ok(_) => hit = pick(scan_own_client()?),
            Err(e) => log_line(&format!("client download failed {}", e.msg)),
        }
    }
    Ok(hit)
}
// Puts our jar in the profile (or takes it out) and switches AxolotlClient off (or back on) to match.
pub fn apply_own_client(server: &Value, own: Option<&OwnClient>) -> R<()> {
    let dir = mods_dir(server);
    ensure_dir(&dir)?;
    let dest = dir.join(OWN_JAR);
    match own {
        Some(o) => {
            if fs::read(&dest).ok().as_deref() != Some(&o.buf[..]) { fs::write(&dest, &o.buf)?; }
            rm_force(&dir.join(format!("{}.disabled", OWN_JAR)));
        }
        None => rm_force(&dest),
    }
    let idx = mod_index(server);
    if let Some(axo) = idx.values().find(|x| gs(x, "slug") == "axolotlclient") {
        let f = gs(axo, "file");
        if !f.is_empty() {
            let (on, off) = (dir.join(&f), dir.join(format!("{}.disabled", f)));
            if own.is_some() && exists(&on) { fs::rename(&on, &off)?; }
            if own.is_none() && exists(&off) && !exists(&on) { fs::rename(&off, &on)?; }
        }
    }
    Ok(())
}
pub fn ensure_server_mods(server: &Value, own: bool) -> R<Vec<String>> {
    if gs(server, "loader") == "vanilla" { return Ok(vec![]); }
    let modded = client_modded(server);
    let mut wanted: Vec<String> = Vec::new();
    if modded { for (s, _) in CLIENT_MODS { if !(own && *s == "axolotlclient") { wanted.push(s.to_string()); } } }
    wanted.extend(arr(g(server, "mods")).iter().map(js_string));
    let mut slugs: Vec<String> = Vec::new();
    for s in wanted { if !slugs.contains(&s) { slugs.push(s); } }
    if slugs.is_empty() { return Ok(vec![]); }
    let idx = mod_index(server);
    let installed: HashSet<String> = idx.values().map(|x| gs(x, "slug")).filter(|x| !x.is_empty()).collect();
    let missing: Vec<String> = slugs.into_iter().filter(|s| !installed.contains(s)).collect();
    let mut skipped = Vec::new();
    let label = if modded { "Installing Auroria Client mods" } else { "Installing profile mods" };
    for (done, slug) in missing.iter().enumerate() {
        set_progress(label, done, missing.len());
        let r: R<()> = (|| {
            let proj = get_json(&format!("{}/project/{}", MR, enc_uri(slug)))?;
            let pid = gs(&proj, "id");
            if !mod_index(server).contains_key(&pid) { install_mod_project(server, &pid, &mut vec![], "mod", &HashSet::new())?; }
            let mut idx3 = mod_index(server);
            if let Some(Value::Object(e)) = idx3.get_mut(&pid) {
                e.insert("slug".into(), json!(slug));
                e.insert("client".into(), json!(CLIENT_MODS.iter().any(|(s, _)| s == slug)));
                save_mod_index(server, &idx3)?;
            }
            Ok(())
        })();
        if let Err(e) = r { skipped.push(slug.clone()); log_line(&format!("mod skipped {} {}", slug, e.msg)); }
        set_progress(label, done + 1, missing.len());
    }
    if !skipped.is_empty() { broadcast(json!({ "type": "notice", "message": format!("Skipped {}: no build for Minecraft {} on {}.", skipped.join(", "), gs(server, "version"), loader_name(&gs(server, "loader"))) })); }
    Ok(skipped)
}
// Puts the Auroria UI pack in the profile and switches it on in options.txt.
pub fn ensure_client_pack(server: &Value, game_dir: &Path) -> R<bool> {
    if !pack_supported(&gs(server, "version")) { return Ok(false); }
    let dir = game_dir.join("resourcepacks");
    let dest = dir.join(PACK_FILE);
    if fs::read(&dest).ok().as_deref() != Some(assets::UI_PACK) { ensure_dir(&dir)?; fs::write(&dest, assets::UI_PACK)?; }
    enable_pack(&game_dir.join("options.txt"), &format!("file/{}", PACK_FILE))?;
    Ok(true)
}
pub fn enable_pack(options_file: &Path, entry: &str) -> R<()> {
    let mut text = read_text(options_file);
    for key in ["resourcePacks", "incompatibleResourcePacks"] {
        let rx = re(&format!("(?mR)^{}:(.*)$", key));
        let found = rx.captures(&text).map(|c| (c.get(0).unwrap().range(), c[1].to_string()));
        let mut list: Vec<Value> = found.as_ref().and_then(|(_, v)| serde_json::from_str::<Value>(v).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        if key == "resourcePacks" && list.is_empty() { list = vec![json!("vanilla")]; }
        if !list.iter().any(|x| x.as_str() == Some(entry)) { list.push(json!(entry)); }
        let line = format!("{}:{}", key, serde_json::to_string(&list)?);
        text = match found {
            Some((range, _)) => format!("{}{}{}", &text[..range.start], line, &text[range.end..]),
            None => format!("{}{}\n", if !text.is_empty() && !text.ends_with('\n') { format!("{}\n", text) } else { text.clone() }, line),
        };
    }
    fs::write(options_file, text)?;
    Ok(())
}

// ---------- Auroria Client skin: rebrands and recolours AxolotlClient through a generated resource pack ----------
fn rebrand(v: &str) -> String {
    let a = re(r"(?i)Axolotl\s?Client").replace_all(v, "Auroria Client").into_owned();
    let b = a.replace("Axolotl", "Auroria");
    // axolotl(?=\s)
    let mut out = String::new();
    let mut rest = b.as_str();
    while let Some(i) = rest.find("axolotl") {
        let after = &rest[i + 7..];
        out.push_str(&rest[..i]);
        if after.chars().next().map_or(false, |c| c.is_whitespace()) { out.push_str("Auroria"); } else { out.push_str("axolotl"); }
        rest = after;
    }
    out.push_str(rest);
    out
}
pub fn build_client_skin(server: &Value, game_dir: &Path) -> R<bool> {
    let idx = mod_index(server);
    let Some(entry) = idx.values().find(|x| gs(x, "slug") == "axolotlclient") else { return Ok(false) };
    let Ok(jar) = fs::read(join_rel(&mods_dir(server), &gs(entry, "file"))) else { return Ok(false) };
    let dir = game_dir.join("resourcepacks");
    let dest = dir.join("Auroria-Client-Skin.zip");
    let mut stamped = jar.clone();
    stamped.extend_from_slice(b"skin-v2");
    let stamp = sha1_hex(&stamped);
    let marker = dir.join(".auroria-client-skin");
    let opts = game_dir.join("options.txt");
    if read_text(&marker) == stamp && exists(&dest) { enable_pack(&opts, "file/Auroria-Client-Skin.zip")?; return Ok(true); }
    set_progress("Skinning Auroria Client", 0, 1);
    let ui_list = zipx::entries(assets::UI_PACK)?;
    let ui = |n: &str| -> R<Vec<u8>> { zipx::find(&ui_list, n).ok_or_else(|| Error::new(format!("Cannot read properties of undefined (reading 'read'): {}", n)))?.read(assets::UI_PACK) };
    let pack_png = ui("pack.png")?;
    let icon = zipx::decode_png(&pack_png).ok_or("Cannot read the pack icon")?;
    let word = zipx::crop_alpha(zipx::decode_png(&ui("assets/minecraft/textures/gui/title/minecraft.png")?).ok_or("Cannot read the title image")?);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let path_re = re(r"^assets/([^/]+)/(.+)$");
    let lang_re = re(r"(?i)^lang/[a-z_]+\.json$");
    let tex_re = re(r"(?i)^textures/.+\.png$");
    let skip_key = re(r"(?i)credit|author|contributor|license|translator|github|discord|url|link");
    let axo = re(r"(?i)axolotl");
    let logo = re(r"logo|icon|axolotl|banner|title");
    for e in zipx::entries(&jar)? {
        let Some(c) = path_re.captures(&e.name) else { continue };
        if e.name.ends_with('/') { continue; }
        let (ns, rest) = (c[1].to_string(), c[2].to_string());
        if !ns.contains("axolotl") { continue; }
        if lang_re.is_match(&rest) {
            let parsed: Option<Value> = e.read_str(&jar).ok().and_then(|t| serde_json::from_str(&t).ok());
            if let Some(Value::Object(o)) = parsed {
                let mut merged = o.clone();
                for (k, v) in &o { if let Some(s) = v.as_str() { if axo.is_match(s) && !skip_key.is_match(k) { merged.insert(k.clone(), json!(rebrand(s))); } } }
                files.push((e.name.clone(), to_pretty(&Value::Object(merged), b" ")));
            }
        } else if tex_re.is_match(&rest) {
            let Some(mut img) = e.read(&jar).ok().and_then(|b| zipx::decode_png(&b)) else { continue };
            let base = basename(&rest).to_lowercase();
            if logo.is_match(&base) {
                let src = if img.w as f64 >= img.h as f64 * 1.8 { &word } else { &icon };
                files.push((e.name.clone(), zipx::encode_png(&zipx::fit_into(src, img.w, img.h))));
            } else if zipx::recolor(&mut img) > 0 { files.push((e.name.clone(), zipx::encode_png(&img))); }
        }
    }
    let mm = json!({ "modmenu.nameTranslation.axolotlclient": "Auroria Client", "modmenu.descriptionTranslation.axolotlclient": "Auroria's in-game client: HUD mods, keystrokes, CPS, zoom, freelook and more. Powered by AxolotlClient." });
    files.push(("assets/auroria/lang/en_us.json".into(), to_pretty(&mm, b" ")));
    files.push(("pack.mcmeta".into(), serde_json::to_vec(&json!({ "pack": { "pack_format": 15, "supported_formats": [1, 99], "min_format": 1, "max_format": 99, "description": "§6Auroria Client§r skin" } }))?));
    files.push(("pack.png".into(), pack_png));
    ensure_dir(&dir)?;
    fs::write(&dest, zipx::write_zip(&files))?;
    fs::write(&marker, &stamp)?;
    enable_pack(&opts, "file/Auroria-Client-Skin.zip")?;
    Ok(true)
}

pub fn list_mods(server: &Value, lookup: bool) -> R<Vec<Value>> {
    let dir = mods_dir(server);
    ensure_dir(&dir)?;
    let names: Vec<String> = read_dir(&dir)?.into_iter().map(|x| x.0).filter(|f| f.ends_with(".jar") || f.ends_with(".jar.disabled")).collect();
    let mut mods: Vec<Obj> = Vec::new();
    let title_of = |f: &str| f.strip_suffix(".jar.disabled").or_else(|| f.strip_suffix(".jar")).unwrap_or(f).to_string();
    for f in &names {
        let buf = fs::read(dir.join(f))?;
        let mut m = obj(json!({ "file": f, "enabled": f.ends_with(".jar"), "size": buf.len(), "sha1": sha1_hex(&buf), "title": title_of(f) }));
        if f.starts_with(OWN_JAR) {
            if let Some((version, _)) = own_client_meta(&buf) {
                for (k, v) in obj(json!({ "own": true, "client": true, "slug": "auroria-client", "title": "Auroria Client", "version": version, "category": "Your own client" })) { m.insert(k, v); }
            }
        }
        mods.push(m);
    }
    let idx0 = mod_index(server);
    for m in mods.iter_mut() {
        if m.contains_key("own") { continue; }
        let f = strip_disabled(&gs(&Value::Object(m.clone()), "file")).to_string();
        if let Some(e) = idx0.values().find(|x| truthy(g(x, "file")) && gs(x, "file") == f) {
            m.insert("slug".into(), json!(gs(e, "slug")));
            m.insert("client".into(), json!(truthy(g(e, "client"))));
        }
    }
    if lookup && !mods.is_empty() {
        let r: R<()> = (|| {
            let by_hash = post_json(&format!("{}/version_files", MR), &json!({ "hashes": mods.iter().map(|m| m["sha1"].clone()).collect::<Vec<_>>(), "algorithm": "sha1" }))?;
            let mut pids: Vec<String> = Vec::new();
            if let Some(o) = by_hash.as_object() { for v in o.values() { let p = js_string(g(v, "project_id")); if !pids.contains(&p) { pids.push(p); } } }
            let projects = if pids.is_empty() { json!([]) } else { get_json(&format!("{}/projects?ids={}", MR, enc_uri(&serde_json::to_string(&pids)?)))? };
            let pmap: HashMap<String, Value> = arr(&projects).iter().map(|p| (gs(p, "id"), p.clone())).collect();
            let idx_all = mod_index(server);
            for m in mods.iter_mut() {
                let v = &by_hash[gs(&Value::Object(m.clone()), "sha1")];
                if !truthy(v) || m.contains_key("own") { continue; }
                let pid = js_string(g(v, "project_id"));
                let pr = pmap.get(&pid).cloned().unwrap_or(json!({}));
                let ie = idx_all.get(&pid).cloned().unwrap_or(Value::Null);
                let title = if truthy(g(&pr, "title")) { pr["title"].clone() } else { m["title"].clone() };
                for (k, val) in obj(json!({
                    "slug": gs(&ie, "slug"), "client": truthy(&ie) && truthy(g(&ie, "client")), "projectId": pid, "versionId": v["id"], "version": v["version_number"],
                    "title": title, "icon": if truthy(g(&pr, "icon_url")) { pr["icon_url"].clone() } else { Value::Null }, "category": arr(&pr["categories"]).first().map(str_or).unwrap_or_default(),
                })) { m.insert(k, val); }
            }
            Ok(())
        })();
        if let Err(e) = r { log_line(&format!("modrinth lookup failed {}", e.msg)); }
    }
    let mut out: Vec<Value> = mods.into_iter().map(Value::Object).collect();
    out.sort_by(|a, b| locale_cmp(&js_string(g(a, "title")), &js_string(g(b, "title"))));
    Ok(out)
}
pub fn mod_updates(server: &Value) -> R<Value> {
    let mods = list_mods(server, true)?;
    let hashes: Vec<Value> = mods.iter().filter(|m| truthy(g(m, "versionId"))).map(|m| m["sha1"].clone()).collect();
    if hashes.is_empty() { return Ok(json!([])); }
    let latest = post_json(&format!("{}/version_files/update", MR), &json!({ "hashes": hashes, "algorithm": "sha1", "loaders": mod_loaders(server), "game_versions": [g(server, "version")] }))?;
    Ok(Value::Array(mods.iter().filter(|m| { let l = &latest[gs(m, "sha1")]; truthy(l) && g(l, "id") != g(m, "versionId") }).map(|m| {
        let l = &latest[gs(m, "sha1")];
        let mut o = obj(json!({ "file": m["file"], "title": m["title"] }));
        if let Some(v) = m.get("version") { o.insert("from".into(), v.clone()); }
        o.insert("to".into(), l["version_number"].clone());
        if let Some(v) = m.get("projectId") { o.insert("projectId".into(), v.clone()); }
        Value::Object(o)
    }).collect()))
}

// ---------- pre-launch mod check and crash diagnosis ----------
// Does a Minecraft version satisfy a Fabric-style range ("1.20.x", ">=1.20 <1.21", "~1.20.1", or an array of alternatives)?
fn mc_satisfies(ver: &str, range: &Value) -> bool {
    if !re(r"^\d+\.\d+").is_match(ver) { return true; }
    let alts: Vec<String> = match range { Value::Array(a) => a.iter().map(js_string).collect(), x => vec![js_string(x)] };
    let opre = re(r"^(>=|<=|>|<|=|~|\^)?(.+)$");
    alts.iter().any(|r| r.trim().split_whitespace().all(|c| {
        if c == "*" { return true; }
        let Some(m) = opre.captures(c) else { return false };
        let op = m.get(1).map(|x| x.as_str()).unwrap_or("=");
        let v = m[2].split('-').next().unwrap_or("").to_string();
        if v.ends_with(".x") || v.ends_with(".*") { let pre = &v[..v.len() - 2]; return ver == pre || ver.starts_with(&format!("{}.", pre)); }
        let d = cmp_ver(ver, &v);
        let p: Vec<&str> = v.split('.').collect();
        match op {
            ">=" => d >= 0, "<=" => d <= 0, ">" => d > 0, "<" => d < 0,
            "~" => d >= 0 && ver.starts_with(&p[..p.len().min(2)].join(".")),
            "^" => d >= 0 && ver.starts_with(&format!("{}.", p[0])),
            _ => d == 0,
        }
    }))
}
// Mod ids a Fabric jar carries inside itself (jar-in-jar, listed under "jars"), e.g. Lithium bundles MixinExtras.
fn bundled_ids(buf: &[u8], z: &[zipx::Entry], j: &Value, depth: u32) -> Vec<Value> {
    let mut out = Vec::new();
    for r in arr(g(j, "jars")) {
        let res: Option<()> = (|| {
            let e = zipx::find(z, &gs(r, "file"))?;
            let inner_buf = e.read(buf).ok()?;
            let inner = zipx::entries(&inner_buf).ok()?;
            let fj = zipx::find(&inner, "fabric.mod.json")?;
            let ij: Value = serde_json::from_str(&fj.read_str(&inner_buf).ok()?).ok()?;
            if truthy(g(&ij, "id")) { out.push(ij["id"].clone()); }
            out.extend_from_slice(arr(g(&ij, "provides")));
            if depth < 2 { out.extend(bundled_ids(&inner_buf, &inner, &ij, depth + 1)); }
            Some(())
        })();
        let _ = res;
    }
    out
}
struct ModInfo { id: String, name: Value, version: Value, provides: Vec<Value>, depends: Vec<(String, Value)>, file: String }
fn mod_ref(m: &ModInfo) -> Value {
    let mut o = obj(json!({ "file": m.file, "name": m.name }));
    if !m.version.is_null() { o.insert("version".into(), m.version.clone()); }
    Value::Object(o)
}
// Finds problems the loader would refuse to start with: two copies of a mod, and (Fabric/Quilt only) a missing required mod
// or a mod for another Minecraft version. Forge only gets the duplicate check; its own popup covers the rest.
pub fn analyze_mods(server: &Value) -> Vec<Value> {
    let loader = gs(server, "loader");
    if !["fabric", "quilt", "forge", "neoforge"].contains(&loader.as_str()) { return vec![]; }
    let fabric_like = loader == "fabric" || loader == "quilt";
    let dir = mods_dir(server);
    let Ok(ents) = read_dir(&dir) else { return vec![] };
    let files: Vec<String> = ents.into_iter().map(|x| x.0).filter(|f| f.ends_with(".jar")).collect();
    let undef = || Value::Null;
    let mut mods: Vec<ModInfo> = Vec::new();
    for f in &files {
        let res: Option<ModInfo> = (|| {
            let buf = fs::read(dir.join(f)).ok()?;
            let z = zipx::entries(&buf).ok()?;
            let (fe, qe) = (zipx::find(&z, "fabric.mod.json"), zipx::find(&z, "quilt.mod.json"));
            let mut m: Option<ModInfo> = None;
            if let Some(fe) = fe {
                let j: Value = serde_json::from_str(&fe.read_str(&buf).ok()?).ok()?;
                let mut provides = arr(g(&j, "provides")).to_vec();
                provides.extend(bundled_ids(&buf, &z, &j, 0));
                let depends = g(&j, "depends").as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
                m = Some(ModInfo { id: str_or(g(&j, "id")), name: if truthy(g(&j, "name")) { j["name"].clone() } else { g(&j, "id").clone() }, version: j.get("version").cloned().unwrap_or_else(undef), provides, depends, file: String::new() });
            } else if let Some(qe) = qe {
                let q = g(&serde_json::from_str::<Value>(&qe.read_str(&buf).ok()?).ok()?, "quilt_loader").clone();
                let provides = arr(g(&q, "provides")).iter().map(|p| if p.is_string() { p.clone() } else { g(p, "id").clone() }).collect();
                let depends = arr(g(&q, "depends")).iter().filter(|d| d.is_object() && !truthy(g(d, "optional")) && truthy(g(d, "id"))).map(|d| (gs(d, "id"), if truthy(g(d, "versions")) { d["versions"].clone() } else { json!("*") })).collect();
                let name = if truthy(g(g(&q, "metadata"), "name")) { q["metadata"]["name"].clone() } else { g(&q, "id").clone() };
                m = Some(ModInfo { id: str_or(g(&q, "id")), name, version: q.get("version").cloned().unwrap_or_else(undef), provides, depends, file: String::new() });
            }
            if m.is_none() && !fabric_like { // Forge: mcmod.info (1.7 to 1.12) or mods.toml (1.13 and newer) names the mod id
                let info = zipx::find(&z, "mcmod.info");
                let toml = zipx::find(&z, "META-INF/mods.toml").or_else(|| zipx::find(&z, "META-INF/neoforge.mods.toml"));
                let (mut id, mut name, mut version) = (String::new(), String::new(), String::new());
                let grab = |rx: &str, t: &str| re(rx).captures(t).map(|c| c[1].to_string()).unwrap_or_default();
                if let Some(info) = info {
                    let raw = info.read_str(&buf).ok()?;
                    match serde_json::from_str::<Value>(&raw) {
                        Ok(j) => {
                            let e0 = if j.is_array() { arr(&j).first().cloned() } else { arr(g(&j, "modList")).first().cloned() };
                            if let Some(e0) = e0 { id = str_or(g(&e0, "modid")); name = str_or(g(&e0, "name")); version = str_or(g(&e0, "version")); }
                        }
                        Err(_) => { id = grab(r#""modid"\s*:\s*"([^"]+)""#, &raw); name = grab(r#""name"\s*:\s*"([^"]+)""#, &raw); version = grab(r#""version"\s*:\s*"([^"]+)""#, &raw); }
                    }
                } else if let Some(toml) = toml {
                    let raw = toml.read_str(&buf).ok()?;
                    id = grab(r#"modId\s*=\s*"([^"]+)""#, &raw); name = grab(r#"displayName\s*=\s*"([^"]+)""#, &raw); version = grab(r#"(?mR)^\s*version\s*=\s*"([^"]+)""#, &raw);
                }
                // No usable metadata (many old mods): compare file names with the version numbers taken out.
                let stem = f.strip_suffix(".jar").or_else(|| f.strip_suffix(".JAR")).unwrap_or(f).to_string();
                if id.is_empty() {
                    let a = re(r"\d+(\.\d+)+\w*").replace_all(&stem.to_lowercase(), " ").into_owned();
                    id = format!("file:{}", re(r"[^a-z]+").replace_all(&a, " ").trim());
                }
                let nm = if !name.is_empty() { name } else {
                    let a = re(r"\([^)]*\)").replace_all(&stem, "").into_owned();
                    let b = re(r"[-_ ]*v?\d+(\.\d+)+.*$").replace(&a, "").trim().to_string();
                    if b.is_empty() { stem.clone() } else { b }
                };
                m = Some(ModInfo { id, name: json!(nm), version: json!(version), provides: vec![], depends: vec![], file: String::new() });
            }
            m
        })();
        if let Some(mut m) = res { if !m.id.is_empty() { m.file = f.clone(); mods.push(m); } }
    }
    let mut problems: Vec<Value> = Vec::new();
    let mut have: HashMap<String, usize> = HashMap::new();
    let mut by_id: indexmap::IndexMap<String, Vec<usize>> = indexmap::IndexMap::new();
    for (i, m) in mods.iter().enumerate() {
        by_id.entry(m.id.clone()).or_default().push(i);
        have.insert(m.id.clone(), i);
        for p in &m.provides { let id = if p.is_string() { js_string(p) } else { js_string(g(p, "id")) }; have.insert(id, i); }
    }
    for (_, list) in &by_id {
        if list.len() > 1 { problems.push(json!({ "type": "duplicate", "text": format!("Two copies of {} are installed. Delete one.", js_string(&mods[list[0]].name)), "mods": list.iter().map(|&i| mod_ref(&mods[i])).collect::<Vec<_>>() })); }
    }
    if !fabric_like { return problems; }
    // Fabric Loader 0.15+ and Quilt ship MixinExtras themselves.
    let builtin = ["minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "quilt-loader", "mixinextras"];
    let has_fabric_api = have.contains_key("fabric-api") || have.contains_key("fabric");
    let fab = re(r"^fabric(-api)?($|-)");
    let nice = |id: &str| -> String { if fab.is_match(id) { "Fabric API".into() } else { have.get(id).map(|&i| str_or(&mods[i].name)).filter(|x| !x.is_empty()).unwrap_or_else(|| id.to_string()) } };
    let ver = gs(server, "version");
    for m in &mods {
        for (dep, range) in &m.depends {
            if builtin.contains(&dep.as_str()) {
                if dep == "minecraft" && !mc_satisfies(&ver, range) {
                    let r = match range { Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(" or "), x => js_string(x) };
                    problems.push(json!({ "type": "version", "text": format!("{} is built for Minecraft {}, but this profile uses {}.", js_string(&m.name), r, ver), "mods": [mod_ref(m)] }));
                }
                continue;
            }
            if have.contains_key(dep) || (dep.starts_with("fabric-") && has_fabric_api) { continue; }
            let t = format!("{} needs {}, which is not installed.", js_string(&m.name), nice(dep));
            if !problems.iter().any(|p| gs(p, "text") == t) { problems.push(json!({ "type": "missing", "dep": dep, "depName": nice(dep), "text": t, "mods": [mod_ref(m)] })); }
        }
    }
    problems
}
// Turns the last game output into a short, human reason the game stopped.
pub fn diagnose_crash(lines: &[String]) -> Value {
    let text = lines.join("\n");
    let c1 = re(r"^\[[^\]]*\]\s*(\[[^\]]*\]:?\s*)?");
    let c2 = re(r"^\s*[-*]\s*");
    let clean = |l: &str| -> String { let a = c1.replace(l, "").into_owned(); c2.replace(&a, "").trim().to_string() };
    let pick = |rx: &str, n: usize| -> Vec<String> {
        let r = re(rx);
        let mut out: Vec<String> = Vec::new();
        for l in lines.iter().filter(|l| r.is_match(l)) { let c = clean(l); if !out.contains(&c) { out.push(c); } }
        out.truncate(n);
        out
    };
    let t = |rx: &str| re(rx).is_match(&text);
    if t("OutOfMemoryError") { return json!({ "kind": "memory", "title": "Minecraft ran out of memory", "lines": [], "hint": "Give it more memory in Settings, under Java and memory, or remove heavy mods and shaders." }); }
    if t("UnsupportedClassVersionError|Unsupported class file major version") { return json!({ "kind": "java", "title": "A mod needs a newer Java", "lines": pick("UnsupportedClassVersionError|Unsupported class file", 3), "hint": "The mod was built for a newer Minecraft than this profile uses. Update or remove it." }); }
    if t(r"(?i)Incompatible mods found|Mod resolution (failed|encountered)|incompatible mod set|Some of your mods are incompatible|Duplicate mod|Mod .+ requires") {
        let skip = re(r"(?i)^(Incompatible mods found|Mod resolution)");
        let l: Vec<String> = pick(r"(?i)\brequires\b|is missing|conflicts? with|\bbreaks\b|incompatible|duplicate|more than one", 8).into_iter().filter(|x| !skip.is_match(x)).collect();
        return json!({ "kind": "mods", "title": "Some mods do not work together", "lines": l, "hint": "Update the listed mods, install the ones that are missing, or remove the ones that conflict." });
    }
    if t(r"(?i)Missing or unsupported mandatory dependencies|MissingModsException|Missing Mods:|DuplicateModsFoundException") { return json!({ "kind": "mods", "title": "A mod is missing something it needs", "lines": pick(r"(?i)Mod ID|Requested by|Currently|requires|Missing|Duplicate", 8), "hint": "Install the missing mod, or remove the mod that asked for it." }); }
    if t(r"Mixin apply failed|MixinTransformerError|InvalidMixinException|Mixin transformation of .+ failed|MixinApplyError") {
        let mut cfg: Vec<String> = Vec::new();
        for m in re(r"([\w.-]+)\.mixins?\.json").find_iter(&text) { let s = m.as_str().to_string(); if !cfg.contains(&s) { cfg.push(s); } }
        cfg.truncate(4);
        return json!({ "kind": "mixin", "title": "Two mods are fighting over the same code", "lines": cfg.iter().map(|c| format!("Involved: {}", c)).collect::<Vec<_>>(), "hint": "A mod is likely out of date for this Minecraft version. Update your mods, or remove the ones named above." });
    }
    let er = re(r"Exception|Error:|Caused by");
    let err: Vec<String> = lines.iter().filter(|l| er.is_match(l)).map(|l| clean(l)).collect();
    let mut last: Vec<String> = Vec::new();
    for e in err[err.len().saturating_sub(3)..].iter() { if !last.contains(e) { last.push(e.clone()); } }
    json!({ "kind": "other", "title": "Minecraft closed unexpectedly", "lines": last, "hint": "Open the game log for the full output." })
}
