// Game files and launching: Mojang's Java runtimes, version manifests, libraries, assets, natives, mod loaders, and the java command line.
use crate::net::*;
use crate::state::*;
use crate::util::*;
use crate::{mods, win, zipx};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

pub const OS_NAME: &str = "windows";
pub const LOADERS: &[&str] = &["vanilla", "fabric", "quilt", "forge", "neoforge"];
pub fn loader_name(l: &str) -> &'static str {
    match l { "fabric" => "Fabric", "quilt" => "Quilt", "forge" => "Forge", "neoforge" => "NeoForge", _ => "Vanilla" }
}
const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const NEO_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
pub const VERSION_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const JAVA_ALL: &str = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const DETACHED_PROCESS: u32 = 0x0000_0008;
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

fn java_platform() -> &'static str { if cfg!(target_arch = "aarch64") { "windows-arm64" } else if cfg!(target_arch = "x86") { "windows-x86" } else { "windows-x64" } }
fn is_x86() -> bool { cfg!(target_arch = "x86") }

pub fn instance_dir(s: &Value) -> PathBuf { p().instances.join(gs(s, "id")) }
pub fn mods_dir(s: &Value) -> PathBuf { instance_dir(s).join("mods") }

// ---------- Java runtime (Mojang's own runtimes) ----------
pub fn ensure_java(component: &str) -> R<String> {
    let jp = st().settings.get("javaPath").map(str_or).unwrap_or_default();
    if !jp.is_empty() { return Ok(jp); }
    let dir = p().runtime.join(component);
    let exe = dir.join("bin").join("javaw.exe");
    let marker = dir.join(".complete");
    if exists(&marker) { return Ok(path_str(&exe)); }
    set_progress("Downloading Java", 0, 1);
    let all = get_json(JAVA_ALL)?;
    let entry = arr(&all[java_platform()][component]).first().cloned();
    let Some(entry) = entry else { bail!("No Java runtime \"{}\" for this computer.", component) };
    let manifest = get_json(&js_string(&entry["manifest"]["url"]))?;
    let files_obj = manifest["files"].as_object().cloned().unwrap_or_default();
    let mut files: Vec<(String, Value)> = Vec::new();
    for (rel, f) in &files_obj {
        if gs(f, "type") == "directory" { ensure_dir(&join_rel(&dir, rel))?; }
        if gs(f, "type") == "file" { files.push((rel.clone(), f.clone())); }
    }
    let done = std::sync::atomic::AtomicUsize::new(0);
    pool(&files, 12, |(rel, f)| {
        let raw = &f["downloads"]["raw"];
        download(&gs(raw, "url"), &join_rel(&dir, rel), raw["sha1"].as_str(), as_u64(&raw["size"]))?;
        set_progress("Downloading Java", done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1, files.len());
        Ok(())
    })?;
    let name = gs(&entry["version"], "name");
    fs::write(&marker, if name.is_empty() { component.to_string() } else { name })?;
    Ok(path_str(&exe))
}

// ---------- game files ----------
fn os_release() -> String {
    static REL: OnceLock<String> = OnceLock::new();
    REL.get_or_init(win::os_release).clone()
}
pub fn rule_allows(rules: &Value, features: &HashMap<&str, bool>) -> bool {
    let rules = arr(rules);
    if rules.is_empty() { return true; }
    let mut allowed = false;
    for r in rules {
        let mut m = true;
        let os = g(r, "os");
        if truthy(os) {
            if truthy(g(os, "name")) && gs(os, "name") != OS_NAME { m = false; }
            if truthy(g(os, "arch")) && gs(os, "arch") == "x86" && !is_x86() { m = false; }
            if truthy(g(os, "version")) { if let Ok(re) = regex_lite::Regex::new(&gs(os, "version")) { if !re.is_match(&os_release()) { m = false; } } }
        }
        if let Some(fe) = g(r, "features").as_object() {
            for (k, v) in fe { if v.as_bool() != Some(features.get(k.as_str()).copied().unwrap_or(false)) { m = false; } }
        }
        if m { allowed = gs(r, "action") == "allow"; }
    }
    allowed
}
pub fn maven_path(name: &str) -> String {
    let p: Vec<&str> = name.split(':').collect();
    let (group, artifact, version) = (p.first().copied().unwrap_or(""), p.get(1).copied().unwrap_or("undefined"), p.get(2).copied().unwrap_or("undefined"));
    let file = format!("{}-{}{}.jar", artifact, version, p.get(3).map(|c| format!("-{}", c)).unwrap_or_default());
    format!("{}/{}/{}/{}", group.replace('.', "/"), artifact, version, file)
}
fn lib_key(name: &str) -> String {
    let p: Vec<&str> = name.split(':').collect();
    format!("{}:{}{}", p.first().copied().unwrap_or(""), p.get(1).copied().unwrap_or("undefined"), p.get(3).map(|c| format!(":{}", c)).unwrap_or_default())
}
pub fn load_vanilla(id: &str) -> R<Value> {
    let file = p().versions.join(id).join(format!("{}.json", id));
    if let Some(v) = read_json(&file) { return Ok(v); }
    let manifest = get_json(VERSION_MANIFEST)?;
    let Some(entry) = arr(&manifest["versions"]).iter().find(|x| g(x, "id").as_str() == Some(id)).cloned() else { bail!("Minecraft {} was not found.", id) };
    let v = get_json(&gs(&entry, "url"))?;
    write_json(&file, &v)?;
    Ok(v)
}

