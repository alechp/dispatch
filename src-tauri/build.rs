fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=Cocoa");

        cc::Build::new()
            .file("src/nsevent_bridge.m")
            .flag("-fobjc-arc")
            .compile("nsevent_bridge");
    }

    tauri_build::build()
}
