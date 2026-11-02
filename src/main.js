'use strict';
// Auroria Launcher — backend.
// Runs as a single Windows executable (Node SEA). Serves the UI on 127.0.0.1 and
// opens it in a chromeless Microsoft Edge app window. Uses only Node built-ins.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const zlib = require('zlib');
const { spawn } = require('child_process');

const VERSION = '1.2.1';
const UA = `Auroria-Launcher/${VERSION}`;
const IS_WIN = process.platform === 'win32';

// ---------- embedded assets ----------
let sea = null;
try { sea = require('node:sea'); } catch { sea = null; }
const IS_SEA = !!(sea && sea.isSea && sea.isSea());
function asset(name) {
  if (IS_SEA) return Buffer.from(sea.getAsset(name));
  return fs.readFileSync(path.join(__dirname, name));
}

// ---------- paths ----------
const DATA = IS_WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Auroria')
  : path.join(os.homedir(), '.auroria');
const P = {
  data: DATA,
  runtime: path.join(DATA, 'runtime'),
  versions: path.join(DATA, 'versions'),
  libraries: path.join(DATA, 'libraries'),
  assets: path.join(DATA, 'assets'),
  instances: path.join(DATA, 'instances'),
  skins: path.join(DATA, 'skins'),
  settings: path.join(DATA, 'settings.json'),
  account: path.join(DATA, 'account.json'),
  config: path.join(DATA, 'config.json'),
  servers: path.join(DATA, 'servers.json'),
  lock: path.join(DATA, 'instance.json'),
  log: path.join(DATA, 'launcher.log'),
  client: path.join(DATA, 'client'),
};

const DEFAULT_SETTINGS = {
  ramGB: 4,
  customResolution: false,
  width: 1280,
  height: 720,
  fullscreen: false,
  javaPath: '',
  keepOpen: true,
  selectedServer: '',
  notifications: true,
  discordPresence: true,
  updateCheck: true,
  accent: '',
};

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); }
async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
async function readJson(p, fallback) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; } }
async function writeJson(p, v) { await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(v, null, 2)); }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function logLine(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(P.log, line); } catch {}
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

function netError(url, e) {
  let host = url; try { host = new URL(url).host; } catch {}
  const err = new Error(`Could not reach ${host}. Check your internet connection and try again.`);
  err.cause = e; return err;
}
async function getJson(url, opts = {}) {
  let res;
  try { res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } }); }
  catch (e) { throw netError(url, e); }
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
function postJson(url, data, headers = {}) {
  return getJson(url, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', ...headers } });
}
function postForm(url, data) {
  return getJson(url, { method: 'POST', body: new URLSearchParams(data).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

// Download with size/sha1 check and retries. Skips files that already exist with the right size.
async function download(url, dest, { sha1: want, size } = {}) {
  try {
    const st = await fsp.stat(dest);
    if (size ? st.size === size : st.size > 0) return false;
  } catch {}
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let res;
      try { res = await fetch(url, { headers: { 'User-Agent': UA } }); } catch (e) { throw netError(url, e); }
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${path.basename(dest)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (want && sha1(buf) !== want) throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
      await ensureDir(path.dirname(dest));
      const tmp = dest + '.part';
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      return true;
    } catch (e) { lastErr = e; await sleep(500 * (attempt + 1)); }
  }
  throw lastErr;
}

// ---------- state ----------
let settings = { ...DEFAULT_SETTINGS };
let config = {};
let account = null; // active account: { msRefresh, mcToken, mcExpires, profile }
let accounts = []; // every signed-in account; `account` is one of them
let game = { state: 'idle', proc: null, serverId: null, progress: null, logs: [] };

async function loadState() {
  await ensureDir(DATA);
  settings = { ...DEFAULT_SETTINGS, ...(await readJson(P.settings, {})) };
  const bundled = JSON.parse(asset('config.json').toString('utf8'));
  if (!(await exists(P.config))) await writeJson(P.config, bundled);
  const user = await readJson(P.config, bundled);
  config = { ...bundled, ...user };
  const own = await readJson(P.servers, null);
  if (Array.isArray(own) && own.length) config.servers = own;
  if (config.remoteConfigUrl) {
    try {
      const remote = await getJson(config.remoteConfigUrl);
      for (const k of ['servers', 'brand']) if (remote && remote[k]) config[k] = remote[k];
    } catch (e) { logLine('remote config failed', e.message); }
  }
  if (!Array.isArray(config.servers) || !config.servers.length) config.servers = bundled.servers;
  for (const sv of config.servers) sv.client = true;
  if (!config.servers.find((s) => s.id === settings.selectedServer)) settings.selectedServer = config.servers[0].id;
  const stored = await readJson(P.account, null);
  accounts = !stored ? [] : Array.isArray(stored.list) ? stored.list : stored.msRefresh ? [stored] : [];
  account = accounts.find((a) => a.profile && a.profile.id === (stored && stored.active)) || accounts[0] || null;
}
const saveSettings = () => writeJson(P.settings, settings);
const accountId = (a) => (a && a.profile ? a.profile.id : '');
const saveAccount = () => (accounts.length ? writeJson(P.account, { active: accountId(account), list: accounts }) : fsp.rm(P.account, { force: true }));
// Replace the stored copy of an account (matched by profile id) or add it, and make it the active one.
function setAccount(a) {
  const i = accounts.findIndex((x) => accountId(x) === accountId(a));
  if (i >= 0) accounts[i] = a; else accounts.push(a);
  account = a;
}
function dropAccount(a) {
  accounts = accounts.filter((x) => accountId(x) !== accountId(a));
  if (account === a || accountId(account) === accountId(a)) account = accounts[0] || null;
}
const accountList = () => accounts.map((a) => ({ id: accountId(a), name: a.profile ? a.profile.name : '?', active: accountId(a) === accountId(account) }));

// ---------- events (SSE) ----------
const clients = new Set();
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}
function setProgress(stage, done, total) {
  game.progress = { stage, done, total };
  broadcast({ type: 'progress', ...game.progress });
}
function setGameState(state, extra = {}) {
  game.state = state;
  broadcast({ type: 'game', state, serverId: game.serverId, ...extra });
}

// ---------- Microsoft / Minecraft auth ----------
// Two sign-in modes:
//  - "launcher" (default, no setup): the Minecraft Launcher's public client ID through login.live.com.
//  - "azure": your own Azure app ID through login.microsoftonline.com (needs Mojang approval).
const LAUNCHER_CLIENT_ID = '00000000402b5328';
const AUTH = {
  launcher: {
    clientId: () => LAUNCHER_CLIENT_ID,
    scope: 'service::user.auth.xboxlive.com::MBI_SSL',
    deviceUrl: 'https://login.live.com/oauth20_connect.srf',
    tokenUrl: 'https://login.live.com/oauth20_token.srf',
    ticket: (t) => t,
    deviceExtra: { response_type: 'device_code' },
  },
  azure: {
    clientId: () => config.microsoftClientId,
    scope: 'XboxLive.signin offline_access',
    deviceUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    ticket: (t) => `d=${t}`,
    deviceExtra: {},
  },
};
const authMode = () => (config.microsoftClientId ? 'azure' : 'launcher');
let authFlow = null;

async function msToMinecraft(msAccess, mode) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: AUTH[mode].ticket(msAccess) },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
  });
  const uhs = xbl.DisplayClaims.xui[0].uhs;
  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    });
  } catch (e) {
    const code = e.body && e.body.XErr;
    if (code === 2148916233) throw new Error('This Microsoft account has no Xbox profile. Sign in at minecraft.net once, then try again.');
    if (code === 2148916235) throw new Error('Xbox Live is not available in your country.');
    if (code === 2148916238) throw new Error('This is a child account. An adult must add it to a Microsoft Family first.');
    throw e;
  }
  let mc;
  try {
    mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  } catch (e) {
    if ((e.status === 403 || e.status === 401) && mode === 'azure') throw new Error('Minecraft has not approved your own app ID yet. Clear it in Settings → Account to use the built-in sign-in instead.');
    throw e;
  }
  let profile;
  try {
    profile = await getJson('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${mc.access_token}` } });
  } catch (e) {
    if (e.status === 404) throw new Error('This account does not own Minecraft: Java Edition.');
    throw e;
  }
  return { mcToken: mc.access_token, mcExpires: Date.now() + (mc.expires_in - 60) * 1000, profile, xuid: (xsts.DisplayClaims.xui[0] || {}).xid || '' };
}

async function startAuth() {
  const mode = authMode(); const A = AUTH[mode];
  const dc = await postForm(A.deviceUrl, { client_id: A.clientId(), scope: A.scope, ...A.deviceExtra });
  const flow = { cancelled: false };
  authFlow = flow;
  (async () => {
    let interval = (dc.interval || 5) * 1000;
    const deadline = Date.now() + (dc.expires_in || 900) * 1000;
    while (!flow.cancelled && Date.now() < deadline) {
      await sleep(interval);
      try {
        const tok = await postForm(A.tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: A.clientId(), device_code: dc.device_code });
        broadcast({ type: 'auth', status: 'working' });
        const mc = await msToMinecraft(tok.access_token, mode);
        setAccount({ mode, msRefresh: tok.refresh_token, ...mc });
        await saveAccount();
        broadcast({ type: 'auth', status: 'success', profile: publicProfile(), accounts: accountList() });
        return;
      } catch (e) {
        const err = e.body && e.body.error;
        if (err === 'authorization_pending') continue;
        if (err === 'slow_down') { interval += 5000; continue; }
        broadcast({ type: 'auth', status: 'error', message: (e.body && e.body.error_description) || e.message });
        return;
      }
    }
    if (!flow.cancelled) broadcast({ type: 'auth', status: 'error', message: 'The sign-in code expired. Try again.' });
  })();
  return { userCode: dc.user_code, verificationUri: dc.verification_uri || 'https://www.microsoft.com/link', expiresIn: dc.expires_in };
}

async function ensureFreshAccount() {
  if (!account) throw new Error('Sign in with your Microsoft account first.');
  if (account.mcExpires > Date.now()) return account;
  const mode = account.mode || 'azure'; const A = AUTH[mode];
  let tok;
  try { tok = await postForm(A.tokenUrl, { grant_type: 'refresh_token', client_id: A.clientId(), refresh_token: account.msRefresh, scope: A.scope }); }
  catch (e) { if (e.status === 400 || e.status === 401) { dropAccount(account); await saveAccount(); throw new Error('Your sign-in expired. Sign in again.'); } throw e; }
  const mc = await msToMinecraft(tok.access_token, mode);
  setAccount({ mode, msRefresh: tok.refresh_token || account.msRefresh, ...mc });
  await saveAccount();
  return account;
}
function publicProfile() {
  if (!account || !account.profile) return null;
  const p = account.profile;
  const skin = (p.skins || []).find((s) => s.state === 'ACTIVE') || (p.skins || [])[0] || null;
  return {
    id: p.id, name: p.name,
    skin: skin ? { url: skin.url, variant: (skin.variant || 'CLASSIC').toUpperCase() } : null,
    capes: (p.capes || []).map((c) => ({ id: c.id, alias: c.alias, url: c.url, active: c.state === 'ACTIVE' })),
  };
}
async function refreshProfile() {
  const acc = await ensureFreshAccount();
  acc.profile = await getJson('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${acc.mcToken}` } });
  await saveAccount();
  return publicProfile();
}

// ---------- Java runtime (Mojang's own runtimes) ----------
const JAVA_ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
function javaPlatform() {
  if (IS_WIN) return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}
async function ensureJava(component) {
  if (settings.javaPath) return settings.javaPath;
  const dir = path.join(P.runtime, component);
  const exe = path.join(dir, 'bin', IS_WIN ? 'javaw.exe' : 'java');
  const marker = path.join(dir, '.complete');
  if (await exists(marker)) return exe;
  setProgress('Downloading Java', 0, 1);
  const all = await getJson(JAVA_ALL);
  const entry = ((all[javaPlatform()] || {})[component] || [])[0];
  if (!entry) throw new Error(`No Java runtime "${component}" for this computer.`);
  const manifest = await getJson(entry.manifest.url);
  const files = Object.entries(manifest.files).filter(([, f]) => f.type === 'file');
  for (const [rel, f] of Object.entries(manifest.files)) if (f.type === 'directory') await ensureDir(path.join(dir, rel));
  let done = 0;
  await pool(files, 12, async ([rel, f]) => {
    const raw = f.downloads.raw;
    const dest = path.join(dir, rel);
    await download(raw.url, dest, { sha1: raw.sha1, size: raw.size });
    if (f.executable && !IS_WIN) await fsp.chmod(dest, 0o755);
    setProgress('Downloading Java', ++done, files.length);
  });
  await fsp.writeFile(marker, entry.version.name || component);
  return exe;
}

// ---------- game files ----------
const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let versionCache = null;
const OS_NAME = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

function ruleAllows(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== OS_NAME) match = false;
      if (r.os.arch && r.os.arch === 'x86' && process.arch !== 'ia32') match = false;
      if (r.os.version) { try { if (!new RegExp(r.os.version).test(os.release())) match = false; } catch {} }
    }
    if (r.features) for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}
function mavenPath(name) {
  const [group, artifact, version, classifier] = name.split(':');
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}
function libKey(name) { const p = name.split(':'); return p[0] + ':' + p[1] + (p[3] ? ':' + p[3] : ''); }

async function loadVanilla(id) {
  const file = path.join(P.versions, id, `${id}.json`);
  let v = await readJson(file, null);
  if (!v) {
    const manifest = await getJson(VERSION_MANIFEST);
    const entry = manifest.versions.find((x) => x.id === id);
    if (!entry) throw new Error(`Minecraft ${id} was not found.`);
    v = await getJson(entry.url);
    await writeJson(file, v);
  }
  return v;
}
// ---------- loaders ----------
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const LOADER_NAME = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
function cmpVer(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number), pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
function neoToMc(v) { const [a, b] = String(v).split('.'); return b === '0' ? `1.${a}` : `1.${a}.${b}`; }
async function getText(url) {
  let res; try { res = await fetch(url, { headers: { 'User-Agent': UA } }); } catch (e) { throw netError(url, e); }
  if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e; }
  return res.text();
}
async function loaderVersions(loader, mc) {
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? FABRIC_META : QUILT_META;
    let list;
    try { list = await getJson(`${base}/versions/loader/${encodeURIComponent(mc)}`); } catch (e) { if (e.status === 400 || e.status === 404) return []; throw e; }
    return list.map((x) => ({ id: x.loader.version, stable: x.loader.stable !== false && !/beta|pre|rc/i.test(x.loader.version) }));
  }
  if (loader === 'forge') {
    const xml = await getText(`${FORGE_MAVEN}/maven-metadata.xml`);
    const ids = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter((v) => v.startsWith(mc + '-')).map((v) => v.slice(mc.length + 1));
    let promos = {}; try { promos = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos || {}; } catch {}
    const rec = promos[`${mc}-recommended`];
    return ids.sort((a, b) => cmpVer(b, a)).map((id) => ({ id, stable: true, recommended: id === rec }));
  }
  if (loader === 'neoforge') {
    const r = await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    return (r.versions || []).filter((v) => neoToMc(v) === mc).sort((a, b) => cmpVer(b, a)).map((id) => ({ id, stable: !/beta|alpha/i.test(id) }));
  }
  return [];
}
async function pickLoaderVersion(server) {
  if (server.loaderVersion) {
    if (server.loader !== 'forge') return server.loaderVersion;
    // Forge for 1.7 to 1.12 publishes "<build>-<mc>" (11.15.1.2318-1.8.9); other launchers store just the build number.
    const known = await loaderVersions('forge', server.version).catch(() => []);
    const hit = known.find((x) => x.id === server.loaderVersion) || known.find((x) => x.id.startsWith(server.loaderVersion + '-'));
    return hit ? hit.id : server.loaderVersion;
  }
  const list = await loaderVersions(server.loader, server.version);
  const v = list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0];
  if (!v) throw new Error(`${LOADER_NAME[server.loader]} has no build for Minecraft ${server.version}.`);
  return v.id;
}
function runJava(java, args, cwd, label) {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn(java, args, { cwd, windowsHide: true });
    const on = (d) => { const lines = d.toString('utf8').split(/\r?\n/).filter(Boolean); out.push(...lines); game.logs.push(...lines.map((l) => `[${label}] ${l}`)); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('error', (e) => resolve({ code: -1, out: [e.message] }));
    p.on('exit', (code) => resolve({ code, out }));
  });
}
// Forge before 1.12.2-14.23.5.2847 has no command-line install. Its installer is a zip holding install_profile.json (the version file
// plus where to put the Forge jar), so install it by hand: write the version json and unpack the universal jar into libraries.
async function installOldForge(inst) {
  const files = zipEntries(await fsp.readFile(inst));
  const profEntry = files.find((f) => f.name === 'install_profile.json');
  if (!profEntry) throw new Error('This Forge installer has an unknown format.');
  const prof = JSON.parse(profEntry.read().toString('utf8'));
  const vi = prof.versionInfo, ins = prof.install;
  if (!vi || !ins || !ins.path || !ins.filePath) throw new Error('This Forge installer has an unknown format.');
  const jar = files.find((f) => f.name === ins.filePath);
  if (!jar) throw new Error(`The Forge installer is missing ${ins.filePath}.`);
  const dest = path.join(P.libraries, mavenPath(ins.path));
  await ensureDir(path.dirname(dest)); await fsp.writeFile(dest, jar.read());
  const id = vi.id || ins.target;
  await ensureDir(path.join(P.versions, id)); await writeJson(path.join(P.versions, id, `${id}.json`), vi);
  return vi;
}
// Forge and NeoForge ship an installer that patches the game; run it headless into our .minecraft-style folder.
async function ensureForgeLike(loader, mc, ver, java, base) {
  // Forge 1.12.2 and older name the version "<mc>-forge<mc>-<ver>", newer ones "<mc>-forge-<ver>".
  const ids = loader === 'forge' ? [`${mc}-forge-${ver}`, `${mc}-forge${mc}-${ver}`] : [`neoforge-${ver}`];
  for (const id of ids) { const cached = await readJson(path.join(P.versions, id, `${id}.json`), null); if (cached) return cached; }
  const name = loader === 'forge' ? `forge-${mc}-${ver}-installer.jar` : `neoforge-${ver}-installer.jar`;
  const url = loader === 'forge' ? `${FORGE_MAVEN}/${mc}-${ver}/${name}` : `${NEO_MAVEN}/${ver}/${name}`;
  const inst = path.join(DATA, 'installers', name);
  setProgress(`Downloading ${LOADER_NAME[loader]}`, 0, 1);
  await download(url, inst);
  await download(base.downloads.client.url, path.join(P.versions, mc, `${mc}.jar`), { sha1: base.downloads.client.sha1, size: base.downloads.client.size });
  const lp = path.join(DATA, 'launcher_profiles.json');
  if (!(await exists(lp))) await writeJson(lp, { profiles: {}, selectedProfile: '' });
  setProgress(`Installing ${LOADER_NAME[loader]} (takes a minute)`, 0, 1);
  const flags = loader === 'forge' ? ['--installClient', '--install-client'] : ['--install-client', '--installClient'];
  let r;
  for (const flag of flags) {
    r = await runJava(java, ['-jar', inst, flag, DATA], DATA, LOADER_NAME[loader]);
    if (r.code === 0) break;
    if (!r.out.join('\n').match(/not a recognized option|UnrecognizedOption|unrecognized/i)) break;
  }
  let json = null;
  for (const id of ids) { json = await readJson(path.join(P.versions, id, `${id}.json`), null); if (json) break; }
  if (!json) {
    for (const d of await fsp.readdir(P.versions).catch(() => [])) {
      const j = await readJson(path.join(P.versions, d, `${d}.json`), null);
      if (j && (!j.inheritsFrom || j.inheritsFrom === mc) && d.toLowerCase().includes(loader === 'forge' ? 'forge' : 'neoforge') && d.includes(ver)) { json = j; break; }
    }
  }
  if (!json && loader === 'forge' && r && /not a recognized option|UnrecognizedOption|unrecognized/i.test(r.out.join('\n'))) json = await installOldForge(inst);
  if (!json) throw new Error(`The ${LOADER_NAME[loader]} installer did not finish. ${(r && r.out.slice(-2).join(' ')) || ''}`.trim());
  return json;
}