// ---------- loaders ----------
pub fn neo_to_mc(v: &str) -> String {
    let mut it = v.split('.');
    let (a, b) = (it.next().unwrap_or(""), it.next());
    match b { Some("0") => format!("1.{}", a), Some(b) => format!("1.{}.{}", a, b), None => format!("1.{}.undefined", a) }
}
fn has_ci(s: &str, words: &[&str]) -> bool { let l = s.to_lowercase(); words.iter().any(|w| l.contains(w)) }
pub fn loader_versions(loader: &str, mc: &str) -> R<Vec<Value>> {
    if loader == "fabric" || loader == "quilt" {
        let base = if loader == "fabric" { FABRIC_META } else { QUILT_META };
        let list = match get_json(&format!("{}/versions/loader/{}", base, enc_uri(mc))) {
            Ok(l) => l,
            Err(e) => { if e.status == 400 || e.status == 404 { return Ok(vec![]); } return Err(e); }
        };
        return Ok(arr(&list).iter().map(|x| {
            let v = js_string(g(&x["loader"], "version"));
            json!({ "id": v, "stable": x["loader"]["stable"] != json!(false) && !has_ci(&v, &["beta", "pre", "rc"]) })
        }).collect());
    }
    if loader == "forge" {
        let xml = get_text(&format!("{}/maven-metadata.xml", FORGE_MAVEN))?;
        let pre = format!("{}-", mc);
        let mut ids: Vec<String> = xml.split("<version>").skip(1).filter_map(|c| c.split_once("</version>").map(|(v, _)| v.to_string())).filter(|v| !v.contains('<') && v.starts_with(&pre)).map(|v| v[pre.len()..].to_string()).collect();
        let promos = get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json").ok().map(|p| p["promos"].clone()).unwrap_or(Value::Null);
        let rec = promos.get(format!("{}-recommended", mc)).map(js_string);
        ids.sort_by(|a, b| cmp_ver(b, a).cmp(&0));
        return Ok(ids.into_iter().map(|id| { let r = rec.as_deref() == Some(id.as_str()); json!({ "id": id, "stable": true, "recommended": r }) }).collect());
    }
    if loader == "neoforge" {
        let r = get_json("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")?;
        let mut ids: Vec<String> = arr(&r["versions"]).iter().map(js_string).filter(|v| neo_to_mc(v) == mc).collect();
        ids.sort_by(|a, b| cmp_ver(b, a).cmp(&0));
        return Ok(ids.into_iter().map(|id| { let st = !has_ci(&id, &["beta", "alpha"]); json!({ "id": id, "stable": st }) }).collect());
    }
    Ok(vec![])
}
pub fn pick_loader_version(server: &Value) -> R<String> {
    let (lv, loader, ver) = (gs(server, "loaderVersion"), gs(server, "loader"), gs(server, "version"));
    if !lv.is_empty() {
        if loader != "forge" { return Ok(lv); }
        // Forge for 1.7 to 1.12 publishes "<build>-<mc>" (11.15.1.2318-1.8.9); other launchers store just the build number.
        let known = loader_versions("forge", &ver).unwrap_or_default();
        let pre = format!("{}-", lv);
        let hit = known.iter().find(|x| gs(x, "id") == lv).or_else(|| known.iter().find(|x| gs(x, "id").starts_with(&pre)));
        return Ok(hit.map(|h| gs(h, "id")).unwrap_or(lv));
    }
    let list = loader_versions(&loader, &ver)?;
    let v = list.iter().find(|x| truthy(g(x, "recommended"))).or_else(|| list.iter().find(|x| truthy(g(x, "stable")))).or_else(|| list.first());
    match v { Some(v) => Ok(gs(v, "id")), None => bail!("{} has no build for Minecraft {}.", loader_name(&loader), ver) }
}
fn unrecognized(out: &str) -> bool { let l = out.to_lowercase(); l.contains("not a recognized option") || l.contains("unrecognizedoption") || l.contains("unrecognized") }
pub fn run_java(java: &str, args: &[String], cwd: &Path, label: &str) -> (i32, Vec<String>) {
    use std::os::windows::process::CommandExt;
    let child = Command::new(java).args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW).spawn();
    let mut child = match child { Ok(c) => c, Err(e) => return (-1, vec![e.to_string()]) };
    let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let ctx = ctx_get();
    let mut readers = Vec::new();
    let streams: Vec<Box<dyn std::io::Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    for s in streams {
        let (out, ctx, label) = (out.clone(), ctx.clone(), label.to_string());
        readers.push(std::thread::spawn(move || {
            ctx_set(ctx);
            for line in BufReader::new(s).split(b'\n').map_while(Result::ok) {
                let l = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                if l.is_empty() { continue; }
                ctx_log(&[format!("[{}] {}", label, l)]);
                out.lock().unwrap().push(l);
            }
        }));
    }
    for r in readers { let _ = r.join(); }
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    let lines = out.lock().unwrap().clone();
    (code, lines)
}
// Forge before 1.12.2-14.23.5.2847 has no command-line install. Its installer is a zip holding install_profile.json (the version file
// plus where to put the Forge jar), so install it by hand: write the version json and unpack the universal jar into libraries.
fn install_old_forge(inst: &Path) -> R<Value> {
    let buf = fs::read(inst)?;
    let files = zipx::entries(&buf)?;
    let Some(pe) = zipx::find(&files, "install_profile.json") else { bail!("This Forge installer has an unknown format.") };
    let prof: Value = serde_json::from_str(&pe.read_str(&buf)?)?;
    let (vi, ins) = (prof["versionInfo"].clone(), prof["install"].clone());
    if !truthy(&vi) || !truthy(&ins) || !truthy(g(&ins, "path")) || !truthy(g(&ins, "filePath")) { bail!("This Forge installer has an unknown format."); }
    let Some(jar) = zipx::find(&files, &gs(&ins, "filePath")) else { bail!("The Forge installer is missing {}.", gs(&ins, "filePath")) };
    let dest = join_rel(&p().libraries, &maven_path(&gs(&ins, "path")));
    ensure_dir(dest.parent().unwrap())?;
    fs::write(&dest, jar.read(&buf)?)?;
    let id = { let i = gs(&vi, "id"); if i.is_empty() { gs(&ins, "target") } else { i } };
    write_json(&p().versions.join(&id).join(format!("{}.json", id)), &vi)?;
    Ok(vi)
}
// Forge and NeoForge ship an installer that patches the game; run it headless into our .minecraft-style folder.
fn ensure_forge_like(loader: &str, mc: &str, ver: &str, java: &str, base: &Value) -> R<Value> {
    // Forge 1.12.2 and older name the version "<mc>-forge<mc>-<ver>", newer ones "<mc>-forge-<ver>".
    let ids = if loader == "forge" { vec![format!("{}-forge-{}", mc, ver), format!("{}-forge{}-{}", mc, mc, ver)] } else { vec![format!("neoforge-{}", ver)] };
    for id in &ids { if let Some(c) = read_json(&p().versions.join(id).join(format!("{}.json", id))) { return Ok(c); } }
    let name = if loader == "forge" { format!("forge-{}-{}-installer.jar", mc, ver) } else { format!("neoforge-{}-installer.jar", ver) };
    let url = if loader == "forge" { format!("{}/{}-{}/{}", FORGE_MAVEN, mc, ver, name) } else { format!("{}/{}/{}", NEO_MAVEN, ver, name) };
    let data = &p().data;
    let inst = data.join("installers").join(&name);
    set_progress(&format!("Downloading {}", loader_name(loader)), 0, 1);
    download(&url, &inst, None, None)?;
    let c = &base["downloads"]["client"];
    download(&gs(c, "url"), &p().versions.join(mc).join(format!("{}.jar", mc)), c["sha1"].as_str(), as_u64(&c["size"]))?;
    let lp = data.join("launcher_profiles.json");
    if !exists(&lp) { write_json(&lp, &json!({ "profiles": {}, "selectedProfile": "" }))?; }
    set_progress(&format!("Installing {} (takes a minute)", loader_name(loader)), 0, 1);
    let flags = if loader == "forge" { ["--installClient", "--install-client"] } else { ["--install-client", "--installClient"] };
    let mut r: Option<(i32, Vec<String>)> = None;
    for flag in flags {
        let res = run_java(java, &["-jar".into(), path_str(&inst), flag.into(), path_str(data)], data, loader_name(loader));
        let (code, out) = (res.0, res.1.join("\n"));
        r = Some(res);
        if code == 0 || !unrecognized(&out) { break; }
    }
    let mut found: Option<Value> = None;
    for id in &ids { if let Some(j) = read_json(&p().versions.join(id).join(format!("{}.json", id))) { found = Some(j); break; } }
    if found.is_none() {
        let want = if loader == "forge" { "forge" } else { "neoforge" };
        for (d, _) in read_dir(&p().versions).unwrap_or_default() {
            if let Some(j) = read_json(&p().versions.join(&d).join(format!("{}.json", d))) {
                let inh = gs(&j, "inheritsFrom");
                if (inh.is_empty() || inh == mc) && d.to_lowercase().contains(want) && d.contains(ver) { found = Some(j); break; }
            }
        }
    }
    let out_text = r.as_ref().map(|x| x.1.join("\n")).unwrap_or_default();
    if found.is_none() && loader == "forge" && r.is_some() && unrecognized(&out_text) { found = Some(install_old_forge(&inst)?); }
    match found {
        Some(j) => Ok(j),
        None => {
            let tail = r.map(|x| x.1.iter().rev().take(2).rev().cloned().collect::<Vec<_>>().join(" ")).unwrap_or_default();
            Err(Error::new(format!("The {} installer did not finish. {}", loader_name(loader), tail).trim().to_string()))
        }
    }
}

