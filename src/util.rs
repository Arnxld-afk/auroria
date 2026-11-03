// Small helpers shared by every module: errors, JavaScript-style value handling, paths, files, time, hashing, encoding.
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering as AO};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub type Obj = Map<String, Value>;
pub type R<T> = Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Error {
    pub msg: String,
    pub status: u16,
    pub body: Value,
}
impl Error {
    pub fn new(msg: impl Into<String>) -> Self { Error { msg: msg.into(), status: 0, body: Value::Null } }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.msg) }
}
impl From<String> for Error { fn from(s: String) -> Self { Error::new(s) } }
impl From<&str> for Error { fn from(s: &str) -> Self { Error::new(s) } }
impl From<std::io::Error> for Error { fn from(e: std::io::Error) -> Self { Error::new(io_msg(&e)) } }
impl From<serde_json::Error> for Error { fn from(e: serde_json::Error) -> Self { Error::new(e.to_string()) } }

pub fn io_msg(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT: no such file or directory".into(),
        PermissionDenied => "EPERM: operation not permitted".into(),
        AlreadyExists => "EEXIST: file already exists".into(),
        _ => e.to_string(),
    }
}

#[macro_export]
macro_rules! bail {
    ($($t:tt)*) => { return Err($crate::util::Error::new(format!($($t)*))) };
}

// ---------- JavaScript-style values ----------
pub static NULL: Value = Value::Null;
pub fn g<'a>(v: &'a Value, k: &str) -> &'a Value { v.get(k).unwrap_or(&NULL) }
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
/// String(v)
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => fmt_num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// String(v || '')
pub fn str_or(v: &Value) -> String { if truthy(v) { js_string(v) } else { String::new() } }
/// String(obj[k] || '')
pub fn gs(v: &Value, k: &str) -> String { str_or(g(v, k)) }
/// Number(v)
pub fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) { i64::from_str_radix(h, 16).map(|x| x as f64).unwrap_or(f64::NAN) } else if t == "Infinity" || t == "+Infinity" { f64::INFINITY } else if t == "-Infinity" { f64::NEG_INFINITY } else if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) { t.parse::<f64>().unwrap_or(f64::NAN) } else { f64::NAN }
        }
        Value::Array(a) => if a.is_empty() { 0.0 } else if a.len() == 1 { js_number(&a[0]) } else { f64::NAN },
        Value::Object(_) => f64::NAN,
    }
}
/// Number(v) || d
pub fn num_or(v: &Value, d: f64) -> f64 { let n = js_number(v); if n == 0.0 || n.is_nan() { d } else { n } }
pub fn num_val(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 { Value::from(f as i64) } else if f.is_finite() { serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null) } else { Value::Null }
}
pub fn fmt_num(f: f64) -> String {
    if f.is_nan() { "NaN".into() } else if f.is_infinite() { if f > 0.0 { "Infinity".into() } else { "-Infinity".into() } } else if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i128) } else { format!("{}", f) }
}
pub fn as_u64(v: &Value) -> Option<u64> { v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)) }
pub fn obj(v: Value) -> Obj { match v { Value::Object(m) => m, _ => Obj::new() } }
pub fn arr(v: &Value) -> &[Value] { v.as_array().map(|a| a.as_slice()).unwrap_or(&[]) }
pub fn str_list(v: &Value) -> Vec<String> { arr(v).iter().map(js_string).collect() }

/// String.prototype.localeCompare, close enough for titles and paths: punctuation, then digits, then letters, case-insensitive first.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let key = |c: char| -> (u8, String) {
        let class = if c.is_alphabetic() { 2 } else if c.is_numeric() { 1 } else { 0 };
        (class, c.to_lowercase().collect())
    };
    let (ka, kb): (Vec<_>, Vec<_>) = (a.chars().map(key).collect(), b.chars().map(key).collect());
    match ka.cmp(&kb) {
        Ordering::Equal => {
            // Same letters: lowercase sorts before uppercase.
            for (x, y) in a.chars().zip(b.chars()) {
                if x != y { return if x.is_lowercase() && y.is_uppercase() { Ordering::Less } else if x.is_uppercase() && y.is_lowercase() { Ordering::Greater } else { x.cmp(&y) }; }
            }
            a.len().cmp(&b.len())
        }
        o => o,
    }
}

/// Compares version strings by their numeric parts ("1.20.1" > "1.20").
pub fn cmp_ver(a: &str, b: &str) -> i64 {
    let parts = |s: &str| -> Vec<i64> { s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).map(|x| x.parse::<i64>().unwrap_or(i64::MAX)).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0).saturating_sub(pb.get(i).copied().unwrap_or(0));
        if d != 0 { return d; }
    }
    0
}