// Resolves everything needed to launch a profile, for any Minecraft version and loader.
async function resolveProfile(server) {
  const mc = server.version;
  const loader = LOADERS.includes(server.loader) ? server.loader : 'vanilla';
  const base = await loadVanilla(mc);
  const javaComponent = (base.javaVersion && base.javaVersion.component) || 'jre-legacy';
  let child = null;
  if (loader === 'fabric' || loader === 'quilt') {
    const ver = await pickLoaderVersion({ ...server, loader });
    const id = `${loader}-loader-${ver}-${mc}`;
    const file = path.join(P.versions, id, `${id}.json`);
    child = await readJson(file, null);
    if (!child) {
      const metaBase = loader === 'fabric' ? FABRIC_META : QUILT_META;
      child = await getJson(`${metaBase}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(ver)}/profile/json`);
      child.id = id; await writeJson(file, child);
    }
  } else if (loader === 'forge' || loader === 'neoforge') {
    const ver = await pickLoaderVersion({ ...server, loader });
    const java = await ensureJava(javaComponent);
    child = await ensureForgeLike(loader, mc, ver, java, base);
  }
  const libs = []; const natives = []; const seen = new Set();
  const arch = process.arch === 'ia32' ? '32' : '64';
  const addLib = (l, defaultMaven) => {
    if (!l || !l.name || !ruleAllows(l.rules)) return;
    const nat = l.natives && l.natives[OS_NAME];
    if (nat) {
      const c = l.downloads && l.downloads.classifiers && l.downloads.classifiers[nat.replace('${arch}', arch)];
      if (c) natives.push({ path: c.path, url: c.url, sha1: c.sha1, size: c.size, exclude: (l.extract && l.extract.exclude) || [] });
    }
    const key = libKey(l.name);
    if (seen.has(key)) return;
    const a = l.downloads && l.downloads.artifact;
    if (a) { seen.add(key); libs.push({ path: a.path || mavenPath(l.name), url: a.url || '', sha1: a.sha1, size: a.size }); return; }
    if (!l.downloads) { seen.add(key); const rel = mavenPath(l.name); const alt = ['https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/', 'https://repo1.maven.org/maven2/'].map((h) => h + rel); const host = (l.url || defaultMaven).replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, 'https://maven.minecraftforge.net/').replace(/^http:/, 'https:'); libs.push({ path: rel, url: host.replace(/\/?$/, '/') + rel, alt, sha1: l.sha1, size: l.size }); }
  };
  if (child) for (const l of child.libraries || []) addLib(l, loader === 'quilt' ? 'https://maven.quiltmc.org/repository/release/' : loader === 'fabric' ? 'https://maven.fabricmc.net/' : 'https://libraries.minecraft.net/');
  for (const l of base.libraries || []) addLib(l, 'https://libraries.minecraft.net/');
  let game = [], jvm = [], legacy = null;
  if (base.arguments) { game = base.arguments.game || []; jvm = base.arguments.jvm || []; } else legacy = base.minecraftArguments || '';
  if (child) {
    if (child.arguments) { game = game.concat(child.arguments.game || []); jvm = jvm.concat(child.arguments.jvm || []); }
    if (child.minecraftArguments) legacy = child.minecraftArguments;
  }
  if (legacy !== null) game = legacy.split(' ').filter(Boolean);
  return {
    id: child ? child.id : base.id, jarId: base.id, loader, mainClass: (child && child.mainClass) || base.mainClass,
    libraries: libs, natives, args: { game, jvm }, legacy: !base.arguments,
    assetIndex: base.assetIndex, client: base.downloads.client, type: base.type, javaComponent,
    logging: base.logging && base.logging.client,
  };
}

// Minimal zip reader for unpacking natives in pre-1.19 versions.
async function extractZip(file, destDir, exclude = []) {
  const buf = await fsp.readFile(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`${path.basename(file)} is not a valid archive.`);
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(destDir);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.startsWith('META-INF/') || exclude.some((e) => name.startsWith(e))) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.slice(start, start + csize);
    const outBuf = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : null;
    if (!outBuf) continue;
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep)) continue;
    await ensureDir(path.dirname(dest)); await fsp.writeFile(dest, outBuf);
  }
}

async function installFiles(profile, gameDir) {
  const baseJar = path.join(P.versions, profile.jarId, `${profile.jarId}.jar`);
  setProgress('Downloading Minecraft', 0, 1);
  await download(profile.client.url, baseJar, { sha1: profile.client.sha1, size: profile.client.size });
  let jar = baseJar;
  if (profile.id !== profile.jarId) { // loaders expect the game jar under their own version name
    jar = path.join(P.versions, profile.id, `${profile.id}.jar`);
    const a = await fsp.stat(baseJar), b = await fsp.stat(jar).catch(() => null);
    if (!b || b.size !== a.size) { await ensureDir(path.dirname(jar)); await fsp.copyFile(baseJar, jar); }
  }
  let done = 0;
  await pool(profile.libraries, 12, async (l) => {
    const dest = path.join(P.libraries, l.path);
    if (!l.url) { if (!(await exists(dest))) throw new Error(`Missing ${path.basename(dest)}. Delete the profile's loader and try again.`); }
    else {
      let lastErr;
      for (const u of [l.url, ...(l.alt || [])]) { try { await download(u, dest, { sha1: l.sha1, size: l.size }); lastErr = null; break; } catch (e) { lastErr = e; } }
      if (lastErr) throw lastErr;
    }
    setProgress('Downloading libraries', ++done, profile.libraries.length);
  });
  const nativesDir = path.join(P.versions, profile.id, 'natives');
  await ensureDir(nativesDir);
  if (profile.natives.length && !(await exists(path.join(nativesDir, '.done')))) {
    setProgress('Unpacking natives', 0, profile.natives.length);
    for (const n of profile.natives) {
      const f = path.join(P.libraries, n.path);
      await download(n.url, f, { sha1: n.sha1, size: n.size });
      await extractZip(f, nativesDir, n.exclude);
    }
    await fsp.writeFile(path.join(nativesDir, '.done'), '1');
  }
  let logArg = null;
  if (profile.logging && profile.logging.file && profile.logging.argument) {
    const lf = path.join(P.assets, 'log_configs', profile.logging.file.id);
    await download(profile.logging.file.url, lf, { sha1: profile.logging.file.sha1, size: profile.logging.file.size });
    logArg = profile.logging.argument.replace('${path}', lf);
  }
  const idxFile = path.join(P.assets, 'indexes', `${profile.assetIndex.id}.json`);
  await download(profile.assetIndex.url, idxFile, { sha1: profile.assetIndex.sha1, size: profile.assetIndex.size });
  const idx = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
  const entries = Object.entries(idx.objects);
  const uniq = [...new Map(entries.map(([, o]) => [o.hash, o])).values()];
  done = 0;
  await pool(uniq, 24, async (o) => {
    const sub = o.hash.slice(0, 2);
    await download(`https://resources.download.minecraft.net/${sub}/${o.hash}`, path.join(P.assets, 'objects', sub, o.hash), { sha1: o.hash, size: o.size });
    done++;
    if (done % 25 === 0 || done === uniq.length) setProgress('Downloading assets', done, uniq.length);
  });
  let gameAssets = P.assets;
  if (idx.virtual || idx.map_to_resources) { // very old versions read loose files
    gameAssets = idx.map_to_resources ? path.join(gameDir, 'resources') : path.join(P.assets, 'virtual', profile.assetIndex.id);
    for (const [name, o] of entries) {
      const dest = path.join(gameAssets, name);
      if (await exists(dest)) continue;
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(path.join(P.assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
    }
  }
  return { jar, logArg, gameAssets, nativesDir };
}

function substitute(str, vars) { return str.replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }
function expandArgs(list, features, vars) {
  const out = [];
  for (const a of list) {
    if (typeof a === 'string') { out.push(substitute(a, vars)); continue; }
    if (!ruleAllows(a.rules, features)) continue;
    const vals = Array.isArray(a.value) ? a.value : [a.value];
    for (const v of vals) out.push(substitute(v, vars));
  }
  return out;
}
function splitAddress(addr) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(addr.trim());
  return { host: m ? m[1] : addr, port: m && m[2] ? Number(m[2]) : 25565 };
}

// Builds the java argument list. Exported for testing.
function buildLaunchArgs({ profile, jar, gameDir, acc, server, logArg = null, gameAssets = P.assets }) {
  const sep = IS_WIN ? ';' : ':';
  const nativesDir = path.join(P.versions, profile.id, 'natives');
  const classpath = profile.libraries.map((l) => path.join(P.libraries, l.path)).concat(jar).join(sep);
  const hasQuickPlay = JSON.stringify(profile.args.game).includes('quickPlayMultiplayer');
  const joining = !!(server.address && server.address.trim());
  const features = {
    has_custom_resolution: !!settings.customResolution, is_demo_user: false, has_quick_plays_support: false,
    is_quick_play_multiplayer: joining && hasQuickPlay, is_quick_play_singleplayer: false, is_quick_play_realms: false,
  };
  const vars = {
    auth_player_name: acc.profile.name, version_name: profile.id, game_directory: gameDir,
    assets_root: gameAssets, game_assets: gameAssets, assets_index_name: profile.assetIndex.id, auth_uuid: acc.profile.id,
    auth_access_token: acc.mcToken, auth_session: `token:${acc.mcToken}:${acc.profile.id}`, clientid: '', auth_xuid: acc.xuid || '',
    user_type: 'msa', version_type: profile.type || 'release', resolution_width: settings.width,
    resolution_height: settings.height, natives_directory: nativesDir, launcher_name: 'Auroria',
    launcher_version: VERSION, classpath, classpath_separator: sep, library_directory: P.libraries,
    quickPlayMultiplayer: joining ? server.address.trim() : '', user_properties: '{}', profile_name: server.name || 'Auroria',
  };
  const ram = Number(server.ramGB) || settings.ramGB;
  const jvm = [`-Xmx${ram}G`, '-Xms512M', ...(Array.isArray(server.jvmArgs) ? server.jvmArgs.filter((a) => /^-XX:[+-]?\w+(=[\w.]+)?$/.test(a)) : [])];
  if (logArg) jvm.push(logArg);
  jvm.push(...expandArgs(profile.args.jvm, features, vars));
  if (!profile.args.jvm.length) {
    if (IS_WIN) jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    jvm.push(`-Djava.library.path=${nativesDir}`, '-cp', classpath);
  }
  const gameArgs = expandArgs(profile.args.game, features, vars);
  if (settings.customResolution && profile.legacy) gameArgs.push('--width', String(settings.width), '--height', String(settings.height));
  if (joining && !hasQuickPlay) { const { host, port } = splitAddress(server.address); gameArgs.push('--server', host, '--port', String(port)); }
  if (settings.fullscreen) gameArgs.push('--fullscreen');
  return { args: [...jvm, profile.mainClass, ...gameArgs], nativesDir };
}

// ---------- Modrinth mods ----------
const MR = 'https://api.modrinth.com/v2';
const modLoaders = (s) => (s.loader === 'quilt' ? ['quilt', 'fabric'] : [s.loader]);
function serverById(id) { return config.servers.find((s) => s.id === id) || config.servers[0]; }
function instanceDir(server) { return path.join(P.instances, server.id); }
function modsDir(server) { return path.join(instanceDir(server), 'mods'); }
async function modIndex(server) { return readJson(path.join(instanceDir(server), 'auroria-mods.json'), {}); }
async function saveModIndex(server, idx) { return writeJson(path.join(instanceDir(server), 'auroria-mods.json'), idx); }
function mrQuery(server) {
  return `loaders=${encodeURIComponent(JSON.stringify(modLoaders(server)))}&game_versions=${encodeURIComponent(JSON.stringify([server.version]))}`;
}

const PACK_TYPES = {
  mod: { dir: 'mods', loaders: (s) => modLoaders(s), label: 'mod' },
  resourcepack: { dir: 'resourcepacks', loaders: () => ['minecraft'], label: 'resource pack' },
  shader: { dir: 'shaderpacks', loaders: () => ['iris', 'optifine'], label: 'shader' },
};
async function installModProject(server, projectId, visited = new Set(), type = 'mod', have = new Set()) {
  if (visited.has(projectId)) return;
  visited.add(projectId);
  const T = PACK_TYPES[type] || PACK_TYPES.mod;
  const q = `loaders=${encodeURIComponent(JSON.stringify(T.loaders(server)))}&game_versions=${encodeURIComponent(JSON.stringify([server.version]))}`;
  const versions = await getJson(`${MR}/project/${encodeURIComponent(projectId)}/version?${q}`);
  const v = versions[0];
  if (!v) throw new Error(`This ${T.label} has no build for Minecraft ${server.version}${type === 'mod' ? ` on ${server.loader}` : ''}.`);
  const file = v.files.find((f) => f.primary) || v.files[0];
  const dir = path.join(instanceDir(server), T.dir);
  const idx = await modIndex(server);
  const prev = idx[v.project_id];
  if (prev && prev.file !== file.filename) await fsp.rm(path.join(dir, prev.file), { force: true });
  await download(file.url, path.join(dir, file.filename), { sha1: file.hashes.sha1, size: file.size });
  idx[v.project_id] = { ...(idx[v.project_id] || {}), file: file.filename, versionId: v.id, type };
  await saveModIndex(server, idx);
  if (type !== 'mod') return;
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id && !idx[d.project_id] && !have.has(d.project_id)) await installModProject(server, d.project_id, visited, 'mod', have);
  }
}
// After installing a project, removes older jars of it that Auroria did not track (mods from imports, packs or dropped in by hand).
// A replaced jar that was switched off leaves the new one switched off too.
async function dropReplacedJars(server, projectId, before) {
  const cur = (await modIndex(server))[projectId]; if (!cur || !cur.file) return;
  const dir = modsDir(server);
  for (const m of before) {
    if (m.projectId !== projectId || m.file.replace(/\.disabled$/, '') === cur.file) continue;
    await fsp.rm(path.join(dir, m.file), { force: true });
    if (!m.enabled) await fsp.rename(path.join(dir, cur.file), path.join(dir, cur.file + '.disabled')).catch(() => {});
  }
}
// Enabled mods that list this one as a required dependency on Modrinth.
async function modDependents(server, file) {
  const mods = await listMods(server);
  const target = mods.find((m) => m.file === file);
  if (!target || !target.projectId) return [];
  const others = mods.filter((m) => m.enabled && m.file !== file && m.projectId);
  if (!others.length) return [];
  const byHash = await postJson(`${MR}/version_files`, { hashes: others.map((m) => m.sha1), algorithm: 'sha1' }, { 'User-Agent': UA }).catch(() => ({}));
  return others.filter((m) => ((byHash[m.sha1] || {}).dependencies || []).some((d) => d.dependency_type === 'required' && d.project_id === target.projectId)).map((m) => m.title);
}

// ---------- Java picker: installs found on this PC plus Auroria's own runtimes ----------
async function javaRelease(home) {
  try { const t = await fsp.readFile(path.join(home, 'release'), 'utf8'); const m = /JAVA_VERSION="([^"]+)"/.exec(t); if (m) return m[1]; } catch {}
  return '';
}
const javaMajor = (v) => { const p = String(v).split(/[._-]/).map(Number); return p[0] === 1 ? p[1] || 0 : p[0] || 0; };
async function detectJavas() {
  const exeName = IS_WIN ? 'javaw.exe' : 'java';
  const homes = new Map();
  const addHome = (home, source) => { const k = path.resolve(home).toLowerCase(); if (!homes.has(k)) homes.set(k, { home: path.resolve(home), source }); };
  const scan = async (root, source, depth = 1) => {
    let ents = []; try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory()) { const d = path.join(root, e.name); if (await exists(path.join(d, 'bin', exeName))) addHome(d, source); else if (depth > 1) await scan(d, source, depth - 1); }
  };
  if (IS_WIN) {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Zulu', 'Microsoft', 'BellSoft', 'Amazon Corretto', 'Semeru', 'AdoptOpenJDK', 'GraalVM']) await scan(path.join(pf, vendor), vendor === 'Java' ? 'Oracle / OpenJDK' : vendor);
    }
    await scan(path.join(os.homedir(), '.jdks'), 'IntelliJ');
  } else {
    await scan('/usr/lib/jvm', 'System'); await scan('/Library/Java/JavaVirtualMachines', 'System', 3);
  }
  if (process.env.JAVA_HOME && await exists(path.join(process.env.JAVA_HOME, 'bin', exeName))) addHome(process.env.JAVA_HOME, 'JAVA_HOME');
  await scan(P.runtime, 'Auroria');
  const list = [];
  for (const { home, source } of homes.values()) {
    let version = await javaRelease(home);
    if (!version && source === 'Auroria') { try { version = (await fsp.readFile(path.join(home, '.complete'), 'utf8')).trim(); } catch {} }
    list.push({ path: path.join(home, 'bin', exeName), version: version || 'unknown', major: javaMajor(version), source });
  }
  return list.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}