pub struct Lib { pub path: String, pub url: String, pub alt: Vec<String>, pub sha1: Option<String>, pub size: Option<u64> }
pub struct Native { pub path: String, pub url: String, pub sha1: Option<String>, pub size: Option<u64>, pub exclude: Vec<String> }
pub struct Profile {
    pub id: String,
    pub jar_id: String,
    pub main_class: String,
    pub libraries: Vec<Lib>,
    pub natives: Vec<Native>,
    pub game: Vec<Value>,
    pub jvm: Vec<Value>,
    pub legacy: bool,
    pub asset_index: Value,
    pub client: Value,
    pub typ: String,
    pub java_component: String,
    pub logging: Value,
}
// Resolves everything needed to launch a profile, for any Minecraft version and loader.
pub fn resolve_profile(server: &Value) -> R<Profile> {
    let mc = gs(server, "version");
    let loader = { let l = gs(server, "loader"); if LOADERS.contains(&l.as_str()) { l } else { "vanilla".into() } };
    let base = load_vanilla(&mc)?;
    let java_component = { let c = gs(&base["javaVersion"], "component"); if c.is_empty() { "jre-legacy".to_string() } else { c } };
    let mut child: Option<Value> = None;
    let mut sv = server.clone();
    sv["loader"] = json!(loader);
    if loader == "fabric" || loader == "quilt" {
        let ver = pick_loader_version(&sv)?;
        let id = format!("{}-loader-{}-{}", loader, ver, mc);
        let file = p().versions.join(&id).join(format!("{}.json", id));
        child = read_json(&file);
        if child.is_none() {
            let meta = if loader == "fabric" { FABRIC_META } else { QUILT_META };
            let mut c = get_json(&format!("{}/versions/loader/{}/{}/profile/json", meta, enc_uri(&mc), enc_uri(&ver)))?;
            c["id"] = json!(id);
            write_json(&file, &c)?;
            child = Some(c);
        }
    } else if loader == "forge" || loader == "neoforge" {
        let ver = pick_loader_version(&sv)?;
        let java = ensure_java(&java_component)?;
        child = Some(ensure_forge_like(&loader, &mc, &ver, &java, &base)?);
    }
    let (mut libs, mut natives, mut seen) = (Vec::new(), Vec::new(), HashSet::new());
    let arch = if is_x86() { "32" } else { "64" };
    let none = HashMap::new();
    let mut add_lib = |l: &Value, default_maven: &str| {
        let name = gs(l, "name");
        if name.is_empty() || !rule_allows(g(l, "rules"), &none) { return; }
        let nat = g(g(l, "natives"), OS_NAME);
        if truthy(nat) {
            let c = &l["downloads"]["classifiers"][js_string(nat).replace("${arch}", arch)];
            if truthy(c) {
                natives.push(Native { path: gs(c, "path"), url: gs(c, "url"), sha1: c["sha1"].as_str().map(String::from), size: as_u64(&c["size"]), exclude: str_list(&l["extract"]["exclude"]) });
            }
        }
        let key = lib_key(&name);
        if seen.contains(&key) { return; }
        let a = &l["downloads"]["artifact"];
        if truthy(a) {
            seen.insert(key);
            let pth = gs(a, "path");
            libs.push(Lib { path: if pth.is_empty() { maven_path(&name) } else { pth }, url: gs(a, "url"), alt: vec![], sha1: a["sha1"].as_str().map(String::from), size: as_u64(&a["size"]) });
            return;
        }
        if !truthy(g(l, "downloads")) {
            seen.insert(key);
            let rel = maven_path(&name);
            let alt = ["https://libraries.minecraft.net/", "https://maven.minecraftforge.net/", "https://repo1.maven.org/maven2/"].iter().map(|h| format!("{}{}", h, rel)).collect();
            let mut host = { let u = gs(l, "url"); if u.is_empty() { default_maven.to_string() } else { u } };
            for pre in ["https://files.minecraftforge.net/maven/", "http://files.minecraftforge.net/maven/", "https://files.minecraftforge.net/maven", "http://files.minecraftforge.net/maven"] {
                if let Some(rest) = host.strip_prefix(pre) { host = format!("https://maven.minecraftforge.net/{}", rest); break; }
            }
            if let Some(rest) = host.strip_prefix("http:") { host = format!("https:{}", rest); }
            let host = if host.ends_with('/') { host } else { format!("{}/", host) };
            libs.push(Lib { path: rel.clone(), url: format!("{}{}", host, rel), alt, sha1: l["sha1"].as_str().map(String::from), size: as_u64(&l["size"]) });
        }
    };
    if let Some(c) = &child {
        let dm = if loader == "quilt" { "https://maven.quiltmc.org/repository/release/" } else if loader == "fabric" { "https://maven.fabricmc.net/" } else { "https://libraries.minecraft.net/" };
        for l in arr(&c["libraries"]) { add_lib(l, dm); }
    }
    for l in arr(&base["libraries"]) { add_lib(l, "https://libraries.minecraft.net/"); }
    let (mut game, mut jvm, mut legacy): (Vec<Value>, Vec<Value>, Option<String>) = (vec![], vec![], None);
    if truthy(g(&base, "arguments")) { game = arr(&base["arguments"]["game"]).to_vec(); jvm = arr(&base["arguments"]["jvm"]).to_vec(); } else { legacy = Some(gs(&base, "minecraftArguments")); }
    if let Some(c) = &child {
        if truthy(g(c, "arguments")) { game.extend_from_slice(arr(&c["arguments"]["game"])); jvm.extend_from_slice(arr(&c["arguments"]["jvm"])); }
        if truthy(g(c, "minecraftArguments")) { legacy = Some(gs(c, "minecraftArguments")); }
    }
    if let Some(l) = legacy { game = l.split(' ').filter(|x| !x.is_empty()).map(|x| json!(x)).collect(); }
    let main_class = child.as_ref().map(|c| gs(c, "mainClass")).filter(|x| !x.is_empty()).unwrap_or_else(|| gs(&base, "mainClass"));
    Ok(Profile {
        id: child.as_ref().map(|c| gs(c, "id")).unwrap_or_else(|| gs(&base, "id")),
        jar_id: gs(&base, "id"),
        main_class,
        libraries: libs,
        natives,
        game,
        jvm,
        legacy: !truthy(g(&base, "arguments")),
        asset_index: base["assetIndex"].clone(),
        client: base["downloads"]["client"].clone(),
        typ: gs(&base, "type"),
        java_component,
        logging: base["logging"]["client"].clone(),
    })
}

