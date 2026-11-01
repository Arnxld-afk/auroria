// Builds dist/Auroria.exe: a Node single-executable app made from the official Windows node.exe.
// Usage: node build.mjs <path-to-windows-node.exe>   (close any running Auroria.exe first, or set AURORIA_OUT=Auroria-new.exe)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ResEdit = await import('resedit');
const { inject } = require('postject');

const root = path.dirname(fileURLToPath(import.meta.url));
const nodeExe = process.argv[2];
if (!nodeExe || !fs.existsSync(nodeExe)) { console.error('Pass the path to a Windows node.exe of the same version as this node.'); process.exit(1); }
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

// 1. SEA blob with all UI files embedded as assets.
const assets = {
  'config.json': 'src/config.json',
  'ui/index.html': 'src/ui/index.html',
  'ui/styles.css': 'src/ui/styles.css',
  'ui/app.js': 'src/ui/app.js',
  'ui/bg.jpg': 'src/ui/bg.jpg',
  'ui/favicon.ico': 'src/ui/favicon.ico',
  'ui/skinview3d.js': 'src/ui/skinview3d.js',
  'assets/auroria-ui.zip': 'src/assets/auroria-ui.zip',
  'assets/webview/Microsoft.Web.WebView2.Core.dll': 'src/assets/webview/Microsoft.Web.WebView2.Core.dll',
  'assets/webview/Microsoft.Web.WebView2.WinForms.dll': 'src/assets/webview/Microsoft.Web.WebView2.WinForms.dll',
  'assets/webview/x64/WebView2Loader.dll': 'src/assets/webview/x64/WebView2Loader.dll',
  'assets/webview/arm64/WebView2Loader.dll': 'src/assets/webview/arm64/WebView2Loader.dll',
};
for (const f of fs.readdirSync(path.join(root, 'src/ui/fonts'))) if (f.endsWith('.woff2') || f.endsWith('.ttf')) assets[`ui/fonts/${f}`] = `src/ui/fonts/${f}`;
const seaConfig = {
  main: 'src/main.js', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true,
  useSnapshot: false, useCodeCache: false,
  assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, path.join(root, v)])),
};
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { cwd: root, stdio: 'inherit' });

// 2. Copy node.exe, swap icon + version info, switch to the GUI subsystem (no console window), drop the old signature.
const out = path.join(dist, process.env.AURORIA_OUT || 'Auroria.exe'); // set AURORIA_OUT when a running Auroria.exe locks the default file
fs.copyFileSync(nodeExe, out);
await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(path.join(dist, 'sea-prep.blob')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
const exe = ResEdit.NtExecutable.from(fs.readFileSync(out), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'src/build/icon.ico')));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(1, 0, 0, 0, lang);
vi.setProductVersion(1, 0, 0, 0, lang);
vi.setStringValues({ lang, codepage: 1200 }, {
  FileDescription: 'Auroria Launcher', ProductName: 'Auroria', CompanyName: 'Auroria',
  InternalName: 'Auroria', OriginalFilename: 'Auroria.exe', LegalCopyright: 'Auroria. Minecraft is a trademark of Mojang Studios.',
  FileVersion: '1.0.0', ProductVersion: '1.0.0',
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
exe.newHeader.optionalHeader.subsystem = 2; // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(out, Buffer.from(exe.generate()));

console.log('Built', out, (fs.statSync(out).size / 1048576).toFixed(1), 'MB');