// ---------- Auroria Client: curated Lunar-style mods + in-game UI pack ----------
const CLIENT_MODS = [
  { slug: 'fabric-api', what: 'Fabric API' },
  { slug: 'sodium', what: 'Faster rendering' },
  { slug: 'lithium', what: 'Faster game logic' },
  { slug: 'ferrite-core', what: 'Lower memory use' },
  { slug: 'entityculling', what: 'Skips hidden entities' },
  { slug: 'immediatelyfast', what: 'Faster HUD and text' },
  { slug: 'axolotlclient', what: 'HUD, keystrokes, CPS, FPS, zoom, freelook' },
  { slug: 'modmenu', what: 'In-game mod list' },
];
const PACK_FILE = 'Auroria-UI.zip';
const clientModded = (s) => s.loader === 'fabric' || s.loader === 'quilt';
function packSupported(v) {
  let m = /^1\.(\d+)/.exec(v); if (m) return Number(m[1]) >= 20;
  m = /^(\d\d)w\d\d/.exec(v); if (m) return Number(m[1]) >= 23;
  return false;
}
// ---------- Auroria Client: our own Fabric mod, used instead of AxolotlClient on the versions it supports ----------
const OWN_JAR = 'auroria-client.jar';
let ownClientVersions = [];
function ownClientMeta(buf) {
  const e = zipEntries(buf).find((x) => x.name === 'fabric.mod.json');
  if (!e) return null;
  const meta = JSON.parse(e.read().toString('utf8'));
  if (meta.id !== 'auroria-client') return null;
  return { version: meta.version || '', mc: ((meta.custom || {})['auroria:minecraft'] || []).map(String) };
}
async function scanOwnClient() {
  await ensureDir(P.client);
  const found = [];
  for (const f of await fsp.readdir(P.client)) {
    if (!f.endsWith('.jar')) continue;
    try { const buf = await fsp.readFile(path.join(P.client, f)); const meta = ownClientMeta(buf); if (meta) found.push({ file: f, buf, ...meta }); } catch (e) { logLine('client jar unreadable', f, e.message); }
  }
  ownClientVersions = [...new Set(found.flatMap((x) => x.mc))];
  return found;
}
// Finds an Auroria Client jar for this Minecraft version in %APPDATA%\Auroria\client, or downloads one from config.clientModUrls.
async function ownClientJar(mc) {
  const pick = (list) => list.filter((x) => x.mc.includes(mc)).sort((a, b) => cmpVer(b.version.split('+')[0], a.version.split('+')[0]))[0] || null;
  let hit = pick(await scanOwnClient());
  const url = (config.clientModUrls || {})[mc];
  if (!hit && url) {
    setProgress('Downloading Auroria Client', 0, 1);
    try { await download(url, path.join(P.client, `auroria-client-${mc}.jar`)); hit = pick(await scanOwnClient()); }
    catch (e) { logLine('client download failed', e.message); }
  }
  return hit;
}
// Puts our jar in the profile (or takes it out) and switches AxolotlClient off (or back on) to match.
async function applyOwnClient(server, own) {
  const dir = modsDir(server);
  await ensureDir(dir);
  const dest = path.join(dir, OWN_JAR);
  if (own) {
    const cur = await fsp.readFile(dest).catch(() => null);
    if (!cur || !cur.equals(own.buf)) await fsp.writeFile(dest, own.buf);
    await fsp.rm(dest + '.disabled', { force: true });
  } else {
    await fsp.rm(dest, { force: true });
  }
  const idx = await modIndex(server);
  const axo = Object.values(idx).find((x) => x.slug === 'axolotlclient');
  if (axo && axo.file) {
    const on = path.join(dir, axo.file), off = on + '.disabled';
    if (own && await exists(on)) await fsp.rename(on, off);
    if (!own && await exists(off) && !(await exists(on))) await fsp.rename(off, on);
  }
}
async function ensureServerMods(server, own = null) {
  if (server.loader === 'vanilla') return [];
  const clientSlugs = CLIENT_MODS.map((c) => c.slug).filter((s) => !(own && s === 'axolotlclient'));
  const wanted = [...(clientModded(server) ? clientSlugs : []), ...(server.mods || [])];
  const slugs = [...new Set(wanted)];
  if (!slugs.length) return [];
  const idx = await modIndex(server);
  const installed = new Set(Object.values(idx).map((x) => x.slug).filter(Boolean));
  const missing = slugs.filter((s) => !installed.has(s));
  const skipped = [];
  let done = 0;
  for (const slug of missing) {
    setProgress(clientModded(server) ? 'Installing Auroria Client mods' : 'Installing profile mods', done, missing.length);
    try {
      const proj = await getJson(`${MR}/project/${encodeURIComponent(slug)}`);
      const idx2 = await modIndex(server);
      if (!idx2[proj.id]) await installModProject(server, proj.id);
      const idx3 = await modIndex(server);
      if (idx3[proj.id]) { idx3[proj.id].slug = slug; idx3[proj.id].client = CLIENT_MODS.some((c) => c.slug === slug); await saveModIndex(server, idx3); }
    } catch (e) {
      skipped.push(slug); logLine('mod skipped', slug, e.message);
    }
    setProgress(clientModded(server) ? 'Installing Auroria Client mods' : 'Installing profile mods', ++done, missing.length);
  }
  if (skipped.length) broadcast({ type: 'notice', message: `Skipped ${skipped.join(', ')}: no build for Minecraft ${server.version} on ${LOADER_NAME[server.loader]}.` });
  return skipped;
}
// Puts the Auroria UI pack in the profile and switches it on in options.txt.
async function ensureClientPack(server, gameDir) {
  if (!packSupported(server.version)) return false;
  const dir = path.join(gameDir, 'resourcepacks');
  const dest = path.join(dir, PACK_FILE);
  const data = asset('assets/auroria-ui.zip');
  const cur = await fsp.readFile(dest).catch(() => null);
  if (!cur || !cur.equals(data)) { await ensureDir(dir); await fsp.writeFile(dest, data); }
  await enablePack(path.join(gameDir, 'options.txt'), `file/${PACK_FILE}`);
  return true;
}
async function enablePack(optionsFile, entry) {
  let text = await fsp.readFile(optionsFile, 'utf8').catch(() => '');
  const setList = (key, add) => {
    const re = new RegExp(`^${key}:(.*)$`, 'm');
    const m = re.exec(text);
    let list = [];
    if (m) { try { list = JSON.parse(m[1]); } catch { list = []; } }
    if (key === 'resourcePacks' && !list.length) list = ['vanilla'];
    if (!list.includes(add)) list.push(add);
    const line = `${key}:${JSON.stringify(list)}`;
    text = m ? text.replace(re, line) : (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
  };
  setList('resourcePacks', entry);
  setList('incompatibleResourcePacks', entry);
  await fsp.writeFile(optionsFile, text);
}
// ---------- Auroria Client skin: rebrands and recolours AxolotlClient through a generated resource pack ----------
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip archive');
  const out = []; const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + elen + clen;
    out.push({ name, read: () => {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const d = buf.slice(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(d) : d;
    } });
  }
  return out;
}
function writeZip(files) {
  const parts = []; const central = []; let off = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8'); const comp = zlib.deflateRawSync(data); const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nameBuf, comp); central.push(ch, nameBuf); off += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, w, h, bd, ct, il, plte = null, trns = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || il !== 0 || ![2, 3, 6].includes(ct)) return null;
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1; const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(w * h * 4); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ct === 3) { const i = line[x]; out[o] = plte[i * 3]; out[o + 1] = plte[i * 3 + 1]; out[o + 2] = plte[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
      else { out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255; }
    }
    prev = line;
  }
  return { w, h, data: out };
}
function encodePng({ w, h, data }) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, d) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, d])) >>> 0); return Buffer.concat([len, t, d, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Shift every saturated colour to the Auroria orange family, keeping light and dark shades.
function recolor(img) {
  const d = img.data; let changed = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, delta = max - min;
    if (delta < 0.08) continue;
    const s = delta / (1 - Math.abs(2 * l - 1) || 1);
    if (s < 0.18) continue;
    const H = 26 / 360, S = Math.min(1, s * 1.05 + 0.08);
    const q = l < 0.5 ? l * (1 + S) : l + S - l * S, p = 2 * l - q;
    const hue = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    d[i] = Math.round(hue(H + 1 / 3) * 255); d[i + 1] = Math.round(hue(H) * 255); d[i + 2] = Math.round(hue(H - 1 / 3) * 255);
    changed++;
  }
  return changed;
}
function fitInto(src, w, h) { // nearest-neighbour, keeps aspect, centred on transparent
  const out = { w, h, data: Buffer.alloc(w * h * 4) };
  const scale = Math.min(w / src.w, h / src.h); const dw = Math.max(1, Math.round(src.w * scale)), dh = Math.max(1, Math.round(src.h * scale));
  const ox = Math.floor((w - dw) / 2), oy = Math.floor((h - dh) / 2);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = Math.min(src.w - 1, Math.floor(x / scale)), sy = Math.min(src.h - 1, Math.floor(y / scale));
    src.data.copy(out.data, ((oy + y) * w + ox + x) * 4, (sy * src.w + sx) * 4, (sy * src.w + sx) * 4 + 4);
  }
  return out;
}
function cropAlpha(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.data[(y * img.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4);
  return { w, h, data };
}
const rebrand = (v) => String(v).replace(/Axolotl\s?Client/gi, 'Auroria Client').replace(/Axolotl/g, 'Auroria').replace(/axolotl(?=\s)/g, 'Auroria');
async function buildClientSkin(server, gameDir) {
  const idx = await modIndex(server);
  const entry = Object.values(idx).find((x) => x.slug === 'axolotlclient');
  if (!entry) return false;
  const jarPath = path.join(modsDir(server), entry.file);
  const jar = await fsp.readFile(jarPath).catch(() => null);
  if (!jar) return false;
  const dir = path.join(gameDir, 'resourcepacks');
  const dest = path.join(dir, 'Auroria-Client-Skin.zip');
  const stamp = sha1(Buffer.concat([jar, Buffer.from('skin-v2')]));
  const marker = path.join(dir, '.auroria-client-skin');
  if ((await fsp.readFile(marker, 'utf8').catch(() => '')) === stamp && (await exists(dest))) { await enablePack(path.join(gameDir, 'options.txt'), 'file/Auroria-Client-Skin.zip'); return true; }
  setProgress('Skinning Auroria Client', 0, 1);
  const ui = Object.fromEntries(zipEntries(asset('assets/auroria-ui.zip')).map((e) => [e.name, e]));
  const icon = decodePng(ui['pack.png'].read());
  const word = cropAlpha(decodePng(ui['assets/minecraft/textures/gui/title/minecraft.png'].read()));
  const files = []; const langs = {};
  for (const e of zipEntries(jar)) {
    const m = /^assets\/([^/]+)\/(.+)$/.exec(e.name);
    if (!m || e.name.endsWith('/')) continue;
    const [, ns, rest] = m;
    if (!ns.includes('axolotl')) continue;
    if (/^lang\/[a-z_]+\.json$/i.test(rest)) {
      try {
        const obj = JSON.parse(e.read().toString('utf8'));
        const outObj = {}; for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && /axolotl/i.test(v) && !/credit|author|contributor|license|translator|github|discord|url|link/i.test(k)) outObj[k] = rebrand(v);
        const code = rest.slice(5, -5).toLowerCase(); langs[code] = Object.assign(langs[code] || {}, outObj);
        files.push({ name: e.name, data: Buffer.from(JSON.stringify({ ...obj, ...outObj }, null, 1)) });
      } catch {}
    } else if (/^textures\/.+\.png$/i.test(rest)) {
      const img = decodePng(e.read()); if (!img) continue;
      const base = path.basename(rest).toLowerCase();
      if (/logo|icon|axolotl|banner|title/.test(base)) {
        const src = img.w >= img.h * 1.8 ? word : icon;
        files.push({ name: e.name, data: encodePng(fitInto(src, img.w, img.h)) });
      } else if (recolor(img)) files.push({ name: e.name, data: encodePng(img) });
    }
  }
  const mm = { 'modmenu.nameTranslation.axolotlclient': 'Auroria Client', 'modmenu.descriptionTranslation.axolotlclient': 'Auroria\'s in-game client: HUD mods, keystrokes, CPS, zoom, freelook and more. Powered by AxolotlClient.' };
  files.push({ name: 'assets/auroria/lang/en_us.json', data: Buffer.from(JSON.stringify(mm, null, 1)) });
  files.push({ name: 'pack.mcmeta', data: Buffer.from(JSON.stringify({ pack: { pack_format: 15, supported_formats: [1, 99], min_format: 1, max_format: 99, description: '§6Auroria Client§r skin' } })) });
  files.push({ name: 'pack.png', data: ui['pack.png'].read() });
  await ensureDir(dir);
  await fsp.writeFile(dest, writeZip(files));
  await fsp.writeFile(marker, stamp);
  await enablePack(path.join(gameDir, 'options.txt'), 'file/Auroria-Client-Skin.zip');
  return true;
}
async function listMods(server, lookup = true) {
  const dir = modsDir(server);
  await ensureDir(dir);
  const names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
  const mods = [];
  for (const f of names) {
    const buf = await fsp.readFile(path.join(dir, f));
    const m = { file: f, enabled: f.endsWith('.jar'), size: buf.length, sha1: sha1(buf), title: f.replace(/\.jar(\.disabled)?$/, '') };
    if (f.startsWith(OWN_JAR)) { try { const meta = ownClientMeta(buf); if (meta) Object.assign(m, { own: true, client: true, slug: 'auroria-client', title: 'Auroria Client', version: meta.version, category: 'Your own client' }); } catch {} }
    mods.push(m);
  }
  const idx0 = await modIndex(server);
  for (const m of mods) {
    const e = !m.own && Object.values(idx0).find((x) => x.file && x.file === m.file.replace(/\.disabled$/, ''));
    if (e) Object.assign(m, { slug: e.slug || '', client: !!e.client });
  }
  if (lookup && mods.length) {
    try {
      const byHash = await postJson(`${MR}/version_files`, { hashes: mods.map((m) => m.sha1), algorithm: 'sha1' }, { 'User-Agent': UA });
      const pids = [...new Set(Object.values(byHash).map((v) => v.project_id))];
      const projects = pids.length ? await getJson(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(pids))}`) : [];
      const pmap = Object.fromEntries(projects.map((p) => [p.id, p]));
      const idxAll = await modIndex(server);
      for (const m of mods) {
        const v = byHash[m.sha1];
        if (!v || m.own) continue;
        const p = pmap[v.project_id] || {};
        Object.assign(m, { slug: (idxAll[v.project_id] || {}).slug || '', client: !!(idxAll[v.project_id] && idxAll[v.project_id].client), projectId: v.project_id, versionId: v.id, version: v.version_number, title: p.title || m.title, icon: p.icon_url || null, category: (p.categories || [])[0] || '' });
      }
    } catch (e) { logLine('modrinth lookup failed', e.message); }
  }
  return mods.sort((a, b) => a.title.localeCompare(b.title));
}
async function modUpdates(server) {
  const mods = await listMods(server);
  const hashes = mods.filter((m) => m.versionId).map((m) => m.sha1);
  if (!hashes.length) return [];
  const latest = await postJson(`${MR}/version_files/update`, { hashes, algorithm: 'sha1', loaders: modLoaders(server), game_versions: [server.version] }, { 'User-Agent': UA });
  return mods.filter((m) => latest[m.sha1] && latest[m.sha1].id !== m.versionId)
    .map((m) => ({ file: m.file, title: m.title, from: m.version, to: latest[m.sha1].version_number, projectId: m.projectId }));
}

// ---------- server list ping (Minecraft SLP) ----------
function varint(n) { const b = []; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; b.push(t); } while (n); return Buffer.from(b); }
function packet(id, payload) { const body = Buffer.concat([varint(id), payload]); return Buffer.concat([varint(body.length), body]); }
async function pingServer(address, timeout = 3000) {
  let { host, port } = splitAddress(address);
  try { const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`); if (srv[0]) { host = srv[0].name; port = srv[0].port; } } catch {}
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const start = Date.now();
    let buf = Buffer.alloc(0);
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout, () => done({ online: false }));
    sock.on('error', () => done({ online: false }));
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      sock.write(packet(0, Buffer.concat([varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        let off = 0;
        const rv = () => { let n = 0, s = 0, b; do { if (off >= buf.length) throw new Error('more'); b = buf[off++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return n; };
        const len = rv(); if (buf.length - off < len) return;
        rv(); const sl = rv();
        const json = JSON.parse(buf.slice(off, off + sl).toString('utf8'));
        const flat = (c) => (typeof c === 'string' ? c : c ? (c.text || '') + (c.extra || []).map(flat).join('') : '');
        const motd = flat(json.description).replace(/§./g, '').trim().slice(0, 160);
        done({ online: true, players: (json.players || {}).online || 0, max: (json.players || {}).max || 0, version: (json.version || {}).name || '', latency: Date.now() - start, motd });
      } catch (e) { if (e.message !== 'more') done({ online: false }); }
    });
  });
}