pub struct Installed { pub jar: PathBuf, pub log_arg: Option<String>, pub game_assets: PathBuf }
pub fn install_files(profile: &Profile, game_dir: &Path) -> R<Installed> {
    let pp = p();
    let base_jar = pp.versions.join(&profile.jar_id).join(format!("{}.jar", profile.jar_id));
    set_progress("Downloading Minecraft", 0, 1);
    download(&gs(&profile.client, "url"), &base_jar, profile.client["sha1"].as_str(), as_u64(&profile.client["size"]))?;
    let mut jar = base_jar.clone();
    if profile.id != profile.jar_id { // loaders expect the game jar under their own version name
        jar = pp.versions.join(&profile.id).join(format!("{}.jar", profile.id));
        let a = fs::metadata(&base_jar)?.len();
        let b = fs::metadata(&jar).ok().map(|m| m.len());
        if b != Some(a) { ensure_dir(jar.parent().unwrap())?; fs::copy(&base_jar, &jar)?; }
    }
    let done = std::sync::atomic::AtomicUsize::new(0);
    pool(&profile.libraries, 12, |l| {
        let dest = join_rel(&pp.libraries, &l.path);
        if l.url.is_empty() {
            if !exists(&dest) { bail!("Missing {}. Delete the profile's loader and try again.", dest.file_name().unwrap().to_string_lossy()); }
        } else {
            let mut last: Option<Error> = None;
            for u in std::iter::once(&l.url).chain(l.alt.iter()) {
                match download(u, &dest, l.sha1.as_deref(), l.size) { Ok(_) => { last = None; break; } Err(e) => last = Some(e) }
            }
            if let Some(e) = last { return Err(e); }
        }
        set_progress("Downloading libraries", done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1, profile.libraries.len());
        Ok(())
    })?;
    let natives_dir = pp.versions.join(&profile.id).join("natives");
    ensure_dir(&natives_dir)?;
    if !profile.natives.is_empty() && !exists(&natives_dir.join(".done")) {
        set_progress("Unpacking natives", 0, profile.natives.len());
        for n in &profile.natives {
            let f = join_rel(&pp.libraries, &n.path);
            download(&n.url, &f, n.sha1.as_deref(), n.size)?;
            zipx::extract_zip(&f, &natives_dir, &n.exclude)?;
        }
        fs::write(natives_dir.join(".done"), "1")?;
    }
    let mut log_arg = None;
    let lg = &profile.logging;
    if truthy(g(lg, "file")) && truthy(g(lg, "argument")) {
        let lf = pp.assets.join("log_configs").join(gs(&lg["file"], "id"));
        download(&gs(&lg["file"], "url"), &lf, lg["file"]["sha1"].as_str(), as_u64(&lg["file"]["size"]))?;
        log_arg = Some(gs(lg, "argument").replacen("${path}", &path_str(&lf), 1));
    }
    let ai = &profile.asset_index;
    let idx_file = pp.assets.join("indexes").join(format!("{}.json", gs(ai, "id")));
    download(&gs(ai, "url"), &idx_file, ai["sha1"].as_str(), as_u64(&ai["size"]))?;
    let idx: Value = serde_json::from_str(&fs::read_to_string(&idx_file)?)?;
    let objects = idx["objects"].as_object().cloned().unwrap_or_default();
    let mut uniq: indexmap::IndexMap<String, Value> = indexmap::IndexMap::new();
    for (_, o) in &objects { uniq.insert(gs(o, "hash"), o.clone()); }
    let uniq: Vec<Value> = uniq.into_values().collect();
    let done = std::sync::atomic::AtomicUsize::new(0);
    pool(&uniq, 24, |o| {
        let hash = gs(o, "hash");
        let sub = &hash[..2.min(hash.len())];
        download(&format!("https://resources.download.minecraft.net/{}/{}", sub, hash), &pp.assets.join("objects").join(sub).join(&hash), Some(&hash), as_u64(&o["size"]))?;
        let d = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if d % 25 == 0 || d == uniq.len() { set_progress("Downloading assets", d, uniq.len()); }
        Ok(())
    })?;
    let mut game_assets = pp.assets.clone();
    if truthy(g(&idx, "virtual")) || truthy(g(&idx, "map_to_resources")) { // very old versions read loose files
        game_assets = if truthy(g(&idx, "map_to_resources")) { game_dir.join("resources") } else { pp.assets.join("virtual").join(gs(ai, "id")) };
        for (name, o) in &objects {
            let dest = join_rel(&game_assets, name);
            if exists(&dest) { continue; }
            ensure_dir(dest.parent().unwrap())?;
            let hash = gs(o, "hash");
            fs::copy(pp.assets.join("objects").join(&hash[..2.min(hash.len())]).join(&hash), &dest)?;
        }
    }
    Ok(Installed { jar, log_arg, game_assets })
}

