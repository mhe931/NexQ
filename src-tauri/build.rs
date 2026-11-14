fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS missing");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").expect("Cargo target environment missing");

    // Fix CRT linking: ort_sys and whisper_rs_sys are compiled with /MD (dynamic CRT)
    // but Rust uses /MT (static CRT). We need to swap static CRT for dynamic CRT.
    if target_os == "windows" && target_env == "msvc" {
        // Remove static CRT, add dynamic CRT to resolve __imp_* symbols
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:libucrt.lib");
        println!("cargo:rustc-link-arg=/DEFAULTLIB:ucrt.lib");
    }

    // Embed one application manifest (Common Controls v6, identical to tauri-build's
    // default) into every link target: the app, unit/integration tests and examples. Without it, test executables that link tauri's dialog code fail to
    // load with STATUS_ENTRYPOINT_NOT_FOUND (comctl32 TaskDialogIndirect needs v6).
    // tauri-build is told not to embed its own copy so the manifests don't collide.
    if target_os == "windows" && target_env == "msvc" {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // Plain link-arg (not -bins/-tests): cargo only accepts the scoped forms when
        // the package declares such targets, and lib unit tests are not covered by them.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    if target_os == "windows" && target_env == "gnu" {
        // Prefer the active compiler's C++ ABI over Rust's bundled MinGW libraries.
        let output = std::process::Command::new("g++")
            .arg("-print-file-name=libstdc++.dll.a")
            .output()
            .expect("failed to locate MinGW C++ runtime; activate the GNU toolchain");
        assert!(
            output.status.success(),
            "g++ C++ runtime lookup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let library = std::path::PathBuf::from(
            std::str::from_utf8(&output.stdout)
                .expect("g++ returned an invalid runtime path")
                .trim(),
        );
        assert!(
            library.is_file(),
            "MinGW C++ import library not found: {}",
            library.display()
        );
        println!(
            "cargo:rustc-link-search=native={}",
            library.parent().unwrap().display()
        );
        // Keep explicit exports but prevent auto-exporting every dependency symbol.
        println!("cargo:rustc-cdylib-link-arg=-Wl,--exclude-all-symbols");

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows-app-manifest.xml");
        let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
        let resource = out_dir.join("nexq-manifest.rc");
        let object = out_dir.join("nexq-manifest.o");
        println!("cargo:rerun-if-changed={}", manifest.display());
        std::fs::write(
            &resource,
            format!(
                "1 24 \"{}\"\n",
                manifest.display().to_string().replace('\\', "\\\\")
            ),
        )
        .expect("failed to write GNU manifest resource");
        let status = std::process::Command::new("windres")
            .args(["--input-format=rc", "--output-format=coff"])
            .arg("--input")
            .arg(&resource)
            .arg("--output")
            .arg(&object)
            .status()
            .expect("failed to run GNU windres; activate the MinGW-w64 toolchain");
        assert!(
            status.success(),
            "GNU manifest resource compilation failed: {status}"
        );
        // Link directly into every target, including lib unit tests.
        println!("cargo:rustc-link-arg={}", object.display());
    }

    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