// ---------- pre-launch mod check and crash diagnosis ----------
// Does a Minecraft version satisfy a Fabric-style range ("1.20.x", ">=1.20 <1.21", "~1.20.1", or an array of alternatives)?
function mcSatisfies(ver, range) {
  if (!/^\d+\.\d+/.test(ver)) return true;
  const alts = Array.isArray(range) ? range : [range];
  return alts.some((r) => String(r).trim().split(/\s+/).filter(Boolean).every((c) => {
    if (c === '*') return true;
    const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(c); const op = m[1] || '='; const v = m[2].split('-')[0];
    if (/\.[x*]$/.test(v)) { const pre = v.replace(/\.[x*]$/, ''); return ver === pre || ver.startsWith(pre + '.'); }
    const d = cmpVer(ver, v); const p = v.split('.');
    if (op === '>=') return d >= 0; if (op === '<=') return d <= 0; if (op === '>') return d > 0; if (op === '<') return d < 0;
    if (op === '~') return d >= 0 && ver.startsWith(p.slice(0, 2).join('.')); if (op === '^') return d >= 0 && ver.startsWith(p[0] + '.');
    return d === 0;
  }));
}
// Mod ids a Fabric jar carries inside itself (jar-in-jar, listed under "jars"), e.g. Lithium bundles MixinExtras.
function bundledIds(z, j, depth = 0) {
  const out = [];
  for (const ref of j.jars || []) {
    try {
      const e = z.find((x) => x.name === ref.file); if (!e) continue;
      const inner = zipEntries(e.read()); const fj = inner.find((x) => x.name === 'fabric.mod.json'); if (!fj) continue;
      const ij = JSON.parse(fj.read().toString('utf8'));
      if (ij.id) out.push(ij.id);
      out.push(...(ij.provides || []));
      if (depth < 2) out.push(...bundledIds(inner, ij, depth + 1));
    } catch {}
  }
  return out;
}
// Finds problems the loader would refuse to start with: two copies of a mod, and (Fabric/Quilt only) a missing required mod
// or a mod for another Minecraft version. Forge only gets the duplicate check; its own popup covers the rest.
async function analyzeMods(server) {
  if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(server.loader)) return [];
  const fabricLike = server.loader === 'fabric' || server.loader === 'quilt';
  const dir = modsDir(server); let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jar')); } catch { return []; }
  const mods = [];
  for (const f of files) {
    try {
      const z = zipEntries(await fsp.readFile(path.join(dir, f)));
      const fe = z.find((e) => e.name === 'fabric.mod.json'), qe = z.find((e) => e.name === 'quilt.mod.json');
      let m = null;
      if (fe) { const j = JSON.parse(fe.read().toString('utf8')); m = { id: j.id, name: j.name || j.id, version: j.version, provides: [...(j.provides || []), ...bundledIds(z, j)], depends: j.depends || {} }; }
      else if (qe) { const q = JSON.parse(qe.read().toString('utf8')).quilt_loader || {}; m = { id: q.id, name: (q.metadata && q.metadata.name) || q.id, version: q.version, provides: (q.provides || []).map((p) => (typeof p === 'string' ? p : p.id)), depends: Object.fromEntries((q.depends || []).filter((d) => typeof d === 'object' && !d.optional && d.id).map((d) => [d.id, d.versions || '*'])) }; }
      if (!m && !fabricLike) { // Forge: mcmod.info (1.7 to 1.12) or mods.toml (1.13 and newer) names the mod id
        const info = z.find((e) => e.name === 'mcmod.info'), toml = z.find((e) => e.name === 'META-INF/mods.toml' || e.name === 'META-INF/neoforge.mods.toml');
        let id = '', name = '', version = '';
        if (info) {
          const raw = info.read().toString('utf8');
          try { const j = JSON.parse(raw); const e0 = Array.isArray(j) ? j[0] : (j.modList || [])[0]; if (e0) ({ modid: id, name, version } = e0); }
          catch { id = ((/"modid"\s*:\s*"([^"]+)"/.exec(raw)) || [])[1] || ''; name = ((/"name"\s*:\s*"([^"]+)"/.exec(raw)) || [])[1] || ''; version = ((/"version"\s*:\s*"([^"]+)"/.exec(raw)) || [])[1] || ''; }
        } else if (toml) {
          const raw = toml.read().toString('utf8'); id = ((/modId\s*=\s*"([^"]+)"/.exec(raw)) || [])[1] || ''; name = ((/displayName\s*=\s*"([^"]+)"/.exec(raw)) || [])[1] || ''; version = ((/^\s*version\s*=\s*"([^"]+)"/m.exec(raw)) || [])[1] || '';
        }
        // No usable metadata (many old mods): compare file names with the version numbers taken out.
        const stem = f.replace(/\.jar$/i, '');
        if (!id) id = 'file:' + stem.toLowerCase().replace(/\d+(\.\d+)+\w*/g, ' ').replace(/[^a-z]+/g, ' ').trim();
        m = { id, name: name || stem.replace(/\([^)]*\)/g, '').replace(/[-_ ]*v?\d+(\.\d+)+.*$/, '').trim() || stem, version, provides: [], depends: {} };
      }
      if (m && m.id) mods.push({ ...m, file: f });
    } catch {}
  }
  const problems = [];
  const have = new Map(); const byId = new Map();
  for (const m of mods) {
    if (!byId.has(m.id)) byId.set(m.id, []); byId.get(m.id).push(m);
    for (const id of [m.id, ...m.provides.map((p) => (typeof p === 'string' ? p : p.id))]) have.set(id, m);
  }
  for (const [id, list] of byId) if (list.length > 1) problems.push({ type: 'duplicate', text: `Two copies of ${list[0].name} are installed. Delete one.`, mods: list.map((x) => ({ file: x.file, name: x.name, version: x.version })) });
  if (!fabricLike) return problems;
  // Fabric Loader 0.15+ and Quilt ship MixinExtras themselves.
  const builtin = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'mixinextras']);
  const hasFabricApi = have.has('fabric-api') || have.has('fabric');
  const nice = (id) => (/^fabric(-api)?($|-)/.test(id) ? 'Fabric API' : (have.get(id) || {}).name || id);
  for (const m of mods) {
    for (const [dep, range] of Object.entries(m.depends)) {
      if (builtin.has(dep)) {
        if (dep === 'minecraft' && !mcSatisfies(server.version, range)) problems.push({ type: 'version', text: `${m.name} is built for Minecraft ${[].concat(range).join(' or ')}, but this profile uses ${server.version}.`, mods: [{ file: m.file, name: m.name, version: m.version }] });
        continue;
      }
      if (have.has(dep) || (dep.startsWith('fabric-') && hasFabricApi)) continue;
      const t = `${m.name} needs ${nice(dep)}, which is not installed.`;
      if (!problems.some((p) => p.text === t)) problems.push({ type: 'missing', dep, depName: nice(dep), text: t, mods: [{ file: m.file, name: m.name, version: m.version }] });
    }
  }
  return problems;
}
// Turns the last game output into a short, human reason the game stopped.
function diagnoseCrash(lines) {
  const text = lines.join('\n');
  const clean = (l) => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]:?\s*)?/, '').replace(/^\s*[-*]\s*/, '').trim();
  const pick = (re, n = 6) => [...new Set(lines.filter((l) => re.test(l)).map(clean))].slice(0, n);
  if (/OutOfMemoryError/.test(text)) return { kind: 'memory', title: 'Minecraft ran out of memory', lines: [], hint: 'Give it more memory in Settings, under Java and memory, or remove heavy mods and shaders.' };
  if (/UnsupportedClassVersionError|Unsupported class file major version/.test(text)) return { kind: 'java', title: 'A mod needs a newer Java', lines: pick(/UnsupportedClassVersionError|Unsupported class file/, 3), hint: 'The mod was built for a newer Minecraft than this profile uses. Update or remove it.' };
  if (/Incompatible mods found|Mod resolution (failed|encountered)|incompatible mod set|Some of your mods are incompatible|Duplicate mod|Mod .+ requires/i.test(text)) {
    const l = pick(/\brequires\b|is missing|conflicts? with|\bbreaks\b|incompatible|duplicate|more than one/i, 8).filter((x) => !/^(Incompatible mods found|Mod resolution)/i.test(x));
    return { kind: 'mods', title: 'Some mods do not work together', lines: l, hint: 'Update the listed mods, install the ones that are missing, or remove the ones that conflict.' };
  }
  if (/Missing or unsupported mandatory dependencies|MissingModsException|Missing Mods:|DuplicateModsFoundException/i.test(text)) return { kind: 'mods', title: 'A mod is missing something it needs', lines: pick(/Mod ID|Requested by|Currently|requires|Missing|Duplicate/i, 8), hint: 'Install the missing mod, or remove the mod that asked for it.' };
  if (/Mixin apply failed|MixinTransformerError|InvalidMixinException|Mixin transformation of .+ failed|MixinApplyError/.test(text)) {
    const cfg = [...new Set([...text.matchAll(/([\w.-]+)\.mixins?\.json/g)].map((m) => m[0]))].slice(0, 4);
    return { kind: 'mixin', title: 'Two mods are fighting over the same code', lines: cfg.map((c) => `Involved: ${c}`), hint: 'A mod is likely out of date for this Minecraft version. Update your mods, or remove the ones named above.' };
  }
  const err = lines.filter((l) => /Exception|Error:|Caused by/.test(l)).map(clean);
  return { kind: 'other', title: 'Minecraft closed unexpectedly', lines: [...new Set(err.slice(-3))], hint: 'Open the game log for the full output.' };
}

