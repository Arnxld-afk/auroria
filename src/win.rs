// Windows side: the WebView2 window host (and the Edge fallback), lifecycle, notifications, shortcuts, Discord presence,
// self-update, the server list ping, and the few Win32 calls the launcher needs.
use crate::game::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS};
use crate::net::*;
use crate::state::*;
use crate::util::*;
use crate::{assets, zipx};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const HOST_CS: &str = include_str!("host/host.cs");
const HOST_PS: &str = include_str!("host/host.ps1");
const WIN_PS: &str = include_str!("host/edge-helper.ps1");
const START_LINK_PS: &str = include_str!("host/start-link.ps1");

/// Packaged means the real Auroria.exe. AURORIA_DEV makes a test build behave like the unpackaged Node script:
/// no self-update, shortcuts or notifications, which would touch the owner's Start menu and desktop.
pub fn is_packaged() -> bool { std::env::var_os("AURORIA_DEV").is_none() }
pub fn no_window() -> bool { std::env::var_os("AURORIA_NO_WINDOW").map_or(false, |v| !v.is_empty()) }
fn exe_path() -> String { std::env::current_exe().map(|p| path_str(&p)).unwrap_or_default() }

// ---------- Win32 ----------
#[repr(C)]
struct MemStatus { len: u32, load: u32, total_phys: u64, avail_phys: u64, total_page: u64, avail_page: u64, total_virt: u64, avail_virt: u64, avail_ext: u64 }
#[repr(C)]
struct OsVersion { size: u32, major: u32, minor: u32, build: u32, platform: u32, csd: [u16; 128] }
#[repr(C)]
struct DnsSrv { target: *mut u16, priority: u16, weight: u16, port: u16, pad: u16 }
#[repr(C)]
struct DnsRecord { next: *mut DnsRecord, name: *mut u16, typ: u16, data_len: u16, flags: u32, ttl: u32, reserved: u32, srv: DnsSrv }
#[link(name = "kernel32")]
extern "system" {
    fn GlobalMemoryStatusEx(p: *mut MemStatus) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn TerminateProcess(h: isize, code: u32) -> i32;
    fn CloseHandle(h: isize) -> i32;
    fn WaitForSingleObject(h: isize, ms: u32) -> u32;
    fn LoadLibraryW(name: *const u16) -> isize;
    fn GetProcAddress(h: isize, name: *const u8) -> *const c_void;
    fn PeekNamedPipe(h: *mut c_void, buf: *mut u8, size: u32, read: *mut u32, avail: *mut u32, left: *mut u32) -> i32;
}
#[link(name = "ntdll")]
extern "system" { fn RtlGetVersion(info: *mut OsVersion) -> i32; }
#[link(name = "dnsapi")]
extern "system" {
    fn DnsQuery_W(name: *const u16, typ: u16, opts: u32, extra: *mut c_void, results: *mut *mut DnsRecord, reserved: *mut c_void) -> i32;
    fn DnsFree(p: *mut c_void, t: i32);
}
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
unsafe fn from_wide(p: *const u16) -> String {
    if p.is_null() { return String::new(); }
    let mut n = 0;
    while *p.add(n) != 0 { n += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

pub fn total_mem() -> u64 {
    let mut m = MemStatus { len: std::mem::size_of::<MemStatus>() as u32, load: 0, total_phys: 0, avail_phys: 0, total_page: 0, avail_page: 0, total_virt: 0, avail_virt: 0, avail_ext: 0 };
    unsafe { GlobalMemoryStatusEx(&mut m) };
    m.total_phys
}
/// os.release(): "10.0.26200".
pub fn os_release() -> String {
    let mut v = OsVersion { size: std::mem::size_of::<OsVersion>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
    unsafe { RtlGetVersion(&mut v) };
    format!("{}.{}.{}", v.major, v.minor, v.build)
}
pub fn kill_pid(pid: u32) {
    unsafe {
        let h = OpenProcess(0x0001, 0, pid);
        if h != 0 { TerminateProcess(h, 1); CloseHandle(h); }
    }
}
/// Waits up to `ms` for a process to exit.
pub fn wait_pid(pid: u32, ms: u32) {
    unsafe {
        let h = OpenProcess(0x0010_0000, 0, pid);
        if h != 0 { WaitForSingleObject(h, ms); CloseHandle(h); }
    }
}
fn resolve_srv(name: &str) -> Option<(String, u16)> {
    unsafe {
        let mut rec: *mut DnsRecord = std::ptr::null_mut();
        if DnsQuery_W(wide(name).as_ptr(), 0x21, 0, std::ptr::null_mut(), &mut rec, std::ptr::null_mut()) != 0 || rec.is_null() { return None; }
        let mut cur = rec;
        let mut out = None;
        while !cur.is_null() {
            if (*cur).typ == 0x21 { out = Some((from_wide((*cur).srv.target), (*cur).srv.port)); break; }
            cur = (*cur).next;
        }
        DnsFree(rec as *mut c_void, 1);
        out
    }
}

/// Reads rows from a SQLite file with Windows' own winsqlite3.dll, read-only. Each row has `cols` text columns (None for NULL).
pub fn sqlite_rows(file: &Path, sql: &str, cols: i32) -> R<Vec<Vec<Option<String>>>> {
    type Open = unsafe extern "system" fn(*const u8, *mut *mut c_void, i32, *const u8) -> i32;
    type Prepare = unsafe extern "system" fn(*mut c_void, *const u8, i32, *mut *mut c_void, *mut *const u8) -> i32;
    type Step = unsafe extern "system" fn(*mut c_void) -> i32;
    type Text = unsafe extern "system" fn(*mut c_void, i32) -> *const u8;
    type One = unsafe extern "system" fn(*mut c_void) -> i32;
    type Msg = unsafe extern "system" fn(*mut c_void) -> *const u8;
    unsafe {
        let lib = LoadLibraryW(wide("winsqlite3.dll").as_ptr());
        if lib == 0 { bail!("winsqlite3.dll is not available"); }
        let f = |n: &str| { let c = format!("{}\0", n); GetProcAddress(lib, c.as_ptr()) };
        let syms = [f("sqlite3_open_v2"), f("sqlite3_prepare_v2"), f("sqlite3_step"), f("sqlite3_column_text"), f("sqlite3_finalize"), f("sqlite3_close"), f("sqlite3_errmsg")];
        if syms.iter().any(|p| p.is_null()) { bail!("winsqlite3.dll is missing functions"); }
        let open: Open = std::mem::transmute(syms[0]);
        let prepare: Prepare = std::mem::transmute(syms[1]);
        let step: Step = std::mem::transmute(syms[2]);
        let text: Text = std::mem::transmute(syms[3]);
        let finalize: One = std::mem::transmute(syms[4]);
        let close: One = std::mem::transmute(syms[5]);
        let errmsg: Msg = std::mem::transmute(syms[6]);
        let cstr = |p: *const u8| -> Option<String> {
            if p.is_null() { return None; }
            let mut n = 0;
            while *p.add(n) != 0 { n += 1; }
            Some(String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned())
        };
        let mut db: *mut c_void = std::ptr::null_mut();
        let fname = format!("{}\0", path_str(file));
        if open(fname.as_ptr(), &mut db, 1, std::ptr::null()) != 0 { let m = cstr(errmsg(db)).unwrap_or_default(); close(db); bail!("{}", m); }
        let mut stmt: *mut c_void = std::ptr::null_mut();
        let q = format!("{}\0", sql);
        if prepare(db, q.as_ptr(), -1, &mut stmt, std::ptr::null_mut()) != 0 { let m = cstr(errmsg(db)).unwrap_or_default(); close(db); bail!("{}", m); }
        let mut rows = Vec::new();
        loop {
            let rc = step(stmt);
            if rc != 100 { if rc != 101 { let m = cstr(errmsg(db)).unwrap_or_default(); finalize(stmt); close(db); bail!("{}", m); } break; }
            rows.push((0..cols).map(|i| cstr(text(stmt, i))).collect());
        }
        finalize(stmt);
        close(db);
        Ok(rows)
    }
}

// ---------- OS helpers ----------
pub fn open_external(target: &str) {
    let arg = format!("/c start \"\" \"{}\"", target.replace('"', ""));
    let _ = Command::new("cmd").raw_arg(arg).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS).spawn();
}
pub fn reveal(file: &Path) {
    let _ = Command::new("explorer.exe").raw_arg(format!("/select,{}", path_str(file))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS).spawn();
}
pub fn ps_run(script: &str, env: &[(&str, &str)]) -> R<()> {
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    for (k, v) in env { c.env(k, v); }
    let out = c.output()?;
    if out.status.success() { return Ok(()); }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() { bail!("PowerShell exited with {}", out.status.code().unwrap_or(-1)); }
    Err(Error::new(err))
}

// ---------- desktop shortcut per profile: Auroria.exe --play <id> ----------
pub fn create_shortcut(s: &Value) -> R<Value> {
    if !is_packaged() { bail!("Shortcuts work from Auroria.exe on Windows."); }
    let base = safe_file_name(&gs(s, "name"));
    let name = format!("{} - Auroria", if base.is_empty() { "Minecraft" } else { &base });
    ps_run("$ErrorActionPreference=\"Stop\"; $d=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory, [Environment+SpecialFolderOption]::Create); if (-not $d) { throw \"Windows did not report a Desktop folder.\" }; $l=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ($env:A_NAME + \".lnk\"))); $l.TargetPath=$env:A_EXE; $l.Arguments=\"--play \" + $env:A_ID; $l.IconLocation=$env:A_EXE + \",0\"; $l.WorkingDirectory=(Split-Path $env:A_EXE); $l.Description=\"Play \" + $env:A_NAME; $l.Save()",
        &[("A_NAME", &name), ("A_EXE", &exe_path()), ("A_ID", &gs(s, "id"))])?;
    Ok(json!({ "name": name }))
}

// ---------- Windows notifications ----------
// Windows shows toasts only for apps it knows: a Start-menu shortcut that carries the app ID. Auroria keeps one (it also puts Auroria in Start).
const AUMID: &str = "Auroria.Launcher";
static TOAST: Mutex<bool> = Mutex::new(false);
pub fn notify(title: &str, body: &str) {
    if !is_packaged() || st().settings.get("notifications") == Some(&json!(false)) { return; }
    let x = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;");
    let xml = format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", x(title), x(body));
    std::thread::spawn(move || {
        {
            let mut ready = TOAST.lock().unwrap_or_else(|e| e.into_inner());
            if !*ready {
                if let Err(e) = ps_run(START_LINK_PS, &[("A_EXE", &exe_path()), ("A_ID", AUMID)]) { log_line(&format!("start menu link failed {}", e.msg)); }
                *ready = true;
            }
        }
        let script = format!("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; $x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:A_XML); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\"{}\").Show([Windows.UI.Notifications.ToastNotification]::new($x))", AUMID);
        if let Err(e) = ps_run(&script, &[("A_XML", &xml)]) { log_line(&format!("toast failed {}", e.msg)); }
    });
}

// ---------- Discord Rich Presence over Discord's local IPC pipe ----------
const DISCORD_APP_ID: &str = "1566706607197266031";
static DISCORD: Mutex<Option<fs::File>> = Mutex::new(None);
fn discord_frame(op: i32, v: &Value) -> Vec<u8> {
    let d = serde_json::to_vec(v).unwrap_or_default();
    let mut f = Vec::with_capacity(8 + d.len());
    f.extend_from_slice(&op.to_le_bytes());
    f.extend_from_slice(&(d.len() as i32).to_le_bytes());
    f.extend(d);
    f
}
/// Bytes waiting in the pipe, or None when Discord closed it.
fn pipe_avail(f: &fs::File) -> Option<u32> {
    let mut avail = 0u32;
    let ok = unsafe { PeekNamedPipe(f.as_raw_handle(), std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) };
    if ok == 0 { None } else { Some(avail) }
}
fn discord_connect(app_id: &str) -> Option<fs::File> {
    for i in 0..10 {
        let Ok(mut f) = fs::OpenOptions::new().read(true).write(true).open(format!(r"\\?\pipe\discord-ipc-{}", i)) else { continue };
        // Discord drops commands sent before it answers the handshake with READY.
        if f.write_all(&discord_frame(0, &json!({ "v": 1, "client_id": app_id }))).is_err() { return None; }
        let deadline = now_ms() + 5000;
        let mut ready = false;
        while now_ms() < deadline {
            match pipe_avail(&f) {
                None => break,
                Some(0) => sleep_ms(25),
                Some(n) => {
                    let mut buf = vec![0u8; n as usize];
                    let got = f.read(&mut buf).unwrap_or(0);
                    let d = &buf[..got];
                    ready = d.len() > 8 && i32::from_le_bytes([d[0], d[1], d[2], d[3]]) == 1 && String::from_utf8_lossy(&d[8..]).contains("\"READY\"");
                    break;
                }
            }
        }
        return if ready { Some(f) } else { None };
    }
    None
}
const LOADER_LABEL: &[(&str, &str)] = &[("fabric", "Fabric"), ("quilt", "Quilt"), ("forge", "Forge"), ("neoforge", "NeoForge")];
pub fn discord_set(server: Option<Value>, started_at: i64, join: String) {
    std::thread::spawn(move || {
        let (app_id, enabled, accent) = {
            let s = st();
            let id = s.config.get("discordClientId").map(str_or).filter(|x| !x.is_empty()).unwrap_or_else(|| DISCORD_APP_ID.into());
            (id, s.settings.get("discordPresence") != Some(&json!(false)), s.settings.get("accent").map(str_or).unwrap_or_default())
        };
        if app_id.is_empty() || !enabled { return; }
        let mut guard = DISCORD.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().map_or(false, |f| pipe_avail(f).is_none()) { *guard = None; }
        if guard.is_none() { *guard = discord_connect(&app_id); }
        let Some(f) = guard.as_mut() else { return };
        // Discord answers every command; read the answers so the pipe never fills.
        if let Some(n) = pipe_avail(f) { if n > 0 { let mut b = vec![0u8; n as usize]; let _ = f.read(&mut b); } }
        let activity = match &server {
            Some(sv) => {
                let loader = gs(sv, "loader");
                let label = LOADER_LABEL.iter().find(|x| x.0 == loader).map(|x| x.1.to_string()).unwrap_or_else(|| loader.clone());
                let state = if !join.is_empty() { format!("On {}", join) } else { format!("Minecraft {}{}", gs(sv, "version"), if !loader.is_empty() && loader != "vanilla" { format!(" · {}", label) } else { String::new() }) };
                json!({
                    "details": slice_chars(&gs(sv, "name"), 120), "state": slice_chars(&state, 120),
                    "timestamps": { "start": started_at }, "assets": { "large_image": format!("https://arnxld-afk.github.io/auroria/assets/flame/{}.png", theme_flame(&accent)), "large_text": "Auroria Launcher" },
                    "buttons": [{ "label": "Get Auroria", "url": "https://arnxld-afk.github.io/auroria/" }],
                })
            }
            None => Value::Null,
        };
        if f.write_all(&discord_frame(1, &json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": uuid() }))).is_err() { *guard = None; return; }
        if server.is_none() { let f = guard.take(); drop(guard); sleep_ms(500); drop(f); }
    });
}
// Discord shows the flame in your theme colour. The site hosts one per preset; a custom colour uses the preset closest in hue.
const FLAME_PRESETS: &[&str] = &["f07f2a", "e5484d", "f5b82e", "5fb34a", "2ec4b6", "4a8fe0", "9b6cf0", "e85d9e"];
pub fn is_hex_color(s: &str) -> bool { s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit()) }
fn theme_flame(accent: &str) -> String {
    let hex = if is_hex_color(accent) { accent[1..].to_lowercase() } else { "f07f2a".into() };
    if FLAME_PRESETS.contains(&hex.as_str()) { return hex; }
    let hue = |h: &str| -> f64 {
        let c: Vec<f64> = (0..3).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0) as f64 / 255.0).collect();
        let (r, g, b) = (c[0], c[1], c[2]);
        let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
        if mx == mn { return 0.0; }
        let d = mx - mn;
        let x = if mx == r { ((g - b) / d) % 6.0 } else if mx == g { (b - r) / d + 2.0 } else { (r - g) / d + 4.0 };
        (x * 60.0 + 360.0) % 360.0
    };
    let dist = |a: f64, b: f64| (a - b).abs().min(360.0 - (a - b).abs());
    let target = hue(&hex);
    let mut best = "f07f2a";
    for p in FLAME_PRESETS { if dist(hue(p), target) < dist(hue(best), target) { best = p; } }
    best.to_string()
}

// ---------- auto-update from GitHub Releases ----------
const UPDATE_REPO: &str = "Arnxld-afk/auroria";
static UPDATE: Mutex<Option<(i64, Value, Value)>> = Mutex::new(None);
static NOTIFIED: Mutex<String> = Mutex::new(String::new());
pub fn check_update(force: bool) -> R<Value> {
    if !force { if let Some((at, info, _)) = UPDATE.lock().unwrap().as_ref() { if now_ms() - at < 3_600_000 { return Ok(info.clone()); } } }
    let rel = get_json_h(&format!("https://api.github.com/repos/{}/releases/latest", UPDATE_REPO), &[("Accept", "application/vnd.github+json")])?;
    let tag = str_or(g(&rel, "tag_name"));
    let latest = tag.strip_prefix('v').unwrap_or(&tag).to_string();
    let exe = arr(g(&rel, "assets")).iter().find(|a| gs(a, "name").eq_ignore_ascii_case("Auroria.exe")).cloned();
    let info = json!({
        "current": VERSION, "latest": latest, "available": exe.is_some() && cmp_ver(&latest, VERSION) > 0, "notes": slice_chars(&str_or(g(&rel, "body")), 2000),
        "size": exe.as_ref().map(|e| e["size"].clone()).unwrap_or(json!(0)), "canApply": is_packaged(), "url": g(&rel, "html_url"),
    });
    *UPDATE.lock().unwrap() = Some((now_ms(), info.clone(), exe.unwrap_or(Value::Null)));
    if truthy(&info["available"]) {
        let mut n = NOTIFIED.lock().unwrap();
        if *n != latest { *n = latest.clone(); notify(&format!("Auroria {} is ready", latest), "Open the launcher and press Update now."); }
    }
    Ok(info)
}
pub fn apply_update() -> R<Value> {
    let info = check_update(true)?;
    let exe = UPDATE.lock().unwrap().as_ref().map(|x| x.2.clone()).unwrap_or(Value::Null);
    if !truthy(&info["available"]) || !truthy(&exe) { bail!("Auroria is already up to date."); }
    if !truthy(&info["canApply"]) { bail!("Updating in place only works from Auroria.exe. Download the new version from GitHub."); }
    if st().any_running() { bail!("Close Minecraft before updating."); }
    let digest = gs(&exe, "digest");
    let want = digest.strip_prefix("sha256:").filter(|h| h.len() == 64 && h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    let Some(want) = want else { bail!("The release has no checksum, so Auroria will not install it automatically. Download it from GitHub instead.") };
    set_progress("Downloading update", 0, 1);
    let res = get_bytes(&gs(&exe, "browser_download_url"), None)?;
    if !res.ok() { bail!("Update download failed (HTTP {}).", res.status); }
    if sha256_hex(&res.body) != want { bail!("The update download did not match its checksum, so it was not installed."); }
    let me = std::env::current_exe()?;
    let fresh = PathBuf::from(format!("{}.new", path_str(&me)));
    let old = PathBuf::from(format!("{}.old", path_str(&me)));
    fs::write(&fresh, &res.body)?;
    rm_force(&old);
    fs::rename(&me, &old)?; // Windows lets a running exe be renamed, not overwritten
    if let Err(e) = fs::rename(&fresh, &me) { let _ = fs::rename(&old, &me); bail!("Could not put the update in place: {}", io_msg(&e)); }
    log_line(&format!("updated to {}", gs(&info, "latest")));
    std::thread::spawn(move || {
        sleep_ms(300);
        let _ = Command::new(&me).env("AURORIA_WAIT_PID", std::process::id().to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn();
        broadcast(json!({ "type": "quit" }));
        sleep_ms(400);
        shutdown();
    });
    Ok(json!({ "ok": true, "version": gs(&info, "latest") }))
}

// ---------- server list ping (Minecraft SLP) ----------
fn varint(mut n: u32, out: &mut Vec<u8>) { loop { let mut t = (n & 0x7f) as u8; n >>= 7; if n != 0 { t |= 0x80; } out.push(t); if n == 0 { break; } } }
fn packet(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    varint(id, &mut body);
    body.extend_from_slice(payload);
    let mut out = Vec::new();
    varint(body.len() as u32, &mut out);
    out.extend(body);
    out
}
fn read_varint(buf: &[u8], off: &mut usize) -> Option<usize> {
    let (mut n, mut s) = (0usize, 0);
    loop {
        let b = *buf.get(*off)?;
        *off += 1;
        n |= ((b & 0x7f) as usize) << s;
        s += 7;
        if b & 0x80 == 0 || s > 35 { return Some(n); }
    }
}
fn flat_text(c: &Value) -> String {
    match c { Value::String(s) => s.clone(), Value::Null => String::new(), Value::Bool(false) => String::new(), _ => format!("{}{}", str_or(g(c, "text")), arr(g(c, "extra")).iter().map(flat_text).collect::<String>()) }
}
pub fn ping_server(address: &str, timeout_ms: u64) -> Value {
    use std::net::{TcpStream, ToSocketAddrs};
    let offline = json!({ "online": false });
    let (mut host, mut port) = crate::game::split_address(address);
    if let Some((h, p)) = resolve_srv(&format!("_minecraft._tcp.{}", host)) { host = h; port = p; }
    let start = now_ms();
    let deadline = start + timeout_ms as i64;
    let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else { return offline };
    let mut sock = None;
    for a in addrs {
        let left = deadline - now_ms();
        if left <= 0 { break; }
        if let Ok(s) = TcpStream::connect_timeout(&a, Duration::from_millis(left as u64)) { sock = Some(s); break; }
    }
    let Some(mut sock) = sock else { return offline };
    let mut hs = Vec::new();
    varint(767, &mut hs);
    varint(host.len() as u32, &mut hs);
    hs.extend_from_slice(host.as_bytes());
    hs.extend_from_slice(&port.to_be_bytes());
    varint(1, &mut hs);
    if sock.write_all(&packet(0, &hs)).is_err() || sock.write_all(&packet(0, &[])).is_err() { return offline; }
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let left = deadline - now_ms();
        if left <= 0 { return offline; }
        let _ = sock.set_read_timeout(Some(Duration::from_millis(left as u64)));
        let n = match sock.read(&mut chunk) { Ok(0) | Err(_) => return offline, Ok(n) => n };
        buf.extend_from_slice(&chunk[..n]);
        let mut off = 0usize;
        let Some(len) = read_varint(&buf, &mut off) else { continue };
        if buf.len() - off < len { continue; }
        let (Some(_), Some(sl)) = (read_varint(&buf, &mut off), read_varint(&buf, &mut off)) else { return offline };
        let Some(raw) = buf.get(off..off + sl) else { return offline };
        let Ok(j) = serde_json::from_slice::<Value>(raw) else { return offline };
        let motd: String = flat_text(g(&j, "description"));
        let mut clean = String::new();
        let mut it = motd.chars().peekable();
        while let Some(c) = it.next() { if c == '§' { it.next(); } else { clean.push(c); } }
        return json!({
            "online": true, "players": num_or(g(&j["players"], "online"), 0.0) as i64, "max": num_or(g(&j["players"], "max"), 0.0) as i64,
            "version": str_or(g(&j["version"], "name")), "latency": now_ms() - start, "motd": slice_chars(js_trim(&clean), 160),
        });
    }
}

// ---------- window host ----------
struct WinState { stdin: Option<ChildStdin>, queue: VecDeque<(u64, Sender<Option<String>>)>, ready: bool, shown: bool, pid: u32, generation: u64 }
static WIN: Mutex<WinState> = Mutex::new(WinState { stdin: None, queue: VecDeque::new(), ready: false, shown: false, pid: 0, generation: 0 });
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn win() -> std::sync::MutexGuard<'static, WinState> { WIN.lock().unwrap_or_else(|e| e.into_inner()) }
pub fn window_ready() -> bool { win().ready }
pub fn has_helper() -> bool { win().stdin.is_some() }
pub fn win_cmd(cmd: &str) -> Option<String> {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    {
        let mut w = win();
        let stdin = w.stdin.as_mut()?;
        if writeln!(stdin, "{}", cmd).and_then(|_| stdin.flush()).is_err() { return None; }
        w.queue.push_back((id, tx));
    }
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(v) => v,
        Err(_) => { win().queue.retain(|(i, _)| *i != id); None }
    }
}
/// Tells the window to use less memory while a game runs in front of it.
pub fn mem_hint(any_running: bool) {
    if !win().shown { return; }
    std::thread::spawn(move || { win_cmd(if any_running { "MEM LOW" } else { "MEM NORMAL" }); });
}
fn on_helper_line(line: &str) {
    if let Some((_, tx)) = win().queue.pop_front() { let _ = tx.send(Some(line.to_string())); }
}
fn helper_exit(generation: u64) {
    let mut w = win();
    if w.generation != generation { return; }
    w.stdin = None;
    w.ready = false;
    w.pid = 0;
    for (_, tx) in w.queue.drain(..) { let _ = tx.send(None); }
}

const WV_VERSION: &str = "1.0.3719.77";
const WV_SHA256: &str = "2f6be3a10a1a8d6d1fde986af4131dab344f8181fffe75590824e0f4b037ed73";
const WV_FILES: &[(&str, &str)] = &[
    ("Microsoft.Web.WebView2.Core.dll", "lib/net462/Microsoft.Web.WebView2.Core.dll"),
    ("Microsoft.Web.WebView2.WinForms.dll", "lib/net462/Microsoft.Web.WebView2.WinForms.dll"),
    ("x64/WebView2Loader.dll", "runtimes/win-x64/native/WebView2Loader.dll"),
    ("arm64/WebView2Loader.dll", "runtimes/win-arm64/native/WebView2Loader.dll"),
];
fn wv_sdk() -> PathBuf { p().data.join("webview").join("sdk") }
// Microsoft's WebView2 SDK is not open source, so Auroria does not ship it: it fetches the official NuGet package once,
// checks it against a pinned SHA-256 and keeps the four files it needs.
fn ensure_webview_sdk() -> R<()> {
    let sdk = wv_sdk();
    let marker = sdk.join("version.txt");
    if read_text(&marker).trim() == WV_VERSION && WV_FILES.iter().all(|(r, _)| exists(&join_rel(&sdk, r))) { return Ok(()); }
    let url = format!("https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{v}/microsoft.web.webview2.{v}.nupkg", v = WV_VERSION);
    let res = get_bytes(&url, Some(Duration::from_secs(60)))?;
    if !res.ok() { bail!("WebView2 SDK download failed (HTTP {})", res.status); }
    if sha256_hex(&res.body) != WV_SHA256 { bail!("The WebView2 SDK download did not match its checksum."); }
    let zip = zipx::entries(&res.body)?;
    for (rel, in_pkg) in WV_FILES {
        let Some(e) = zipx::find(&zip, in_pkg) else { bail!("WebView2 SDK is missing {}", in_pkg) };
        let dest = join_rel(&sdk, rel);
        ensure_dir(dest.parent().unwrap())?;
        if let Err(err) = fs::write(&dest, e.read(&res.body)?) { if !exists(&dest) { return Err(err.into()); } } // in use by a running window: keep the old copy
    }
    fs::write(&marker, WV_VERSION)?;
    Ok(())
}
// Trims what WebView2 runs: no background services Auroria never uses, and the network service inside the browser process.
const WV_ARGS: &str = "--disable-background-networking --disable-component-update --disable-sync --disable-extensions --disable-default-apps --no-first-run --disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI,Translate,AutofillServerCommunication,OptimizationHints,MediaRouter,SpareRendererForSitePerProcess,msEdgeSidebarV2 --enable-features=NetworkServiceInProcess2 --renderer-process-limit=1";
fn csc() -> PathBuf { PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Microsoft.NET").join("Framework64").join("v4.0.30319").join("csc.exe") }
fn ensure_host_exe() -> R<Option<PathBuf>> {
    let csc = csc();
    if !exists(&csc) { return Ok(None); }
    let hash = sha1_hex(format!("{}{}", HOST_CS, WV_VERSION).as_bytes())[..12].to_string();
    let cache = p().data.join("cache");
    let exe = cache.join(format!("auroria-host-{}.exe", hash));
    if exists(&exe) { return Ok(Some(exe)); }
    ensure_dir(&cache)?;
    let cs = cache.join(format!("auroria-host-{}.cs", hash));
    let tmp = PathBuf::from(format!("{}.tmp.exe", path_str(&exe)));
    fs::write(&cs, HOST_CS)?;
    let icon = cache.join("auroria.ico");
    let _ = fs::write(&icon, assets::FAVICON);
    let sdk = wv_sdk();
    let out = Command::new(&csc)
        .args(["/nologo", "/optimize+", "/target:winexe", "/platform:anycpu", "/main:AuroriaEntry"])
        .arg(format!("/out:{}", path_str(&tmp))).arg(format!("/win32icon:{}", path_str(&icon)))
        .args(["/r:System.Windows.Forms.dll", "/r:System.Drawing.dll"])
        .arg(format!("/r:{}", path_str(&sdk.join("Microsoft.Web.WebView2.Core.dll")))).arg(format!("/r:{}", path_str(&sdk.join("Microsoft.Web.WebView2.WinForms.dll"))))
        .arg(&cs).stdin(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).output();
    rm_force(&cs);
    match out {
        Ok(o) if o.status.success() => { fs::rename(&tmp, &exe)?; Ok(Some(exe)) }
        Ok(o) => { log_line(&format!("host compile failed {}", slice_chars(&String::from_utf8_lossy(&o.stdout), 400))); rm_force(&tmp); Ok(None) }
        Err(e) => { log_line(&format!("host compile failed {}", e)); rm_force(&tmp); Ok(None) }
    }
}
fn start_host(url: &str) -> bool {
    let data = &p().data;
    let exe = ensure_host_exe().unwrap_or_else(|e| { log_line(&format!("host compile failed {}", e.msg)); None });
    let mut cmd = match &exe {
        Some(e) => Command::new(e),
        None => { let mut c = Command::new("powershell.exe"); c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", &utf16_b64(HOST_PS)]); c }
    };
    cmd.env("AURORIA_URL", url).env("AURORIA_SDK", wv_sdk()).env("AURORIA_CACHE", data.join("cache")).env("AURORIA_PROFILE", data.join("webview").join("profile"))
        .env("AURORIA_ICON", exe_path()).env("AURORIA_WV_ARGS", WV_ARGS).env("AURORIA_HOST_CS", HOST_CS)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => { log_line(&format!("window host failed {}", e)); return false; } };
    let generation = {
        let mut w = win();
        w.generation += 1;
        w.stdin = child.stdin.take();
        w.shown = false;
        w.pid = child.id();
        w.generation
    };
    let fell_back = Arc::new(AtomicBool::new(false));
    let pid = child.id();
    let fallback = {
        let (fell_back, url) = (fell_back.clone(), url.to_string());
        move |why: &str| {
            if win().shown || fell_back.swap(true, Ordering::SeqCst) { return; }
            log_line(&format!("native window unavailable, using Edge: {}", why));
            kill_pid(pid);
            open_edge_window(&url);
        }
    };
    let stdout = child.stdout.take().unwrap();
    {
        let fallback = fallback.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line == "READY" { continue; }
                if line == "SHOWN" {
                    { let mut w = win(); w.shown = true; w.ready = true; }
                    broadcast(json!({ "type": "window", "ready": true }));
                    continue;
                }
                if let Some(why) = line.strip_prefix("FAIL") { fallback(why.trim()); continue; }
                on_helper_line(&line);
            }
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            helper_exit(generation);
            fallback(&format!("exit {}", code));
        });
    }
    std::thread::spawn(move || { sleep_ms(30000); fallback("timed out"); });
    true
}

