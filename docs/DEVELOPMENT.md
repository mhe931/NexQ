# Developing NexQ

Everything you need to build, run, test and debug NexQ locally. For how the code is organized, read [ARCHITECTURE.md](ARCHITECTURE.md); for the contribution workflow, read [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

### Windows 10 / 11

- [Node.js](https://nodejs.org/) 20 or newer
- [Rust](https://rustup.rs/) stable (MSVC toolchain) and the Visual Studio C++ build tools
- [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11)
- CMake, Ninja and LLVM, required to compile whisper.cpp:
  ```powershell
  winget install --silent Kitware.CMake Ninja-build.Ninja LLVM.LLVM
  ```
  `src-tauri/.cargo/config.toml` sets `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin` and uses the Ninja generator, so `cmake` and `ninja` must be on `PATH`. Open a new terminal after installing.

### macOS (Apple Silicon)

- Node.js 20 or newer and Rust stable
- Xcode Command Line Tools: `xcode-select --install`
- CMake: `brew install cmake` (Ninja optional: `brew install ninja`)
- Before `npx tauri dev`, run `source scripts/macos-env.sh` in that shell: it points `LIBCLANG_PATH` at the Xcode toolchain and picks a CMake generator, overriding the Windows defaults in `src-tauri/.cargo/config.toml`. `./build-mac.sh` does this for you.

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) if something is missing.

### Windows source-only builds with Conda

An existing user-scoped Conda environment can supply Node, Rust, CMake,
Ninja and LLVM/libclang, where company policy permits those packages. It does
not by itself supply the Microsoft C++ headers/libraries or Windows SDK.
The default MSVC-based setup still needs a coherent MSVC C++ toolchain and SDK;
LLD alone cannot provide missing libraries such as `kernel32.lib`.
Conda's `vc14_runtime` and `ucrt` runtime packages are not a development SDK.

Use an approved C++ developer shell and activate the existing environment:

```powershell
conda activate nexq
# If libclang is installed here, override the repository's system-wide default:
$env:LIBCLANG_PATH = Join-Path $env:CONDA_PREFIX 'Library\bin'
npm run tauri -- build --no-bundle
```

Only set `LIBCLANG_PATH` to a directory containing the installed libclang DLL.
The build command compiles the native release application without producing or
running an installer. Its existing pre-build hook still stages ONNX Runtime
1.24.2 and the MSVC runtime DLLs; acquire these dependencies only through an
approved route. The staging script currently locates the MSVC redistributable
through an installed Visual Studio toolchain. Do not substitute the older
Windows System32 ONNX Runtime, disable TLS checks, or change download formats
to evade policy.

#### GNU alternative with approved Anaconda defaults

When MSVC/Windows SDK development files are unavailable, use a separate
user-scoped environment rather than replacing the existing `nexq` environment.
Use defaults only where organizational policy and Anaconda's terms permit it.
Verify the solver plan with `--dry-run` before creating the environment:

```powershell
conda create -n nexq-native --override-channels -c defaults `
  rust-gnu=1.99.1 ucrt64-gcc-toolchain=14.2.0 `
  clang=23.1.4 libclang=23.1.4 libclang13=23.1.4 `
  cmake=4.3.4 ninja=1.13.2 onnxruntime-cpp=1.24.4=hbb2ed37_2_cpu
```

The `mingw64-gcc-toolchain` metapackage currently has unavailable defaults
dependencies; `ucrt64-gcc-toolchain` supplies GCC/G++, binutils, MinGW headers
and import libraries. `rust-gnu` supplies the matching Rust standard library.
Compile and execute small C, C++ and Rust probes before using a new toolchain.

The approved CPU runtime package provides ONNX Runtime **1.24.4**, not the
upstream staging script's 1.24.2 archive. Its x64 DLL and API 24 entry point were
verified locally; the locked `ort` crate still targets API 24. Do not silently
substitute an older API or the Windows System32 runtime.

From the project root, activate both environments, keeping GNU tools first:

```powershell
conda activate nexq
conda activate --stack nexq-native
$nativePrefix = $env:CONDA_PREFIX
$nativeBin = Join-Path $nativePrefix 'Library\bin'
$env:LIBCLANG_PATH = Join-Path $PWD 'src-tauri\target\native-tools'
New-Item -ItemType Directory -Force $env:LIBCLANG_PATH | Out-Null
Copy-Item (Join-Path $nativeBin 'libclang-13.dll') `
  (Join-Path $env:LIBCLANG_PATH 'libclang.dll')
$clangResources = (& clang -print-resource-dir).Trim()
$mingwHeaders = Join-Path $nativePrefix 'Library\ucrt64\include'
$env:BINDGEN_EXTRA_CLANG_ARGS = "--target=x86_64-pc-windows-gnu -resource-dir='$clangResources' -I'$mingwHeaders'"
$env:CMAKE_GENERATOR = 'Ninja'
$env:CMAKE_CXX_FLAGS = '-finput-charset=UTF-8'
$env:CMAKE_PROJECT_INCLUDE = Join-Path $PWD 'src-tauri\cmake\windows-gnu.cmake'
$env:CARGO_BUILD_JOBS = '2'
```

The build-local libclang alias preserves the installed DLL's bytes: Windows
`clang-sys` recognizes `libclang.dll`, not Conda's `libclang-13.dll`. Bindgen
also needs an explicit GNU target (libclang otherwise defaults to MSVC) and
quoted paths, because its argument parser treats unquoted backslashes as
escapes. The CMake override replaces whisper-rs-sys's MSVC-only `/utf-8`
argument with GCC's equivalent; GCC/G++ remain the native compilers.
The CMake project hook restores the `lib` prefix on ggml's GNU static
archives so rustc can find them, without patching downloaded crate sources.
After changing these native build settings, invalidate only the relevant
generated package output with `cargo clean -p whisper-rs-sys` from `src-tauri`;
whisper-rs-sys does not track all CMake environment variables itself.

Stage dependencies **from the approved installed packages**, not a download
workaround. Verify package provenance, per-file metadata hashes and x64
architecture first; preserve any existing staged files whose provenance differs.
For the exact ONNX package above:

```powershell
$ortSource = Join-Path $nativeBin 'onnxruntime_conda.dll'
if ((Get-FileHash $ortSource -Algorithm SHA256).Hash -ne `
    '5b54bcc46dbcbc368d4d10527dc17a5b1ddd7c1e8dfa4828bc29fbedef534599') {
  throw 'ONNX Runtime does not match the approved package'
}
$ortDir = Join-Path $PWD 'src-tauri\ort'
New-Item -ItemType Directory -Force $ortDir | Out-Null
Copy-Item $ortSource (Join-Path $ortDir 'onnxruntime.dll')
foreach ($dll in @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
  Copy-Item (Join-Path $nativeBin $dll) (Join-Path $ortDir $dll)
}
Set-Content (Join-Path $ortDir '.version') '1.24.4' -Encoding Ascii
```

The VC runtime DLLs come from defaults `vc14_runtime` 14.44.35208. No ONNX
headers/import library are required by the app's dynamic-loading configuration.
The Conda build overlay deliberately skips the original network/Visual Studio
staging hook; Tauri still requires and copies the staged resource files:

```powershell
Push-Location src-tauri
cargo check --locked --offline --target x86_64-pc-windows-gnu
Pop-Location
npx tauri build --debug --no-bundle --target x86_64-pc-windows-gnu `
  --config src-tauri\tauri.conda.conf.json '--' --locked
```

In PowerShell the bare `--` separator is swallowed, so quote it (`'--'`) as above;
npm 12 otherwise rejects `--target`/`--config`. Set `CARGO_NET_OFFLINE=true` for an
offline build. `. .\scripts\native-env.ps1` performs the whole toolchain activation
above in one step (Node comes from the `nexq` environment, the GNU tools from
`nexq-native`).

This builds the native application with embedded frontend assets, not an
installer or a browser preview. Omit `--debug` for an optimized release build,
which is the launcher's default profile.
The GNU build embeds the same Common Controls v6 manifest using `windres`;
MSVC retains its existing linker flags. It also prioritizes the active GCC
C++ import library over Rust's bundled MinGW copy (which has a different
`mbstate_t` ABI), and disables implicit cdylib auto-exports to stay within
Windows' export ordinal limit. Explicit exports are retained.