// ---------- launch ----------
async function launch(serverId, join = '') {
  if (game.state !== 'idle') throw new Error('The game is already starting or running.');
  const server = serverById(serverId);
  game.serverId = server.id;
  game.logs = [];
  game.userStopped = false;
  setGameState('preparing');
  try {
    const acc = await ensureFreshAccount();
    const profile = await resolveProfile(server);
    const java = server.javaPath && await exists(server.javaPath) ? server.javaPath : await ensureJava(profile.javaComponent);
    const gameDir = instanceDir(server);
    await ensureDir(gameDir);
    const { jar, logArg, gameAssets } = await installFiles(profile, gameDir);
    const own = clientModded(server) ? await ownClientJar(server.version).catch((e) => { logLine('own client failed', e.message); return null; }) : null;
    await ensureServerMods(server, own);
    if (clientModded(server)) await applyOwnClient(server, own);
    await ensureClientPack(server, gameDir).catch((e) => logLine('pack failed', e.message));
    if (clientModded(server) && !own) await buildClientSkin(server, gameDir).catch((e) => logLine('client skin failed', e.message));
    const { args } = buildLaunchArgs({ profile, jar, gameDir, acc, server: join ? { ...server, address: join } : server, logArg, gameAssets });
    server.lastPlayed = Date.now();
    await writeJson(P.servers, config.servers).catch(() => {});
    setProgress('Starting Minecraft', 1, 1);
    logLine('launch', server.id, profile.id);
    const detached = !settings.keepOpen;
    const proc = spawn(java, args, { cwd: gameDir, detached, windowsHide: false, stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'] });
    game.proc = proc;
    proc.on('error', (e) => { game.proc = null; setGameState('idle', { error: `Java could not start: ${e.message}` }); });
    if (detached) {
      proc.unref();
      setGameState('running');
      setTimeout(() => { broadcast({ type: 'quit' }); setTimeout(() => process.exit(0), 1500); }, 4000);
      return;
    }
    const onData = (d) => {
      const lines = d.toString('utf8').split(/\r?\n/).filter(Boolean);
      game.logs.push(...lines); if (game.logs.length > 5000) game.logs.splice(0, game.logs.length - 5000);
      for (const l of lines) broadcast({ type: 'log', line: l });
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    setGameState('running');
    const startedAt = Date.now();
    discordSet(server, startedAt, join);
    proc.on('exit', (code) => {
      game.proc = null;
      addPlaytime(server, startedAt, Date.now());
      writeJson(P.servers, config.servers).catch(() => {});
      discordSet(null);
      const mins = Math.round((Date.now() - startedAt) / 60000);
      if (code && !game.userStopped) notify('Minecraft crashed', `${server.name} closed unexpectedly. Open Auroria to see what went wrong.`);
      else notify('Minecraft closed', `You played ${server.name} for ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`}.`);
      const crashed = code && !game.userStopped;
      setGameState('idle', crashed ? { error: `Minecraft closed with code ${code}. Check the game log.`, crash: diagnoseCrash(game.logs) } : {});
      maybeExit();
    });
  } catch (e) {
    logLine('launch failed', e.stack || e.message);
    setGameState('idle', { error: e.message });
  }
}

// ---------- skins ----------
async function skinLibrary() { return readJson(path.join(P.skins, 'library.json'), []); }
async function saveSkinLibrary(lib) { return writeJson(path.join(P.skins, 'library.json'), lib); }
async function applySkin(id) {
  const acc = await ensureFreshAccount();
  const lib = await skinLibrary();
  const item = lib.find((s) => s.id === id);
  if (!item) throw new Error('That skin is not in your library.');
  const png = await fsp.readFile(path.join(P.skins, `${id}.png`));
  const form = new FormData();
  form.append('variant', item.variant === 'SLIM' ? 'slim' : 'classic');
  form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: `Bearer ${acc.mcToken}`, 'User-Agent': UA }, body: form });
  if (!res.ok) throw new Error(`Minecraft refused the skin (HTTP ${res.status}).`);
  return refreshProfile();
}
async function applyCape(capeId) {
  const acc = await ensureFreshAccount();
  const url = 'https://api.minecraftservices.com/minecraft/profile/capes/active';
  const res = capeId
    ? await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${acc.mcToken}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ capeId }) })
    : await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${acc.mcToken}`, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Could not change cape (HTTP ${res.status}).`);
  return refreshProfile();
}

// ---------- OS helpers ----------
function openExternal(target) {
  if (IS_WIN) spawn('cmd', ['/c', 'start', '""', `"${target.replace(/"/g, '')}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}
function openInEditor(file) {
  if (IS_WIN) spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  else openExternal(file);
}

// ---------- HTTP server ----------
const TOKEN = crypto.randomBytes(24).toString('hex');
let PORT = 0;
const STATIC = {
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['ui/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/bg.jpg': ['ui/bg.jpg', 'image/jpeg'],
  '/favicon.ico': ['ui/favicon.ico', 'image/x-icon'],
  '/skinview3d.js': ['ui/skinview3d.js', 'text/javascript; charset=utf-8'],
};
const FONT_FILES = ['oxanium-600', 'oxanium-700', 'oxanium-800', 'jakarta-400', 'jakarta-500', 'jakarta-600', 'jakarta-700', 'jakarta-800'];
for (const f of FONT_FILES) STATIC[`/fonts/${f}.woff2`] = [`ui/fonts/${f}.woff2`, 'font/woff2'];
for (const f of ['monocraft', 'monocraft-bold']) STATIC[`/fonts/${f}.ttf`] = [`ui/fonts/${f}.ttf`, 'font/ttf'];

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
async function readBody(req, max = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new Error('Request too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

// ---------- import profiles from other launchers ----------
const IMPORT_SKIP = new Set(['logs', 'crash-reports', '.fabric', '.mixin.out', 'natives', 'versions', 'libraries', 'assets', 'runtime', 'webcache2', 'cache', '.cache', 'downloads']);
const normLoader = (x) => { const l = String(x || '').toLowerCase(); return l.includes('neoforge') ? 'neoforge' : l.includes('quilt') ? 'quilt' : l.includes('fabric') ? 'fabric' : l.includes('forge') ? 'forge' : 'vanilla'; };
async function readTextJson(f) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; } }
async function pngDataUrl(f) {
  try { const b = await fsp.readFile(f); if (b.length <= 150000 && b.slice(1, 4).toString() === 'PNG') return `data:image/png;base64,${b.toString('base64')}`; } catch {}
  return '';
}
async function scanImports() {
  const out = [];
  const roam = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const add = (source, dir, name, version, loader, loaderVersion, icon) => {
    if (!name || !version) return;
    const l = normLoader(loader);
    out.push({ id: sha1(Buffer.from(dir)).slice(0, 12), source, dir, name: String(name).slice(0, 48), version, loader: l, loaderVersion: l === 'vanilla' ? '' : String(loaderVersion || ''), icon: icon || '' });
  };
  // Modrinth App keeps its profiles in a SQLite database next to the profile folders.
  try {
    const dbFile = path.join(roam, 'ModrinthApp', 'app.db');
    if (await exists(dbFile)) {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const rows = db.prepare('select i.path, i.name, i.icon_path, c.game_version, c.loader, c.loader_version from instances i join instance_content_sets c on c.id = i.applied_content_set_id order by i.last_played desc').all();
        for (const r of rows) {
          const dir = path.join(roam, 'ModrinthApp', 'profiles', r.path);
          if (await exists(dir)) add('Modrinth App', dir, r.name, r.game_version, r.loader, r.loader_version, r.icon_path ? await pngDataUrl(r.icon_path) : '');
        }
      } finally { db.close(); }
    }
  } catch (e) { logLine('import scan: Modrinth App', e.message); }
  // Prism Launcher, PolyMC and MultiMC share one instance format.
  for (const base of ['PrismLauncher', 'PolyMC', 'MultiMC']) {
    const root = path.join(roam, base, 'instances');
    let dirs = []; try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const inst = path.join(root, d.name);
      const pack = await readTextJson(path.join(inst, 'mmc-pack.json'));
      if (!pack || !Array.isArray(pack.components)) continue;
      const comp = (uid) => pack.components.find((c) => c.uid === uid);
      const mc = comp('net.minecraft'); if (!mc) continue;
      const lo = comp('net.neoforged') ? ['neoforge', comp('net.neoforged')] : comp('org.quiltmc.quilt-loader') ? ['quilt', comp('org.quiltmc.quilt-loader')] : comp('net.fabricmc.fabric-loader') ? ['fabric', comp('net.fabricmc.fabric-loader')] : comp('net.minecraftforge') ? ['forge', comp('net.minecraftforge')] : ['vanilla', null];
      let name = d.name; try { const m = /^name=(.*)$/m.exec(await fsp.readFile(path.join(inst, 'instance.cfg'), 'utf8')); if (m && m[1].trim()) name = m[1].trim(); } catch {}
      const game = [path.join(inst, '.minecraft'), path.join(inst, 'minecraft')].find((p) => fs.existsSync(p));
      if (game) add(base === 'PrismLauncher' ? 'Prism Launcher' : base, game, name, mc.version, lo[0], lo[1] && lo[1].version, '');
    }
  }
  // CurseForge app.
  try {
    const root = path.join(os.homedir(), 'curseforge', 'minecraft', 'Instances');
    for (const d of await fsp.readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const inst = path.join(root, d.name);
      const j = await readTextJson(path.join(inst, 'minecraftinstance.json')); if (!j) continue;
      const bl = j.baseModLoader && j.baseModLoader.name ? String(j.baseModLoader.name) : '';
      const lv = /^[a-z]+-(\d[^-]*)/i.exec(bl); // "fabric-0.15.7-1.20.1" or "forge-47.2.0"
      add('CurseForge', inst, j.name || d.name, j.gameVersion, bl, lv ? lv[1] : '', '');
    }
  } catch {}
  // The official Minecraft Launcher's folder: worlds, packs and options of its most recently used profile.
  try {
    const mcDir = path.join(roam, '.minecraft');
    const lp = await readTextJson(path.join(mcDir, 'launcher_profiles.json'));
    const profs = lp && lp.profiles ? Object.values(lp.profiles).filter((p) => /^(\d|fabric-loader|quilt-loader)/.test(String(p.lastVersionId || ''))).sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || ''))) : [];
    if (profs[0]) {
      const v = String(profs[0].lastVersionId); const m = /^(fabric|quilt)-loader-([^-]+)-(.+)$/.exec(v);
      add('Minecraft Launcher', mcDir, 'Minecraft Launcher worlds', m ? m[3] : v, m ? m[1] : 'vanilla', m ? m[2] : '', '');
    }
  } catch {}
  return out;
}
function newProfileEntry(fields) {
  const name = String(fields.name || 'Imported profile').trim().slice(0, 48) || 'Imported profile';
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  while (config.servers.some((s) => s.id === id)) id += '-' + crypto.randomBytes(2).toString('hex');
  return { id, client: true, name, address: '', version: fields.version, loader: fields.loader, loaderVersion: fields.loaderVersion || '', mods: [], color: '#f07f2a', icon: fields.icon || '', ramGB: 0, description: String(fields.description || '').slice(0, 120), tags: [], badge: '', created: Date.now() };
}
async function commitProfile(entry) {
  config.servers = [...config.servers, entry]; await writeJson(P.servers, config.servers);
  return { servers: config.servers, id: entry.id };
}
// Modrinth modpack (.mrpack): a zip with modrinth.index.json plus override folders.
async function importMrpack(buf) {
  const files = zipEntries(buf);
  const idxEntry = files.find((f) => f.name === 'modrinth.index.json');
  if (!idxEntry) throw new Error('That is not a Modrinth modpack (.mrpack): modrinth.index.json is missing.');
  const idx = JSON.parse(idxEntry.read().toString('utf8'));
  const dep = idx.dependencies || {};
  if (!dep.minecraft) throw new Error('The modpack does not name a Minecraft version.');
  const depKey = { neoforge: 'neoforge', quilt: 'quilt-loader', fabric: 'fabric-loader', forge: 'forge' };
  const loader = dep.neoforge ? 'neoforge' : dep['quilt-loader'] ? 'quilt' : dep['fabric-loader'] ? 'fabric' : dep.forge ? 'forge' : 'vanilla';
  const entry = newProfileEntry({ name: idx.name, version: dep.minecraft, loader, loaderVersion: loader === 'vanilla' ? '' : dep[depKey[loader]], description: idx.summary || `Imported from ${idx.name || 'a modpack'}` });
  const dest = instanceDir(entry); await ensureDir(dest);
  const safe = (rel) => { const t = path.resolve(dest, rel); if (!t.startsWith(dest + path.sep)) throw new Error(`Unsafe path in modpack: ${rel}`); return t; };
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const f of files) {
      if (!f.name.startsWith(prefix) || f.name.endsWith('/')) continue;
      const t = safe(f.name.slice(prefix.length)); await ensureDir(path.dirname(t)); await fsp.writeFile(t, f.read());
    }
  }
  const list = (idx.files || []).filter((f) => !f.env || f.env.client !== 'unsupported');
  let next = 0; let failed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < list.length) {
      const f = list[next++];
      try { await download((f.downloads || [])[0], safe(f.path), { sha1: f.hashes && f.hashes.sha1, size: f.fileSize }); } catch (e) { failed++; logLine('mrpack file failed', f.path, e.message); }
    }
  }));
  return { ...(await commitProfile(entry)), failed };
}
// Modrinth modpack from Browse: newest version's .mrpack, then the same import path as a dropped file.
async function installModpack(projectId) {
  if (!/^[A-Za-z0-9]{2,64}$/.test(projectId || '')) throw new Error('Unknown modpack.');
  const [project, versions] = await Promise.all([getJson(`${MR}/project/${projectId}`), getJson(`${MR}/project/${projectId}/version`)]);
  const ver = versions.find((v) => (v.files || []).some((f) => f.filename.endsWith('.mrpack')));
  if (!ver) throw new Error('That modpack has no downloadable version.');
  const file = ver.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) || ver.files.find((f) => f.filename.endsWith('.mrpack'));
  let res; try { res = await fetch(file.url, { headers: { 'User-Agent': UA } }); } catch (e) { throw netError(file.url, e); }
  if (!res.ok) throw new Error(`Modpack download failed (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (file.hashes && file.hashes.sha1 && sha1(buf) !== file.hashes.sha1) throw new Error('The modpack download was corrupted. Try again.');
  const r = await importMrpack(buf);
  const entry = config.servers.find((s) => s.id === r.id);
  if (entry && project.icon_url) {
    try {
      const ir = await fetch(project.icon_url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      const type = (ir.headers.get('content-type') || '').split(';')[0];
      const ib = Buffer.from(await ir.arrayBuffer());
      if (ir.ok && /^image\/(png|jpeg|webp|gif)$/.test(type) && ib.length <= 150000) { entry.icon = `data:${type};base64,${ib.toString('base64')}`; await writeJson(P.servers, config.servers); }
    } catch {}
  }
  if (entry && project.description) { entry.description = String(project.description).slice(0, 120); await writeJson(P.servers, config.servers); }
  return { ...r, servers: config.servers };
}

// ---------- profile sharing: export as a Modrinth .mrpack that Auroria, the Modrinth App and Prism can import ----------
async function exportProfile(s) {
  const dir = instanceDir(s);
  const depKey = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };
  const dependencies = { minecraft: s.version };
  if (depKey[s.loader]) {
    let lv = s.loaderVersion || String(await pickLoaderVersion(s).catch(() => '') || '');
    if (lv.startsWith(`${s.version}-`)) lv = lv.slice(s.version.length + 1);
    if (lv.endsWith(`-${s.version}`)) lv = lv.slice(0, -s.version.length - 1);
    if (!lv) throw new Error('Auroria could not work out which loader version this profile uses. Check your connection and try again.');
    dependencies[depKey[s.loader]] = lv;
  }
  const local = [];
  for (const sub of ['mods', 'resourcepacks', 'shaderpacks']) {
    let names = []; try { names = await fsp.readdir(path.join(dir, sub)); } catch {}
    for (const n of names) if (/\.(jar|zip)$/i.test(n)) { const buf = await fsp.readFile(path.join(dir, sub, n)); local.push({ rel: `${sub}/${n}`, buf, hash: sha1(buf) }); }
  }
  const known = local.length ? await postJson(`${MR}/version_files`, { hashes: local.map((f) => f.hash), algorithm: 'sha1' }).catch(() => ({})) : {};
  const files = []; const zip = [];
  for (const f of local) {
    const v = known[f.hash]; const mf = v && (v.files || []).find((x) => x.hashes && x.hashes.sha1 === f.hash);
    if (mf) files.push({ path: f.rel, hashes: { sha1: f.hash, sha512: mf.hashes.sha512 }, downloads: [mf.url], fileSize: mf.size, env: { client: 'required', server: 'optional' } });
    else zip.push({ name: `overrides/${f.rel}`, data: f.buf });
  }
  const walk = async (rel) => {
    let ents = []; try { ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch {}
    for (const e of ents) { const r = `${rel}/${e.name}`; if (e.isDirectory()) await walk(r); else zip.push({ name: `overrides/${r}`, data: await fsp.readFile(path.join(dir, r)) }); }
  };
  await walk('config');
  if (await exists(path.join(dir, 'options.txt'))) zip.push({ name: 'overrides/options.txt', data: await fsp.readFile(path.join(dir, 'options.txt')) });
  const index = { formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: s.name, summary: s.description || `Shared from Auroria`, files, dependencies };
  zip.unshift({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) });
  const outDir = path.join(os.homedir(), 'Downloads'); await ensureDir(outDir);
  const base = s.name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim() || 'profile';
  let out = path.join(outDir, `${base}.mrpack`); for (let n = 2; await exists(out); n++) out = path.join(outDir, `${base} (${n}).mrpack`);
  await fsp.writeFile(out, writeZip(zip));
  if (IS_WIN) spawn('explorer.exe', [`/select,${out}`], { detached: true, stdio: 'ignore' }).unref();
  return { file: out, linked: files.length, bundled: zip.length - 1 };
}

// ---------- profile extras: playtime, worlds and backups, screenshots, options sync, saved servers ----------
function addPlaytime(s, start, end) {
  const ms = end - start; if (!(ms > 5000)) return;
  s.playMs = (s.playMs || 0) + ms;
  const k = new Date(end).toISOString().slice(0, 10); const days = { ...(s.playDays || {}) }; days[k] = (days[k] || 0) + ms;
  for (const d of Object.keys(days).sort().slice(0, -30)) delete days[d];
  s.playDays = days;
}
const profileBusy = (s) => game.state !== 'idle' && game.serverId === s.id;
const savesDir = (s) => path.join(instanceDir(s), 'saves');
const backupsDir = (s) => path.join(instanceDir(s), 'backups');
const safeName = (n) => { const b = path.basename(String(n || '')); if (!b || b === '.' || b === '..') throw new Error('Bad name.'); return b; };
async function treeStat(dir) {
  let size = 0, mtime = 0;
  const walk = async (d) => { let ents = []; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else { try { const st = await fsp.stat(p); size += st.size; mtime = Math.max(mtime, st.mtimeMs); } catch {} } } };
  await walk(dir); return { size, mtime };
}
async function listWorlds(s) {
  let names = []; try { names = (await fsp.readdir(savesDir(s), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  let backups = []; try { backups = await fsp.readdir(backupsDir(s)); } catch {}
  const worlds = await Promise.all(names.map(async (n) => {
    const st = await treeStat(path.join(savesDir(s), n));
    const mine = await Promise.all(backups.filter((b) => b.startsWith(`${n}__`) && b.endsWith('.zip')).map(async (b) => { const bs = await fsp.stat(path.join(backupsDir(s), b)); return { file: b, size: bs.size, time: bs.mtimeMs }; }));
    return { name: n, size: st.size, modified: st.mtime, icon: await exists(path.join(savesDir(s), n, 'icon.png')), backups: mine.sort((a, b) => b.time - a.time) };
  }));
  return worlds.sort((a, b) => b.modified - a.modified);
}
// Streams a folder into a zip one file at a time, so a large world never sits in memory whole.
async function zipFolder(dir, outFile, topLevel = null) {
  const out = await fsp.open(outFile + '.part', 'w'); const central = []; let off = 0; let count = 0;
  const walk = async (rel) => {
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (!rel && topLevel && !topLevel.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(r); continue; }
      if (e.name === 'session.lock') continue;
      const data = await fsp.readFile(path.join(dir, r)); const comp = zlib.deflateRawSync(data); const crc = zlib.crc32(data) >>> 0; const nb = Buffer.from(r, 'utf8');
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      await out.write(Buffer.concat([lh, nb, comp])); central.push(ch, nb); off += 30 + nb.length + comp.length; count++;
      if (off > 0xfff00000 || count > 65000) throw new Error('This world is too large to back up as one zip.');
    }
  };
  try {
    await walk('');
    const cd = Buffer.concat(central); const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    await out.write(Buffer.concat([cd, end])); await out.close();
    await fsp.rename(outFile + '.part', outFile);
  } catch (e) { await out.close().catch(() => {}); await fsp.rm(outFile + '.part', { force: true }); throw e; }
}
async function backupWorld(s, world) {
  const src = path.join(savesDir(s), safeName(world));
  if (!(await exists(src))) throw new Error('That world no longer exists.');
  await ensureDir(backupsDir(s));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(backupsDir(s), `${safeName(world)}__${stamp}.zip`);
  await zipFolder(src, file); return path.basename(file);
}
async function restoreWorld(s, file) {
  const name = safeName(file); const m = /^(.+)__\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.zip$/.exec(name);
  if (!m) throw new Error('That is not an Auroria world backup.');
  const zip = path.join(backupsDir(s), name); if (!(await exists(zip))) throw new Error('That backup no longer exists.');
  const dest = path.join(savesDir(s), m[1]);
  if (await exists(dest)) { await backupWorld(s, m[1]); await fsp.rm(dest, { recursive: true, force: true }); }
  await ensureDir(dest); await extractZip(zip, dest);
}
async function listShots(s) {
  const dir = path.join(instanceDir(s), 'screenshots');
  let names = []; try { names = (await fsp.readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f)); } catch {}
  const items = await Promise.all(names.map(async (f) => { try { const st = await fsp.stat(path.join(dir, f)); return { file: f, time: st.mtimeMs, size: st.size }; } catch { return null; } }));
  return items.filter(Boolean).sort((a, b) => b.time - a.time).slice(0, 400);
}
const OPTION_GROUPS = {
  controls: (k) => k.startsWith('key_') || ['mouseSensitivity', 'invertYMouse', 'toggleCrouch', 'toggleSprint', 'autoJump', 'rawMouseInput', 'discrete_mouse_scroll', 'mouseWheelSensitivity'].includes(k),
  video: (k) => ['renderDistance', 'simulationDistance', 'fov', 'maxFps', 'graphicsMode', 'fancyGraphics', 'guiScale', 'gamma', 'enableVsync', 'fullscreen', 'entityShadows', 'particles', 'ao', 'biomeBlendRadius', 'mipmapLevels', 'renderClouds', 'bobView', 'entityDistanceScaling', 'fovEffectScale', 'screenEffectScale', 'prioritizeChunkUpdates', 'darknessEffectScale', 'glintStrength', 'glintSpeed'].includes(k),
  sound: (k) => k.startsWith('soundCategory_') || k === 'soundDevice' || k === 'showSubtitles',
};
const readOptions = async (s) => { try { return await fsp.readFile(path.join(instanceDir(s), 'options.txt'), 'utf8'); } catch { return ''; } };
async function syncOptions(from, to, groups) {
  const want = groups.filter((g) => OPTION_GROUPS[g]);
  if (!want.length) throw new Error('Pick at least one group of settings.');
  if (!(await readOptions(from)).trim()) throw new Error(`${from.name} has no settings yet. Play it once first.`);
  // Key bindings changed format in 1.13 (numbers before, key names after), so they only copy between versions on the same side.
  const keysCompatible = (cmpVer(from.version, '1.13') < 0) === (cmpVer(to.version, '1.13') < 0);
  const src = new Map(); for (const line of (await readOptions(from)).split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) src.set(line.slice(0, i), line.slice(i + 1)); }
  const pick = (k) => want.some((g) => OPTION_GROUPS[g](k)) && !(k.startsWith('key_') && !keysCompatible);
  const lines = (await readOptions(to)).split(/\r?\n/).filter((l) => l !== ''); const seen = new Set(); let changed = 0;
  const outLines = lines.map((l) => { const i = l.indexOf(':'); if (i <= 0) return l; const k = l.slice(0, i); seen.add(k); if (pick(k) && src.has(k) && src.get(k) !== l.slice(i + 1)) { changed++; return `${k}:${src.get(k)}`; } return l; });
  for (const [k, v] of src) if (pick(k) && !seen.has(k)) { outLines.push(`${k}:${v}`); changed++; }
  await ensureDir(instanceDir(to)); await fsp.writeFile(path.join(instanceDir(to), 'options.txt'), outLines.join('\n') + '\n');
  return { changed, skippedKeys: want.includes('controls') && !keysCompatible };
}

// ---------- profile snapshots: the mods and their configs, saved before updates and restorable ----------
const SNAP_PARTS = ['mods', 'config', 'auroria-mods.json'];
const snapsDir = (s) => path.join(instanceDir(s), 'snapshots');
const SNAP_RE = /^(\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d)__([a-z0-9-]{1,40})\.zip$/;
async function listSnapshots(s) {
  let names = []; try { names = await fsp.readdir(snapsDir(s)); } catch {}
  const out = [];
  for (const f of names) { const m = SNAP_RE.exec(f); if (!m) continue; try { const st = await fsp.stat(path.join(snapsDir(s), f)); out.push({ file: f, label: m[2], time: st.mtimeMs, size: st.size }); } catch {} }
  return out.sort((a, b) => b.time - a.time);
}
async function takeSnapshot(s, label = 'manual') {
  const dir = instanceDir(s); await ensureDir(snapsDir(s)); await ensureDir(modsDir(s));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(snapsDir(s), `${stamp}__${String(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'manual'}.zip`);
  await zipFolder(dir, file, SNAP_PARTS);
  // Automatic snapshots keep the newest ten; ones you take yourself stay until you delete them.
  const autos = (await listSnapshots(s)).filter((x) => x.label.startsWith('before-'));
  for (const x of autos.slice(10)) await fsp.rm(path.join(snapsDir(s), x.file), { force: true });
  return path.basename(file);
}
async function restoreSnapshot(s, file) {
  const f = safeName(file); if (!SNAP_RE.test(f)) throw new Error('That is not an Auroria snapshot.');
  const zip = path.join(snapsDir(s), f); if (!(await exists(zip))) throw new Error('That snapshot no longer exists.');
  await takeSnapshot(s, 'before-restore');
  for (const p of SNAP_PARTS) await fsp.rm(path.join(instanceDir(s), p), { recursive: true, force: true });
  await extractZip(zip, instanceDir(s));
  await ensureDir(modsDir(s));
}

// ---------- performance presets: memory, JVM flags and video settings in one click ----------
const G1_TUNED = ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'];
const PRESETS = {
  low: { name: 'Low-end PC', ramGB: 2, jvm: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50', '-XX:+DisableExplicitGC'],
    video: { renderDistance: 6, simulationDistance: 5, graphics: 0, particles: 2, entityShadows: false, ao: false, maxFps: 60, enableVsync: true, biomeBlendRadius: 0, mipmapLevels: 0, renderClouds: 'false', entityDistanceScaling: 0.5 } },
  balanced: { name: 'Balanced', ramGB: 4, jvm: G1_TUNED,
    video: { renderDistance: 10, simulationDistance: 8, graphics: 1, particles: 1, entityShadows: true, ao: true, maxFps: 120, enableVsync: false, biomeBlendRadius: 2, mipmapLevels: 4, renderClouds: 'fast', entityDistanceScaling: 1.0 } },
  max: { name: 'Max FPS', ramGB: 6, jvm: G1_TUNED,
    video: { renderDistance: 8, simulationDistance: 6, graphics: 0, particles: 2, entityShadows: false, ao: false, maxFps: 260, enableVsync: false, biomeBlendRadius: 0, mipmapLevels: 0, renderClouds: 'false', entityDistanceScaling: 0.75 } },
};
async function setOptions(s, kv) {
  const file = path.join(instanceDir(s), 'options.txt');
  const lines = (await fsp.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l !== '');
  const seen = new Set();
  const out = lines.map((l) => { const i = l.indexOf(':'); const k = i > 0 ? l.slice(0, i) : ''; if (k in kv) { seen.add(k); return `${k}:${kv[k]}`; } return l; });
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(`${k}:${v}`);
  await ensureDir(instanceDir(s)); await fsp.writeFile(file, out.join('\n') + '\n');
}
async function applyPreset(s, key) {
  const p = PRESETS[key]; if (!p) throw new Error('Unknown preset.');
  const v = p.video; const kv = {};
  // Option names and value types changed over the years: graphics was a boolean before 1.16, smooth lighting an int before 1.19.
  if (cmpVer(s.version, '1.16') < 0) kv.fancyGraphics = v.graphics > 0; else kv.graphicsMode = v.graphics;
  kv.ao = cmpVer(s.version, '1.19') < 0 ? (v.ao ? 2 : 0) : v.ao;
  if (cmpVer(s.version, '1.18') >= 0) kv.simulationDistance = v.simulationDistance;
  Object.assign(kv, { renderDistance: v.renderDistance, particles: v.particles, entityShadows: v.entityShadows, maxFps: v.maxFps, enableVsync: v.enableVsync, biomeBlendRadius: v.biomeBlendRadius, mipmapLevels: v.mipmapLevels, renderClouds: `"${v.renderClouds}"`, entityDistanceScaling: v.entityDistanceScaling });
  await setOptions(s, kv);
  const cap = Math.max(1, Math.floor(os.totalmem() / 1024 ** 3 / 2));
  Object.assign(s, { preset: key, ramGB: Math.min(p.ramGB, cap), jvmArgs: p.jvm.slice() });
  await writeJson(P.servers, config.servers);
}

// ---------- resource packs and shaders ----------
const isPack = (n) => /\.zip$/i.test(n);
async function listPacks(s, type) {
  const dir = path.join(instanceDir(s), type === 'shader' ? 'shaderpacks' : 'resourcepacks');
  let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch {}
  const names = ents.filter((e) => e.isDirectory() || isPack(e.name)).map((e) => e.name);
  const opts = await fsp.readFile(path.join(instanceDir(s), 'options.txt'), 'utf8').catch(() => '');
  if (type === 'shader') {
    const iris = await fsp.readFile(path.join(instanceDir(s), 'config', 'iris.properties'), 'utf8').catch(() => '');
    const on = !/^enableShaders=false/m.test(iris);
    const m = /^shaderPack=(.*)$/m.exec(iris) || /^shaderPack=(.*)$/m.exec(await fsp.readFile(path.join(instanceDir(s), 'optionsshaders.txt'), 'utf8').catch(() => ''));
    const active = m && on ? m[1].trim() : '';
    return names.sort().map((n) => ({ name: n, enabled: n === active }));
  }
  let list = []; const m = /^resourcePacks:(.*)$/m.exec(opts); if (m) { try { list = JSON.parse(m[1]); } catch {} }
  const order = list.filter((x) => typeof x === 'string' && x.startsWith('file/')).map((x) => x.slice(5)).reverse();
  const enabled = order.filter((n) => names.includes(n));
  return [...enabled.map((n) => ({ name: n, enabled: true })), ...names.filter((n) => !enabled.includes(n)).sort().map((n) => ({ name: n, enabled: false }))];
}
// order: enabled packs, top of the list first (the top pack wins, like the in-game screen).
async function setResourcePacks(s, order) {
  const file = path.join(instanceDir(s), 'options.txt');
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  let list = []; const m = /^resourcePacks:(.*)$/m.exec(text); if (m) { try { list = JSON.parse(m[1]); } catch {} }
  const builtin = list.filter((x) => typeof x === 'string' && !x.startsWith('file/'));
  const have = new Set((await listPacks(s, 'resourcepack')).map((x) => x.name));
  const files = order.map((n) => safeName(n)).filter((n) => have.has(n)).map((n) => `file/${n}`).reverse();
  await setOptions(s, { resourcePacks: JSON.stringify([...(builtin.length ? builtin : ['vanilla']), ...files]) });
}
async function setShader(s, name) {
  const n = name ? safeName(name) : '';
  const cfg = path.join(instanceDir(s), 'config'); await ensureDir(cfg);
  const irisFile = path.join(cfg, 'iris.properties');
  let iris = await fsp.readFile(irisFile, 'utf8').catch(() => '');
  const put = (k, v) => { const re = new RegExp(`^${k}=.*$`, 'm'); iris = re.test(iris) ? iris.replace(re, `${k}=${v}`) : `${iris}${iris && !iris.endsWith('\n') ? '\n' : ''}${k}=${v}\n`; };
  put('enableShaders', n ? 'true' : 'false'); if (n) put('shaderPack', n);
  await fsp.writeFile(irisFile, iris);
  const of = path.join(instanceDir(s), 'optionsshaders.txt');
  let ofText = await fsp.readFile(of, 'utf8').catch(() => '');
  ofText = /^shaderPack=.*$/m.test(ofText) ? ofText.replace(/^shaderPack=.*$/m, `shaderPack=${n || 'OFF'}`) : `${ofText}shaderPack=${n || 'OFF'}\n`;
  await fsp.writeFile(of, ofText);
}

// ---------- desktop shortcut per profile: Auroria.exe --play <id> ----------
let pendingPlay = '';
function argPlay() { const i = process.argv.indexOf('--play'); return i > 0 ? String(process.argv[i + 1] || '') : ''; }
function psRun(script, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: { ...process.env, ...env } });
    let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || `PowerShell exited with ${c}`))));
  });
}
async function createShortcut(s) {
  if (!IS_WIN || !IS_SEA) throw new Error('Shortcuts work from Auroria.exe on Windows.');
  const name = `${s.name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim() || 'Minecraft'} - Auroria`;
  await psRun('$ErrorActionPreference="Stop"; $d=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory, [Environment+SpecialFolderOption]::Create); if (-not $d) { throw "Windows did not report a Desktop folder." }; $l=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ($env:A_NAME + ".lnk"))); $l.TargetPath=$env:A_EXE; $l.Arguments="--play " + $env:A_ID; $l.IconLocation=$env:A_EXE + ",0"; $l.WorkingDirectory=(Split-Path $env:A_EXE); $l.Description="Play " + $env:A_NAME; $l.Save()',
    { A_NAME: name, A_EXE: process.execPath, A_ID: s.id });
  return { name };
}

// ---------- Windows notifications ----------
// Windows shows toasts only for apps it knows: a Start-menu shortcut that carries the app ID. Auroria keeps one (it also puts Auroria in Start).
const AUMID = 'Auroria.Launcher';
const START_LINK_PS = String.raw`
$ErrorActionPreference = 'Stop'
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Auroria.lnk'
if ((Test-Path $lnk) -and (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath -eq $env:A_EXE) { exit 0 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes; using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr d, int fl); void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short k); void SetHotkey(short k); void GetShowCmd(out int c); void SetShowCmd(int c);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r); void Resolve(IntPtr h, int f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}
[StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropKey { public Guid fmt; public uint pid; }
[StructLayout(LayoutKind.Explicit)] struct PropVar { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropKey k); void GetValue(ref PropKey k, out PropVar v); void SetValue(ref PropKey k, ref PropVar v); void Commit(); }
public static class AuroriaStartLink {
  public static void Write(string lnk, string exe, string aumid) {
    var link = (IShellLinkW)new CShellLink();
    link.SetPath(exe); link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(exe)); link.SetIconLocation(exe, 0); link.SetDescription("Auroria Minecraft launcher");
    var key = new PropKey { fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var val = new PropVar { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
    var store = (IPropertyStore)link; store.SetValue(ref key, ref val); store.Commit(); Marshal.FreeCoTaskMem(val.p);
    ((IPersistFile)link).Save(lnk, true);
  }
}
"@
[AuroriaStartLink]::Write($lnk, $env:A_EXE, $env:A_ID)
`;
let toastReady = null;
function notify(title, body) {
  if (!IS_WIN || !IS_SEA || settings.notifications === false) return;
  const x = (t) => String(t).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${x(title)}</text><text>${x(body)}</text></binding></visual></toast>`;
  toastReady = toastReady || psRun(START_LINK_PS, { A_EXE: process.execPath, A_ID: AUMID }).catch((e) => logLine('start menu link failed', e.message));
  toastReady.then(() => psRun(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; $x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:A_XML); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${AUMID}").Show([Windows.UI.Notifications.ToastNotification]::new($x))`, { A_XML: xml }))
    .catch((e) => logLine('toast failed', e.message));
}

// ---------- Discord Rich Presence over Discord's local IPC pipe ----------
const DISCORD_APP_ID = '1566706607197266031';
const discord = { sock: null };
function discordFrame(op, obj) { const d = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(d.length, 4); return Buffer.concat([h, d]); }
async function discordConnect(appId) {
  for (let i = 0; i < 10; i++) {
    const p = IS_WIN ? `\\\\?\\pipe\\discord-ipc-${i}` : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', `discord-ipc-${i}`);
    const sock = await new Promise((resolve) => { const c = net.connect(p); c.once('connect', () => resolve(c)); c.once('error', () => resolve(null)); });
    if (!sock) continue;
    sock.on('error', () => {}); sock.on('close', () => { if (discord.sock === sock) discord.sock = null; });
    // Discord drops commands sent before it answers the handshake with READY.
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      sock.once('data', (d) => { clearTimeout(t); resolve(d.length > 8 && d.readInt32LE(0) === 1 && d.slice(8).toString().includes('"READY"')); });
      sock.once('close', () => { clearTimeout(t); resolve(false); });
      sock.write(discordFrame(0, { v: 1, client_id: appId }));
    });
    if (!ready) { try { sock.destroy(); } catch {} return null; }
    return sock;
  }
  return null;
}
async function discordSet(server, startedAt, join) {
  const appId = config.discordClientId || DISCORD_APP_ID;
  if (!appId || settings.discordPresence === false) return;
  try {
    if (!discord.sock) discord.sock = await discordConnect(appId);
    if (!discord.sock) return;
    const activity = server ? {
      details: server.name.slice(0, 120), state: (join ? `On ${join}` : `Minecraft ${server.version}${server.loader && server.loader !== 'vanilla' ? ` · ${LOADER_LABEL[server.loader] || server.loader}` : ''}`).slice(0, 120),
      timestamps: { start: startedAt }, assets: { large_image: `https://arnxld-afk.github.io/auroria/assets/flame/${themeFlame(settings.accent)}.png`, large_text: 'Auroria Launcher' },
      buttons: [{ label: 'Get Auroria', url: 'https://arnxld-afk.github.io/auroria/' }],
    } : null;
    discord.sock.write(discordFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: crypto.randomUUID() }));
    if (!server) { const s = discord.sock; discord.sock = null; setTimeout(() => { try { s.end(); } catch {} }, 500); }
  } catch (e) { logLine('discord presence failed', e.message); }
}
const LOADER_LABEL = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
// Discord shows the flame in your theme colour. The site hosts one per preset; a custom colour uses the preset closest in hue.
const FLAME_PRESETS = ['f07f2a', 'e5484d', 'f5b82e', '5fb34a', '2ec4b6', '4a8fe0', '9b6cf0', 'e85d9e'];
function themeFlame(accent) {
  const hex = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent.slice(1).toLowerCase() : 'f07f2a';
  if (FLAME_PRESETS.includes(hex)) return hex;
  const hue = (h) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0; const d = mx - mn; const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (x * 60 + 360) % 360; };
  const dist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  return FLAME_PRESETS.reduce((best, p) => (dist(hue(p), hue(hex)) < dist(hue(best), hue(hex)) ? p : best), 'f07f2a');
}

