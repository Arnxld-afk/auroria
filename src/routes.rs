// Every /api route the UI calls, with the same names, inputs and JSON answers as the Node backend had.
use crate::auth::*;
use crate::extras::*;
use crate::game::*;
use crate::mods::*;
use crate::net::*;
use crate::state::*;
use crate::util::*;
use crate::win::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const ROUTES: &[&str] = &[
    "GET /api/ping", "POST /api/ui-ready", "POST /api/logs/upload", "POST /api/window", "GET /api/state", "POST /api/auth/start", "POST /api/config/client-id",
    "POST /api/auth/cancel", "POST /api/auth/logout", "POST /api/auth/switch", "POST /api/profile/refresh", "POST /api/settings", "POST /api/servers/save",
    "POST /api/servers/delete", "GET /api/servers/ping-one", "GET /api/versions", "GET /api/loader-versions", "GET /api/import/scan", "POST /api/import/run",
    "POST /api/import/mrpack", "GET /api/modpacks/versions", "POST /api/modpacks/install", "GET /api/snapshots", "POST /api/snapshots/take", "POST /api/snapshots/restore",
    "POST /api/snapshots/delete", "GET /api/presets", "POST /api/profile/preset", "GET /api/packs", "POST /api/packs/order", "POST /api/packs/shader", "POST /api/packs/delete",
    "POST /api/profile/shortcut", "POST /api/autoplay", "POST /api/profile/export", "GET /api/worlds", "POST /api/worlds/backup", "POST /api/worlds/restore",
    "POST /api/worlds/delete-backup", "POST /api/worlds/open", "GET /api/shots", "POST /api/shots/open", "POST /api/options/sync", "POST /api/profile/servers",
    "GET /api/update/check", "POST /api/update/apply", "POST /api/servers/duplicate", "GET /api/servers/ping", "POST /api/launch", "POST /api/stop", "GET /api/launch-check",
    "GET /api/logs", "GET /api/mods", "GET /api/mods/sig", "GET /api/mods/updates", "GET /api/mods/search", "POST /api/mods/install", "POST /api/mods/install-dep",
    "GET /api/mods/dependents", "GET /api/java", "POST /api/mods/toggle", "POST /api/mods/delete", "POST /api/mods/update", "GET /api/skins", "POST /api/skins/upload",
    "POST /api/skins/delete", "POST /api/skins/apply", "POST /api/capes/apply", "POST /api/open",
];
pub fn exists(key: &str) -> bool { ROUTES.contains(&key) }