Quit NexQ from its system-tray menu before rebuilding the same profile.
Closing its window only hides it. Windows locks loaded runtime DLLs, so
tauri-build's resource/WebView2 loader copies otherwise fail with
`The process cannot access the file because it is being used by another process.
(os error 32)`. A separate release build can compile while the debug app runs.

After a successful GNU release source build, launch the local output:

```powershell
.\scripts\start-nexq.ps1
```

The launcher uses `nexq-native` so MinGW runtime DLLs are on `PATH`, and performs
no downloads or installation. It reports an error if the local build is absent.
It defaults to `src-tauri\target\x86_64-pc-windows-gnu\release\nexq.exe`;
pass `-Configuration debug` to use the debug profile.
Quit the existing instance before switching profiles: NexQ's single-instance
handler otherwise focuses the old app instead of loading the new executable.
The launcher explicitly refuses a switch while this project's other profile runs.
Its default Conda location is
`$HOME\Miniforge3\Scripts\conda.exe`; pass `-CondaExe` for another existing
installation. The launcher does not override PowerShell execution policy.

Configure cloud providers in **Settings > LLM Providers**. Enter keys only in
the app's masked fields, then use **Test Connection**, **Load Models**, and
**Set as Active Provider**. Windows stores keys in the current user's Credential
Manager. A ChatGPT subscription does not include OpenAI API access.
Gemini model, streaming and cache requests authenticate with `x-goog-api-key`,
not URL query parameters, so transport-error URLs do not contain the API key.