fn substitute(s: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(j) if j > 0 => {
                let k = &after[..j];
                match vars.get(k) { Some(v) => out.push_str(v), None => { out.push_str("${"); out.push_str(k); out.push('}'); } }
                rest = &after[j + 1..];
            }
            _ => { out.push_str("${"); rest = after; }
        }
    }
    out.push_str(rest);
    out
}
fn expand_args(list: &[Value], features: &HashMap<&str, bool>, vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for a in list {
        if let Some(s) = a.as_str() { out.push(substitute(s, vars)); continue; }
        if !rule_allows(g(a, "rules"), features) { continue; }
        let v = g(a, "value");
        match v { Value::Array(vals) => for x in vals { out.push(substitute(&js_string(x), vars)) }, x => out.push(substitute(&js_string(x), vars)) }
    }
    out
}
pub fn split_address(addr: &str) -> (String, u16) {
    static RE: OnceLock<regex_lite::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex_lite::Regex::new(r"^\[?([^\]]+?)\]?(?::(\d+))?$").unwrap());
    match re.captures(js_trim(addr)) {
        Some(c) => (c[1].to_string(), c.get(2).and_then(|m| m.as_str().parse::<u32>().ok()).map(|p| p as u16).unwrap_or(25565)),
        None => (addr.to_string(), 25565),
    }
}