fn server_of(v: &Value) -> Value { st().server_by(v) }
fn find_server(v: &Value) -> Option<Value> { v.as_str().and_then(|id| st().find_server(id)) }
fn busy(s: &Value) -> bool { st().profile_busy(&gs(s, "id")) }
fn servers_json() -> Value { Value::Array(st().servers().clone()) }
fn is_address(a: &str) -> bool { !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':')) }
fn is_mc_version(v: &str) -> bool { (2..=40).contains(&v.chars().count()) && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ')) }
fn installed_ids(before: &[Value]) -> HashSet<String> { before.iter().map(|m| gs(m, "projectId")).filter(|x| !x.is_empty()).collect() }
fn auth_state() -> Value { let s = st(); json!({ "profile": public_profile_of(s.account()), "accounts": s.account_list() }) }

pub fn call(key: &str, b: &Value, q: &Query) -> R<Value> {
    match key {
        "GET /api/ping" => Ok(json!({ "ok": true })),
        "POST /api/ui-ready" => { log_line(&format!("ui ready {} ms after page start", (num_or(g(b, "ms"), 0.0) + 0.5).floor())); Ok(json!({ "ok": true })) }
        "POST /api/logs/upload" => {
            let content = str_or(g(b, "content"));
            let lines: Vec<&str> = content.split('\n').collect();
            let lines = &lines[lines.len().saturating_sub(24000)..];
            if lines.concat().trim().is_empty() { bail!("The log is empty"); }
            let url = "https://api.mclo.gs/1/log";
            let ua = ua();
            let r = fetch("POST", url, &[("User-Agent", &ua), ("Content-Type", "application/x-www-form-urlencoded")], Some(form_encode(&[("content", &lines.join("\n"))]).as_bytes()), Some(std::time::Duration::from_secs(30)))?;
            let j = r.json();
            match j {
                Some(j) if truthy(g(&j, "success")) => Ok(json!({ "url": g(&j, "url") })),
                Some(j) if truthy(g(&j, "error")) => bail!("{}", js_string(&j["error"])),
                _ => bail!("mclo.gs answered HTTP {}", r.status),
            }
        }
        "POST /api/window" => {
            let a = str_or(g(b, "action"));
            match a.as_str() {
                "min" => Ok(json!({ "r": win_cmd("MIN") })),
                "max" => Ok(json!({ "r": win_cmd("MAX") })),
                "close" => Ok(json!({ "r": win_cmd("CLOSE") })),
                "show" => {
                    if has_helper() { return Ok(json!({ "r": win_cmd("SHOW") })); }
                    let url = crate::server::ui_url();
                    std::thread::spawn(move || open_window(&url));
                    Ok(json!({ "ok": true }))
                }
                "rect" => {
                    let r = win_cmd("RECT").unwrap_or_default();
                    let p: Vec<&str> = r.split(' ').collect();
                    if p.len() >= 4 && p[0] == "RECT" { if let (Ok(x), Ok(y)) = (p[1].parse::<i64>(), p[2].parse::<i64>()) { return Ok(json!({ "x": x, "y": y, "max": p[3] == "True" })); } }
                    Ok(json!({ "x": null }))
                }
                "pos" => {
                    let cmd = format!("POS {} {}", (num_or(g(b, "x"), 0.0) + 0.5).floor(), (num_or(g(b, "y"), 0.0) + 0.5).floor());
                    std::thread::spawn(move || { win_cmd(&cmd); });
                    Ok(json!({ "ok": true }))
                }
                _ => bail!("Unknown window action"),
            }
        }
        "GET /api/state" => {
            let mut s = st();
            let auto = std::mem::take(&mut s.pending_play);
            let mut cfg = Obj::new();
            if let Some(v) = s.config.get("brand") { cfg.insert("brand".into(), v.clone()); }
            cfg.insert("servers".into(), Value::Array(s.servers().clone()));
            Ok(json!({
                "version": VERSION, "windowControls": window_ready(), "clientMods": client_mods_json(), "ownClientVersions": s.own_client_versions, "profile": public_profile_of(s.account()),
                "accounts": s.account_list(), "settings": s.settings, "hasClientId": true, "authMode": s.auth_mode(), "clientId": s.config.get("microsoftClientId").map(str_or).unwrap_or_default(),
                "config": cfg, "games": s.games_summary(), "dataDir": path_str(&p().data), "autoPlay": auto,
            }))
        }
        "POST /api/auth/start" => start_auth(),
        "POST /api/config/client-id" => {
            let id = js_trim(&str_or(g(b, "clientId"))).to_string();
            let ok = { let p: Vec<&str> = id.split('-').collect(); p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| x.len() == *n && x.chars().all(|c| c.is_ascii_hexdigit())) };
            if !id.is_empty() && !ok { bail!("That does not look like an Application (client) ID. It has the form 00000000-0000-0000-0000-000000000000."); }
            let mut user = read_json(&p().config).map(obj).unwrap_or_default();
            user.insert("microsoftClientId".into(), json!(id));
            write_json(&p().config, &Value::Object(user))?;
            st().config.insert("microsoftClientId".into(), json!(id));
            Ok(json!({ "ok": true, "clientId": id }))
        }
        "POST /api/auth/cancel" => { cancel_auth(); Ok(json!({ "ok": true })) }
        "POST /api/auth/logout" => {
            { let mut s = st(); let id = s.account().map(account_id).unwrap_or_default(); s.drop_account(&id); s.save_account()?; }
            Ok(auth_state())
        }
        "POST /api/auth/switch" => {
            {
                let mut s = st();
                let id = g(b, "id").clone();
                let Some(a) = s.accounts.iter().find(|x| json!(account_id(x)) == id).cloned() else { bail!("That account is no longer signed in.") };
                s.active = account_id(&a);
                s.save_account()?;
            }
            Ok(auth_state())
        }
        "POST /api/profile/refresh" => refresh_profile(),
        "POST /api/settings" => {
            let mut s = st();
            for (k, _) in DEFAULT_SETTINGS { if let Some(v) = b.get(*k) { s.settings.insert(k.to_string(), v.clone()); } }
            let set = |s: &mut State, k: &str, v: Value| { s.settings.insert(k.into(), v); };
            let ram = num_or(&s.setting("ramGB"), 4.0).max(1.0).min(32.0);
            set(&mut s, "ramGB", num_val(ram));
            let w = num_or(&s.setting("width"), 1280.0).max(320.0);
            set(&mut s, "width", num_val(w));
            let h = num_or(&s.setting("height"), 720.0).max(240.0);
            set(&mut s, "height", num_val(h));
            if !is_hex_color(&str_or(&s.setting("accent"))) { set(&mut s, "accent", json!("")); }
            for k in ["notifications", "discordPresence", "updateCheck"] { let v = s.setting(k) != json!(false); set(&mut s, k, json!(v)); }
            s.save_settings()?;
            Ok(Value::Object(s.settings.clone()))
        }
        "POST /api/servers/save" => servers_save(b),
        "POST /api/servers/delete" => {
            let mut s = st();
            if s.servers().len() <= 1 { bail!("Keep at least one server in the list."); }
            let id = g(b, "id").clone();
            s.servers_mut().retain(|x| g(x, "id") != &id);
            s.save_servers()?;
            if s.setting("selectedServer") == id { let first = g(&s.servers()[0], "id").clone(); s.settings.insert("selectedServer".into(), first); s.save_settings()?; }
            Ok(json!({ "servers": s.servers(), "settings": s.settings }))
        }
        "GET /api/servers/ping-one" => {
            let a = js_trim(&q.get("address").unwrap_or_default()).to_string();
            if !is_address(&a) { bail!("Enter an address first."); }
            Ok(ping_server(&a, 4000))
        }
        "GET /api/versions" => {
            if let Some(v) = st().version_cache.clone() { return Ok(v); }
            let m = get_json(VERSION_MANIFEST)?;
            let v = json!({ "latest": m["latest"], "versions": arr(&m["versions"]).iter().map(|v| json!({ "id": v["id"], "type": v["type"], "date": v["releaseTime"] })).collect::<Vec<_>>() });
            st().version_cache = Some(v.clone());
            Ok(v)
        }
        "GET /api/loader-versions" => {
            let loader = q.get("loader").unwrap_or_default();
            let mc = q.get("mc").unwrap_or_default();
            if !LOADERS.contains(&loader.as_str()) || loader == "vanilla" { return Ok(json!([])); }
            let mut l = loader_versions(&loader, &mc)?;
            l.truncate(60);
            Ok(Value::Array(l))
        }
        "GET /api/import/scan" => Ok(Value::Array(scan_imports().into_iter().map(|e| json!({ "id": e.id, "source": e.source, "name": e.name, "version": e.version, "loader": e.loader, "loaderVersion": e.loader_version, "hasIcon": !e.icon.is_empty() })).collect())),
        "POST /api/import/run" => {
            let id = g(b, "id").clone();
            let Some(src) = scan_imports().into_iter().find(|e| json!(e.id) == id) else { bail!("That profile was not found any more. Reopen this window to scan again.") };
            let entry = new_profile_entry(&src.name, &src.version, &src.loader, &src.loader_version, &src.icon, &format!("Imported from {}", src.source));
            let dest = instance_dir(&entry);
            if let Err(e) = copy_dir(&src.dir, &dest, IMPORT_SKIP) { rm_rf(&dest); bail!("Could not copy the files: {}", e.msg); }
            commit_profile(entry)
        }
        "POST /api/import/mrpack" => {
            let data = str_or(g(b, "data"));
            let Some(b64) = data.strip_prefix("data:").and_then(|r| r.split_once(";base64,")).filter(|(t, _)| !t.contains(';')).map(|(_, d)| d) else { bail!("No file received.") };
            import_mrpack(&b64_decode(b64))
        }
        "GET /api/modpacks/versions" => modpack_versions(&q.get("projectId").unwrap_or_default()),
        "POST /api/modpacks/install" => {
            let r = install_modpack(&str_or(g(b, "projectId")), &str_or(g(b, "versionId")), &str_or(g(b, "gameVersion")))?;
            let name = st().find_server(&gs(&r, "id")).map(|e| gs(&e, "name")).unwrap_or_else(|| "The modpack".into());
            notify("Modpack installed", &format!("{} is ready to play.", name));
            Ok(r)
        }
        "GET /api/snapshots" => Ok(list_snapshots(&server_of(&q.val("server")))),
        "POST /api/snapshots/take" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft first."); }
            take_snapshot(&s, &{ let l = str_or(g(b, "label")); if l.is_empty() { "manual".into() } else { l } })?;
            Ok(list_snapshots(&s))
        }
        "POST /api/snapshots/restore" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft before restoring a snapshot."); }
            restore_snapshot(&s, g(b, "file"))?;
            Ok(list_snapshots(&s))
        }
        "POST /api/snapshots/delete" => { let s = server_of(g(b, "server")); delete_snapshot(&s, g(b, "file"))?; Ok(list_snapshots(&s)) }
        "GET /api/presets" => Ok(presets_json()),
        "POST /api/profile/preset" => {
            let Some(s) = find_server(g(b, "server")) else { bail!("That profile no longer exists.") };
            if busy(&s) { bail!("Close Minecraft first, or it will overwrite the new settings."); }
            apply_preset(&gs(&s, "id"), g(b, "preset"))?;
            Ok(json!({ "servers": servers_json() }))
        }
        "GET /api/packs" => Ok(list_packs(&server_of(&q.val("server")), if q.get("type").as_deref() == Some("shader") { "shader" } else { "resourcepack" })),
        "POST /api/packs/order" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft first, or it will undo this change."); }
            set_resource_packs(&s, &arr(g(b, "order")).iter().map(js_string).collect::<Vec<_>>())?;
            Ok(list_packs(&s, "resourcepack"))
        }
        "POST /api/packs/shader" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft first, or it will undo this change."); }
            set_shader(&s, g(b, "name"))?;
            Ok(list_packs(&s, "shader"))
        }
        "POST /api/packs/delete" => {
            let s = server_of(g(b, "server"));
            let typ = if g(b, "type").as_str() == Some("shader") { "shader" } else { "resourcepack" };
            rm_rf(&instance_dir(&s).join(if typ == "shader" { "shaderpacks" } else { "resourcepacks" }).join(safe_name(g(b, "name"))?));
            Ok(list_packs(&s, typ))
        }
        "POST /api/profile/shortcut" => create_shortcut(&server_of(g(b, "server"))),
        "POST /api/autoplay" => {
            let Some(s) = find_server(g(b, "id")) else { bail!("That profile no longer exists.") };
            { let mut st = st(); st.settings.insert("selectedServer".into(), s["id"].clone()); st.save_settings()?; }
            broadcast(json!({ "type": "autoplay", "id": s["id"] }));
            Ok(json!({ "ok": true }))
        }
        "POST /api/profile/export" => export_profile(&server_of(g(b, "server"))),
        "GET /api/worlds" => Ok(list_worlds(&server_of(&q.val("server")))),
        "POST /api/worlds/backup" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft before backing up its worlds."); }
            let file = backup_world(&s, g(b, "world"))?;
            Ok(json!({ "file": file, "worlds": list_worlds(&s) }))
        }
        "POST /api/worlds/restore" => {
            let s = server_of(g(b, "server"));
            if busy(&s) { bail!("Close Minecraft before restoring a world."); }
            restore_world(&s, g(b, "file"))?;
            Ok(json!({ "worlds": list_worlds(&s) }))
        }
        "POST /api/worlds/delete-backup" => {
            let s = server_of(g(b, "server"));
            let f = safe_name(g(b, "file"))?;
            if !is_backup_name(&f) { bail!("That is not an Auroria world backup."); }
            rm_force(&backups_dir(&s).join(f));
            Ok(json!({ "worlds": list_worlds(&s) }))
        }
        "POST /api/worlds/open" => {
            let s = server_of(g(b, "server"));
            let d = if truthy(g(b, "backups")) { backups_dir(&s) } else { saves_dir(&s) };
            ensure_dir(&d)?;
            open_external(&path_str(&d));
            Ok(json!({ "ok": true }))
        }
        "GET /api/shots" => Ok(list_shots(&server_of(&q.val("server")))),
        "POST /api/shots/open" => {
            let s = server_of(g(b, "server"));
            let dir = instance_dir(&s).join("screenshots");
            if truthy(g(b, "file")) { let f = dir.join(safe_name(g(b, "file"))?); if crate::util::exists(&f) { open_external(&path_str(&f)); } } else { ensure_dir(&dir)?; open_external(&path_str(&dir)); }
            Ok(json!({ "ok": true }))
        }
        "POST /api/options/sync" => {
            let (from, to) = (find_server(g(b, "from")), find_server(g(b, "to")));
            let (Some(from), Some(to)) = (from, to) else { bail!("Pick another profile to copy from.") };
            if from["id"] == to["id"] { bail!("Pick another profile to copy from."); }
            if busy(&to) { bail!("Close Minecraft first, or it will overwrite the copied settings."); }
            sync_options(&from, &to, arr(g(b, "groups")))
        }
        "POST /api/profile/servers" => {
            let mut s = st();
            let id = g(b, "server").as_str().unwrap_or("").to_string();
            if s.find_server(&id).is_none() || !g(b, "server").is_string() { bail!("That profile no longer exists."); }
            let list: Vec<Value> = arr(g(b, "list")).iter().take(30).map(|x| (slice_chars(js_trim(&str_or(g(x, "name"))), 40), slice_chars(js_trim(&str_or(g(x, "address"))), 80)))
                .filter(|(_, a)| is_address(a)).map(|(n, a)| json!({ "name": if n.is_empty() { a.clone() } else { n }, "address": a })).collect();
            if let Some(e) = s.server_mut(&id) { e["serverList"] = Value::Array(list); }
            s.save_servers()?;
            Ok(json!({ "servers": s.servers() }))
        }
        "GET /api/update/check" => check_update(q.get("force").as_deref() == Some("1")),
        "POST /api/update/apply" => apply_update(),
        "POST /api/servers/duplicate" => {
            let Some(src) = find_server(g(b, "id")) else { bail!("That profile no longer exists.") };
            let mut s = st();
            let mut id = format!("{}-copy", gs(&src, "id"));
            while s.servers().iter().any(|x| g(x, "id").as_str() == Some(&id)) { id = format!("{}-{}", id, random_hex(2)); }
            let mut copy = obj(src.clone());
            for (k, v) in obj(json!({ "id": id, "name": slice_chars(&format!("{} (copy)", gs(&src, "name")), 48), "created": now_ms(), "lastPlayed": 0, "playMs": 0, "playDays": {} })) { copy.insert(k, v); }
            let copy = Value::Object(copy);
            s.servers_mut().push(copy.clone());
            drop(s);
            if crate::util::exists(&instance_dir(&src)) { copy_dir(&instance_dir(&src), &instance_dir(&copy), &[])?; }
            let s = st();
            s.save_servers()?;
            Ok(json!({ "servers": s.servers(), "id": id }))
        }
        "GET /api/servers/ping" => {
            let list = st().servers().clone();
            let out: Vec<Value> = std::thread::scope(|sc| {
                let hs: Vec<_> = list.iter().map(|s| sc.spawn(move || {
                    let mut o = obj(json!({ "id": s["id"] }));
                    let r = if truthy(g(s, "address")) { ping_server(&gs(s, "address"), 3000) } else { json!({ "online": null }) };
                    for (k, v) in obj(r) { o.insert(k, v); }
                    Value::Object(o)
                })).collect();
                hs.into_iter().map(|h| h.join().unwrap_or(Value::Null)).collect()
            });
            Ok(Value::Array(out))
        }
        "POST /api/launch" => {
            let sel = if truthy(g(b, "serverId")) { b["serverId"].clone() } else { st().setting("selectedServer") };
            let s = server_of(&sel);
            if busy(&s) { bail!("{} is already starting or running.", gs(&s, "name")); }
            let join = js_trim(&str_or(g(b, "join"))).to_string();
            if !join.is_empty() && !is_address(&join) { bail!("That server address is not valid."); }
            let acc = str_or(g(b, "account"));
            if !acc.is_empty() && !st().accounts.iter().any(|a| account_id(a) == acc) { bail!("That account is no longer signed in."); }
            // launch reports its own failures; never let one take the process down
            match begin_launch(&gs(&s, "id"), &acc) {
                Ok((server, chosen)) => { std::thread::spawn(move || run_game(server, join, chosen)); }
                Err(e) => log_line(&format!("launch rejected {}", e.msg)),
            }
            Ok(json!({ "ok": true }))
        }
        "POST /api/stop" => {
            let mut s = st();
            if let Some(gm) = s.games.get_mut(&str_or(g(b, "serverId"))) { if let Some(pid) = gm.pid { gm.user_stopped = true; kill_pid(pid); } }
            Ok(json!({ "ok": true }))
        }
        "GET /api/launch-check" => {
            let s = server_of(&q.val("server"));
            if s.is_null() || gs(&s, "loader") == "vanilla" { return Ok(json!({ "outdated": [], "problems": [] })); }
            let (problems, outdated) = std::thread::scope(|sc| {
                let a = sc.spawn(|| analyze_mods(&s));
                let (tx, rx) = std::sync::mpsc::channel();
                let s2 = s.clone();
                std::thread::spawn(move || { let _ = tx.send(mod_updates(&s2).unwrap_or(json!([]))); });
                let outdated = rx.recv_timeout(std::time::Duration::from_secs(7)).unwrap_or(json!([]));
                (a.join().unwrap_or_default(), outdated)
            });
            Ok(json!({ "problems": problems, "outdated": outdated }))
        }
        "GET /api/logs" => {
            let s = st();
            Ok(json!({ "games": Value::Object(s.games.values().filter(|g| !g.logs.is_empty()).map(|g| (g.server_id.clone(), json!(g.logs))).collect()) }))
        }
        "GET /api/mods" => Ok(Value::Array(list_mods(&server_of(&q.val("server")), q.get("fast").as_deref() != Some("1"))?)),
        "GET /api/mods/sig" => {
            let dir = mods_dir(&server_of(&q.val("server")));
            let mut names: Vec<String> = read_dir(&dir).unwrap_or_default().into_iter().map(|x| x.0).filter(|f| f.ends_with(".jar") || f.ends_with(".jar.disabled")).collect();
            names.sort();
            let parts: Vec<String> = names.iter().filter_map(|f| fs::metadata(dir.join(f)).ok().map(|m| format!("{}:{}:{}", f, m.len(), (mtime_ms(&m) + 0.5).floor()))).collect();
            Ok(json!(parts.join("|")))
        }
        "GET /api/mods/updates" => mod_updates(&server_of(&q.val("server"))),
        "GET /api/mods/search" => mods_search(q),
        "POST /api/mods/install" => {
            let s = server_of(g(b, "server"));
            let typ = g(b, "type").as_str().filter(|t| pack_type(t).is_some()).unwrap_or("mod").to_string();
            let before = if typ == "mod" { list_mods(&s, true)? } else { vec![] };
            let have = installed_ids(&before);
            let mut visited = Vec::new();
            install_mod_project(&s, &str_or(g(b, "projectId")), &mut visited, &typ, &have)?;
            if typ == "mod" { for pid in &visited { drop_replaced_jars(&s, pid, &before); } }
            let mods = list_mods(&s, true)?;
            if truthy(g(b, "withDeps")) { return Ok(json!({ "mods": mods, "deps": visited.len().saturating_sub(1) })); }
            Ok(Value::Array(mods))
        }
        // A mod id from fabric.mod.json is usually the Modrinth slug; otherwise take the best search hit for this version and loader.
        "POST /api/mods/install-dep" => {
            let s = server_of(g(b, "server"));
            let dep = str_or(g(b, "dep"));
            if dep.is_empty() || dep.len() > 64 || !dep.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) { bail!("Unknown mod."); }
            let mut project: Option<Value> = None;
            if regex_lite::Regex::new(r"^fabric(-api)?($|-)").unwrap().is_match(&dep) { project = Some(get_json(&format!("{}/project/P7dR8mSH", MR))?); }
            if project.is_none() { project = get_json(&format!("{}/project/{}", MR, enc_uri(&dep))).ok(); }
            if project.as_ref().map_or(true, |p| gs(p, "project_type") != "mod") {
                let facets = json!([["project_type:mod"], [format!("versions:{}", gs(&s, "version"))], mod_loaders(&s).iter().map(|l| format!("categories:{}", l)).collect::<Vec<_>>()]);
                let r = get_json(&format!("{}/search?query={}&facets={}&limit=5", MR, enc_uri(&dep.replace(['-', '_'], " ")), enc_uri(&serde_json::to_string(&facets)?)))?;
                let hits = arr(&r["hits"]);
                let flat = dep.replace(['-', '_'], "");
                let hit = hits.iter().find(|h| gs(h, "slug") == dep || gs(h, "slug").replace('-', "") == flat).or_else(|| hits.first());
                let Some(hit) = hit else { bail!("Could not find \"{}\" on Modrinth for Minecraft {}. Look for it under Browse.", dep, gs(&s, "version")) };
                project = Some(json!({ "id": hit["project_id"], "title": hit["title"] }));
            }
            let project = project.unwrap();
            let before = list_mods(&s, true)?;
            let have = installed_ids(&before);
            let mut visited = Vec::new();
            install_mod_project(&s, &gs(&project, "id"), &mut visited, "mod", &have)?;
            for pid in &visited { drop_replaced_jars(&s, pid, &before); }
            Ok(json!({ "title": project["title"], "mods": list_mods(&s, true)? }))
        }
        "GET /api/mods/dependents" => mod_dependents(&server_of(&q.val("server")), &basename(&q.get("file").unwrap_or_default())),
        "GET /api/java" => {
            let s = server_of(&q.val("server"));
            let ver = gs(&s, "version");
            let (list, base) = std::thread::scope(|sc| {
                let b = sc.spawn(|| load_vanilla(&ver).ok());
                (detect_javas(), b.join().unwrap_or(None))
            });
            let required = match base.as_ref().filter(|b| truthy(g(b, "javaVersion"))) { Some(b) => b["javaVersion"]["majorVersion"].clone(), None => json!(if cmp_ver(&ver, "1.17") < 0 { 8 } else { 17 }) };
            Ok(json!({ "list": list, "required": required, "current": gs(&s, "javaPath") }))
        }
        "POST /api/mods/toggle" => {
            let s = server_of(g(b, "server"));
            let dir = mods_dir(&s);
            let f = basename(&js_string(g(b, "file")));
            let to = match f.strip_suffix(".disabled") { Some(x) => x.to_string(), None => format!("{}.disabled", f) };
            fs::rename(dir.join(&f), dir.join(&to))?;
            Ok(Value::Array(list_mods(&s, true)?))
        }
        "POST /api/mods/delete" => {
            let s = server_of(g(b, "server"));
            rm_force(&mods_dir(&s).join(basename(&js_string(g(b, "file")))));
            Ok(Value::Array(list_mods(&s, !truthy(g(b, "fast")))?))
        }
        "POST /api/mods/update" => {
            let s = server_of(g(b, "server"));
            let before = list_mods(&s, true)?;
            let ups = arr(g(b, "updates"));
            if !ups.is_empty() { if let Err(e) = take_snapshot(&s, "before-update") { log_line(&format!("snapshot failed {}", e.msg)); } }
            for u in ups {
                let pid = str_or(g(u, "projectId"));
                if !pid.is_empty() { install_mod_project(&s, &pid, &mut vec![], "mod", &HashSet::new())?; drop_replaced_jars(&s, &pid, &before); }
            }
            Ok(Value::Array(list_mods(&s, true)?))
        }
        "GET /api/skins" => Ok(json!({ "profile": public_profile(), "library": skin_library() })),
        "POST /api/skins/upload" => {
            let data = str_or(g(b, "data"));
            let png = b64_decode(data.strip_prefix("data:image/png;base64,").unwrap_or(&data));
            if png.get(1..4) != Some(b"PNG") { bail!("Skins must be PNG files."); }
            let rd = |o: usize| png.get(o..o + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0);
            let (w, h) = (rd(16), rd(20));
            if w != 64 || (h != 64 && h != 32) { bail!("Skins must be 64×64 or 64×32 pixels."); }
            let id = random_hex(6);
            ensure_dir(&p().skins)?;
            fs::write(p().skins.join(format!("{}.png", id)), &png)?;
            let mut lib = skin_library();
            let name = { let n = str_or(g(b, "name")); if n.is_empty() { "Skin".to_string() } else { slice_chars(&n, 40) } };
            lib.push(json!({ "id": id, "name": name, "variant": if g(b, "variant").as_str() == Some("SLIM") { "SLIM" } else { "CLASSIC" } }));
            save_skin_library(&lib)?;
            Ok(Value::Array(lib))
        }
        "POST /api/skins/delete" => {
            let id = g(b, "id").clone();
            let lib: Vec<Value> = skin_library().into_iter().filter(|s| g(s, "id") != &id).collect();
            rm_force(&p().skins.join(format!("{}.png", basename(&js_string(&id)))));
            save_skin_library(&lib)?;
            Ok(Value::Array(lib))
        }
        "POST /api/skins/apply" => apply_skin(&js_string(g(b, "id"))),
        "POST /api/capes/apply" => apply_cape(if truthy(g(b, "capeId")) { Some(js_string(&b["capeId"])) } else { None }),
        "POST /api/open" => {
            let s = server_of(&st().setting("selectedServer"));
            let what = str_or(g(b, "what"));
            let open_dir = |d: &Path| -> R<()> { ensure_dir(d)?; open_external(&path_str(d)); Ok(()) };
            match what.as_str() {
                "mods" => open_dir(&mods_dir(&s))?,
                "resourcepacks" | "shaderpacks" => open_dir(&instance_dir(&s).join(&what))?,
                "game" => open_dir(&instance_dir(&s))?,
                "profile" => { if let Some(t) = find_server(g(b, "id")) { open_dir(&instance_dir(&t))?; } }
                "data" => open_external(&path_str(&p().data)),
                "url" => { let u = str_or(g(b, "url")); if u.starts_with("https://") { open_external(&u); } }
                _ => {}
            }
            Ok(json!({ "ok": true }))
        }
        _ => bail!("Unknown endpoint"),
    }
}