// ---------- paths ----------
pub struct Paths {
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub versions: PathBuf,
    pub libraries: PathBuf,
    pub assets: PathBuf,
    pub instances: PathBuf,
    pub skins: PathBuf,
    pub settings: PathBuf,
    pub account: PathBuf,
    pub config: PathBuf,
    pub servers: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub client: PathBuf,
}
pub fn home() -> PathBuf {
    if let Ok(h) = std::env::var("USERPROFILE") { if !h.is_empty() { return PathBuf::from(h); } }
    PathBuf::from(format!("{}{}", std::env::var("HOMEDRIVE").unwrap_or_default(), std::env::var("HOMEPATH").unwrap_or_default()))
}
pub fn roaming() -> PathBuf {
    match std::env::var("APPDATA") { Ok(a) if !a.is_empty() => PathBuf::from(a), _ => home().join("AppData").join("Roaming") }
}
pub fn p() -> &'static Paths {
    static P: OnceLock<Paths> = OnceLock::new();
    P.get_or_init(|| {
        let data = roaming().join("Auroria");
        Paths {
            runtime: data.join("runtime"), versions: data.join("versions"), libraries: data.join("libraries"), assets: data.join("assets"),
            instances: data.join("instances"), skins: data.join("skins"), settings: data.join("settings.json"), account: data.join("account.json"),
            config: data.join("config.json"), servers: data.join("servers.json"), lock: data.join("instance.json"), log: data.join("launcher.log"),
            client: data.join("client"), data,
        }
    })
}
/// path.join with forward-slash segments ("a/b/c.jar").
pub fn join_rel(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split(['/', '\\']).filter(|x| !x.is_empty()) { p.push(part); }
    p
}
/// path.resolve(base, rel), refusing anything that lands outside base.
pub fn resolve_under(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut parts: Vec<&str> = Vec::new();
    if rel.starts_with('/') || rel.starts_with('\\') { return None; }
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => { parts.pop()?; }
            s if s.contains(':') => return None,
            s => parts.push(s),
        }
    }
    if parts.is_empty() { return None; }
    let mut out = base.to_path_buf();
    for s in parts { out.push(s); }
    Some(out)
}
pub fn basename(s: &str) -> String {
    let t = s.trim_end_matches(['/', '\\']);
    t.rsplit(['/', '\\']).next().unwrap_or("").to_string()
}
pub fn path_str(p: &Path) -> String { p.to_string_lossy().into_owned() }
pub fn absolute(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c { Component::ParentDir => { out.pop(); } Component::CurDir => {} c => out.push(c) }
    }
    out
}

// ---------- files ----------
pub fn ensure_dir(d: &Path) -> R<()> { fs::create_dir_all(d)?; Ok(()) }
pub fn exists(p: &Path) -> bool { fs::metadata(p).is_ok() }
pub fn read_json(p: &Path) -> Option<Value> { fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }
pub fn to_pretty(v: &Value, indent: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(indent);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, fmt);
    serde::Serialize::serialize(v, &mut ser).ok();
    out
}
pub fn write_json(p: &Path, v: &Value) -> R<()> {
    if let Some(d) = p.parent() { ensure_dir(d)?; }
    fs::write(p, to_pretty(v, b"  "))?;
    Ok(())
}
pub fn read_text(p: &Path) -> String { fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default() }
pub fn rm_force(p: &Path) { let _ = fs::remove_file(p); }
pub fn rm_rf(p: &Path) {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => { let _ = fs::remove_dir_all(p); }
        Ok(_) => { let _ = fs::remove_file(p); }
        Err(_) => {}
    }
}
pub fn mtime_ms(m: &fs::Metadata) -> f64 {
    match m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
        Some(d) => d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6,
        None => 0.0,
    }
}
/// Lists a folder's entries (name, is_dir) in the order Windows returns them.
pub fn read_dir(d: &Path) -> std::io::Result<Vec<(String, bool)>> {
    let mut out = Vec::new();
    for e in fs::read_dir(d)? {
        let e = e?;
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push((e.file_name().to_string_lossy().into_owned(), is_dir));
    }
    Ok(out)
}
/// fs.cp(src, dest, { recursive: true }) skipping any entry whose name is in `skip`.
pub fn copy_dir(src: &Path, dest: &Path, skip: &[&str]) -> R<()> {
    let m = fs::metadata(src)?;
    if !m.is_dir() { if let Some(d) = dest.parent() { ensure_dir(d)?; } fs::copy(src, dest)?; return Ok(()); }
    ensure_dir(dest)?;
    for (name, is_dir) in read_dir(src)? {
        if skip.contains(&name.as_str()) { continue; }
        let (s, d) = (src.join(&name), dest.join(&name));
        if is_dir { copy_dir(&s, &d, skip)?; } else { fs::copy(&s, &d)?; }
    }
    Ok(())
}

