use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::PartyRole;

/// Physical capture state only. STT credentials, models and mute flags do not
/// determine whether the audio device is capturing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioCaptureStatus {
    Active,
    Paused,
    DeviceUnavailable,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioCaptureStatusEvent {
    pub party: PartyRole,
    pub status: AudioCaptureStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A capture session owns its reporter. Closing it prevents old callbacks from
/// overwriting the next session's status after pause/resume or hot-swap.
#[derive(Clone)]
pub struct CaptureStatusReporter {
    app: AppHandle,
    closed: Arc<Mutex<bool>>,
}

impl CaptureStatusReporter {
    pub fn new(app: AppHandle) -> Self {
        Self { app, closed: Arc::new(Mutex::new(false)) }
    }

    pub fn report(&self, party: PartyRole, status: AudioCaptureStatus, message: Option<String>) {
        if let Ok(closed) = self.closed.lock() {
            if !*closed {
                if let Err(error) = self.app.emit("audio_capture_status", AudioCaptureStatusEvent { party, status, message }) {
                    log::error!("Cannot publish audio capture status: {}", error);
                }
            }
        } else {
            log::error!("Cannot publish audio capture status: session state lock failed");
        }
    }

    pub fn error(&self, party: PartyRole, error: &str) {
        self.report(party, capture_error_status(error), Some(error.to_string()));
    }

    pub fn close(&self) {
        if let Ok(mut closed) = self.closed.lock() {
            *closed = true;
        } else {
            log::error!("Cannot close audio capture status session: state lock failed");
        }
    }

    pub fn pause(&self) {
        if let Ok(mut closed) = self.closed.lock() {
            if !*closed {
                *closed = true;
                for party in [PartyRole::You, PartyRole::Them] {
                    if let Err(error) = self.app.emit("audio_capture_status", AudioCaptureStatusEvent {
                        party, status: AudioCaptureStatus::Paused, message: None,
                    }) {
                        log::error!("Cannot publish paused audio capture status: {}", error);
                    }
                }
            }
        } else {
            log::error!("Cannot publish paused audio capture status: session state lock failed");
        }
    }

    pub fn stream(&self, parties: &[PartyRole]) -> StreamCaptureStatusReporter {
        StreamCaptureStatusReporter {
            session: self.clone(), parties: parties.to_vec(), failed: Arc::new(Mutex::new(false)),
        }
    }
}

/// One physical stream may serve both parties. Its error callback reports once
/// and wins over a concurrent startup acknowledgement.
#[derive(Clone)]
pub struct StreamCaptureStatusReporter {
    session: CaptureStatusReporter,
    parties: Vec<PartyRole>,
    failed: Arc<Mutex<bool>>,
}

impl StreamCaptureStatusReporter {
    pub fn stream_error(&self, error: cpal::StreamError) {
        if matches!(&error, cpal::StreamError::DeviceNotAvailable) {
            self.error(&format!("Audio device unavailable: {}", error));
        } else {
            self.error(&error.to_string());
        }
    }

    pub fn active(&self, message: String) {
        if let Ok(failed) = self.failed.lock() {
            if !*failed {
                for party in &self.parties {
                    self.session.report(party.clone(), AudioCaptureStatus::Active, Some(message.clone()));
                }
            }
        } else {
            log::error!("Cannot publish active audio capture status: stream state lock failed");
        }
    }

    pub fn error(&self, error: &str) {
        if let Ok(mut failed) = self.failed.lock() {
            if !*failed {
                *failed = true;
                for party in &self.parties {
                    self.session.error(party.clone(), error);
                }
            }
        } else {
            log::error!("Cannot publish failed audio capture status: stream state lock failed");
        }
    }
}

/// Only explicit device/permission evidence is classified specially. Provider
/// failures and generic errors never imply denied microphone permission.
fn capture_error_status(error: &str) -> AudioCaptureStatus {
    let error = error.to_lowercase();
    if ["permission denied", "permissiondenied", "access denied", "access is denied", "accessdenied", "not permitted",
        "0x80070005", "-2147024891"].iter().any(|message| error.contains(message)) {
        AudioCaptureStatus::PermissionDenied
    } else if ["device not available", "device is no longer available", "device unavailable",
        "no default input device", "no default output device", "0x88890004"]
        .iter().any(|message| error.contains(message))
        || (error.contains("device") && error.contains("not found")) {
        AudioCaptureStatus::DeviceUnavailable
    } else {
        AudioCaptureStatus::Failed
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_device_and_permission_evidence_identifies_capture_failures() {
        assert_eq!(capture_error_status("Access is denied (0x80070005)"), AudioCaptureStatus::PermissionDenied);
        assert_eq!(capture_error_status("Audio device unavailable"), AudioCaptureStatus::DeviceUnavailable);
        assert_eq!(capture_error_status("Deepgram API key not configured"), AudioCaptureStatus::Failed);
    }
}
