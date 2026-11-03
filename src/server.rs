// Local HTTP server on 127.0.0.1: the UI's files, the token-checked /api routes and the event stream.
use crate::state::*;
use crate::util::*;
use crate::{assets, extras, net, routes, win};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::Duration;

pub static PORT: AtomicU16 = AtomicU16::new(0);
pub fn token() -> &'static str {
    static T: OnceLock<String> = OnceLock::new();
    T.get_or_init(|| random_hex(24))
}
pub fn ui_url() -> String { format!("http://127.0.0.1:{}/#{}", PORT.load(Ordering::SeqCst), token()) }

struct Req {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body_len: usize,
}
impl Req {
    fn header(&self, k: &str) -> Option<&str> { self.headers.iter().find(|(a, _)| a.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str()) }
}

fn status_text(code: u16) -> &'static str {
    match code { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 500 => "Internal Server Error", _ => "OK" }
}
fn send(s: &mut TcpStream, code: u16, body: &[u8], typ: &str) {
    let head = format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", code, status_text(code), typ, body.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}
fn send_json(s: &mut TcpStream, code: u16, v: &Value) { send(s, code, serde_json::to_string(v).unwrap_or_default().as_bytes(), "application/json"); }

fn read_head(s: &mut TcpStream) -> Option<(Req, Vec<u8>)> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let end = loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > 64 * 1024 { return None; }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let rest = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    let (path, query) = match target.split_once('?') { Some((a, b)) => (a.to_string(), b.to_string()), None => (target.clone(), String::new()) };
    let body_len = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    Some((Req { method, path, query, headers, body_len }, rest))
}

pub fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        std::thread::spawn(move || {
            let mut s = stream;
            let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&mut s)));
            if r.is_err() { send_json(&mut s, 500, &json!({ "error": "Something went wrong" })); }
        });
    }
}

