// Microsoft / Minecraft auth. Two sign-in modes:
//  - "launcher" (default, no setup): the Minecraft Launcher's public client ID through login.live.com.
//  - "azure": your own Azure app ID through login.microsoftonline.com (needs Mojang approval).
use crate::net::*;
use crate::state::*;
use crate::util::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const LAUNCHER_CLIENT_ID: &str = "00000000402b5328";
struct Mode {
    scope: &'static str,
    device_url: &'static str,
    token_url: &'static str,
    ticket_prefix: &'static str,
    device_extra: &'static [(&'static str, &'static str)],
}
fn mode_of(m: &str) -> Mode {
    if m == "launcher" {
        Mode { scope: "service::user.auth.xboxlive.com::MBI_SSL", device_url: "https://login.live.com/oauth20_connect.srf", token_url: "https://login.live.com/oauth20_token.srf", ticket_prefix: "", device_extra: &[("response_type", "device_code")] }
    } else {
        Mode { scope: "XboxLive.signin offline_access", device_url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", token_url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token", ticket_prefix: "d=", device_extra: &[] }
    }
}
fn client_id(m: &str) -> String { if m == "launcher" { LAUNCHER_CLIENT_ID.into() } else { st().config.get("microsoftClientId").map(str_or).unwrap_or_default() } }

static FLOW: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn ms_to_minecraft(ms_access: &str, mode: &str) -> R<Obj> {
    let xbl = post_json("https://user.auth.xboxlive.com/user/authenticate", &json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("{}{}", mode_of(mode).ticket_prefix, ms_access) },
        "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT",
    }))?;
    let uhs = js_string(g(&xbl["DisplayClaims"]["xui"][0], "uhs"));
    let xsts = match post_json("https://xsts.auth.xboxlive.com/xsts/authorize", &json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [g(&xbl, "Token")] },
        "RelyingParty": "rp://api.minecraftservices.com/", "TokenType": "JWT",
    })) {
        Ok(x) => x,
        Err(e) => {
            match g(&e.body, "XErr").as_i64() {
                Some(2148916233) => bail!("This Microsoft account has no Xbox profile. Sign in at minecraft.net once, then try again."),
                Some(2148916235) => bail!("Xbox Live is not available in your country."),
                Some(2148916238) => bail!("This is a child account. An adult must add it to a Microsoft Family first."),
                _ => return Err(e),
            }
        }
    };
    let mc = match post_json("https://api.minecraftservices.com/authentication/login_with_xbox", &json!({ "identityToken": format!("XBL3.0 x={};{}", uhs, js_string(g(&xsts, "Token"))) })) {
        Ok(m) => m,
        Err(e) => {
            if (e.status == 403 || e.status == 401) && mode == "azure" { bail!("Minecraft has not approved your own app ID yet. Clear it in Settings → Account to use the built-in sign-in instead."); }
            return Err(e);
        }
    };
    let token = js_string(g(&mc, "access_token"));
    let profile = match get_json_h("https://api.minecraftservices.com/minecraft/profile", &[("Authorization", &format!("Bearer {}", token))]) {
        Ok(p) => p,
        Err(e) => { if e.status == 404 { bail!("This account does not own Minecraft: Java Edition."); } return Err(e); }
    };
    let expires = now_ms() as f64 + (js_number(g(&mc, "expires_in")) - 60.0) * 1000.0;
    let xid = g(&xsts["DisplayClaims"]["xui"][0], "xid");
    Ok(obj(json!({ "mcToken": token, "mcExpires": num_val(expires), "profile": profile, "xuid": str_or(xid) })))
}

