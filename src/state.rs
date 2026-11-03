// Launcher state: settings, config and profiles, accounts, running games, and the event stream to the UI.
use crate::util::*;
use crate::assets;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::mpsc::Sender;
use std::sync::{LazyLock, Mutex, MutexGuard};

pub const DEFAULT_SETTINGS: &[(&str, fn() -> Value)] = &[
    ("ramGB", || json!(4)),
    ("customResolution", || json!(false)),
    ("width", || json!(1280)),
    ("height", || json!(720)),
    ("fullscreen", || json!(false)),
    ("javaPath", || json!("")),
    ("keepOpen", || json!(true)),
    ("selectedServer", || json!("")),
    ("notifications", || json!(true)),
    ("discordPresence", || json!(true)),
    ("updateCheck", || json!(true)),
    ("accent", || json!("")),
];
pub fn default_settings() -> Obj { DEFAULT_SETTINGS.iter().map(|(k, f)| (k.to_string(), f())).collect() }

// One entry per profile that is starting or running: several profiles can play at once, each with its own account.
pub struct Game {
    pub state: String,
    pub pid: Option<u32>,
    pub server_id: String,
    pub progress: Value,
    pub logs: Vec<String>,
    pub user_stopped: bool,
    pub account_id: String,
    pub account_name: String,
    pub started_at: i64,
    pub join: String,
}

pub struct State {
    pub settings: Obj,
    pub config: Obj,
    pub accounts: Vec<Value>,
    pub active: String,
    pub games: IndexMap<String, Game>,
    pub own_client_versions: Vec<String>,
    pub pending_play: String,
    pub version_cache: Option<Value>,
}
pub static ST: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State {
    settings: default_settings(), config: Obj::new(), accounts: Vec::new(), active: String::new(), games: IndexMap::new(),
    own_client_versions: Vec::new(), pending_play: String::new(), version_cache: None,
}));
pub fn st() -> MutexGuard<'static, State> { ST.lock().unwrap_or_else(|e| e.into_inner()) }

pub fn account_id(a: &Value) -> String { gs(g(a, "profile"), "id") }