// ---------- log ----------
pub fn log_line(msg: &str) {
    static GATE: Mutex<()> = Mutex::new(());
    let _g = GATE.lock();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p().log) {
        let _ = writeln!(f, "[{}] {}", iso(now_ms()), msg);
    }
}

// ---------- time ----------
pub fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
pub fn sleep_ms(ms: u64) { std::thread::sleep(Duration::from_millis(ms)) }
/// Date.prototype.toISOString
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Days to civil date (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}
/// new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
pub fn stamp() -> String { iso(now_ms())[..19].replace([':', 'T'], "-") }

// ---------- hashing and random ----------
pub fn sha1_hex(b: &[u8]) -> String { sha1_smol::Sha1::from(b).digest().to_string() }
pub fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|x| format!("{:02x}", x)).collect()
}
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
pub fn uuid() -> String {
    let h = random_hex(16);
    let mut c: Vec<char> = h.chars().collect();
    c[12] = '4';
    c[16] = ['8', '9', 'a', 'b'][(c[16].to_digit(16).unwrap_or(0) & 3) as usize];
    let s: String = c.into_iter().collect();
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

// ---------- encoding ----------
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn b64_encode(b: &[u8]) -> String {
    let mut out = String::with_capacity((b.len() + 2) / 3 * 4);
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}
/// Buffer.from(s, 'base64'): skips characters outside the alphabet, stops at padding.
pub fn b64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' | b'-' => 62, b'/' | b'_' => 63, b'=' => break, _ => continue };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    out
}
pub fn utf16_b64(s: &str) -> String { b64_encode(&s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>()) }
/// encodeURIComponent
pub fn enc_uri(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { out.push(b as char) } else { out.push_str(&format!("%{:02X}", b)) }
    }
    out
}
/// application/x-www-form-urlencoded, as URLSearchParams writes it.
pub fn form_encode(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| -> String {
        let mut out = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || b"*-._".contains(&b) { out.push(b as char) } else if b == b' ' { out.push('+') } else { out.push_str(&format!("%{:02X}", b)) }
        }
        out
    };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'+' { out.push(b' '); i += 1; continue; }
        if b[i] == b'%' {
            if let (Some(h), Some(l)) = (b.get(i + 1).and_then(|c| (*c as char).to_digit(16)), b.get(i + 2).and_then(|c| (*c as char).to_digit(16))) {
                out.push((h * 16 + l) as u8); i += 3; continue;
            }
        }
        out.push(b[i]); i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// URLSearchParams over a request's query string.
pub struct Query(pub Vec<(String, String)>);
impl Query {
    pub fn parse(q: &str) -> Query {
        Query(q.split('&').filter(|x| !x.is_empty()).map(|kv| { let (k, v) = kv.split_once('=').unwrap_or((kv, "")); (pct_decode(k), pct_decode(v)) }).collect())
    }
    pub fn get(&self, k: &str) -> Option<String> { self.0.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()) }
    pub fn val(&self, k: &str) -> Value { self.get(k).map(Value::String).unwrap_or(Value::Null) }
}

/// Runs `f` over `items` with up to `n` worker threads. The calling launch's progress context goes with them.
pub fn pool<T: Sync, F: Fn(&T) -> R<()> + Sync>(items: &[T], n: usize, f: F) -> R<()> {
    let next = AtomicUsize::new(0);
    let err: Mutex<Option<Error>> = Mutex::new(None);
    let ctx = crate::state::ctx_get();
    std::thread::scope(|sc| {
        for _ in 0..n.min(items.len()) {
            sc.spawn(|| {
                crate::state::ctx_set(ctx.clone());
                loop {
                    if err.lock().map(|e| e.is_some()).unwrap_or(true) { break; }
                    let i = next.fetch_add(1, AO::SeqCst);
                    if i >= items.len() { break; }
                    if let Err(e) = f(&items[i]) { if let Ok(mut g) = err.lock() { g.get_or_insert(e); } break; }
                }
            });
        }
    });
    match err.into_inner().ok().flatten() { Some(e) => Err(e), None => Ok(()) }
}

/// Lowercases ids the way the profile and import code does: "My Pack!" -> "my-pack".
pub fn slug_id(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() { out.push(c); dash = false; } else if !dash { out.push('-'); dash = true; }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() { fallback.into() } else { t }
}
/// name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim()
pub fn safe_file_name(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && (*c as u32) >= 0x20).collect::<String>().trim().to_string()
}
/// JavaScript's String.prototype.trim also strips these.
pub fn js_trim(s: &str) -> &str { s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') }
/// .slice(0, n) by UTF-16 units, close enough: by characters.
pub fn slice_chars(s: &str, n: usize) -> String { s.chars().take(n).collect() }