// ---------- auto-update from GitHub Releases ----------
const UPDATE_REPO = 'Arnxld-afk/auroria';
let updateCache = null;
let notifiedUpdate = '';
async function checkUpdate(force) {
  if (!force && updateCache && Date.now() - updateCache.at < 3600000) return updateCache.info;
  const rel = await getJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const exe = (rel.assets || []).find((a) => /^Auroria\.exe$/i.test(a.name));
  const info = { current: VERSION, latest, available: !!exe && cmpVer(latest, VERSION) > 0, notes: String(rel.body || '').slice(0, 2000), size: exe ? exe.size : 0, canApply: IS_SEA && IS_WIN, url: rel.html_url };
  updateCache = { at: Date.now(), info, exe };
  if (info.available && notifiedUpdate !== latest) { notifiedUpdate = latest; notify(`Auroria ${latest} is ready`, 'Open the launcher and press Update now.'); }
  return info;
}
async function applyUpdate() {
  const info = await checkUpdate(true); const exe = updateCache.exe;
  if (!info.available || !exe) throw new Error('Auroria is already up to date.');
  if (!info.canApply) throw new Error('Updating in place only works from Auroria.exe. Download the new version from GitHub.');
  if (game.state !== 'idle') throw new Error('Close Minecraft before updating.');
  const want = /^sha256:([0-9a-f]{64})$/.exec(exe.digest || '');
  if (!want) throw new Error('The release has no checksum, so Auroria will not install it automatically. Download it from GitHub instead.');
  setProgress('Downloading update', 0, 1);
  let res; try { res = await fetch(exe.browser_download_url, { headers: { 'User-Agent': UA } }); } catch (e) { throw netError(exe.browser_download_url, e); }
  if (!res.ok) throw new Error(`Update download failed (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want[1]) throw new Error('The update download did not match its checksum, so it was not installed.');
  const self = process.execPath; const fresh = self + '.new'; const old = self + '.old';
  await fsp.writeFile(fresh, buf);
  await fsp.rm(old, { force: true }).catch(() => {});
  await fsp.rename(self, old); // Windows lets a running exe be renamed, not overwritten
  try { await fsp.rename(fresh, self); } catch (e) { await fsp.rename(old, self).catch(() => {}); throw new Error(`Could not put the update in place: ${e.message}`); }
  logLine('updated to', info.latest);
  setTimeout(() => {
    spawn(self, [], { detached: true, stdio: 'ignore', env: { ...process.env, AURORIA_WAIT_PID: String(process.pid) } }).unref();
    broadcast({ type: 'quit' }); setTimeout(shutdown, 400);
  }, 300);
  return { ok: true, version: info.latest };
}

const routes = {
  'GET /api/ping': async () => ({ ok: true }),
  'POST /api/ui-ready': async (b) => { logLine(`ui ready ${Math.round(Number(b.ms) || 0)} ms after page start`); return { ok: true }; },
  'POST /api/logs/upload': async (b) => {
    const lines = String(b.content || '').split('\n').slice(-24000);
    if (!lines.join('').trim()) throw new Error('The log is empty');
    let res;
    try { res = await fetch('https://api.mclo.gs/1/log', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ content: lines.join('\n') }), signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw netError('https://api.mclo.gs/1/log', e); }
    const j = await res.json().catch(() => null);
    if (!j || !j.success) throw new Error((j && j.error) || `mclo.gs answered HTTP ${res.status}`);
    return { url: j.url };
  },
  'POST /api/window': async (b) => {
    const a = String(b.action || '');
    if (a === 'min') return { r: await winCmd('MIN') };
    if (a === 'max') return { r: await winCmd('MAX') };
    if (a === 'close') return { r: await winCmd('CLOSE') };
    if (a === 'show') { if (winHelper) return { r: await winCmd('SHOW') }; openWindow(`http://127.0.0.1:${PORT}/#${TOKEN}`); return { ok: true }; }
    if (a === 'rect') { const r = await winCmd('RECT'); const m = /^RECT (-?\d+) (-?\d+) (\w+)/.exec(r || ''); return m ? { x: Number(m[1]), y: Number(m[2]), max: m[3] === 'True' } : { x: null }; }
    if (a === 'pos') { winCmd(`POS ${Math.round(Number(b.x) || 0)} ${Math.round(Number(b.y) || 0)}`); return { ok: true }; }
    throw new Error('Unknown window action');
  },
  'GET /api/state': async () => ({
    version: VERSION, windowControls: winReady, clientMods: CLIENT_MODS, ownClientVersions, profile: publicProfile(), accounts: accountList(), settings, hasClientId: true, authMode: authMode(), clientId: config.microsoftClientId || '',
    config: { brand: config.brand, servers: config.servers },
    game: { state: game.state, serverId: game.serverId, progress: game.progress }, dataDir: DATA, autoPlay: (() => { const p = pendingPlay; pendingPlay = ''; return p; })(),
  }),
  'POST /api/auth/start': async () => startAuth(),
  'POST /api/config/client-id': async (b) => {
    const id = String(b.clientId || '').trim();
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('That does not look like an Application (client) ID. It has the form 00000000-0000-0000-0000-000000000000.');
    const user = await readJson(P.config, {});
    user.microsoftClientId = id; await writeJson(P.config, user);
    config.microsoftClientId = id;
    return { ok: true, clientId: id };
  },
  'POST /api/auth/cancel': async () => { if (authFlow) authFlow.cancelled = true; return { ok: true }; },
  'POST /api/auth/logout': async () => { dropAccount(account); await saveAccount(); return { profile: publicProfile(), accounts: accountList() }; },
  'POST /api/auth/switch': async (b) => {
    const a = accounts.find((x) => accountId(x) === b.id);
    if (!a) throw new Error('That account is no longer signed in.');
    if (game.state !== 'idle') throw new Error('Stop the game before switching accounts.');
    account = a; await saveAccount();
    return { profile: publicProfile(), accounts: accountList() };
  },
  'POST /api/profile/refresh': async () => refreshProfile(),
  'POST /api/settings': async (b) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) settings[k] = b[k];
    settings.ramGB = Math.min(32, Math.max(1, Number(settings.ramGB) || 4));
    settings.width = Math.max(320, Number(settings.width) || 1280);
    settings.height = Math.max(240, Number(settings.height) || 720);
    if (!/^#[0-9a-f]{6}$/i.test(settings.accent || '')) settings.accent = '';
    settings.notifications = settings.notifications !== false; settings.discordPresence = settings.discordPresence !== false; settings.updateCheck = settings.updateCheck !== false;
    await saveSettings(); return settings;
  },
  'POST /api/servers/save': async (b) => {
    const name = String(b.name || '').trim().slice(0, 48);
    if (!name) throw new Error('Give the server a name.');
    const version = String(b.version || '').trim();
    if (!/^[0-9a-z.\-_ ]{2,40}$/i.test(version)) throw new Error('Pick a Minecraft version, for example 1.20.1.');
    const address = String(b.address || '').trim();
    if (address && !/^[a-z0-9.\-[\]:]+$/i.test(address)) throw new Error('The address can only contain letters, numbers, dots, dashes and a :port.');
    const loader = LOADERS.includes(b.loader) ? b.loader : 'vanilla';
    const mods = loader !== 'vanilla' ? String(b.mods || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9_\-]{2,64}$/.test(x)).slice(0, 50) : [];
    const tag = String(b.tag || '').trim().toLowerCase().slice(0, 20);
    const list = config.servers.slice();
    let entry = list.find((s) => s.id === b.id);
    if (!entry) {
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
      while (list.some((s) => s.id === id)) id += '-' + crypto.randomBytes(2).toString('hex');
      entry = { id }; list.push(entry);
    }
    const loaderVersion = loader === 'vanilla' ? '' : String(b.loaderVersion || '').trim().slice(0, 40);
    const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : (entry.color || '#f07f2a');
    const icon = b.icon === undefined ? (entry.icon || '') : (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.icon) && b.icon.length <= 200000 ? b.icon : '');
    const ramGB = b.ramGB ? Math.min(32, Math.max(1, Number(b.ramGB) || 0)) : 0;
    const javaPath = b.javaPath === undefined ? (entry.javaPath || '') : String(b.javaPath || '').trim();
    if (javaPath && (!/(^|[\\/])javaw?(\.exe)?$/i.test(javaPath) || !(await exists(javaPath)))) throw new Error('That Java was not found. Pick one from the list, or leave it on Automatic.');
    entry.javaPath = javaPath;
    if (entry.version && (entry.version !== version || entry.loader !== loader || (entry.loaderVersion || '') !== loaderVersion)) entry.changed = Date.now();
    const client = true; // Auroria Client is part of every profile
    Object.assign(entry, { client, name, address, version, loader, loaderVersion, mods, color, icon, ramGB, description: String(b.description || '').trim().slice(0, 120), tags: tag ? [tag] : [], badge: entry.badge || '', created: entry.created || Date.now() });
    config.servers = list; await writeJson(P.servers, list);
    return { servers: list, id: entry.id };
  },
  'POST /api/servers/delete': async (b) => {
    if (config.servers.length <= 1) throw new Error('Keep at least one server in the list.');
    config.servers = config.servers.filter((s) => s.id !== b.id); await writeJson(P.servers, config.servers);
    if (settings.selectedServer === b.id) { settings.selectedServer = config.servers[0].id; await saveSettings(); }
    return { servers: config.servers, settings };
  },
  'GET /api/servers/ping-one': async (b, q) => {
    const a = String(q.get('address') || '').trim();
    if (!a || !/^[a-z0-9.\-[\]:]+$/i.test(a)) throw new Error('Enter an address first.');
    return pingServer(a, 4000);
  },
  'GET /api/versions': async () => {
    if (!versionCache) { const m = await getJson(VERSION_MANIFEST); versionCache = { latest: m.latest, versions: m.versions.map((v) => ({ id: v.id, type: v.type, date: v.releaseTime })) }; }
    return versionCache;
  },
  'GET /api/loader-versions': async (b, q) => {
    const loader = q.get('loader'); const mc = q.get('mc') || '';
    if (!LOADERS.includes(loader) || loader === 'vanilla') return [];
    return (await loaderVersions(loader, mc)).slice(0, 60);
  },
  'GET /api/import/scan': async () => (await scanImports()).map(({ dir, icon, ...e }) => ({ ...e, hasIcon: !!icon })),
  'POST /api/import/run': async (b) => {
    const src = (await scanImports()).find((e) => e.id === b.id);
    if (!src) throw new Error('That profile was not found any more. Reopen this window to scan again.');
    const entry = newProfileEntry({ name: src.name, version: src.version, loader: src.loader, loaderVersion: src.loaderVersion, icon: src.icon, description: `Imported from ${src.source}` });
    const dest = instanceDir(entry);
    try {
      await fsp.cp(src.dir, dest, { recursive: true, filter: (f) => f === src.dir || !IMPORT_SKIP.has(path.basename(f)) });
    } catch (e) { await fsp.rm(dest, { recursive: true, force: true }); throw new Error(`Could not copy the files: ${e.message}`); }
    return commitProfile(entry);
  },
  'POST /api/import/mrpack': async (b) => {
    const m = /^data:[^;]*;base64,(.*)$/s.exec(String(b.data || ''));
    if (!m) throw new Error('No file received.');
    return importMrpack(Buffer.from(m[1], 'base64'));
  },
  'POST /api/modpacks/install': async (b) => { const r = await installModpack(String(b.projectId || '')); const e = config.servers.find((x) => x.id === r.id); notify('Modpack installed', `${e ? e.name : 'The modpack'} is ready to play.`); return r; },
  'GET /api/snapshots': async (b, q) => listSnapshots(serverById(q.get('server'))),
  'POST /api/snapshots/take': async (b) => { const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft first.'); await takeSnapshot(s, b.label || 'manual'); return listSnapshots(s); },
  'POST /api/snapshots/restore': async (b) => { const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft before restoring a snapshot.'); await restoreSnapshot(s, b.file); return listSnapshots(s); },
  'POST /api/snapshots/delete': async (b) => { const s = serverById(b.server); const f = safeName(b.file); if (!SNAP_RE.test(f)) throw new Error('That is not an Auroria snapshot.'); await fsp.rm(path.join(snapsDir(s), f), { force: true }); return listSnapshots(s); },
  'GET /api/presets': async () => ({ presets: Object.entries(PRESETS).map(([k, p]) => ({ key: k, name: p.name, ramGB: Math.min(p.ramGB, Math.max(1, Math.floor(os.totalmem() / 1024 ** 3 / 2))), video: p.video })), totalGB: Math.round(os.totalmem() / 1024 ** 3) }),
  'POST /api/profile/preset': async (b) => { const s = config.servers.find((x) => x.id === b.server); if (!s) throw new Error('That profile no longer exists.'); if (profileBusy(s)) throw new Error('Close Minecraft first, or it will overwrite the new settings.'); await applyPreset(s, b.preset); return { servers: config.servers }; },
  'GET /api/packs': async (b, q) => listPacks(serverById(q.get('server')), q.get('type') === 'shader' ? 'shader' : 'resourcepack'),
  'POST /api/packs/order': async (b) => { const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft first, or it will undo this change.'); await setResourcePacks(s, Array.isArray(b.order) ? b.order.map(String) : []); return listPacks(s, 'resourcepack'); },
  'POST /api/packs/shader': async (b) => { const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft first, or it will undo this change.'); await setShader(s, b.name || ''); return listPacks(s, 'shader'); },
  'POST /api/packs/delete': async (b) => {
    const s = serverById(b.server); const type = b.type === 'shader' ? 'shader' : 'resourcepack';
    await fsp.rm(path.join(instanceDir(s), type === 'shader' ? 'shaderpacks' : 'resourcepacks', safeName(b.name)), { recursive: true, force: true });
    return listPacks(s, type);
  },
  'POST /api/profile/shortcut': async (b) => createShortcut(serverById(b.server)),
  'POST /api/autoplay': async (b) => { const s = config.servers.find((x) => x.id === b.id); if (!s) throw new Error('That profile no longer exists.'); settings.selectedServer = s.id; await saveSettings(); broadcast({ type: 'autoplay', id: s.id }); return { ok: true }; },
  'POST /api/profile/export': async (b) => exportProfile(serverById(b.server)),
  'GET /api/worlds': async (b, q) => listWorlds(serverById(q.get('server'))),
  'POST /api/worlds/backup': async (b) => {
    const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft before backing up its worlds.');
    return { file: await backupWorld(s, b.world), worlds: await listWorlds(s) };
  },
  'POST /api/worlds/restore': async (b) => {
    const s = serverById(b.server); if (profileBusy(s)) throw new Error('Close Minecraft before restoring a world.');
    await restoreWorld(s, b.file); return { worlds: await listWorlds(s) };
  },
  'POST /api/worlds/delete-backup': async (b) => {
    const s = serverById(b.server); const f = safeName(b.file);
    if (!/__\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.zip$/.test(f)) throw new Error('That is not an Auroria world backup.');
    await fsp.rm(path.join(backupsDir(s), f), { force: true }); return { worlds: await listWorlds(s) };
  },
  'POST /api/worlds/open': async (b) => { const s = serverById(b.server); const d = b.backups ? backupsDir(s) : savesDir(s); await ensureDir(d); openExternal(d); return { ok: true }; },
  'GET /api/shots': async (b, q) => listShots(serverById(q.get('server'))),
  'POST /api/shots/open': async (b) => {
    const s = serverById(b.server); const dir = path.join(instanceDir(s), 'screenshots');
    if (b.file) { const f = path.join(dir, safeName(b.file)); if (await exists(f)) openExternal(f); } else { await ensureDir(dir); openExternal(dir); }
    return { ok: true };
  },
  'POST /api/options/sync': async (b) => {
    const from = config.servers.find((s) => s.id === b.from); const to = config.servers.find((s) => s.id === b.to);
    if (!from || !to || from.id === to.id) throw new Error('Pick another profile to copy from.');
    if (profileBusy(to)) throw new Error('Close Minecraft first, or it will overwrite the copied settings.');
    return syncOptions(from, to, Array.isArray(b.groups) ? b.groups : []);
  },
  'POST /api/profile/servers': async (b) => {
    const s = config.servers.find((x) => x.id === b.server); if (!s) throw new Error('That profile no longer exists.');
    const list = (Array.isArray(b.list) ? b.list : []).slice(0, 30).map((x) => ({ name: String(x.name || '').trim().slice(0, 40), address: String(x.address || '').trim().slice(0, 80) }))
      .filter((x) => x.address && /^[a-z0-9.\-[\]:]+$/i.test(x.address)).map((x) => ({ ...x, name: x.name || x.address }));
    s.serverList = list; await writeJson(P.servers, config.servers); return { servers: config.servers };
  },
  'GET /api/update/check': async (b, q) => checkUpdate(q.get('force') === '1'),
  'POST /api/update/apply': async () => applyUpdate(),
  'POST /api/servers/duplicate': async (b) => {
    const src = config.servers.find((s) => s.id === b.id);
    if (!src) throw new Error('That profile no longer exists.');
    let id = `${src.id}-copy`; while (config.servers.some((s) => s.id === id)) id += '-' + crypto.randomBytes(2).toString('hex');
    const copy = { ...JSON.parse(JSON.stringify(src)), id, name: `${src.name} (copy)`.slice(0, 48), created: Date.now(), lastPlayed: 0, playMs: 0, playDays: {} };
    config.servers.push(copy);
    if (await exists(instanceDir(src))) await fsp.cp(instanceDir(src), instanceDir(copy), { recursive: true });
    await writeJson(P.servers, config.servers);
    return { servers: config.servers, id };
  },
  'GET /api/servers/ping': async () => Promise.all(config.servers.map(async (s) => ({ id: s.id, ...(s.address ? await pingServer(s.address) : { online: null }) }))),
  'POST /api/launch': async (b) => {
    if (game.state !== 'idle') throw new Error('The game is already starting or running.');
    const join = String(b.join || '').trim();
    if (join && !/^[a-z0-9.\-[\]:]+$/i.test(join)) throw new Error('That server address is not valid.');
    launch(b.serverId || settings.selectedServer, join).catch((e) => logLine('launch rejected', e.message)); // launch reports its own failures; never let one take the process down
    return { ok: true };
  },
  'POST /api/stop': async () => { if (game.proc) { game.userStopped = true; game.proc.kill(); } return { ok: true }; },
  'GET /api/launch-check': async (b, q) => {
    const s = serverById(q.get('server'));
    if (!s || s.loader === 'vanilla') return { outdated: [], problems: [] };
    const [problems, outdated] = await Promise.all([analyzeMods(s).catch(() => []), Promise.race([modUpdates(s), sleep(7000).then(() => [])]).catch(() => [])]);
    return { problems, outdated };
  },
  'GET /api/logs': async () => ({ lines: game.logs }),
  'GET /api/mods': async (b, q) => listMods(serverById(q.get('server')), q.get('fast') !== '1'),
  'GET /api/mods/sig': async (b, q) => {
    const dir = modsDir(serverById(q.get('server')));
    let names = []; try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled')).sort(); } catch {}
    const parts = [];
    for (const f of names) { try { const st = await fsp.stat(path.join(dir, f)); parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`); } catch {} }
    return parts.join('|');
  },
  'GET /api/mods/updates': async (b, q) => modUpdates(serverById(q.get('server'))),
  'GET /api/mods/search': async (b, q) => {
    const s = serverById(q.get('server'));
    const type = q.get('type') === 'modpack' ? 'modpack' : PACK_TYPES[q.get('type')] ? q.get('type') : 'mod';
    // Modpacks bring their own version and loader and become a new profile, so they are not filtered by this one.
    const facets = type === 'modpack' ? [['project_type:modpack']] : [[`versions:${s.version}`], [`project_type:${type}`]];
    if (type === 'mod') facets.push(modLoaders(s).map((l) => `categories:${l}`));
    const index = ['relevance', 'downloads', 'newest', 'updated', 'follows'].includes(q.get('sort')) ? q.get('sort') : 'relevance';
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const r = await getJson(`${MR}/search?query=${encodeURIComponent(q.get('q') || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=${index}&offset=${offset}&limit=20`);
    const idx = await modIndex(s);
    return {
      total: r.total_hits, offset,
      hits: r.hits.map((h) => ({ projectId: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, icon: h.icon_url,
        downloads: h.downloads, follows: h.follows, categories: (h.display_categories || h.categories || []).slice(0, 3), installed: !!idx[h.project_id], type })),
    };
  },
  'POST /api/mods/install': async (b) => {
    const s = serverById(b.server); const type = PACK_TYPES[b.type] ? b.type : 'mod';
    const before = type === 'mod' ? await listMods(s) : [];
    const have = new Set(before.map((m) => m.projectId).filter(Boolean));
    const visited = new Set();
    await installModProject(s, b.projectId, visited, type, have);
    if (type === 'mod') for (const pid of visited) await dropReplacedJars(s, pid, before);
    const mods = await listMods(s);
    if (b.withDeps) return { mods, deps: Math.max(0, visited.size - 1) };
    return mods;
  },
  // A mod id from fabric.mod.json is usually the Modrinth slug; otherwise take the best search hit for this version and loader.
  'POST /api/mods/install-dep': async (b) => {
    const s = serverById(b.server); const dep = String(b.dep || '');
    if (!/^[a-z0-9_.-]{1,64}$/i.test(dep)) throw new Error('Unknown mod.');
    let project = null;
    if (/^fabric(-api)?($|-)/.test(dep)) project = await getJson(`${MR}/project/P7dR8mSH`);
    if (!project) project = await getJson(`${MR}/project/${encodeURIComponent(dep)}`).catch(() => null);
    if (!project || project.project_type !== 'mod') {
      const facets = [['project_type:mod'], [`versions:${s.version}`], modLoaders(s).map((l) => `categories:${l}`)];
      const r = await getJson(`${MR}/search?query=${encodeURIComponent(dep.replace(/[-_]/g, ' '))}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=5`);
      const hit = r.hits.find((h) => h.slug === dep || h.slug.replace(/-/g, '') === dep.replace(/[-_]/g, '')) || r.hits[0];
      if (!hit) throw new Error(`Could not find "${dep}" on Modrinth for Minecraft ${s.version}. Look for it under Browse.`);
      project = { id: hit.project_id, title: hit.title };
    }
    const before = await listMods(s); const have = new Set(before.map((m) => m.projectId).filter(Boolean));
    const visited = new Set(); await installModProject(s, project.id, visited, 'mod', have);
    for (const pid of visited) await dropReplacedJars(s, pid, before);
    return { title: project.title, mods: await listMods(s) };
  },
  'GET /api/mods/dependents': async (b, q) => modDependents(serverById(q.get('server')), path.basename(q.get('file') || '')),
  'GET /api/java': async (b, q) => {
    const s = serverById(q.get('server'));
    const [list, base] = await Promise.all([detectJavas(), loadVanilla(s.version).catch(() => null)]);
    return { list, required: base && base.javaVersion ? base.javaVersion.majorVersion : (cmpVer(s.version, '1.17') < 0 ? 8 : 17), current: s.javaPath || '' };
  },
  'POST /api/mods/toggle': async (b) => {
    const s = serverById(b.server); const dir = modsDir(s); const f = path.basename(b.file);
    const to = f.endsWith('.disabled') ? f.replace(/\.disabled$/, '') : f + '.disabled';
    await fsp.rename(path.join(dir, f), path.join(dir, to)); return listMods(s);
  },
  'POST /api/mods/delete': async (b) => {
    const s = serverById(b.server); await fsp.rm(path.join(modsDir(s), path.basename(b.file)), { force: true }); return listMods(s, !b.fast);
  },
  'POST /api/mods/update': async (b) => {
    const s = serverById(b.server);
    const before = await listMods(s);
    if ((b.updates || []).length) await takeSnapshot(s, 'before-update').catch((e) => logLine('snapshot failed', e.message));
    for (const u of b.updates || []) if (u.projectId) { await installModProject(s, u.projectId); await dropReplacedJars(s, u.projectId, before); }
    return listMods(s);
  },
  'GET /api/skins': async () => ({ profile: publicProfile(), library: await skinLibrary() }),
  'POST /api/skins/upload': async (b) => {
    const png = Buffer.from(String(b.data || '').replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.slice(1, 4).toString() !== 'PNG') throw new Error('Skins must be PNG files.');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w !== 64 || (h !== 64 && h !== 32)) throw new Error('Skins must be 64×64 or 64×32 pixels.');
    const id = crypto.randomBytes(6).toString('hex');
    await ensureDir(P.skins); await fsp.writeFile(path.join(P.skins, `${id}.png`), png);
    const lib = await skinLibrary(); lib.push({ id, name: String(b.name || 'Skin').slice(0, 40), variant: b.variant === 'SLIM' ? 'SLIM' : 'CLASSIC' });
    await saveSkinLibrary(lib); return lib;
  },
  'POST /api/skins/delete': async (b) => {
    const lib = (await skinLibrary()).filter((s) => s.id !== b.id);
    await fsp.rm(path.join(P.skins, `${path.basename(b.id)}.png`), { force: true }); await saveSkinLibrary(lib); return lib;
  },
  'POST /api/skins/apply': async (b) => applySkin(b.id),
  'POST /api/capes/apply': async (b) => applyCape(b.capeId || null),
  'POST /api/open': async (b) => {
    const s = serverById(settings.selectedServer);
    if (b.what === 'mods') { await ensureDir(modsDir(s)); openExternal(modsDir(s)); }
    else if (b.what === 'resourcepacks' || b.what === 'shaderpacks') { const d = path.join(instanceDir(s), b.what); await ensureDir(d); openExternal(d); }
    else if (b.what === 'game') { await ensureDir(instanceDir(s)); openExternal(instanceDir(s)); }
    else if (b.what === 'profile') { const t = config.servers.find((x) => x.id === b.id); if (t) { await ensureDir(instanceDir(t)); openExternal(instanceDir(t)); } }
    else if (b.what === 'data') openExternal(DATA);
    else if (b.what === 'url' && /^https:\/\//.test(b.url || '')) openExternal(b.url);
    return { ok: true };
  },
};

async function handle(req, res) {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [name, type] = STATIC[url.pathname];
    try {
      // The page paints in the saved accent from its first frame, splash included.
      if (url.pathname === '/') return send(res, 200, asset(name).toString('utf8').replace('__ACCENT__', /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : ''), type);
      return send(res, 200, asset(name), type);
    } catch { return send(res, 404, 'Not found', 'text/plain'); }
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
  const tok = req.headers['x-auroria-token'] || url.searchParams.get('token');
  if (tok !== TOKEN) return send(res, 401, { error: 'Unauthorized' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res); everConnected = true;
    const keep = setInterval(() => { try { res.write(': k\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(keep); clients.delete(res); maybeExit(); });
    return;
  }
  if (url.pathname === '/api/cape-image') {
    const u = url.searchParams.get('url') || '';
    if (!/^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]+$/.test(u)) return send(res, 400, { error: 'Bad cape URL' });
    try { const r = await fetch(u.replace(/^http:/, 'https:')); return send(res, 200, Buffer.from(await r.arrayBuffer()), 'image/png'); }
    catch { return send(res, 404, { error: 'No cape' }); }
  }
  if (url.pathname === '/api/skin-image') {
    try {
      const id = url.searchParams.get('id') || '';
      if (id === 'current' || id.startsWith('acct:')) {
        const prev = account;
        if (id !== 'current') account = accounts.find((x) => accountId(x) === id.slice(5)) || account;
        const pp = publicProfile(); account = prev;
        if (!pp || !pp.skin || !/^https?:\/\/textures\.minecraft\.net\//.test(pp.skin.url)) return send(res, 404, { error: 'No skin' });
        const r = await fetch(pp.skin.url.replace(/^http:/, 'https:'));
        return send(res, 200, Buffer.from(await r.arrayBuffer()), 'image/png');
      }
      return send(res, 200, await fsp.readFile(path.join(P.skins, `${path.basename(id)}.png`)), 'image/png');
    } catch { return send(res, 404, { error: 'No skin' }); }
  }
  if (url.pathname === '/api/profile-image') {
    try {
      const s = serverById(url.searchParams.get('server')); const name = safeName(url.searchParams.get('name'));
      const file = url.searchParams.get('kind') === 'world' ? path.join(savesDir(s), name, 'icon.png') : path.join(instanceDir(s), 'screenshots', name);
      return send(res, 200, await fsp.readFile(file), /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png');
    } catch { return send(res, 404, { error: 'No image' }); }
  }
  const fn = routes[`${req.method} ${url.pathname}`];
  if (!fn) return send(res, 404, { error: 'Unknown endpoint' });
  try {
    const body = req.method === 'POST' ? await readBody(req, url.pathname === '/api/import/mrpack' ? 400 * 1024 * 1024 : undefined) : {};
    send(res, 200, await fn(body, url.searchParams));
  } catch (e) {
    logLine('api error', url.pathname, e.stack || e.message);
    send(res, 500, { error: e.message || 'Something went wrong' });
  }
}

// ---------- frameless window (Windows): strips the Edge title bar and drives the window from the UI ----------
const WIN_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class AW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() != title) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (!c.ToString().StartsWith("Chrome_WidgetWin")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static MONITORINFO Work(IntPtr h) { var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfo(MonitorFromWindow(h, 2), ref mi); return mi; }
}
"@
$script:h = [IntPtr]::Zero
$script:saved = $null
function Say($t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }
Say 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  if ($script:h -eq [IntPtr]::Zero -or -not [AW]::IsWindow($script:h)) { $script:h = [AW]::Find('Auroria') }
  $w = $script:h
  if ($w -eq [IntPtr]::Zero) { Say 'NOWIN'; continue }
  switch ($p[0]) {
    'STRIP' {
      $s = [AW]::GetLong($w, -16).ToInt64()
      $ns = $s -band (-bnot [int64]0x00C40000)
      if ($ns -ne $s) {
        [void][AW]::SetLong($w, -16, [IntPtr]$ns)
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
        $v = 2; [void][AW]::DwmSetWindowAttribute($w, 33, [ref]$v, 4)
      }
      Say 'OK'
    }
    'MIN' { [void][AW]::ShowWindow($w, 6); Say 'OK' }
    'MAX' {
      if ($script:saved -eq $null) {
        $r = New-Object AW+RECT; [void][AW]::GetWindowRect($w, [ref]$r); $script:saved = $r
        $m = [AW]::Work($w).rcWork
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, $m.L, $m.T, $m.R - $m.L, $m.B - $m.T, 0x24)
        Say 'MAX 1'
      } else {
        $r = $script:saved; $script:saved = $null
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, $r.L, $r.T, $r.R - $r.L, $r.B - $r.T, 0x24)
        Say 'MAX 0'
      }
    }
    'CLOSE' { [void][AW]::PostMessage($w, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); Say 'OK' }
    'RECT' { $r = New-Object AW+RECT; [void][AW]::GetWindowRect($w, [ref]$r); Say ("RECT " + $r.L + " " + $r.T + " " + ($script:saved -ne $null)) }
    'POS' { $script:saved = $null; [void][AW]::SetWindowPos($w, [IntPtr]::Zero, [int]$p[1], [int]$p[2], 0, 0, 0x15); Say 'OK' }
    default { Say 'ERR' }
  }
}
`;
let winHelper = null; let winQueue = []; let winReady = false; let winBuf = '';
function startWindowHelper() {
  if (!IS_WIN || process.env.AURORIA_NO_WINDOW || winHelper) return;
  try {
    winHelper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(WIN_PS, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) { logLine('window helper failed', e.message); winHelper = null; return; }
  winHelper.stdout.on('data', (d) => {
    winBuf += d.toString('utf8'); let i;
    while ((i = winBuf.indexOf('\n')) >= 0) {
      const line = winBuf.slice(0, i).trim(); winBuf = winBuf.slice(i + 1);
      if (line === 'READY') continue;
      const next = winQueue.shift(); if (next) next(line);
    }
  });
  winHelper.on('exit', () => { winHelper = null; winReady = false; for (const r of winQueue.splice(0)) r(null); });
  // Keep the title bar off: retry until the window appears, then re-check now and then.
  let tries = 0;
  const tick = async () => {
    if (!winHelper) return;
    const r = await winCmd('STRIP');
    if (r === 'OK' && !winReady) { winReady = true; broadcast({ type: 'window', ready: true }); }
    tries++;
    setTimeout(tick, winReady ? 3000 : tries < 60 ? 400 : 3000);
  };
  setTimeout(tick, 600);
}
function winCmd(cmd) {
  if (!winHelper) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    winQueue.push(fin); winHelper.stdin.write(cmd + '\n');
    setTimeout(() => { const i = winQueue.indexOf(fin); if (i >= 0) winQueue.splice(i, 1); fin(null); }, 3000);
  });
}

// ---------- native window (Windows): a borderless WebView2 window, no browser title bar ----------
// Runs in a hidden PowerShell process that compiles a small WinForms host. Talks over stdin/stdout like the helper above.
const HOST_PS = String.raw`
$ErrorActionPreference = 'Stop'
$sdk = $env:AURORIA_SDK
try {
$src = @"
using System; using System.Drawing; using System.IO; using System.Reflection; using System.Threading; using System.Windows.Forms; using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core; using Microsoft.Web.WebView2.WinForms;
public static class AuroriaResolver {
  static string dir;
  public static void Install(string d) { dir = d; AppDomain.CurrentDomain.AssemblyResolve += Resolve; }
  static Assembly Resolve(object s, ResolveEventArgs e) {
    string p = Path.Combine(dir, new AssemblyName(e.Name).Name + ".dll");
    return File.Exists(p) ? Assembly.LoadFrom(p) : null;
  }
}
public class AuroriaHost : Form {
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string p);
  static readonly object Gate = new object();
  static void Say(string s) { lock (Gate) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  const int Grip = 6;
  readonly WebView2 web;
  public AuroriaHost(string url, string profile, string icon) {
    Text = "Auroria"; FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.CenterScreen;
    BackColor = Color.FromArgb(20, 12, 8);
    try { Icon = Icon.ExtractAssociatedIcon(icon); } catch { }
    float scale = 1f; using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
    Rectangle wa = Screen.PrimaryScreen.WorkingArea;
    ClientSize = new Size(Math.Min((int)(1300 * scale), wa.Width - 40), Math.Min((int)(800 * scale), wa.Height - 40));
    MinimumSize = new Size((int)(960 * scale), (int)(600 * scale));
    Opacity = 0;
    System.Windows.Forms.Timer failsafe = new System.Windows.Forms.Timer(); failsafe.Interval = 7000; failsafe.Tick += (o, a) => { failsafe.Stop(); Reveal(); }; failsafe.Start();
    web = new WebView2(); web.Dock = DockStyle.Fill; web.DefaultBackgroundColor = BackColor;
    CoreWebView2CreationProperties props = new CoreWebView2CreationProperties(); props.UserDataFolder = profile; web.CreationProperties = props;
    web.CoreWebView2InitializationCompleted += OnReady;
    Controls.Add(web);
    web.Source = new Uri(url);
  }
  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.Style |= 0x20000 | 0x80000; cp.ClassStyle |= 0x20000; return cp; } }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int round = 2; try { DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch { }
    Thread t = new Thread(ReadCommands); t.IsBackground = true; t.Start();
  }
  void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) { string l = line; try { BeginInvoke((Action)(() => Command(l, true))); } catch { } }
    try { BeginInvoke((Action)(() => Close())); } catch { }
  }
  void OnReady(object sender, CoreWebView2InitializationCompletedEventArgs e) {
    if (!e.IsSuccess) { Say("FAIL " + (e.InitializationException != null ? e.InitializationException.Message.Replace("\n", " ") : "WebView2 did not start")); Environment.Exit(3); return; }
    CoreWebView2Settings st = web.CoreWebView2.Settings;
    st.IsStatusBarEnabled = false; st.IsZoomControlEnabled = false; st.AreDevToolsEnabled = false; st.AreBrowserAcceleratorKeysEnabled = false;
    web.CoreWebView2.WebMessageReceived += OnMessage;
    web.CoreWebView2.NewWindowRequested += (o, a) => { a.Handled = true; try { System.Diagnostics.Process.Start(a.Uri); } catch { } };
    Say("SHOWN");
  }
  void Reveal() { if (Opacity < 1) { Opacity = 1; try { Activate(); } catch { } } }
  void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    string m; try { m = e.TryGetWebMessageAsString(); } catch { return; }
    if (m == "ready") { Reveal(); return; }
    if (m == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); }
    else Command(m.ToUpperInvariant(), false);
  }
  void ToggleMax() {
    if (WindowState == FormWindowState.Maximized) { WindowState = FormWindowState.Normal; return; }
    Screen sc = Screen.FromHandle(Handle); Rectangle wa = sc.WorkingArea;
    MaximizedBounds = new Rectangle(wa.X - sc.Bounds.X, wa.Y - sc.Bounds.Y, wa.Width, wa.Height);
    WindowState = FormWindowState.Maximized;
  }
  void Command(string line, bool reply) {
    string[] p = line.Split(' ');
    string r = "OK";
    switch (p[0]) {
      case "STRIP": break;
      case "MIN": WindowState = FormWindowState.Minimized; break;
      case "MAX": ToggleMax(); r = WindowState == FormWindowState.Maximized ? "MAX 1" : "MAX 0"; break;
      case "CLOSE": Close(); break;
      case "SHOW": if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); SetForegroundWindow(Handle); break;
      case "RECT": r = "RECT " + Left + " " + Top + " " + (WindowState == FormWindowState.Maximized ? "True" : "False"); break;
      case "POS": if (p.Length > 2) Location = new Point(int.Parse(p[1]), int.Parse(p[2])); break;
      default: r = "ERR"; break;
    }
    if (reply) Say(r);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x84 && WindowState == FormWindowState.Normal) {
      long lp = m.LParam.ToInt64();
      Point pt = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
      bool l = pt.X < Grip, rr = pt.X >= ClientSize.Width - Grip, t = pt.Y < Grip, b = pt.Y >= ClientSize.Height - Grip;
      int hit = t && l ? 13 : t && rr ? 14 : b && l ? 16 : b && rr ? 17 : l ? 10 : rr ? 11 : t ? 12 : b ? 15 : 0;
      if (hit != 0) { m.Result = (IntPtr)hit; return; }
    }
    base.WndProc(ref m);
  }
  protected override void OnResize(EventArgs e) { base.OnResize(e); Padding = WindowState == FormWindowState.Maximized ? new Padding(0) : new Padding(2); }
  public static void Run(string url, string profile, string icon, string sdk) {
    try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    try { SetCurrentProcessExplicitAppUserModelID("Auroria.Launcher"); } catch { }
    if (LoadLibrary(Path.Combine(sdk, "x64", "WebView2Loader.dll")) == IntPtr.Zero) LoadLibrary(Path.Combine(sdk, "arm64", "WebView2Loader.dll"));
    Application.EnableVisualStyles();
    Application.Run(new AuroriaHost(url, profile, icon));
  }
}
"@
# Compiling this C# costs ~0.5 s on every start (two csc runs). Compile once per source version and load the cached assembly after that.
$sha = [System.Security.Cryptography.SHA1]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src)) | ForEach-Object { $_.ToString('x2') })
New-Item -ItemType Directory -Force -Path $env:AURORIA_CACHE | Out-Null
$dll = Join-Path $env:AURORIA_CACHE ('host-' + $hash.Substring(0, 12) + '.dll')
if (-not (Test-Path $dll)) {
  $tmp = $dll + '.tmp'
  Add-Type -IgnoreWarnings -ReferencedAssemblies System.Windows.Forms, System.Drawing, (Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $sdk 'Microsoft.Web.WebView2.WinForms.dll') -TypeDefinition $src -OutputAssembly $tmp
  Move-Item -Force $tmp $dll
}
Add-Type -Path $dll
[AuroriaResolver]::Install($sdk)
} catch { [Console]::Out.WriteLine('FAIL ' + ($_.Exception.Message -replace '\s+', ' ')); [Console]::Out.Flush(); exit 2 }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
[AuroriaHost]::Run($env:AURORIA_URL, $env:AURORIA_PROFILE, $env:AURORIA_ICON, $sdk)
`;
const WV_SDK = path.join(DATA, 'webview', 'sdk');
// Microsoft's WebView2 SDK is not open source, so Auroria does not ship it: it fetches the official NuGet package once,
// checks it against a pinned SHA-256 and keeps the four files it needs.
const WV_VERSION = '1.0.3719.77';
const WV_NUPKG = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WV_VERSION}/microsoft.web.webview2.${WV_VERSION}.nupkg`;
const WV_SHA256 = '2f6be3a10a1a8d6d1fde986af4131dab344f8181fffe75590824e0f4b037ed73';
const WV_FILES = {
  'Microsoft.Web.WebView2.Core.dll': 'lib/net462/Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll': 'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
  'x64/WebView2Loader.dll': 'runtimes/win-x64/native/WebView2Loader.dll',
  'arm64/WebView2Loader.dll': 'runtimes/win-arm64/native/WebView2Loader.dll',
};
async function ensureWebViewSdk() {
  const marker = path.join(WV_SDK, 'version.txt');
  const have = await fsp.readFile(marker, 'utf8').catch(() => '');
  if (have.trim() === WV_VERSION && (await Promise.all(Object.keys(WV_FILES).map((r) => exists(path.join(WV_SDK, ...r.split('/')))))).every(Boolean)) return;
  let res; try { res = await fetch(WV_NUPKG, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) }); } catch (e) { throw netError(WV_NUPKG, e); }
  if (!res.ok) throw new Error(`WebView2 SDK download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== WV_SHA256) throw new Error('The WebView2 SDK download did not match its checksum.');
  const zip = zipEntries(buf);
  for (const [rel, inPkg] of Object.entries(WV_FILES)) {
    const e = zip.find((x) => x.name === inPkg); if (!e) throw new Error(`WebView2 SDK is missing ${inPkg}`);
    const dest = path.join(WV_SDK, ...rel.split('/')); await ensureDir(path.dirname(dest));
    try { await fsp.writeFile(dest, e.read()); } catch (err) { if (!(await exists(dest))) throw err; } // in use by a running window: keep the old copy
  }
  await fsp.writeFile(marker, WV_VERSION);
}
let hostShown = false;
function startHost(url) {
  let proc;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(HOST_PS, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, AURORIA_URL: url, AURORIA_SDK: WV_SDK, AURORIA_CACHE: path.join(DATA, 'cache'), AURORIA_PROFILE: path.join(DATA, 'webview', 'profile'), AURORIA_ICON: process.execPath },
    });
  } catch (e) { logLine('window host failed', e.message); return false; }
  winHelper = proc; hostShown = false; winBuf = '';
  let fellBack = false;
  const fallback = (why) => { if (fellBack || hostShown) return; fellBack = true; logLine('native window unavailable, using Edge:', why); try { proc.kill(); } catch {} openEdgeWindow(url); };
  const timer = setTimeout(() => fallback('timed out'), 30000);
  proc.stdout.on('data', (d) => {
    winBuf += d.toString('utf8'); let i;
    while ((i = winBuf.indexOf('\n')) >= 0) {
      const line = winBuf.slice(0, i).trim(); winBuf = winBuf.slice(i + 1);
      if (line === 'READY') continue;
      if (line === 'SHOWN') { hostShown = true; clearTimeout(timer); winReady = true; broadcast({ type: 'window', ready: true }); continue; }
      if (line.startsWith('FAIL')) { clearTimeout(timer); fallback(line.slice(5)); continue; }
      const next = winQueue.shift(); if (next) next(line);
    }
  });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (winHelper === proc) { winHelper = null; winReady = false; for (const r of winQueue.splice(0)) r(null); }
    if (!hostShown) fallback(`exit ${code}`);
  });
  return true;
}
// ---------- window + lifecycle ----------
let everConnected = false;
let exitTimer = null;
function maybeExit() {
  if (process.env.AURORIA_NO_WINDOW) return;
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    if (clients.size === 0 && everConnected && game.state === 'idle') shutdown();
  }, 8000);
}
async function shutdown() { try { if (winHelper) winHelper.kill(); } catch {} try { await fsp.rm(P.lock, { force: true }); } catch {} process.exit(0); }