## First run

```bash
git clone https://github.com/naxhq/NexQ.git
cd NexQ
npm install
npx tauri dev
```

`npx tauri dev` runs the `beforeDevCommand` from `src-tauri/tauri.conf.json`: it stages ONNX Runtime with `scripts/fetch-onnxruntime.mjs` (downloaded once into `src-tauri/ort/`, checksum-verified, skipped when already present), starts Vite on port 5173, then compiles and launches the Rust app. The first build compiles whisper.cpp and takes several minutes; later builds are incremental.

## Everyday commands

| Command | What it does |
|---|---|
| `npx tauri dev` | Full app with frontend hot reload and Rust rebuild on change |
| `npm run dev` | Vite dev server only (UI in a browser, no backend; IPC calls fail) |
| `npm run build` | TypeScript check and Vite production build |
| `npx tsc --noEmit` | Type check only |
| `npm test` | Vitest (jsdom) frontend tests, run once |
| `npm run test:watch` | Vitest in watch mode |
| `cargo test --lib` | Rust unit tests (run in `src-tauri/`) |
| `cargo check` | Fast Rust compile check (run in `src-tauri/`) |
| `npx tauri build` | Production build (NSIS installer on Windows) |
| `./build-mac.sh` | macOS: build the `.app` and `.dmg` and install to `/Applications` (`--help` for options) |

