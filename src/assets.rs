// Files embedded in Auroria.exe.
pub const CONFIG: &[u8] = include_bytes!("config.json");
pub const UI_PACK: &[u8] = include_bytes!("assets/auroria-ui.zip");
pub const FAVICON: &[u8] = include_bytes!("ui/favicon.ico");
pub const INDEX: &str = include_str!("ui/index.html");

/// The UI's static files: URL path, contents, content type.
pub const STATIC: &[(&str, &[u8], &str)] = &[
    ("/styles.css", include_bytes!("ui/styles.css"), "text/css; charset=utf-8"),
    ("/app.js", include_bytes!("ui/app.js"), "text/javascript; charset=utf-8"),
    ("/bg.jpg", include_bytes!("ui/bg.jpg"), "image/jpeg"),
    ("/favicon.ico", include_bytes!("ui/favicon.ico"), "image/x-icon"),
    ("/skinview3d.js", include_bytes!("ui/skinview3d.js"), "text/javascript; charset=utf-8"),
    ("/fonts/oxanium-600.woff2", include_bytes!("ui/fonts/oxanium-600.woff2"), "font/woff2"),
    ("/fonts/oxanium-700.woff2", include_bytes!("ui/fonts/oxanium-700.woff2"), "font/woff2"),
    ("/fonts/oxanium-800.woff2", include_bytes!("ui/fonts/oxanium-800.woff2"), "font/woff2"),
    ("/fonts/jakarta-400.woff2", include_bytes!("ui/fonts/jakarta-400.woff2"), "font/woff2"),
    ("/fonts/jakarta-500.woff2", include_bytes!("ui/fonts/jakarta-500.woff2"), "font/woff2"),
    ("/fonts/jakarta-600.woff2", include_bytes!("ui/fonts/jakarta-600.woff2"), "font/woff2"),
    ("/fonts/jakarta-700.woff2", include_bytes!("ui/fonts/jakarta-700.woff2"), "font/woff2"),
    ("/fonts/jakarta-800.woff2", include_bytes!("ui/fonts/jakarta-800.woff2"), "font/woff2"),
    ("/fonts/monocraft.ttf", include_bytes!("ui/fonts/monocraft.ttf"), "font/ttf"),
    ("/fonts/monocraft-bold.ttf", include_bytes!("ui/fonts/monocraft-bold.ttf"), "font/ttf"),
];
