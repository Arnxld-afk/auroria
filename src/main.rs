// Auroria Launcher. Serves the UI on 127.0.0.1 and shows it in a borderless WebView2 window.
#![windows_subsystem = "windows"]

#[macro_use]
mod util;
mod assets;
mod auth;
mod extras;
mod game;
mod mods;
mod net;
mod routes;
mod server;
mod state;
mod win;
mod zipx;

use serde_json::json;
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::time::Duration;
use util::*;

fn arg_play() -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == "--play").filter(|&i| i > 0).and_then(|i| args.get(i + 1).cloned()).unwrap_or_default()
}

fn main() {
    if let Err(e) = run() { log_line(&format!("fatal {}", e.msg)); std::process::exit(1); }
}

fn run() -> R<()> {
    let pp = p();
    ensure_dir(&pp.data)?;
    // After a self-update the old process hands over: wait for it to exit, then drop the exe it left behind.
    if let Some(pid) = std::env::var("AURORIA_WAIT_PID").ok().and_then(|v| v.parse::<u32>().ok()) {
        std::env::remove_var("AURORIA_WAIT_PID");
        win::wait_pid(pid, 10_000);
    }
    if win::is_packaged() { if let Ok(me) = std::env::current_exe() { rm_force(&std::path::PathBuf::from(format!("{}.old", path_str(&me)))); } }
    // Single instance: if another launcher is running, just show its window.
    if let Some(lock) = read_json(&pp.lock) {
        let (port, token) = (lock["port"].as_u64().unwrap_or(0), gs(&lock, "token"));
        if port != 0 && !token.is_empty() {
            let base = format!("http://127.0.0.1:{}", port);
            let ping = net::fetch("GET", &format!("{}/api/ping", base), &[("x-auroria-token", &token)], None, Some(Duration::from_millis(1500)));
            if ping.map_or(false, |r| r.ok()) {
                // Ask the running launcher to bring its window forward (it reopens one if it was closed), and play the profile a shortcut asked for.
                let h: [(&str, &str); 2] = [("x-auroria-token", &token), ("content-type", "application/json")];
                let _ = net::fetch("POST", &format!("{}/api/window", base), &h, Some(br#"{"action":"show"}"#), Some(Duration::from_secs(5)));
                let play = arg_play();
                if !play.is_empty() { let _ = net::fetch("POST", &format!("{}/api/autoplay", base), &h, Some(json!({ "id": play }).to_string().as_bytes()), Some(Duration::from_secs(5))); }
                sleep_ms(300);
                return Ok(());
            }
        }
    }
    state::load_state()?;
    let play = arg_play();
    if !play.is_empty() {
        let mut s = state::st();
        if s.find_server(&play).is_some() { s.pending_play = play.clone(); s.settings.insert("selectedServer".into(), json!(play)); }
    }
    let _ = mods::scan_own_client();
    let wanted: u16 = std::env::var("AURORIA_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", wanted))?;
    let port = listener.local_addr()?.port();
    server::PORT.store(port, Ordering::SeqCst);
    write_json(&pp.lock, &json!({ "port": port, "token": server::token(), "pid": std::process::id() }))?;
    log_line(&format!("started on {}", port));
    let url = server::ui_url();
    std::thread::spawn(move || win::open_window(&url));
    std::thread::spawn(|| {
        sleep_ms(180_000);
        if !win::EVER_CONNECTED.load(Ordering::SeqCst) && !win::no_window() { win::shutdown(); }
    });
    server::serve(listener);
    Ok(())
}