function findBrowser() {
  if (!IS_WIN) return null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rels = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
  for (const rel of rels) for (const r of roots) { const p = path.join(r, rel); if (fs.existsSync(p)) return p; }
  return null;
}
async function openWindow(url) {
  if (process.env.AURORIA_NO_WINDOW) { console.log(`UI: ${url}`); return; }
  if (IS_WIN && !process.env.AURORIA_EDGE_WINDOW) {
    try { await ensureWebViewSdk(); if (startHost(url)) return; } catch (e) { logLine('native window unavailable', e.message); }
  }
  openEdgeWindow(url);
}
function openEdgeWindow(url) {
  const browser = findBrowser();
  if (browser) {
    startWindowHelper();
    spawn(browser, [`--app=${url}`, '--window-size=1300,800', `--user-data-dir=${path.join(DATA, 'window')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-features=Translate'],
      { detached: true, stdio: 'ignore' }).unref();
  } else openExternal(url);
}

async function main() {
  await ensureDir(DATA);
  // After a self-update the old process hands over: wait for it to exit, then drop the exe it left behind.
  const waitPid = Number(process.env.AURORIA_WAIT_PID) || 0;
  if (waitPid) { delete process.env.AURORIA_WAIT_PID; for (let i = 0; i < 50; i++) { try { process.kill(waitPid, 0); } catch { break; } await sleep(200); } }
  if (IS_SEA) fsp.rm(process.execPath + '.old', { force: true }).catch(() => {});
  // Single instance: if another launcher is running, just show its window.
  const lock = await readJson(P.lock, null);
  if (lock && lock.port && lock.token) {
    try {
      const r = await fetch(`http://127.0.0.1:${lock.port}/api/ping`, { headers: { 'x-auroria-token': lock.token }, signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        // Ask the running launcher to bring its window forward (it reopens one if it was closed), and play the profile a shortcut asked for.
        const hdr = { 'x-auroria-token': lock.token, 'content-type': 'application/json' };
        await fetch(`http://127.0.0.1:${lock.port}/api/window`, { method: 'POST', headers: hdr, body: JSON.stringify({ action: 'show' }), signal: AbortSignal.timeout(5000) }).catch(() => {});
        if (argPlay()) await fetch(`http://127.0.0.1:${lock.port}/api/autoplay`, { method: 'POST', headers: hdr, body: JSON.stringify({ id: argPlay() }), signal: AbortSignal.timeout(5000) }).catch(() => {});
        setTimeout(() => process.exit(0), 300); return;
      }
    } catch {}
  }
  await loadState();
  if (argPlay() && config.servers.some((s) => s.id === argPlay())) { pendingPlay = argPlay(); settings.selectedServer = pendingPlay; }
  await scanOwnClient().catch(() => {});
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: e.message })); });
  const wanted = Number(process.env.AURORIA_PORT) || 0;
  server.listen(wanted, '127.0.0.1', async () => {
    PORT = server.address().port;
    await writeJson(P.lock, { port: PORT, token: TOKEN, pid: process.pid });
    logLine(`started on ${PORT}`);
    openWindow(`http://127.0.0.1:${PORT}/#${TOKEN}`);
    setTimeout(() => { if (!everConnected && !process.env.AURORIA_NO_WINDOW) shutdown(); }, 180000);
  });
}

if (require.main === module || IS_SEA) {
  main().catch((e) => { logLine('fatal', e.stack || e.message); process.exit(1); });
}
module.exports = { notify, discordSet, ownClientMeta, scanOwnClient, ownClientJar, applyOwnClient, ensureServerMods, listMods, buildClientSkin, zipEntries, decodePng, encodePng, recolor, writeZip, modIndex, saveModIndex, enablePack, packSupported, CLIENT_MODS, resolveProfile, extractZip, cmpVer, neoToMc, buildLaunchArgs, ruleAllows, mavenPath, expandArgs, splitAddress, pingServer, _set: (s, c) => { settings = { ...DEFAULT_SETTINGS, ...s }; config = c; }, P, TOKEN };