fn servers_save(b: &Value) -> R<Value> {
    let name = slice_chars(js_trim(&str_or(g(b, "name"))), 48);
    if name.is_empty() { bail!("Give the server a name."); }
    let version = js_trim(&str_or(g(b, "version"))).to_string();
    if !is_mc_version(&version) { bail!("Pick a Minecraft version, for example 1.20.1."); }
    let address = js_trim(&str_or(g(b, "address"))).to_string();
    if !address.is_empty() && !is_address(&address) { bail!("The address can only contain letters, numbers, dots, dashes and a :port."); }
    let loader = g(b, "loader").as_str().filter(|l| LOADERS.contains(l)).unwrap_or("vanilla").to_string();
    let mods: Vec<String> = if loader != "vanilla" {
        str_or(g(b, "mods")).split(|c: char| c.is_whitespace() || c == ',').map(|x| x.trim().to_lowercase()).filter(|x| (2..=64).contains(&x.len()) && x.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')).take(50).collect()
    } else { vec![] };
    let tag = slice_chars(&js_trim(&str_or(g(b, "tag"))).to_lowercase(), 20);
    let loader_version = if loader == "vanilla" { String::new() } else { slice_chars(js_trim(&str_or(g(b, "loaderVersion"))), 40) };
    let java_path_in = g(b, "javaPath");
    let mut s = st();
    let mut list = s.servers().clone();
    let idx = list.iter().position(|x| g(x, "id") == g(b, "id"));
    let idx = match idx {
        Some(i) => i,
        None => {
            let mut id = slug_id(&name, "server");
            while list.iter().any(|x| g(x, "id").as_str() == Some(&id)) { id = format!("{}-{}", id, random_hex(2)); }
            list.push(json!({ "id": id }));
            list.len() - 1
        }
    };
    let entry = list[idx].clone();
    let color = if is_hex_color(&str_or(g(b, "color"))) { b["color"].clone() } else if truthy(g(&entry, "color")) { entry["color"].clone() } else { json!("#f07f2a") };
    let icon = match b.get("icon") {
        None => if truthy(g(&entry, "icon")) { entry["icon"].clone() } else { json!("") },
        Some(v) => { let i = str_or(v); let ok = i.strip_prefix("data:image/png;base64,").map_or(false, |r| !r.is_empty() && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))) && i.len() <= 200000; if ok { json!(i) } else { json!("") } }
    };
    let ram = if truthy(g(b, "ramGB")) { num_or(g(b, "ramGB"), 0.0).max(1.0).min(32.0) } else { 0.0 };
    let java_path = match java_path_in { Value::Null if b.get("javaPath").is_none() => gs(&entry, "javaPath"), v => js_trim(&str_or(v)).to_string() };
    if !java_path.is_empty() {
        let l = java_path.to_lowercase();
        let name_ok = ["java", "javaw", "java.exe", "javaw.exe"].iter().any(|n| l == *n || l.ends_with(&format!("\\{}", n)) || l.ends_with(&format!("/{}", n)));
        if !name_ok || !crate::util::exists(Path::new(&java_path)) { bail!("That Java was not found. Pick one from the list, or leave it on Automatic."); }
    }
    let mut e = obj(entry.clone());
    e.insert("javaPath".into(), json!(java_path));
    if let Some(a) = b.get("accountId") { let ok = s.accounts.iter().any(|x| json!(account_id(x)) == *a); e.insert("accountId".into(), if ok { a.clone() } else { json!("") }); }
    if truthy(g(&entry, "version")) && (gs(&entry, "version") != version || gs(&entry, "loader") != loader || gs(&entry, "loaderVersion") != loader_version) { e.insert("changed".into(), json!(now_ms())); }
    let created = if truthy(g(&entry, "created")) { entry["created"].clone() } else { json!(now_ms()) };
    for (k, v) in obj(json!({
        "client": true, "name": name, "address": address, "version": version, "loader": loader, "loaderVersion": loader_version, "mods": mods, "color": color, "icon": icon,
        "ramGB": num_val(ram), "description": slice_chars(js_trim(&str_or(g(b, "description"))), 120), "tags": if tag.is_empty() { json!([]) } else { json!([tag]) },
        "badge": if truthy(g(&entry, "badge")) { entry["badge"].clone() } else { json!("") }, "created": created,
    })) { e.insert(k, v); }
    let id = e["id"].clone();
    list[idx] = Value::Object(e);
    *s.servers_mut() = list;
    s.save_servers()?;
    Ok(json!({ "servers": s.servers(), "id": id }))
}

