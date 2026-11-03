// Puts the icon, version info and manifest into Auroria.exe. The version comes from Cargo.toml.
fn main() {
    println!("cargo:rerun-if-changed=src/build/icon.ico");
    println!("cargo:rerun-if-changed=src/build/auroria.manifest");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let mut res = winresource::WindowsResource::new();
    res.set_icon("src/build/icon.ico")
        .set_manifest_file("src/build/auroria.manifest")
        .set("FileDescription", "Auroria Launcher")
        .set("ProductName", "Auroria")
        .set("CompanyName", "Auroria")
        .set("InternalName", "Auroria")
        .set("OriginalFilename", "Auroria.exe")
        .set("LegalCopyright", "Auroria. Minecraft is a trademark of Mojang Studios.")
        .set("FileVersion", &version)
        .set("ProductVersion", &version);
    res.compile().expect("could not compile the Windows resources");
}