impl State {
    pub fn setting(&self, k: &str) -> Value { self.settings.get(k).cloned().unwrap_or(Value::Null) }
    pub fn servers(&self) -> &Vec<Value> {
        static EMPTY: Vec<Value> = Vec::new();
        self.config.get("servers").and_then(|v| v.as_array()).unwrap_or(&EMPTY)
    }
    pub fn servers_mut(&mut self) -> &mut Vec<Value> {
        if !self.config.get("servers").map_or(false, |v| v.is_array()) { self.config.insert("servers".into(), json!([])); }
        self.config.get_mut("servers").unwrap().as_array_mut().unwrap()
    }
    pub fn find_server(&self, id: &str) -> Option<Value> { self.servers().iter().find(|s| g(s, "id").as_str() == Some(id)).cloned() }
    pub fn server_mut(&mut self, id: &str) -> Option<&mut Value> { self.servers_mut().iter_mut().find(|s| g(s, "id").as_str() == Some(id)) }
    /// serverById: the profile with this id, else the first one.
    pub fn server_by(&self, id: &Value) -> Value {
        id.as_str().and_then(|i| self.find_server(i)).or_else(|| self.servers().first().cloned()).unwrap_or(Value::Null)
    }
    pub fn save_servers(&self) -> R<()> { write_json(&p().servers, &Value::Array(self.servers().clone())) }
    pub fn save_settings(&self) -> R<()> { write_json(&p().settings, &Value::Object(self.settings.clone())) }
    pub fn account(&self) -> Option<&Value> { self.accounts.iter().find(|a| account_id(a) == self.active) }
    pub fn save_account(&self) -> R<()> {
        if self.accounts.is_empty() { rm_force(&p().account); return Ok(()); }
        write_json(&p().account, &json!({ "active": self.account().map(account_id).unwrap_or_default(), "list": self.accounts }))
    }
    // Replace the stored copy of an account (matched by profile id) or add it, and make it the active one.
    pub fn set_account(&mut self, a: Value, activate: bool) {
        let id = account_id(&a);
        match self.accounts.iter().position(|x| account_id(x) == id) { Some(i) => self.accounts[i] = a, None => self.accounts.push(a) }
        if activate { self.active = id; }
    }
    pub fn drop_account(&mut self, id: &str) {
        let was_active = self.account().map(account_id).as_deref() == Some(id) || self.account().is_none();
        self.accounts.retain(|x| account_id(x) != id);
        if was_active { self.active = self.accounts.first().map(account_id).unwrap_or_default(); }
    }
    pub fn account_list(&self) -> Value {
        let active = self.account().map(account_id).unwrap_or_default();
        Value::Array(self.accounts.iter().map(|a| {
            let p = g(a, "profile");
            json!({ "id": account_id(a), "name": if p.is_object() { g(p, "name").clone() } else { json!("?") }, "active": account_id(a) == active })
        }).collect())
    }
    pub fn game(&mut self, id: &str) -> &mut Game {
        self.games.entry(id.to_string()).or_insert_with(|| Game {
            state: "idle".into(), pid: None, server_id: id.to_string(), progress: Value::Null, logs: Vec::new(), user_stopped: false,
            account_id: String::new(), account_name: String::new(), started_at: 0, join: String::new(),
        })
    }
    pub fn any_running(&self) -> bool { self.games.values().any(|g| g.state != "idle") }
    pub fn profile_busy(&self, id: &str) -> bool { self.games.get(id).map_or(false, |g| g.state != "idle") }
    pub fn games_summary(&self) -> Value {
        Value::Object(self.games.values().map(|g| (g.server_id.clone(), json!({ "state": g.state, "progress": g.progress, "account": g.account_name }))).collect())
    }
    pub fn auth_mode(&self) -> &'static str { if truthy(self.config.get("microsoftClientId").unwrap_or(&NULL)) { "azure" } else { "launcher" } }
}

pub fn public_profile_of(a: Option<&Value>) -> Value {
    let Some(a) = a else { return Value::Null };
    let p = g(a, "profile");
    if !p.is_object() { return Value::Null; }
    let skins = arr(g(p, "skins"));
    let skin = skins.iter().find(|s| g(s, "state").as_str() == Some("ACTIVE")).or_else(|| skins.first());
    let mut out = Obj::new();
    if let Some(v) = p.get("id") { out.insert("id".into(), v.clone()); }
    if let Some(v) = p.get("name") { out.insert("name".into(), v.clone()); }
    out.insert("skin".into(), match skin {
        Some(s) => { let v = g(s, "variant"); json!({ "url": g(s, "url"), "variant": if truthy(v) { js_string(v) } else { "CLASSIC".into() }.to_uppercase() }) }
        None => Value::Null,
    });
    out.insert("capes".into(), Value::Array(arr(g(p, "capes")).iter().map(|c| json!({ "id": g(c, "id"), "alias": g(c, "alias"), "url": g(c, "url"), "active": g(c, "state").as_str() == Some("ACTIVE") })).collect()));
    Value::Object(out)
}
pub fn public_profile() -> Value { let s = st(); public_profile_of(s.account()) }