/// Builds the java argument list.
pub fn build_launch_args(profile: &Profile, jar: &Path, game_dir: &Path, acc: &Value, server: &Value, log_arg: Option<&str>, game_assets: &Path, settings: &Value) -> Vec<String> {
    let pp = p();
    let sep = ";";
    let natives_dir = pp.versions.join(&profile.id).join("natives");
    let mut cp: Vec<String> = profile.libraries.iter().map(|l| path_str(&join_rel(&pp.libraries, &l.path))).collect();
    cp.push(path_str(jar));
    let classpath = cp.join(sep);
    let has_quick_play = serde_json::to_string(&profile.game).unwrap_or_default().contains("quickPlayMultiplayer");
    let address = js_trim(&gs(server, "address")).to_string();
    let joining = !address.is_empty();
    let mut features = HashMap::new();
    features.insert("has_custom_resolution", truthy(g(settings, "customResolution")));
    features.insert("is_demo_user", false);
    features.insert("has_quick_plays_support", false);
    features.insert("is_quick_play_multiplayer", joining && has_quick_play);
    features.insert("is_quick_play_singleplayer", false);
    features.insert("is_quick_play_realms", false);
    let (name, uuid, token) = (gs(&acc["profile"], "name"), gs(&acc["profile"], "id"), gs(acc, "mcToken"));
    let mut vars: HashMap<&str, String> = HashMap::new();
    let ga = path_str(game_assets);
    vars.insert("auth_player_name", name);
    vars.insert("version_name", profile.id.clone());
    vars.insert("game_directory", path_str(game_dir));
    vars.insert("assets_root", ga.clone());
    vars.insert("game_assets", ga);
    vars.insert("assets_index_name", gs(&profile.asset_index, "id"));
    vars.insert("auth_uuid", uuid.clone());
    vars.insert("auth_access_token", token.clone());
    vars.insert("auth_session", format!("token:{}:{}", token, uuid));
    vars.insert("clientid", String::new());
    vars.insert("auth_xuid", gs(acc, "xuid"));
    vars.insert("user_type", "msa".into());
    vars.insert("version_type", if profile.typ.is_empty() { "release".into() } else { profile.typ.clone() });
    vars.insert("resolution_width", js_string(g(settings, "width")));
    vars.insert("resolution_height", js_string(g(settings, "height")));
    vars.insert("natives_directory", path_str(&natives_dir));
    vars.insert("launcher_name", "Auroria".into());
    vars.insert("launcher_version", VERSION.into());
    vars.insert("classpath", classpath.clone());
    vars.insert("classpath_separator", sep.into());
    vars.insert("library_directory", path_str(&pp.libraries));
    vars.insert("quickPlayMultiplayer", if joining { address.clone() } else { String::new() });
    vars.insert("user_properties", "{}".into());
    vars.insert("profile_name", { let n = gs(server, "name"); if n.is_empty() { "Auroria".into() } else { n } });
    let ram = num_or(g(server, "ramGB"), js_number(g(settings, "ramGB")));
    let mut jvm = vec![format!("-Xmx{}G", fmt_num(ram)), "-Xms512M".into()];
    if let Some(list) = g(server, "jvmArgs").as_array() {
        let re = regex_lite::Regex::new(r"^-XX:[+-]?\w+(=[\w.]+)?$").unwrap();
        for a in list { let s = js_string(a); if re.is_match(&s) { jvm.push(s); } }
    }
    if let Some(l) = log_arg { jvm.push(l.to_string()); }
    jvm.extend(expand_args(&profile.jvm, &features, &vars));
    if profile.jvm.is_empty() {
        jvm.push("-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump".into());
        jvm.push(format!("-Djava.library.path={}", path_str(&natives_dir)));
        jvm.push("-cp".into());
        jvm.push(classpath);
    }
    let mut game_args = expand_args(&profile.game, &features, &vars);
    if truthy(g(settings, "customResolution")) && profile.legacy { game_args.extend(["--width".into(), js_string(g(settings, "width")), "--height".into(), js_string(g(settings, "height"))]); }
    if joining && !has_quick_play { let (h, port) = split_address(&address); game_args.extend(["--server".into(), h, "--port".into(), port.to_string()]); }
    if truthy(g(settings, "fullscreen")) { game_args.push("--fullscreen".into()); }
    let mut out = jvm;
    out.push(profile.main_class.clone());
    out.extend(game_args);
    out
}