// ---------- frameless Edge window: strips the Edge title bar and drives the window from the UI ----------
fn start_window_helper() {
    if no_window() || has_helper() { return; }
    let mut child = match Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", &utf16_b64(WIN_PS)])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn() {
        Ok(c) => c,
        Err(e) => { log_line(&format!("window helper failed {}", e)); return; }
    };
    let generation = { let mut w = win(); w.generation += 1; w.stdin = child.stdin.take(); w.pid = child.id(); w.generation };
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if line == "READY" { continue; }
            on_helper_line(&line);
        }
        let _ = child.wait();
        helper_exit(generation);
    });
    // Keep the title bar off: retry until the window appears, then re-check now and then.
    std::thread::spawn(move || {
        sleep_ms(600);
        let mut tries = 0;
        loop {
            if win().generation != generation || !has_helper() { return; }
            let r = win_cmd("STRIP");
            let ready = window_ready();
            if r.as_deref() == Some("OK") && !ready { win().ready = true; broadcast(json!({ "type": "window", "ready": true })); }
            tries += 1;
            sleep_ms(if window_ready() { 3000 } else if tries < 60 { 400 } else { 3000 });
        }
    });
}
fn find_browser() -> Option<PathBuf> {
    let roots: Vec<String> = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|k| std::env::var(k).ok()).filter(|x| !x.is_empty()).collect();
    for rel in [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe"] {
        for r in &roots { let p = Path::new(r).join(rel); if exists(&p) { return Some(p); } }
    }
    None
}
fn open_edge_window(url: &str) {
    match find_browser() {
        Some(b) => {
            start_window_helper();
            let _ = Command::new(b).args([format!("--app={}", url), "--window-size=1300,800".into(), format!("--user-data-dir={}", path_str(&p().data.join("window"))),
                "--no-first-run".into(), "--no-default-browser-check".into(), "--disable-sync".into(), "--disable-extensions".into(), "--disable-features=Translate".into()])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS).spawn();
        }
        None => open_external(url),
    }
}
pub fn open_window(url: &str) {
    if no_window() { println!("UI: {}", url); return; }
    if std::env::var_os("AURORIA_EDGE_WINDOW").is_none() {
        match ensure_webview_sdk() {
            Ok(()) => { if start_host(url) { return; } }
            Err(e) => log_line(&format!("native window unavailable {}", e.msg)),
        }
    }
    open_edge_window(url);
}

// ---------- lifecycle ----------
pub static EVER_CONNECTED: AtomicBool = AtomicBool::new(false);
static EXIT_GEN: AtomicU64 = AtomicU64::new(0);
pub fn maybe_exit() {
    if no_window() { return; }
    let gen = EXIT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        sleep_ms(8000);
        if EXIT_GEN.load(Ordering::SeqCst) == gen && client_count() == 0 && EVER_CONNECTED.load(Ordering::SeqCst) && !st().any_running() { shutdown(); }
    });
}
pub fn shutdown() -> ! {
    let pid = win().pid;
    if pid != 0 { kill_pid(pid); }
    rm_force(&p().lock);
    std::process::exit(0);
}