Do not run `npm run release`; releases are cut by maintainers (see [CONTRIBUTING.md](../CONTRIBUTING.md#how-releases-work)).

## Testing

- **Frontend:** tests sit next to the code as `*.test.ts` / `*.test.tsx` and use Vitest, jsdom and Testing Library. Global setup is in `src/test/setup.ts`. Tauri APIs are not available in jsdom, so mock `src/lib/ipc.ts` or `@tauri-apps/api` in tests.
- **Backend:** unit tests are `#[cfg(test)]` modules inside the Rust files. Recorded protocol fixtures for the Claude CLI provider live in `src-tauri/src/llm/cli_agent/fixtures/`.
- **CI** (`.github/workflows/ci.yml`) runs `npx tsc --noEmit`, `npm test` and `cargo check` on Windows for every pull request.
- **Manual testing:** audio and STT behavior depends on real devices. For changes there, test with an actual call (or any audio playing for "Them") and say in the PR which providers and devices you used. Demo mode (scripted scenarios in `src/demo/`) is handy for UI work without a live meeting.

## Logs and debugging

### Logs

Logging never blocks the caller: `log` macros hand the line to a writer thread over a bounded channel, so audio callbacks and STT loops can log freely. Lines that look like API keys or bearer tokens are masked before they're written. Never log transcript text, prompts or responses; log counts and lengths instead.

| Source | How to see it |
|---|---|
| App log file | `src-tauri/src/logging.rs`. Every `log::info!`/`warn!`/`error!` from our crate, warnings from dependencies, frontend `console.error`/`console.warn`, uncaught errors and Rust panics go to `nexq.log` in the OS log folder, and to the terminal running `npx tauri dev`. Settings → About → Diagnostics opens the folder, copies the last 400 lines, and toggles **Verbose logging** (adds our `debug!` lines and dependencies' `info!`). This is what to ask users for. |
| Dev Log panel | In the overlay, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or click the terminal icon. Shows STT connection status and debug messages live; it can be detached into its own window. |
| AI Call Log | Sidebar listing every LLM request with provider, model, prompt, timing, usage and errors. |
| Frontend console | Dev builds include WebView devtools: press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> (<kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>I</kbd> on macOS). Each window (launcher, overlay) has its own console. |

### Data locations

| | Windows | macOS |
|---|---|---|
| App data (database `nexq.db`, `models/`, `recordings/`, settings) | `%APPDATA%\com.nexq.app\` | `~/Library/Application Support/com.nexq.app/` |
| App log (`nexq.log`, rotated to `nexq.1.log`…`nexq.4.log` at 4 MB) | `%LOCALAPPDATA%\com.nexq.app\logs\` | `~/Library/Logs/com.nexq.app/` |
| API keys | Windows Credential Manager | Keychain |

Deleting `nexq.db` (with the app closed) gives you a clean database; migrations recreate it on next launch. Back it up first if it holds meetings you care about.

### Tips

- **Two windows, two consoles.** The launcher and overlay each have their own JavaScript context and store instances. If state looks stale in one window, check that the relevant event is emitted and handled in both.
- **IPC shape bugs are silent.** If a field arrives as `undefined`, compare the Rust struct (including `serde` renames) with `src/lib/types.ts`.
- **whisper.cpp build flags are cached.** `whisper-rs-sys` does not rebuild when the `GGML_*` variables in `src-tauri/.cargo/config.toml` change. Run `cargo clean -p whisper-rs-sys` in `src-tauri/` after editing them (CI uses a cache key prefix for the same reason).
- **ONNX Runtime problems.** Local ONNX engines (Parakeet TDT, ORT Streaming) load the runtime staged in `src-tauri/ort/`. If loading fails, delete that folder and rerun `node scripts/fetch-onnxruntime.mjs`.
- **Web Speech hot-swap.** Do not recreate `SpeechRecognition` mid-session; stop it cleanly before switching providers or devices.
- **Claude CLI provider.** Requires the `claude` CLI installed and logged in with a subscription account. See the [Claude subscription guide](user-guide/claude-subscription.md) and the code in `src-tauri/src/llm/cli_agent/`.
- **Rust debugging.** The backend is a normal Rust binary: attach a debugger such as CodeLLDB (VS Code) or the Visual Studio debugger to the running `nexq` process from a dev build.
