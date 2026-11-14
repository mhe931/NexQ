//! A dedicated worker thread owns the COM objects and the [`Controller`], so
//! every presentation call is serialised (no interleaved navigation) and COM
//! stays on the thread that initialised it. The thread starts on first use and
//! otherwise costs nothing.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::browsers::SystemBackend;
use super::diagnostics::Diagnostics;
use super::{Backend, BindingStatus, Controller, NavResult, Target, TargetKind};

const REPLY_TIMEOUT: Duration = Duration::from_secs(6);

enum Request {
    Targets,
    Bind(String),
    Disconnect,
    Revalidate { id: String, title: String, kind: TargetKind },
    Status(Option<u32>),
    Goto(u32),
    Test,
    Verify,
    Diagnose,
    LaunchFile(PathBuf),
    LaunchUrl(String),
}

enum Reply {
    Targets(Vec<Target>),
    Status(BindingStatus),
    Nav(NavResult),
    Verified(u32, bool),
    Diagnostics(Box<Diagnostics>),
    Done,
}

type Job = (Request, Sender<Result<Reply, String>>);

/// Builds the backend on the worker thread (COM objects must be created where they are used).
pub type BackendFactory = Arc<dyn Fn() -> Box<dyn Backend> + Send + Sync>;

pub struct PresentationService {
    tx: Mutex<Option<Sender<Job>>>,
    factory: BackendFactory,
}

impl Default for PresentationService {
    fn default() -> Self {
        Self::new()
    }
}

fn serve(rx: Receiver<Job>, factory: BackendFactory) {
    #[cfg(windows)]
    let _apartment = super::com::ComApartment::new();
    let mut controller = Controller::new(factory());
    while let Ok((request, reply)) = rx.recv() {
        let result = match request {
            Request::Targets => controller.targets().map(Reply::Targets),
            Request::Bind(id) => controller.bind(&id).map(Reply::Status),
            Request::Disconnect => {
                controller.disconnect();
                Ok(Reply::Done)
            }
            Request::Revalidate { id, title, kind } => Ok(Reply::Status(controller.revalidate(&id, &title, kind))),
            Request::Status(expected) => Ok(Reply::Status(controller.status(expected))),
            Request::Goto(slide) => controller.goto(slide).map(Reply::Nav),
            Request::Test => controller.test_navigation().map(Reply::Nav),
            Request::Verify => controller.verify_navigation().map(|(slide, moved)| Reply::Verified(slide, moved)),
            Request::Diagnose => Ok(Reply::Diagnostics(Box::new(controller.diagnose()))),
            Request::LaunchFile(path) => controller.launch_file(&path).map(|_| Reply::Done),
            Request::LaunchUrl(url) => controller.launch_url(&url).map(|_| Reply::Done),
        };
        let _ = reply.send(result);
    }
}

impl PresentationService {
    /// The real system: desktop PowerPoint through COM, Google Slides windows listed.
    pub fn new() -> Self {
        Self::with_backend(Arc::new(|| Box::new(SystemBackend::new()) as Box<dyn Backend>))
    }

    /// A service over any backend (tests use a scripted one).
    pub fn with_backend(factory: BackendFactory) -> Self {
        Self { tx: Mutex::new(None), factory }
    }

    fn sender(&self) -> Result<Sender<Job>, String> {
        let mut slot = self.tx.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            let (tx, rx) = channel();
            let factory = self.factory.clone();
            std::thread::Builder::new()
                .name("nexq-presentation".into())
                .spawn(move || serve(rx, factory))
                .map_err(|e| format!("Could not start the presentation worker: {e}"))?;
            *slot = Some(tx);
        }
        Ok(slot.as_ref().expect("just created").clone())
    }

    fn ask(&self, request: Request) -> Result<Reply, String> {
        let (reply_tx, reply_rx) = channel();
        self.sender()?.send((request, reply_tx)).map_err(|_| "The presentation worker stopped.".to_string())?;
        match reply_rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                Err("The presentation application did not answer in time (is a dialog open?).".into())
            }
            Err(RecvTimeoutError::Disconnected) => Err("The presentation worker stopped.".into()),
        }
    }

    pub fn targets(&self) -> Result<Vec<Target>, String> {
        match self.ask(Request::Targets)? {
            Reply::Targets(t) => Ok(t),
            _ => Err("Unexpected reply".into()),
        }
    }

    fn status_reply(&self, request: Request) -> Result<BindingStatus, String> {
        match self.ask(request)? {
            Reply::Status(s) => Ok(s),
            _ => Err("Unexpected reply".into()),
        }
    }

    pub fn bind(&self, id: &str) -> Result<BindingStatus, String> {
        self.status_reply(Request::Bind(id.to_string()))
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.ask(Request::Disconnect).map(|_| ())
    }

    pub fn revalidate(&self, id: &str, title: &str, kind: TargetKind) -> Result<BindingStatus, String> {
        self.status_reply(Request::Revalidate { id: id.to_string(), title: title.to_string(), kind })
    }

    pub fn status(&self, expected: Option<u32>) -> Result<BindingStatus, String> {
        self.status_reply(Request::Status(expected))
    }

    fn nav_reply(&self, request: Request) -> Result<NavResult, String> {
        match self.ask(request)? {
            Reply::Nav(n) => Ok(n),
            _ => Err("Unexpected reply".into()),
        }
    }

    pub fn goto(&self, slide: u32) -> Result<NavResult, String> {
        self.nav_reply(Request::Goto(slide))
    }

    pub fn test_navigation(&self) -> Result<NavResult, String> {
        self.nav_reply(Request::Test)
    }

    /// Read-back proof that navigation reaches the bound presentation: (confirmed slide, whether it moved).
    pub fn verify_navigation(&self) -> Result<(u32, bool), String> {
        match self.ask(Request::Verify)? {
            Reply::Verified(slide, moved) => Ok((slide, moved)),
            _ => Err("Unexpected reply".into()),
        }
    }

    pub fn diagnose(&self) -> Result<Diagnostics, String> {
        match self.ask(Request::Diagnose)? {
            Reply::Diagnostics(d) => Ok(*d),
            _ => Err("Unexpected reply".into()),
        }
    }

    /// Starts the presentation application with this file (never a slide show).
    pub fn launch_file(&self, path: PathBuf) -> Result<(), String> {
        self.ask(Request::LaunchFile(path)).map(|_| ())
    }

    pub fn launch_url(&self, url: &str) -> Result<(), String> {
        self.ask(Request::LaunchUrl(url.to_string())).map(|_| ())
    }
}