// ---------- launch ----------
/// The synchronous part of a launch: checks, picks the account and marks the profile as preparing. Returns what run_game needs.
pub fn begin_launch(server_id: &str, acc_id: &str) -> R<(Value, Option<String>)> {
    let mut s = st();
    let server = s.server_by(&json!(server_id));
    let sid = gs(&server, "id");
    if s.game(&sid).state != "idle" { bail!("{} is already starting or running.", gs(&server, "name")); }
    let want = if acc_id.is_empty() { gs(&server, "accountId") } else { acc_id.to_string() };
    let chosen = s.accounts.iter().find(|a| account_id(a) == want).cloned().or_else(|| s.account().cloned());
    let cid = chosen.as_ref().map(account_id).unwrap_or_default();
    if let Some(busy) = s.games.values().find(|g| g.state != "idle" && !g.account_id.is_empty() && g.account_id == cid) {
        let other = s.server_by(&json!(busy.server_id));
        bail!("{} is already playing {}. Pick another account for this profile.", gs(&chosen.as_ref().unwrap()["profile"], "name"), gs(&other, "name"));
    }
    let g = s.game(&sid);
    g.logs.clear();
    g.user_stopped = false;
    g.account_id = cid.clone();
    g.account_name = chosen.as_ref().filter(|c| g_obj(c, "profile")).map(|c| gs(&c["profile"], "name")).unwrap_or_default();
    drop(s);
    set_game_state(&sid, "preparing", Obj::new());
    Ok((server, chosen.map(|_| cid)))
}
fn g_obj(v: &Value, k: &str) -> bool { g(v, k).is_object() }

