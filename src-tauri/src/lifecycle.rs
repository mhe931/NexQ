//! Closing and quitting NexQ.
//!
//! Closing the main (`launcher`) window ends the whole application. Nothing is
//! hidden to the tray any more, so NexQ can never linger as an invisible
//! process:
//!
//! * **Launcher `CloseRequested`** (title-bar X, Alt+F4): the close is held back
//!   once and the frontend is asked ([`CLOSE_REQUESTED_EVENT`]) whether anything
//!   would be lost (a running meeting, unsaved setup edits). It answers
//!   `confirm_app_close` (quit), `cancel_app_close` (keep running) or
//!   `ack_app_close_prompt` (a dialog is on screen, the user decides). A
//!   frontend that answers nothing within [`CLOSE_ANSWER_TIMEOUT`] is treated as
//!   gone and NexQ quits anyway: a dead webview never makes NexQ unclosable.
//! * **Overlay `CloseRequested`**: the overlay is auxiliary. It is never
//!   destroyed and never quits the app; it is hidden and the launcher is shown.
//! * **Other windows** (dev log, meeting prompt) close normally.
//!
//! Every way of quitting (the answer above, the tray's Quit, the last window
//! closing) ends in `RunEvent::Exit`, where [`shutdown`] runs: it releases what
//! NexQ owns (requests, microphone, the CLI processes NexQ started, the
//! database) in order, each step under its own timeout and all of them under
//! one deadline ([`SHUTDOWN_DEADLINE`]). A watchdog thread ends the process
//! when the deadline passes, whatever is stuck. Nothing is ever killed by name:
//! only child processes NexQ spawned itself, through its own handles.
//!
//! The decisions (which close does what, the fallback timer, the deadline) are
//! plain code with injected clocks and closures, so they are unit tested; the
//! functions that touch the app are thin wrappers around them.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::state::AppState;

pub const LAUNCHER_LABEL: &str = "launcher";
pub const OVERLAY_LABEL: &str = "overlay";

/// Sent to the launcher window when it was asked to close.
pub const CLOSE_REQUESTED_EVENT: &str = "nexq:close_requested";

/// How long the frontend gets to answer a close request before NexQ quits anyway.
pub const CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_millis(2500);

/// All of NexQ's own shutdown work must be done within this, or the watchdog
/// ends the process.
pub const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(4);

// ---------------------------------------------------------------------------
// What a close request does
// ---------------------------------------------------------------------------

/// What a `CloseRequested` on a window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hold the close, ask the frontend, quit on its answer (or its silence).
    AskThenQuit,
    /// The overlay: keep it alive, hide it and show the launcher.
    HideOverlayShowLauncher,
    /// Let the window close.
    AllowClose,
}

/// `exit_underway`: NexQ is already quitting, so the launcher just closes.
pub fn close_action(label: &str, exit_underway: bool) -> CloseAction {
    match label {
        LAUNCHER_LABEL if exit_underway => CloseAction::AllowClose,
        LAUNCHER_LABEL => CloseAction::AskThenQuit,
        OVERLAY_LABEL => CloseAction::HideOverlayShowLauncher,
        _ => CloseAction::AllowClose,
    }
}

// ---------------------------------------------------------------------------
// The pending close question
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateState {
    Idle,
    /// Asked; the fallback timer `token` is running.
    Waiting(u64),
    /// The frontend answered that a dialog is on screen: the user decides, no timer.
    Prompting,
}

/// The one close question that can be open at a time.
pub struct CloseGate {
    state: Mutex<GateState>,
    next_token: AtomicU64,
}

impl CloseGate {
    pub const fn new() -> Self {
        Self { state: Mutex::new(GateState::Idle), next_token: AtomicU64::new(1) }
    }

