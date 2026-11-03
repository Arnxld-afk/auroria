// HTTP client: JSON calls, text, and verified downloads that two launches can share.
use crate::util::*;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub fn ua() -> String { format!("Auroria-Launcher/{}", VERSION) }

fn agent() -> &'static ureq::Agent {
    static A: OnceLock<ureq::Agent> = OnceLock::new();
    A.get_or_init(|| {
        let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(90)).redirects(10).user_agent("node");
        if let Ok(tls) = native_tls::TlsConnector::new() { b = b.tls_connector(Arc::new(tls)); }
        b.build()
    })
}

pub fn net_error(url: &str, cause: &str) -> Error {
    let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url);
    let _ = cause;
    Error::new(format!("Could not reach {}. Check your internet connection and try again.", host))
}

pub struct Resp {
    pub status: u16,
    pub body: Vec<u8>,
    pub ctype: String,
}
impl Resp {
    pub fn ok(&self) -> bool { (200..300).contains(&self.status) }
    pub fn text(&self) -> String { String::from_utf8_lossy(&self.body).into_owned() }
    pub fn json(&self) -> Option<Value> { serde_json::from_slice(&self.body).ok() }
}

/// fetch(): any status comes back as a response; only network failures are errors.
pub fn fetch(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Option<Duration>) -> R<Resp> {
    let mut req = agent().request(method, url);
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in headers.iter().rev() {
        let lk = k.to_ascii_lowercase();
        if seen.contains(&lk) { continue; }
        seen.push(lk);
        req = req.set(k, v);
    }
    if let Some(t) = timeout { req = req.timeout(t); }
    let res = match body { Some(b) => req.send_bytes(b), None => req.call() };
    let resp = match res {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(net_error(url, &e.to_string())),
    };
    let status = resp.status();
    let ctype = resp.header("content-type").unwrap_or("").to_string();
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf).map_err(|e| net_error(url, &e.to_string()))?;
    Ok(Resp { status, body: buf, ctype })
}

fn parse_body(r: &Resp) -> Value {
    if r.body.is_empty() { return Value::Null; }
    r.json().unwrap_or_else(|| Value::String(r.text()))
}
fn json_call(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> R<Value> {
    let ua = ua();
    let mut h: Vec<(&str, &str)> = vec![("User-Agent", ua.as_str()), ("Accept", "application/json")];
    h.extend_from_slice(headers);
    let r = fetch(method, url, &h, body, None)?;
    let body = parse_body(&r);
    if !r.ok() { return Err(Error { msg: format!("HTTP {} for {}", r.status, url), status: r.status, body }); }
    Ok(body)
}
pub fn get_json(url: &str) -> R<Value> { json_call("GET", url, &[], None) }
pub fn get_json_h(url: &str, headers: &[(&str, &str)]) -> R<Value> { json_call("GET", url, headers, None) }
pub fn post_json(url: &str, data: &Value) -> R<Value> {
    json_call("POST", url, &[("Content-Type", "application/json")], Some(serde_json::to_string(data)?.as_bytes()))
}
pub fn post_form(url: &str, pairs: &[(&str, &str)]) -> R<Value> {
    json_call("POST", url, &[("Content-Type", "application/x-www-form-urlencoded")], Some(form_encode(pairs).as_bytes()))
}
pub fn get_text(url: &str) -> R<String> {
    let ua = ua();
    let r = fetch("GET", url, &[("User-Agent", &ua)], None, None)?;
    if !r.ok() { return Err(Error { msg: format!("HTTP {} for {}", r.status, url), status: r.status, body: Value::Null }); }
    Ok(r.text())
}
pub fn get_bytes(url: &str, timeout: Option<Duration>) -> R<Resp> {
    let ua = ua();
    fetch("GET", url, &[("User-Agent", &ua)], None, timeout)
}

// Download with size/sha1 check and retries. Skips files that already exist with the right size.
// Two games launching at once often need the same file: the second waits for the first download instead of racing it.
static DOWNLOADING: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn download(url: &str, dest: &Path, sha1: Option<&str>, size: Option<u64>) -> R<bool> {
    let key = absolute(dest);
    let gate = DOWNLOADING.lock().unwrap().entry(key.clone()).or_default().clone();
    let r = {
        let _g = gate.lock().unwrap_or_else(|e| e.into_inner());
        download_once(url, dest, sha1, size)
    };
    let mut map = DOWNLOADING.lock().unwrap();
    if Arc::strong_count(&gate) <= 2 { map.remove(&key); }
    r
}
fn download_once(url: &str, dest: &Path, want: Option<&str>, size: Option<u64>) -> R<bool> {
    if let Ok(st) = fs::metadata(dest) {
        let done = match size { Some(s) if s > 0 => st.len() == s, _ => st.len() > 0 };
        if done { return Ok(false); }
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut last = Error::new("Download failed");
    for attempt in 0..3u64 {
        let res: R<bool> = (|| {
            let r = get_bytes(url, None)?;
            if !r.ok() { bail!("Download failed (HTTP {}) for {}", r.status, name); }
            if let Some(w) = want { if !w.is_empty() && sha1_hex(&r.body) != w { bail!("Checksum mismatch for {}", name); } }
            if let Some(d) = dest.parent() { ensure_dir(d)?; }
            let mut tmp = dest.as_os_str().to_owned();
            tmp.push(".part");
            fs::write(&tmp, &r.body)?;
            fs::rename(&tmp, dest)?;
            Ok(true)
        })();
        match res { Ok(v) => return Ok(v), Err(e) => { last = e; sleep_ms(500 * (attempt + 1)); } }
    }
    Err(last)
}