pub fn run_game(server: Value, join: String, chosen: Option<String>) {
    let sid = gs(&server, "id");
    ctx_set(Some(sid.clone()));
    if let Err(e) = run_game_inner(&server, &join, chosen) {
        log_line(&format!("launch failed {}", e.msg));
        set_game_state(&sid, "idle", obj(json!({ "error": e.msg })));
    }
}
fn run_game_inner(server: &Value, join: &str, chosen: Option<String>) -> R<()> {
    use std::os::windows::process::CommandExt;
    let sid = gs(server, "id");
    let acc = match &chosen { Some(id) => ensure_fresh_any(id)?, None => crate::auth::ensure_fresh(None)? };
    let profile = resolve_profile(server)?;
    let jp = gs(server, "javaPath");
    let java = if !jp.is_empty() && exists(Path::new(&jp)) { jp } else { ensure_java(&profile.java_component)? };
    let game_dir = instance_dir(server);
    ensure_dir(&game_dir)?;
    let inst = install_files(&profile, &game_dir)?;
    let version = gs(server, "version");
    let modded = mods::client_modded(server);
    let own = if modded { mods::own_client_jar(&version).unwrap_or_else(|e| { log_line(&format!("own client failed {}", e.msg)); None }) } else { None };
    mods::ensure_server_mods(server, own.is_some())?;
    if modded { mods::apply_own_client(server, own.as_ref())?; }
    if let Err(e) = mods::ensure_client_pack(server, &game_dir) { log_line(&format!("pack failed {}", e.msg)); }
    if modded && own.is_none() { if let Err(e) = mods::build_client_skin(server, &game_dir) { log_line(&format!("client skin failed {}", e.msg)); } }
    let mut target = server.clone();
    if !join.is_empty() { target["address"] = json!(join); }
    let settings = Value::Object(st().settings.clone());
    let args = build_launch_args(&profile, &inst.jar, &game_dir, &acc, &target, inst.log_arg.as_deref(), &inst.game_assets, &settings);
    let started = now_ms();
    {
        let mut s = st();
        if let Some(sv) = s.server_mut(&sid) { sv["lastPlayed"] = json!(started); }
        let _ = s.save_servers();
    }
    set_progress("Starting Minecraft", 1, 1);
    log_line(&format!("launch {} {}", sid, profile.id));
    let detached = !truthy(g(&settings, "keepOpen"));
    let mut cmd = Command::new(&java);
    cmd.args(&args).current_dir(&game_dir);
    if detached { cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP); } else { cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()); }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => { set_game_state(&sid, "idle", obj(json!({ "error": format!("Java could not start: {}", e) }))); return Ok(()); }
    };
    if detached {
        set_game_state(&sid, "running", Obj::new());
        std::thread::spawn(|| { sleep_ms(4000); broadcast(json!({ "type": "quit" })); sleep_ms(1500); std::process::exit(0); });
        return Ok(());
    }
    {
        let mut s = st();
        let g = s.game(&sid);
        g.pid = Some(child.id());
    }
    let mut readers = Vec::new();
    let streams: Vec<Box<dyn std::io::Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    for stream in streams {
        let sid = sid.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
                let l = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                if l.is_empty() { continue; }
                {
                    let mut s = st();
                    let g = s.game(&sid);
                    g.logs.push(l.clone());
                    if g.logs.len() > 5000 { let n = g.logs.len() - 5000; g.logs.drain(..n); }
                }
                broadcast(json!({ "type": "log", "serverId": sid, "line": l }));
            }
        }));
    }
    set_game_state(&sid, "running", Obj::new());
    { let mut s = st(); let g = s.game(&sid); g.started_at = started; g.join = join.to_string(); }
    win::discord_set(Some(server.clone()), started, join.to_string());
    let server = server.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        for r in readers { let _ = r.join(); }
        let code = status.ok().and_then(|s| s.code()).unwrap_or(1);
        let end = now_ms();
        let (other, user_stopped, logs) = {
            let mut s = st();
            if let Some(sv) = s.server_mut(&sid) { add_playtime(sv, started, end); }
            let _ = s.save_servers();
            let g = s.game(&sid);
            g.pid = None;
            let (us, logs) = (g.user_stopped, g.logs.clone());
            // Discord shows one game: hand it to another profile that is still running, if any.
            let other = s.games.values().find(|x| x.server_id != sid && x.state == "running").map(|x| (s.server_by(&json!(x.server_id)), x.started_at, x.join.clone()));
            (other, us, logs)
        };
        match other { Some((sv, at, j)) => win::discord_set(Some(sv), at, j), None => win::discord_set(None, 0, String::new()) }
        let name = gs(&server, "name");
        let mins = ((end - started) as f64 / 60000.0 + 0.5).floor() as i64;
        if code != 0 && !user_stopped { win::notify("Minecraft crashed", &format!("{} closed unexpectedly. Open Auroria to see what went wrong.", name)); }
        else { win::notify("Minecraft closed", &format!("You played {} for {}.", name, if mins < 60 { format!("{} min", mins) } else { format!("{} h {} min", mins / 60, mins % 60) })); }
        let extra = if code != 0 && !user_stopped { obj(json!({ "error": format!("Minecraft closed with code {}. Check the game log.", code), "crash": mods::diagnose_crash(&logs) })) } else { Obj::new() };
        set_game_state(&sid, "idle", extra);
        win::maybe_exit();
    });
    Ok(())
}
fn ensure_fresh_any(id: &str) -> R<Value> { crate::auth::ensure_fresh(Some(id)) }

pub fn add_playtime(s: &mut Value, start: i64, end: i64) {
    let ms = end - start;
    if ms <= 5000 { return; }
    s["playMs"] = num_val(js_number(g(s, "playMs")) + ms as f64);
    let k = iso(end)[..10].to_string();
    let mut days = g(s, "playDays").as_object().cloned().unwrap_or_default();
    let cur = days.get(&k).map(js_number).unwrap_or(0.0);
    days.insert(k, num_val(cur + ms as f64));
    let mut keys: Vec<String> = days.keys().cloned().collect();
    keys.sort();
    if keys.len() > 30 { for d in &keys[..keys.len() - 30] { days.shift_remove(d); } }
    s["playDays"] = Value::Object(days);
}