pub fn start_auth() -> R<Value> {
    let mode = st().auth_mode();
    let a = mode_of(mode);
    let cid = client_id(mode);
    let mut form: Vec<(&str, &str)> = vec![("client_id", &cid), ("scope", a.scope)];
    form.extend_from_slice(a.device_extra);
    let dc = post_form(a.device_url, &form)?;
    let flag = Arc::new(AtomicBool::new(false));
    *FLOW.lock().unwrap() = Some(flag.clone());
    let dc2 = dc.clone();
    std::thread::spawn(move || {
        let a = mode_of(mode);
        let mut interval = (num_or(g(&dc2, "interval"), 5.0) * 1000.0) as u64;
        let deadline = now_ms() + (num_or(g(&dc2, "expires_in"), 900.0) * 1000.0) as i64;
        let code = gs(&dc2, "device_code");
        while !flag.load(Ordering::SeqCst) && now_ms() < deadline {
            sleep_ms(interval);
            let res: R<()> = (|| {
                let cid = client_id(mode);
                let tok = post_form(a.token_url, &[("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("client_id", &cid), ("device_code", &code)])?;
                broadcast(json!({ "type": "auth", "status": "working" }));
                let mut acc = obj(json!({ "mode": mode, "msRefresh": g(&tok, "refresh_token") }));
                for (k, v) in ms_to_minecraft(&js_string(g(&tok, "access_token")), mode)? { acc.insert(k, v); }
                let (profile, accounts) = {
                    let mut s = st();
                    s.set_account(Value::Object(acc), true);
                    s.save_account()?;
                    (public_profile_of(s.account()), s.account_list())
                };
                broadcast(json!({ "type": "auth", "status": "success", "profile": profile, "accounts": accounts }));
                Ok(())
            })();
            match res {
                Ok(()) => return,
                Err(e) => {
                    let err = gs(&e.body, "error");
                    if err == "authorization_pending" { continue; }
                    if err == "slow_down" { interval += 5000; continue; }
                    let desc = gs(&e.body, "error_description");
                    broadcast(json!({ "type": "auth", "status": "error", "message": if desc.is_empty() { e.msg } else { desc } }));
                    return;
                }
            }
        }
        if !flag.load(Ordering::SeqCst) { broadcast(json!({ "type": "auth", "status": "error", "message": "The sign-in code expired. Try again." })); }
    });
    let mut out = Obj::new();
    out.insert("userCode".into(), g(&dc, "user_code").clone());
    out.insert("verificationUri".into(), if truthy(g(&dc, "verification_uri")) { dc["verification_uri"].clone() } else { json!("https://www.microsoft.com/link") });
    if let Some(v) = dc.get("expires_in") { out.insert("expiresIn".into(), v.clone()); }
    Ok(Value::Object(out))
}
pub fn cancel_auth() { if let Some(f) = FLOW.lock().unwrap().as_ref() { f.store(true, Ordering::SeqCst); } }

/// Returns the account with a valid Minecraft token, refreshing it when it expired. `id` None means the active account.
pub fn ensure_fresh(id: Option<&str>) -> R<Value> {
    let a = {
        let s = st();
        match id { Some(i) => s.accounts.iter().find(|a| account_id(a) == i).cloned(), None => s.account().cloned() }
    };
    let Some(a) = a else { bail!("Sign in with your Microsoft account first.") };
    if js_number(g(&a, "mcExpires")) > now_ms() as f64 { return Ok(a); }
    let mode = { let m = gs(&a, "mode"); if m.is_empty() { "azure".to_string() } else { m } };
    let md = mode_of(&mode);
    let cid = client_id(&mode);
    let refresh = gs(&a, "msRefresh");
    let tok = match post_form(md.token_url, &[("grant_type", "refresh_token"), ("client_id", &cid), ("refresh_token", &refresh), ("scope", md.scope)]) {
        Ok(t) => t,
        Err(e) => {
            if e.status == 400 || e.status == 401 {
                let mut s = st();
                s.drop_account(&account_id(&a));
                s.save_account()?;
                let name = if g(&a, "profile").is_object() { gs(g(&a, "profile"), "name") } else { "this account".into() };
                bail!("The sign-in for {} expired. Sign in again.", name);
            }
            return Err(e);
        }
    };
    let mc = ms_to_minecraft(&js_string(g(&tok, "access_token")), &mode)?;
    let mut fresh = obj(json!({ "mode": mode, "msRefresh": if truthy(g(&tok, "refresh_token")) { tok["refresh_token"].clone() } else { json!(refresh) } }));
    for (k, v) in mc { fresh.insert(k, v); }
    let fresh = Value::Object(fresh);
    let mut s = st();
    let activate = s.account().map(account_id) == Some(account_id(&a));
    s.set_account(fresh.clone(), activate);
    s.save_account()?;
    Ok(fresh)
}

pub fn refresh_profile() -> R<Value> {
    let acc = ensure_fresh(None)?;
    let profile = get_json_h("https://api.minecraftservices.com/minecraft/profile", &[("Authorization", &format!("Bearer {}", gs(&acc, "mcToken")))])?;
    let mut s = st();
    let id = account_id(&acc);
    if let Some(a) = s.accounts.iter_mut().find(|x| account_id(x) == id) { a["profile"] = profile; }
    s.save_account()?;
    Ok(public_profile_of(s.account()))
}

fn mc_request(method: &str, url: &str, body: Option<(&str, &[u8])>) -> R<u16> {
    let acc = ensure_fresh(None)?;
    let auth = format!("Bearer {}", gs(&acc, "mcToken"));
    let ua = ua();
    let mut h: Vec<(&str, &str)> = vec![("Authorization", &auth), ("User-Agent", &ua)];
    if let Some((ct, _)) = body { h.push(("Content-Type", ct)); }
    Ok(fetch(method, url, &h, body.map(|b| b.1), None)?.status)
}
pub fn apply_skin(id: &str) -> R<Value> {
    ensure_fresh(None)?;
    let lib = skin_library();
    let Some(item) = lib.iter().find(|s| g(s, "id").as_str() == Some(id)) else { bail!("That skin is not in your library.") };
    let png = std::fs::read(p().skins.join(format!("{}.png", id)))?;
    let boundary = format!("----auroria{}", random_hex(8));
    let mut body = Vec::new();
    body.extend(format!("--{b}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{}\r\n", if gs(item, "variant") == "SLIM" { "slim" } else { "classic" }, b = boundary).as_bytes());
    body.extend(format!("--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n", b = boundary).as_bytes());
    body.extend(&png);
    body.extend(format!("\r\n--{}--\r\n", boundary).as_bytes());
    let ct = format!("multipart/form-data; boundary={}", boundary);
    let status = mc_request("POST", "https://api.minecraftservices.com/minecraft/profile/skins", Some((&ct, &body)))?;
    if !(200..300).contains(&status) { bail!("Minecraft refused the skin (HTTP {}).", status); }
    refresh_profile()
}
pub fn apply_cape(cape: Option<String>) -> R<Value> {
    let url = "https://api.minecraftservices.com/minecraft/profile/capes/active";
    let status = match cape {
        Some(c) => mc_request("PUT", url, Some(("application/json", serde_json::to_string(&json!({ "capeId": c }))?.as_bytes())))?,
        None => mc_request("DELETE", url, None)?,
    };
    if !(200..300).contains(&status) { bail!("Could not change cape (HTTP {}).", status); }
    refresh_profile()
}
pub fn skin_library() -> Vec<Value> { read_json(&p().skins.join("library.json")).and_then(|v| v.as_array().cloned()).unwrap_or_default() }
pub fn save_skin_library(lib: &[Value]) -> R<()> { write_json(&p().skins.join("library.json"), &Value::Array(lib.to_vec())) }
