//! A dedicated worker thread owns the COM objects and the [`Controller`], so
//! every presentation call is serialised (no interleaved navigation) and COM
//! stays on the thread that initialised it. The thread starts on first use and
//! otherwise costs nothing.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use super::browsers::SystemBackend;
use super::{BindingStatus, Controller, NavResult, Target, TargetKind};

const REPLY_TIMEOUT: Duration = Duration::from_secs(6);

enum Request {
    Targets,
    Bind(String),
    Disconnect,
    Revalidate { id: String, title: String, kind: TargetKind },
    Status(Option<u32>),
    Goto(u32),
    Test,
}

enum Reply {
    Targets(Vec<Target>),
    Status(BindingStatus),
    Nav(NavResult),
    Done,
}

type Job = (Request, Sender<Result<Reply, String>>);

#[derive(Default)]
pub struct PresentationService {
    tx: Mutex<Option<Sender<Job>>>,
}

fn serve(rx: Receiver<Job>) {
    #[cfg(windows)]
    let _apartment = super::com::ComApartment::new();
    let mut controller = Controller::new(SystemBackend::new());
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
        };
        let _ = reply.send(result);
    }
}

impl PresentationService {
    pub fn new() -> Self {
        Self::default()
    }

    fn sender(&self) -> Result<Sender<Job>, String> {
        let mut slot = self.tx.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            let (tx, rx) = channel();
            std::thread::Builder::new()
                .name("nexq-presentation".into())
                .spawn(move || serve(rx))
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
}