    fn state(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A close was requested. `Some(token)` when the frontend must be asked and
    /// a fallback timer started; `None` when a question is already waiting for
    /// its answer (the timer of that one decides). With a dialog already up the
    /// question is asked again, so a webview that died meanwhile is noticed.
    pub fn begin(&self) -> Option<u64> {
        let mut state = self.state();
        match *state {
            GateState::Waiting(_) => None,
            GateState::Idle | GateState::Prompting => {
                let token = self.next_token.fetch_add(1, Ordering::SeqCst);
                *state = GateState::Waiting(token);
                Some(token)
            }
        }
    }

    /// The frontend shows a dialog: stop the fallback timer. False when there is
    /// no open question (a late answer after the timer already fired).
    pub fn acknowledge(&self) -> bool {
        let mut state = self.state();
        match *state {
            GateState::Idle => false,
            _ => {
                *state = GateState::Prompting;
                true
            }
        }
    }

    /// The frontend answered (confirm or cancel). True when a question was open.
    pub fn resolve(&self) -> bool {
        let mut state = self.state();
        let was_open = *state != GateState::Idle;
        *state = GateState::Idle;
        was_open
    }

    /// The fallback timer of `token` ran out. True when that question is still
    /// unanswered, i.e. NexQ must quit.
    pub fn expire(&self, token: u64) -> bool {
        let mut state = self.state();
        if *state == GateState::Waiting(token) {
            *state = GateState::Idle;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn is_idle(&self) -> bool {
        *self.state() == GateState::Idle
    }
}

impl Default for CloseGate {
    fn default() -> Self {
        Self::new()
    }
}

static CLOSE_GATE: CloseGate = CloseGate::new();

/// NexQ is on its way out (a quit was requested or shutdown has begun).
static EXIT_UNDERWAY: AtomicBool = AtomicBool::new(false);

/// How a close request started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseStart {
    /// The frontend was asked and the fallback timer armed.
    Asked,
    /// A question is already waiting; nothing more to do.
    AlreadyAsked,
    /// The frontend can't be asked: quit now.
    QuitNow,
}

/// Open a close question: `notify` asks the frontend (false when it can't be
/// reached), `arm_timer` starts the fallback timer for the question's token.
pub fn start_close(
    gate: &CloseGate,
    notify: impl FnOnce() -> bool,
    arm_timer: impl FnOnce(u64),
) -> CloseStart {
    let Some(token) = gate.begin() else {
        return CloseStart::AlreadyAsked;
    };
    if !notify() {
        gate.resolve();
        return CloseStart::QuitNow;
    }
    arm_timer(token);
    CloseStart::Asked
}

/// Body of the fallback timer: wait, then quit if the question is still open.
/// Returns whether it quit.
pub fn run_fallback(
    gate: &CloseGate,
    token: u64,
    wait: impl FnOnce(),
    quit: impl FnOnce(),
) -> bool {
    wait();
    if gate.expire(token) {
        quit();
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Deadline, steps and watchdog
// ---------------------------------------------------------------------------

/// The overall budget of the shutdown.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    started: Instant,
    total: Duration,
}

impl Deadline {
    pub fn new(started: Instant, total: Duration) -> Self {
        Self { started, total }
    }

    pub fn remaining_at(&self, now: Instant) -> Duration {
        self.total.saturating_sub(now.saturating_duration_since(self.started))
    }

    /// What a task asking for `wanted` may use at `now`: never more than what is left.
    pub fn budget_at(&self, now: Instant, wanted: Duration) -> Duration {
        wanted.min(self.remaining_at(now))
    }
}

/// One piece of shutdown work, with its own timeout.
pub struct Step {
    pub name: &'static str,
    pub timeout: Duration,
    pub work: Box<dyn FnOnce() + Send + 'static>,
}

impl Step {
    pub fn new(name: &'static str, timeout: Duration, work: impl FnOnce() + Send + 'static) -> Self {
        Self { name, timeout, work: Box::new(work) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Finished,
    /// Still running when its time ran out; left behind (the process ends soon).
    TimedOut,
    /// The deadline had already passed.
    Skipped,
    Panicked,
}

/// Run the steps in order. Each runs on a thread of its own so a step stuck on a
/// lock or a device cannot hold the rest back: it gets `min(timeout, time left)`
/// and is abandoned when that passes. `now` is the clock (injected in tests).
pub fn run_steps(
    steps: Vec<Step>,
    deadline: &Deadline,
    now: impl Fn() -> Instant,
) -> Vec<(&'static str, StepOutcome)> {
    let mut outcomes = Vec::with_capacity(steps.len());
    for step in steps {
        let budget = deadline.budget_at(now(), step.timeout);
        if budget.is_zero() {
            outcomes.push((step.name, StepOutcome::Skipped));
            continue;
        }
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let work = step.work;
        let spawned = std::thread::Builder::new()
            .name(format!("shutdown-{}", step.name))
            .spawn(move || {
                work();
                let _ = done_tx.send(());
            });
        let outcome = match spawned {
            Err(_) => StepOutcome::Panicked,
            Ok(_) => match done_rx.recv_timeout(budget) {
                Ok(()) => StepOutcome::Finished,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => StepOutcome::TimedOut,
                // The worker ended without reporting: it panicked.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => StepOutcome::Panicked,
            },
        };
        outcomes.push((step.name, outcome));
    }
    outcomes
}

/// Body of the watchdog: sleep out the deadline, then end the process.
pub fn watchdog_body(
    deadline: Duration,
    sleep: impl FnOnce(Duration),
    on_expire: impl FnOnce(),
) {
    sleep(deadline);
    on_expire();
}

/// Start the watchdog thread. It is never cancelled: if the process ends on its
/// own first, the thread simply dies with it.
pub fn arm_watchdog(
    deadline: Duration,
    on_expire: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("shutdown-watchdog".into())
        .spawn(move || watchdog_body(deadline, std::thread::sleep, on_expire))
}

/// A flag that flips once: `try_begin` is true for the first caller only.
pub struct OnceFlag(AtomicBool);

impl OnceFlag {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn try_begin(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

static SHUTDOWN_STARTED: OnceFlag = OnceFlag::new();

// ---------------------------------------------------------------------------
// Window events and quitting
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedPayload {
    meeting_active: bool,
}

/// `WindowEvent` handler for the launcher and the overlay (set up in `run`).
pub fn on_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    match close_action(label, EXIT_UNDERWAY.load(Ordering::SeqCst)) {
        CloseAction::AllowClose => {}
        CloseAction::HideOverlayShowLauncher => {
            // Never destroyed (the meeting lives in it), never quits; and the
            // launcher comes up so the app is not left without a window.
            api.prevent_close();
            log::info!("Close requested on the overlay: hiding it, showing the launcher");
            crate::show_launcher(app);
        }
        CloseAction::AskThenQuit => {
            api.prevent_close();
            request_close(app);
        }
    }
}

pub fn request_close(app: &AppHandle) {
    let meeting_active = app
        .try_state::<AppState>()
        .map(|s| s.meeting_active.load(Ordering::SeqCst))
        .unwrap_or(false);
    log::info!("Main window close requested (meeting active: {meeting_active})");
    let timer_app = app.clone();
    let started = start_close(
        &CLOSE_GATE,
        || {
            app.emit_to(LAUNCHER_LABEL, CLOSE_REQUESTED_EVENT, CloseRequestedPayload { meeting_active })
                .is_ok()
        },
        move |token| {
            let app = timer_app.clone();
            let spawned = std::thread::Builder::new().name("close-fallback".into()).spawn(move || {
                let quit_app = app.clone();
                run_fallback(
                    &CLOSE_GATE,
                    token,
                    || std::thread::sleep(CLOSE_ANSWER_TIMEOUT),
                    move || {
                        log::warn!(
                            "The window did not answer the close request within {} ms; quitting",
                            CLOSE_ANSWER_TIMEOUT.as_millis()
                        );
                        request_quit(&quit_app);
                    },
                );
            });
            if spawned.is_err() {
                // No timer can run: don't wait for an answer that may never come.
                if CLOSE_GATE.resolve() {
                    request_quit(&timer_app);
                }
            }
        },
    );
    if started == CloseStart::QuitNow {
        log::warn!("The main window can't be asked about closing; quitting");
        request_quit(app);
    }
}

/// Quit NexQ: everything ends in `RunEvent::ExitRequested` / `Exit`.
pub fn request_quit(app: &AppHandle) {
    EXIT_UNDERWAY.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The frontend confirmed the close: quit (unless the fallback already did).
pub fn confirm_close(app: &AppHandle) {
    if CLOSE_GATE.resolve() {
        request_quit(app);
    } else {
        log::info!("Close confirmation arrived with no question open; ignored");
    }
}

/// The frontend cancelled the close: keep running.
pub fn cancel_close() {
    if CLOSE_GATE.resolve() {
        log::info!("Close cancelled by the user");
    }
}

/// The frontend shows its confirmation dialog: the user decides, no fallback.
pub fn acknowledge_prompt() -> bool {
    CLOSE_GATE.acknowledge()
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/// Where [`shutdown`] runs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitContext {
    /// `RunEvent::Exit`, on the main thread: windows and tray are still ours.
    EventLoop,
    /// A C `exit` NexQ did not start (Windows ending the session makes tao call
    /// `process::exit`): only the work that needs no UI.
    ProcessExit,
}

fn step_timeout(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

/// The shutdown work, in order. Each step is best effort: it reads what it
/// needs with `try_lock`, so a lock held by something stuck costs nothing.
fn shutdown_steps(app: &AppHandle) -> Vec<Step> {
    let mut steps = Vec::new();

    let a = app.clone();
    steps.push(Step::new("cancel-llm", step_timeout(500), move || cancel_llm(&a)));
    let a = app.clone();
    steps.push(Step::new("stop-audio", step_timeout(1500), move || stop_audio(&a)));
    let a = app.clone();
    steps.push(Step::new("stop-stt", step_timeout(1000), move || stop_stt(&a)));
    steps.push(Step::new("copilot", step_timeout(1000), || {
        tauri::async_runtime::block_on(crate::llm::copilot::hub::CopilotHub::global().shutdown());
    }));
    let a = app.clone();
    steps.push(Step::new("claude-sessions", step_timeout(2500), move || {
        if let Some(state) = a.try_state::<AppState>() {
            let sessions = state.agent_sessions.clone();
            tauri::async_runtime::block_on(sessions.close_all());
        }
    }));
    steps.push(Step::new("meeting-detection", step_timeout(300), crate::meeting_detect::stop_sampling));
    let a = app.clone();
    steps.push(Step::new("database", step_timeout(500), move || checkpoint_database(&a)));
    let a = app.clone();
    steps.push(Step::new("settings", step_timeout(500), move || flush_settings(&a)));
    steps
}

/// Stop the generation in flight and flag the router (requests end at the next chunk).
fn cancel_llm(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Some(intelligence) = &state.intelligence {
        if let Ok(engine) = intelligence.try_lock() {
            if let Some(request_id) = engine.cancel() {
                log::info!("Shutdown: cancelled generation {request_id}");
            }
        }
    }
    if let Some(llm) = &state.llm {
        if let Ok(router) = llm.try_lock() {
            tauri::async_runtime::block_on(router.cancel());
        }
    };
}

/// Stop capture and the recording (finishing the WAV), end a device test and
/// give the Windows default microphone back if NexQ had switched it.
fn stop_audio(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.device_monitor_running.store(false, Ordering::SeqCst);

    let original = state.original_default_device.lock().ok().and_then(|mut g| g.take());
    if let Some(id) = original {
        match crate::audio::device_default::restore_default_capture_device(&id) {
            Ok(()) => log::info!("Shutdown: restored the default capture device"),
            Err(e) => log::warn!("Shutdown: could not restore the default capture device: {e}"),
        }
    }

    // Blocks on the audio lock if a command holds it; the step's timeout bounds that.
    if let Ok(mut guard) = state.audio.lock() {
        if let Some(manager) = guard.as_mut() {
            manager.stop_test();
            if let Some((path, _)) = manager.stop_capture(false) {
                log::info!("Shutdown: recording closed at {}", path.display());
            }
        }
    };
}

fn stop_stt(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Some(stt) = &state.stt {
        if let Ok(mut router) = stt.try_lock() {
            if router.is_processing() {
                if let Err(e) = tauri::async_runtime::block_on(router.stop_processing()) {
                    log::warn!("Shutdown: STT did not stop cleanly: {e}");
                }
            }
        }
    };
}

/// Fold the WAL into the database file so it is left as one consistent file.
/// (WAL is crash-safe anyway; this only keeps the folder tidy.)
fn checkpoint_database(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Some(database) = &state.database {
        if let Ok(db) = database.try_lock() {
            let result = db
                .connection()
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get::<_, i64>(0));
            if let Err(e) = result {
                log::warn!("Shutdown: database checkpoint skipped: {e}");
            }
        }
    };
}

/// tauri-plugin-store saves every store itself on `RunEvent::Exit` (its hook runs
/// before NexQ's handler); this repeats it for the exits that bypass that event.
fn flush_settings(app: &AppHandle) {
    use tauri_plugin_store::StoreExt;
    for name in ["config.json", "nexq-settings.json"] {
        if let Some(store) = app.get_store(name) {
            if let Err(e) = store.save() {
                log::warn!("Shutdown: could not save {name}: {e}");
            }
        }
    }
}

/// Release everything NexQ owns, once, within [`SHUTDOWN_DEADLINE`].
pub fn shutdown(app: &AppHandle, context: ExitContext) {
    if !SHUTDOWN_STARTED.try_begin() {
        return;
    }
    EXIT_UNDERWAY.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let meeting_active = app
        .try_state::<AppState>()
        .map(|s| s.meeting_active.load(Ordering::SeqCst))
        .unwrap_or(false);
    log::info!("NexQ is shutting down ({context:?}, meeting active: {meeting_active})");

    if context == ExitContext::EventLoop {
        // However the steps below go, the process ends at the deadline.
        if let Err(e) = arm_watchdog(SHUTDOWN_DEADLINE, || {
            log::warn!(
                "Shutdown still running after {} s; ending the process",
                SHUTDOWN_DEADLINE.as_secs()
            );
            crate::logging::flush(Duration::from_millis(200));
            std::process::exit(0);
        }) {
            log::warn!("Shutdown watchdog could not start: {e}");
        }
        // The window disappears at once, and the tray icon is removed here
        // (the watchdog's process::exit would leave a ghost icon behind).
        for (_, window) in app.webview_windows() {
            let _ = window.hide();
        }
        let _ = app.remove_tray_by_id("main");
    }

    let deadline = Deadline::new(started, SHUTDOWN_DEADLINE);
    let outcomes = run_steps(shutdown_steps(app), &deadline, Instant::now);
    for (name, outcome) in &outcomes {
        if *outcome == StepOutcome::Finished {
            log::debug!("Shutdown step '{name}': {outcome:?}");
        } else {
            log::warn!("Shutdown step '{name}': {outcome:?}");
        }
    }
    log::info!("NexQ shutdown finished in {} ms", started.elapsed().as_millis());
    crate::logging::flush(deadline.budget_at(Instant::now(), Duration::from_millis(500)));
}

// ---------------------------------------------------------------------------
// Exits NexQ did not start
// ---------------------------------------------------------------------------

static APP_FOR_EXIT_HOOK: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
    fn atexit(callback: extern "C" fn()) -> std::os::raw::c_int;
}

extern "C" fn at_process_exit() {
    if let Some(app) = APP_FOR_EXIT_HOOK.get() {
        // Does nothing when the normal shutdown already ran (or is running).
        shutdown(app, ExitContext::ProcessExit);
    }
}

/// Run [`shutdown`] when something calls `process::exit` on NexQ: Windows ending
/// the session does (tao's `WM_ENDSESSION`). Call once from `setup`.
pub fn install_exit_hook(app: &AppHandle) {
    if APP_FOR_EXIT_HOOK.set(app.clone()).is_err() {
        return;
    }
    // SAFETY: registers a plain `extern "C"` function with the C runtime.
    if unsafe { atexit(at_process_exit) } != 0 {
        log::warn!("Could not register the exit hook");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    // -- which close does what -------------------------------------------------

    #[test]
    fn launcher_close_asks_then_quits() {
        assert_eq!(close_action("launcher", false), CloseAction::AskThenQuit);
    }

    #[test]
    fn launcher_close_during_exit_just_closes() {
        assert_eq!(close_action("launcher", true), CloseAction::AllowClose);
    }

    #[test]
    fn overlay_close_never_quits_or_destroys() {
        assert_eq!(close_action("overlay", false), CloseAction::HideOverlayShowLauncher);
        assert_eq!(close_action("overlay", true), CloseAction::HideOverlayShowLauncher);
    }

    #[test]
    fn other_windows_close_normally() {
        for label in ["devlog", "meeting-prompt", "", "Launcher"] {
            assert_eq!(close_action(label, false), CloseAction::AllowClose, "{label:?}");
        }
    }

    // -- the close question ----------------------------------------------------

    #[test]
    fn a_second_close_while_waiting_is_not_asked_again() {
        let gate = CloseGate::new();
        assert!(gate.begin().is_some());
        assert_eq!(gate.begin(), None);
    }

    #[test]
    fn confirm_and_cancel_close_the_question() {
        let gate = CloseGate::new();
        gate.begin().unwrap();
        assert!(gate.resolve());
        assert!(gate.is_idle());
        // Nothing open: a stray answer is reported as such.
        assert!(!gate.resolve());
        // A new close can be asked again after a cancel.
        assert!(gate.begin().is_some());
    }

    #[test]
    fn an_answered_question_does_not_quit_when_its_timer_runs_out() {
        let gate = CloseGate::new();
        let token = gate.begin().unwrap();
        let quit = Cell::new(false);
        let waited = run_fallback(
            &gate,
            token,
            || {
                // The user cancelled while the timer was running.
                assert!(gate.resolve());
            },
            || quit.set(true),
        );
        assert!(!waited);
        assert!(!quit.get());
    }

    #[test]
    fn silence_quits_when_the_timer_runs_out() {
        let gate = CloseGate::new();
        let token = gate.begin().unwrap();
        let quit = Cell::new(false);
        let fired = run_fallback(&gate, token, || {}, || quit.set(true));
        assert!(fired);
        assert!(quit.get());
        // The question is closed; a late confirm finds nothing to answer.
        assert!(!gate.resolve());
    }

    #[test]
    fn the_fallback_waits_for_the_documented_time() {
        let gate = CloseGate::new();
        let token = gate.begin().unwrap();
        let waited = RefCell::new(None);
        run_fallback(&gate, token, || *waited.borrow_mut() = Some(CLOSE_ANSWER_TIMEOUT), || {});
        assert_eq!(*waited.borrow(), Some(Duration::from_millis(2500)));
    }

    #[test]
    fn a_dialog_on_screen_stops_the_fallback() {
        let gate = CloseGate::new();
        let token = gate.begin().unwrap();
        assert!(gate.acknowledge());
        let quit = Cell::new(false);
        assert!(!run_fallback(&gate, token, || {}, || quit.set(true)));
        assert!(!quit.get());
        // Still open: the user can confirm or cancel later.
        assert!(gate.resolve());
    }

    #[test]
    fn closing_again_over_a_dialog_asks_again_with_a_fresh_timer() {
        let gate = CloseGate::new();
        let first = gate.begin().unwrap();
        assert!(gate.acknowledge());
        let second = gate.begin().expect("asked again");
        assert_ne!(first, second);
        // The old timer is void; only the new one can quit.
        assert!(!gate.expire(first));
        assert!(gate.expire(second));
    }

    #[test]
    fn a_late_acknowledgement_after_the_timer_fired_is_refused() {
        let gate = CloseGate::new();
        let token = gate.begin().unwrap();
        assert!(gate.expire(token));
        assert!(!gate.acknowledge());
    }

    #[test]
    fn a_timer_of_an_older_question_never_quits_a_newer_one() {
        let gate = CloseGate::new();
        let old = gate.begin().unwrap();
        gate.resolve();
        let new = gate.begin().unwrap();
        assert!(!gate.expire(old));
        assert!(gate.expire(new));
    }

    #[test]
    fn start_close_asks_and_arms_the_timer() {
        let gate = CloseGate::new();
        let armed = Cell::new(None);
        let started = start_close(&gate, || true, |token| armed.set(Some(token)));
        assert_eq!(started, CloseStart::Asked);
        assert!(armed.get().is_some());
        // A repeated close does not notify or arm again.
        let again = start_close(&gate, || panic!("asked twice"), |_| panic!("armed twice"));
        assert_eq!(again, CloseStart::AlreadyAsked);
    }

    #[test]
    fn start_close_quits_at_once_when_the_window_cannot_be_asked() {
        let gate = CloseGate::new();
        let started = start_close(&gate, || false, |_| panic!("no timer without a question"));
        assert_eq!(started, CloseStart::QuitNow);
        assert!(gate.is_idle());
    }

    // -- deadline and steps ----------------------------------------------------

    #[test]
    fn a_step_gets_what_it_asks_for_until_the_deadline_is_near() {
        let t0 = Instant::now();
        let deadline = Deadline::new(t0, Duration::from_secs(4));
        let want = Duration::from_millis(1500);
        assert_eq!(deadline.budget_at(t0, want), want);
        assert_eq!(deadline.budget_at(t0 + Duration::from_millis(3000), want), Duration::from_millis(1000));
        assert_eq!(deadline.budget_at(t0 + Duration::from_secs(4), want), Duration::ZERO);
        assert_eq!(deadline.budget_at(t0 + Duration::from_secs(9), want), Duration::ZERO);
        // A clock reading from before the start never underflows.
        assert_eq!(deadline.remaining_at(t0 - Duration::from_millis(1)), Duration::from_secs(4));
    }

    #[test]
    fn steps_run_in_order_and_report_finished() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let step = |name: &'static str| {
            let log = log.clone();
            Step::new(name, Duration::from_secs(2), move || log.lock().unwrap().push(name))
        };
        let deadline = Deadline::new(Instant::now(), Duration::from_secs(10));
        let outcomes = run_steps(vec![step("a"), step("b"), step("c")], &deadline, Instant::now);
        assert_eq!(
            outcomes,
            vec![
                ("a", StepOutcome::Finished),
                ("b", StepOutcome::Finished),
                ("c", StepOutcome::Finished)
            ]
        );
        assert_eq!(*log.lock().unwrap(), vec!["a", "b", "c"]);
    }

    #[test]
    fn a_stuck_step_times_out_and_the_next_one_still_runs() {
        let ran_after = Arc::new(AtomicBool::new(false));
        let after = ran_after.clone();
        let stuck = Step::new("stuck", Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_secs(3));
        });
        let next = Step::new("next", Duration::from_secs(2), move || after.store(true, Ordering::SeqCst));
        let deadline = Deadline::new(Instant::now(), Duration::from_secs(10));
        let begun = Instant::now();
        let outcomes = run_steps(vec![stuck, next], &deadline, Instant::now);
        assert!(begun.elapsed() < Duration::from_secs(2), "the stuck step was not abandoned");
        assert_eq!(outcomes[0], ("stuck", StepOutcome::TimedOut));
        assert_eq!(outcomes[1], ("next", StepOutcome::Finished));
        assert!(ran_after.load(Ordering::SeqCst));
    }

    #[test]
    fn a_panicking_step_does_not_stop_the_others() {
        let boom = Step::new("boom", Duration::from_secs(2), || panic!("step failed"));
        let fine = Step::new("fine", Duration::from_secs(2), || {});
        let deadline = Deadline::new(Instant::now(), Duration::from_secs(10));
        let outcomes = run_steps(vec![boom, fine], &deadline, Instant::now);
        assert_eq!(outcomes[0].1, StepOutcome::Panicked);
        assert_eq!(outcomes[1].1, StepOutcome::Finished);
    }

    #[test]
    fn steps_are_skipped_once_the_deadline_passed() {
        let t0 = Instant::now();
        let deadline = Deadline::new(t0, Duration::from_secs(4));
        let ran = Arc::new(AtomicUsize::new(0));
        let counting = |name: &'static str| {
            let ran = ran.clone();
            Step::new(name, Duration::from_secs(1), move || {
                ran.fetch_add(1, Ordering::SeqCst);
            })
        };
        // The injected clock says the deadline is long gone.
        let outcomes = run_steps(vec![counting("a"), counting("b")], &deadline, || t0 + Duration::from_secs(5));
        assert_eq!(outcomes, vec![("a", StepOutcome::Skipped), ("b", StepOutcome::Skipped)]);
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_budget_shrinks_as_the_injected_clock_advances() {
        let t0 = Instant::now();
        let deadline = Deadline::new(t0, Duration::from_millis(100));
        let calls = Cell::new(0u32);
        // First step sees the full budget, the second only the rest, the third none.
        let clock = || {
            let n = calls.get();
            calls.set(n + 1);
            t0 + Duration::from_millis(60 * n as u64)
        };
        let ran = Arc::new(AtomicUsize::new(0));
        let step = |name: &'static str| {
            let ran = ran.clone();
            Step::new(name, Duration::from_secs(1), move || {
                ran.fetch_add(1, Ordering::SeqCst);
            })
        };
        let outcomes = run_steps(vec![step("a"), step("b"), step("c")], &deadline, clock);
        assert_eq!(outcomes[0].1, StepOutcome::Finished);
        assert_eq!(outcomes[1].1, StepOutcome::Finished);
        assert_eq!(outcomes[2].1, StepOutcome::Skipped);
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }

    // -- watchdog --------------------------------------------------------------

    #[test]
    fn the_watchdog_sleeps_the_deadline_then_fires() {
        let order = RefCell::new(Vec::new());
        watchdog_body(
            SHUTDOWN_DEADLINE,
            |d| order.borrow_mut().push(format!("sleep {} ms", d.as_millis())),
            || order.borrow_mut().push("expire".to_string()),
        );
        assert_eq!(*order.borrow(), vec!["sleep 4000 ms".to_string(), "expire".to_string()]);
    }

    #[test]
    fn the_armed_watchdog_fires_on_its_own_thread() {
        let (tx, rx) = std::sync::mpsc::channel();
        arm_watchdog(Duration::from_millis(20), move || {
            let _ = tx.send(std::thread::current().name().map(str::to_string));
        })
        .unwrap();
        let name = rx.recv_timeout(Duration::from_secs(5)).expect("the watchdog did not fire");
        assert_eq!(name.as_deref(), Some("shutdown-watchdog"));
    }

    #[test]
    fn shutdown_runs_once() {
        let flag = OnceFlag::new();
        assert!(flag.try_begin());
        assert!(!flag.try_begin());
        assert!(!flag.try_begin());
    }

    #[test]
    fn the_documented_timings_hold_together() {
        // The frontend's answer window ends well inside the shutdown deadline's
        // order of magnitude, and every per-step timeout fits the deadline.
        assert_eq!(CLOSE_ANSWER_TIMEOUT, Duration::from_millis(2500));
        assert_eq!(SHUTDOWN_DEADLINE, Duration::from_secs(4));
        assert!(CLOSE_ANSWER_TIMEOUT < SHUTDOWN_DEADLINE);
    }
}