fn mods_search(q: &Query) -> R<Value> {
    let s = server_of(&q.val("server"));
    let t = q.get("type").unwrap_or_default();
    let typ = if t == "modpack" { "modpack".to_string() } else if pack_type(&t).is_some() { t } else { "mod".into() };
    // Modpacks bring their own version and loader and become a new profile, so they are not filtered by this one.
    let mc = q.get("mc").filter(|m| is_mc_version(m)).unwrap_or_default();
    let mut facets: Vec<Value> = if typ == "modpack" {
        let mut f = vec![json!(["project_type:modpack"])];
        if !mc.is_empty() { f.push(json!([format!("versions:{}", mc)])); }
        f
    } else { vec![json!([format!("versions:{}", gs(&s, "version"))]), json!([format!("project_type:{}", typ)])] };
    if typ == "mod" { facets.push(json!(mod_loaders(&s).iter().map(|l| format!("categories:{}", l)).collect::<Vec<_>>())); }
    let sort = q.get("sort").filter(|x| ["relevance", "downloads", "newest", "updated", "follows"].contains(&x.as_str())).unwrap_or_else(|| "relevance".into());
    let offset = num_or(&q.val("offset"), 0.0).max(0.0);
    let r = get_json(&format!("{}/search?query={}&facets={}&index={}&offset={}&limit=20", MR, enc_uri(&q.get("q").unwrap_or_default()), enc_uri(&serde_json::to_string(&facets)?), sort, fmt_num(offset)))?;
    let idx = mod_index(&s);
    Ok(json!({
        "total": r["total_hits"], "offset": num_val(offset),
        "hits": arr(&r["hits"]).iter().map(|h| {
            let cats = if truthy(g(h, "display_categories")) { &h["display_categories"] } else { &h["categories"] };
            json!({ "projectId": h["project_id"], "slug": h["slug"], "title": h["title"], "description": h["description"], "author": h["author"], "icon": h["icon_url"],
                "downloads": h["downloads"], "follows": h["follows"], "categories": arr(cats).iter().take(3).cloned().collect::<Vec<_>>(), "installed": idx.contains_key(&gs(h, "project_id")), "type": typ })
        }).collect::<Vec<_>>(),
    }))
}