fn handle(s: &mut TcpStream) {
    let Some((req, mut rest)) = read_head(s) else { return };
    let port = PORT.load(Ordering::SeqCst);
    let host = req.header("host").unwrap_or("");
    if host != format!("127.0.0.1:{}", port) && host != format!("localhost:{}", port) { return send_json(s, 403, &json!({ "error": "Forbidden" })); }
    let q = Query::parse(&req.query);
    if req.method == "GET" {
        if req.path == "/" {
            // The page paints in the saved accent from its first frame, splash included.
            let accent = st().settings.get("accent").map(str_or).filter(|a| win::is_hex_color(a)).unwrap_or_default();
            return send(s, 200, assets::INDEX.replacen("__ACCENT__", &accent, 1).as_bytes(), "text/html; charset=utf-8");
        }
        if let Some((_, data, typ)) = assets::STATIC.iter().find(|(p, _, _)| *p == req.path) { return send(s, 200, data, typ); }
    }
    if !req.path.starts_with("/api/") { return send(s, 404, b"Not found", "text/plain"); }
    let tok = req.header("x-auroria-token").map(String::from).or_else(|| q.get("token"));
    if tok.as_deref() != Some(token()) { return send_json(s, 401, &json!({ "error": "Unauthorized" })); }

    match req.path.as_str() {
        "/api/events" => return events(s),
        "/api/cape-image" => {
            let u = q.get("url").unwrap_or_default();
            if !is_texture_url(&u, true) { return send_json(s, 400, &json!({ "error": "Bad cape URL" })); }
            return match net::get_bytes(&u.replacen("http:", "https:", 1), None) { Ok(r) => send(s, 200, &r.body, "image/png"), Err(_) => send_json(s, 404, &json!({ "error": "No cape" })) };
        }
        "/api/skin-image" => {
            let id = q.get("id").unwrap_or_default();
            if id == "current" || id.starts_with("acct:") {
                let pp = { let st = st(); public_profile_of(if id == "current" { st.account() } else { st.accounts.iter().find(|a| account_id(a) == id[5..]).or(st.account()) }) };
                let url = gs(g(&pp, "skin"), "url");
                if !truthy(&pp) || url.is_empty() || !is_texture_url(&url, false) { return send_json(s, 404, &json!({ "error": "No skin" })); }
                return match net::get_bytes(&url.replacen("http:", "https:", 1), None) { Ok(r) => send(s, 200, &r.body, "image/png"), Err(_) => send_json(s, 404, &json!({ "error": "No skin" })) };
            }
            return match std::fs::read(p().skins.join(format!("{}.png", basename(&id)))) { Ok(b) => send(s, 200, &b, "image/png"), Err(_) => send_json(s, 404, &json!({ "error": "No skin" })) };
        }
        "/api/profile-image" => {
            let r: R<(Vec<u8>, bool)> = (|| {
                let sv = st().server_by(&q.val("server"));
                let name = extras::safe_name(&q.val("name"))?;
                let file = if q.get("kind").as_deref() == Some("world") { extras::saves_dir(&sv).join(&name).join("icon.png") } else { crate::game::instance_dir(&sv).join("screenshots").join(&name) };
                let jpg = { let l = name.to_lowercase(); l.ends_with(".jpg") || l.ends_with(".jpeg") } && q.get("kind").as_deref() != Some("world");
                Ok((std::fs::read(&file)?, jpg))
            })();
            return match r { Ok((b, jpg)) => send(s, 200, &b, if jpg { "image/jpeg" } else { "image/png" }), Err(_) => send_json(s, 404, &json!({ "error": "No image" })) };
        }
        _ => {}
    }
    let key = format!("{} {}", req.method, req.path);
    if !routes::exists(&key) { return send_json(s, 404, &json!({ "error": "Unknown endpoint" })); }
    let body: R<Value> = if req.method == "POST" {
        let max = if req.path == "/api/import/mrpack" { 400 * 1024 * 1024 } else { 8 * 1024 * 1024 };
        if req.body_len > max { Err(Error::new("Request too large")) } else {
            while rest.len() < req.body_len {
                let mut chunk = vec![0u8; (req.body_len - rest.len()).min(1 << 20)];
                match s.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => rest.extend_from_slice(&chunk[..n]) }
            }
            rest.truncate(req.body_len);
            let t = String::from_utf8_lossy(&rest);
            if t.is_empty() { Ok(json!({})) } else { serde_json::from_str(&t).map_err(|e| Error::new(e.to_string())) }
        }
    } else { Ok(json!({})) };
    let res = body.and_then(|b| routes::call(&key, &b, &q));
    match res {
        Ok(v) => send_json(s, 200, &v),
        Err(e) => {
            log_line(&format!("api error {} {}", req.path, e.msg));
            send_json(s, 500, &json!({ "error": if e.msg.is_empty() { "Something went wrong".to_string() } else { e.msg } }));
        }
    }
}
fn is_texture_url(u: &str, cape: bool) -> bool {
    let rest = u.strip_prefix("https://textures.minecraft.net/").or_else(|| u.strip_prefix("http://textures.minecraft.net/"));
    match rest {
        None => false,
        Some(r) if cape => r.strip_prefix("texture/").map_or(false, |h| !h.is_empty() && h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))),
        Some(_) => true,
    }
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);
fn events(s: &mut TcpStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: hi\n\n";
    if s.write_all(head.as_bytes()).is_err() { return; }
    let _ = s.flush();
    let id = NEXT_CLIENT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel::<String>();
    CLIENTS.lock().unwrap().push((id, tx.clone()));
    win::EVER_CONNECTED.store(true, Ordering::SeqCst);
    // A second handle notices the browser closing the stream right away instead of at the next keep-alive.
    if let Ok(mut r) = s.try_clone() {
        let _ = r.set_read_timeout(None);
        std::thread::spawn(move || { let mut b = [0u8; 256]; while matches!(r.read(&mut b), Ok(n) if n > 0) {} let _ = tx.send(String::new()); });
    }
    loop {
        let msg = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(m) if m.is_empty() => break,
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => ": k\n\n".to_string(),
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if s.write_all(msg.as_bytes()).and_then(|_| s.flush()).is_err() { break; }
    }
    CLIENTS.lock().unwrap().retain(|(i, _)| *i != id);
    let _ = s.shutdown(std::net::Shutdown::Both);
    win::maybe_exit();
}