pub fn load_state() -> R<()> {
    let pp = p();
    ensure_dir(&pp.data)?;
    let mut settings = default_settings();
    if let Some(Value::Object(m)) = read_json(&pp.settings) { for (k, v) in m { settings.insert(k, v); } }
    let bundled: Value = serde_json::from_slice(assets::CONFIG)?;
    if !exists(&pp.config) { write_json(&pp.config, &bundled)?; }
    let user = read_json(&pp.config).unwrap_or_else(|| bundled.clone());
    let mut config = obj(bundled.clone());
    if let Value::Object(m) = user { for (k, v) in m { config.insert(k, v); } }
    if let Some(Value::Array(own)) = read_json(&pp.servers) { if !own.is_empty() { config.insert("servers".into(), Value::Array(own)); } }
    let remote = gs(&Value::Object(config.clone()), "remoteConfigUrl");
    if !remote.is_empty() {
        match crate::net::get_json(&remote) {
            Ok(r) => { for k in ["servers", "brand"] { if truthy(g(&r, k)) { config.insert(k.into(), r[k].clone()); } } }
            Err(e) => log_line(&format!("remote config failed {}", e.msg)),
        }
    }
    if !config.get("servers").map_or(false, |v| v.as_array().map_or(false, |a| !a.is_empty())) { config.insert("servers".into(), bundled["servers"].clone()); }
    if let Some(Value::Array(list)) = config.get_mut("servers") { for sv in list.iter_mut() { if let Value::Object(m) = sv { m.insert("client".into(), json!(true)); } } }
    let sel = settings.get("selectedServer").cloned().unwrap_or(Value::Null);
    let servers = config["servers"].as_array().cloned().unwrap_or_default();
    if !servers.iter().any(|s| g(s, "id") == &sel) { settings.insert("selectedServer".into(), g(&servers[0], "id").clone()); }
    let stored = read_json(&pp.account);
    let accounts: Vec<Value> = match &stored {
        None => Vec::new(),
        Some(s) if g(s, "list").is_array() => arr(g(s, "list")).to_vec(),
        Some(s) if truthy(g(s, "msRefresh")) => vec![s.clone()],
        _ => Vec::new(),
    };
    let want = stored.as_ref().map(|s| g(s, "active").clone()).unwrap_or(Value::Null);
    let active = accounts.iter().find(|a| g(a, "profile").is_object() && g(g(a, "profile"), "id") == &want).or_else(|| accounts.first()).map(account_id).unwrap_or_default();
    let mut s = st();
    s.settings = settings;
    s.config = config;
    s.accounts = accounts;
    s.active = active;
    Ok(())
}

// ---------- events (SSE) ----------
pub static CLIENTS: LazyLock<Mutex<Vec<(u64, Sender<String>)>>> = LazyLock::new(|| Mutex::new(Vec::new()));
pub fn broadcast(ev: Value) {
    let data = format!("data: {}\n\n", serde_json::to_string(&ev).unwrap_or_default());
    if let Ok(c) = CLIENTS.lock() { for (_, tx) in c.iter() { let _ = tx.send(data.clone()); } }
}
pub fn client_count() -> usize { CLIENTS.lock().map(|c| c.len()).unwrap_or(0) }

// Progress belongs to the launch it runs inside, so parallel launches report separately.
thread_local! { static CTX: RefCell<Option<String>> = const { RefCell::new(None) }; }
pub fn ctx_get() -> Option<String> { CTX.with(|c| c.borrow().clone()) }
pub fn ctx_set(v: Option<String>) { CTX.with(|c| *c.borrow_mut() = v); }
pub fn set_progress(stage: &str, done: usize, total: usize) {
    let id = ctx_get();
    let progress = json!({ "stage": stage, "done": done, "total": total });
    if let Some(id) = &id { if let Some(g) = st().games.get_mut(id) { g.progress = progress; } }
    broadcast(json!({ "type": "progress", "serverId": id, "stage": stage, "done": done, "total": total }));
}
/// Records lines from an installer run inside the current launch.
pub fn ctx_log(lines: &[String]) {
    if let Some(id) = ctx_get() { if let Some(g) = st().games.get_mut(&id) { g.logs.extend_from_slice(lines); } }
}
pub fn set_game_state(id: &str, state: &str, extra: Obj) {
    let (account, any) = {
        let mut s = st();
        let g = s.game(id);
        g.state = state.to_string();
        if state == "idle" { g.progress = Value::Null; }
        let account = g.account_name.clone();
        (account, s.any_running())
    };
    crate::win::mem_hint(any);
    let mut ev = obj(json!({ "type": "game", "state": state, "serverId": id, "account": account }));
    for (k, v) in extra { ev.insert(k, v); }
    broadcast(Value::Object(ev));
}
