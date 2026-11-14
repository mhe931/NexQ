//! Per-meeting profile: everything a single meeting needs, saved independently.
//!
//! Profiles never contain credentials. Providers and models are referenced by
//! name only; keys live in the OS credential store (see `credentials`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingType {
    PresentationQa,
    Interview,
    General,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Teams,
    Zoom,
    Meet,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    Fast,
    Balanced,
    Best,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    Text,
    Spoken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionEngine {
    Auto,
    Whisper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenShare {
    None,
    Window,
    Display,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebcamPosition {
    TopCenter,
    TopLeft,
    TopRight,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// Practice run: answers are labelled as rehearsal assistance.
    Rehearsal,
    /// Real meeting: AI assistance is labelled and never presented as unaided work.
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseLength {
    Short,
    Medium,
    Long,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormat {
    Plain,
    /// `[ACTION]` steps followed by an `[ANSWER]` to say aloud.
    ActionAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresentationSource {
    None,
    Pptx,
    GoogleSlides,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceFolder {
    pub id: String,
    pub path: String,
    /// `local`, or `cloud` for a locally synced cloud folder (OneDrive, Drive).
    pub kind: String,
    pub label: String,
    pub recursive: bool,
}

impl Default for SourceFolder {
    fn default() -> Self {
        Self {
            id: String::new(),
            path: String::new(),
            kind: "local".into(),
            label: String::new(),
            recursive: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StyleSettings {
    /// Built-in or custom style id (see `templates::style_profiles`). Style is
    /// a writing/speaking manner, not a synthesized voice.
    pub profile_id: Option<String>,
    pub custom_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub primary_provider: Option<String>,
    pub primary_model: Option<String>,
    pub fallback_provider: Option<String>,
    pub fallback_model: Option<String>,
    /// Name of the fallback provider the user explicitly allowed to receive
    /// this meeting's private context. Fallback never happens without it.
    pub fallback_consent_provider: Option<String>,
    pub automatic_fallback: bool,
    pub strategy: Strategy,
    pub response_length: ResponseLength,
    pub response_format: ResponseFormat,
    pub streaming: bool,
    pub max_response_seconds: u32,
    /// Hard spending cap for this meeting in USD.
    pub spend_limit_usd: Option<f64>,
    pub allow_paid_fallback: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            primary_provider: None,
            primary_model: None,
            fallback_provider: None,
            fallback_model: None,
            fallback_consent_provider: None,
            automatic_fallback: false,
            strategy: Strategy::Balanced,
            response_length: ResponseLength::Short,
            response_format: ResponseFormat::Plain,
            streaming: true,
            max_response_seconds: 20,
            spend_limit_usd: None,
            allow_paid_fallback: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    pub transcription_engine: TranscriptionEngine,
    pub mic_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub output_mode: OutputMode,
    /// The user confirmed that everyone whose audio is captured has agreed.
    pub listening_consent_confirmed: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            transcription_engine: TranscriptionEngine::Auto,
            mic_device_id: None,
            output_device_id: None,
            output_mode: OutputMode::Text,
            listening_consent_confirmed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TeleprompterSettings {
    pub font_size: u32,
    /// Maximum line length in characters (0 = fill the window).
    pub line_chars: u32,
    pub opacity: f32,
    /// Auto-scroll speed in pixels per second (0 = manual only).
    pub scroll_speed: u32,
    pub high_contrast: bool,
    /// Overlay rectangle in physical pixels relative to its monitor.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Default for TeleprompterSettings {
    fn default() -> Self {
        Self {
            font_size: 28,
            line_chars: 60,
            opacity: 0.92,
            scroll_speed: 0,
            high_contrast: true,
            x: 0,
            y: 0,
            width: 900,
            height: 220,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvironmentSettings {
    pub monitor_count: u8,
    pub auto_detect_displays: bool,
    pub primary_monitor: u8,
    pub presentation_monitor: u8,
    pub nexq_monitor: u8,
    pub webcam_position: WebcamPosition,
    pub screen_share: ScreenShare,
    pub teleprompter: TeleprompterSettings,
}

impl Default for EnvironmentSettings {
    fn default() -> Self {
        Self {
            monitor_count: 1,
            auto_detect_displays: true,
            primary_monitor: 0,
            presentation_monitor: 0,
            nexq_monitor: 0,
            webcam_position: WebcamPosition::TopCenter,
            screen_share: ScreenShare::None,
            teleprompter: TeleprompterSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PresentationSettings {
    pub source: PresentationSource,
    pub google_slides_url: String,
    /// Automatic slide following is only offered where a supported
    /// integration exists; manual selection is always available.
    pub auto_follow: bool,
    pub current_slide: u32,
}

impl Default for PresentationSettings {
    fn default() -> Self {
        Self {
            source: PresentationSource::None,
            google_slides_url: String::new(),
            auto_follow: false,
            current_slide: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingProfile {
    pub id: String,
    pub name: String,
    pub meeting_type: MeetingType,
    /// Template the profile was created from (`academic_qa`, `technical_interview`, ...).
    pub template: String,
    pub meeting_date: Option<String>,
    pub platform: Platform,
    pub session_kind: SessionKind,
    /// The user confirmed that AI assistance is permitted for this meeting
    /// (for example under an assessment's rules) before a live session starts.
    pub assistance_permitted_confirmed: bool,
    pub system_prompt: String,
    pub additional_instructions: String,
    pub style: StyleSettings,
    pub source_folders: Vec<SourceFolder>,
    pub ai: AiSettings,
    pub audio: AudioSettings,
    pub environment: EnvironmentSettings,
    pub presentation: PresentationSettings,
    pub feedback: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for MeetingProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            meeting_type: MeetingType::General,
            template: "general_meeting".into(),
            meeting_date: None,
            platform: Platform::Other,
            session_kind: SessionKind::Rehearsal,
            assistance_permitted_confirmed: false,
            system_prompt: String::new(),
            additional_instructions: String::new(),
            style: StyleSettings::default(),
            source_folders: Vec::new(),
            ai: AiSettings::default(),
            audio: AudioSettings::default(),
            environment: EnvironmentSettings::default(),
            presentation: PresentationSettings::default(),
            feedback: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub meeting_type: MeetingType,
    pub platform: Platform,
    pub meeting_date: Option<String>,
    pub primary_provider: Option<String>,
    pub primary_model: Option<String>,
    pub document_count: u32,
    pub session_count: u32,
    pub updated_at: String,
}

/// Markers of provider credentials that must never be stored in a profile.
const SECRET_MARKERS: &[&str] = &[
    "sk-", "sk_live", "AIza", "ghp_", "gho_", "github_pat_", "xoxb-", "AKIA",
    "-----BEGIN", "Bearer ", "api_key=", "apikey=", "x-goog-api-key",
];

/// A secret-looking token in free text: a marker followed by a long
/// credential-like run. Plain prose such as "ask-me" is not rejected.
pub fn looks_like_secret(text: &str) -> bool {
    for marker in SECRET_MARKERS {
        let mut from = 0;
        while let Some(pos) = text[from..].find(marker) {
            let start = from + pos;
            let tail: String = text[start + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '=' | '+' | '/'))
                .collect();
            let needs_long_tail = !matches!(*marker, "-----BEGIN" | "x-goog-api-key");
            if !needs_long_tail || tail.len() >= 16 {
                return true;
            }
            from = start + marker.len();
        }
    }
    false
}

impl MeetingProfile {
    /// Rejects profiles that would persist a credential in plain text.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("A meeting needs a name.".into());
        }
        if self.name.chars().count() > 200 {
            return Err("The meeting name is too long (200 characters maximum).".into());
        }
        let fields: [(&str, &str); 6] = [
            ("name", &self.name),
            ("system prompt", &self.system_prompt),
            ("additional instructions", &self.additional_instructions),
            ("style text", &self.style.custom_text),
            ("feedback", &self.feedback),
            ("Google Slides link", &self.presentation.google_slides_url),
        ];
        for (label, value) in fields {
            if looks_like_secret(value) {
                return Err(format!(
                    "The {label} looks like it contains an API key or token. \
                     Credentials belong in Settings (Windows Credential Manager), not in a meeting."
                ));
            }
        }
        for opt in [
            &self.ai.primary_provider, &self.ai.primary_model,
            &self.ai.fallback_provider, &self.ai.fallback_model,
        ] {
            if opt.as_deref().is_some_and(looks_like_secret) {
                return Err("Provider and model fields must be names, not credentials.".into());
            }
        }
        if self.environment.monitor_count == 0 || self.environment.monitor_count > 4 {
            return Err("Monitor count must be between 1 and 4.".into());
        }
        let t = &self.environment.teleprompter;
        if !(12..=120).contains(&t.font_size) {
            return Err("Teleprompter font size must be between 12 and 120.".into());
        }
        if !(0.2..=1.0).contains(&t.opacity) {
            return Err("Teleprompter opacity must be between 0.2 and 1.0.".into());
        }
        if self.ai.max_response_seconds == 0 || self.ai.max_response_seconds > 300 {
            return Err("Maximum response time must be between 1 and 300 seconds.".into());
        }
        if self.ai.fallback_provider.is_some()
            && self.ai.fallback_provider == self.ai.primary_provider
            && self.ai.fallback_model == self.ai.primary_model
        {
            return Err("The fallback must differ from the primary provider/model.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_credentials_are_rejected_everywhere_free_text_is_saved() {
        let mut p = MeetingProfile { name: "A".into(), ..Default::default() };
        p.system_prompt = "Use key sk-abcdefghijklmnopqrstuvwxyz123456 for answers".into();
        assert!(p.validate().unwrap_err().contains("API key"));
        p.system_prompt.clear();
        p.additional_instructions = "AIzaSyA1234567890abcdefghijklmnopqrstuv".into();
        assert!(p.validate().is_err());
        p.additional_instructions = "-----BEGIN PRIVATE KEY-----".into();
        assert!(p.validate().is_err());
        p.additional_instructions.clear();
        p.ai.primary_model = Some("sk-abcdefghijklmnopqrstuvwxyz123456".into());
        assert!(p.validate().is_err());
    }

    #[test]
    fn ordinary_prose_that_mentions_keys_or_tasks_is_accepted() {
        let p = MeetingProfile {
            name: "Ask-me anything".into(),
            system_prompt: "Explain the risk-based task and sk-learn usage briefly.".into(),
            additional_instructions: "Do not read an API key aloud.".into(),
            ..Default::default()
        };
        assert!(p.validate().is_ok());
    }

    #[test]
    fn serialization_round_trips_and_older_profiles_still_load() {
        let mut p = MeetingProfile { id: "m1".into(), name: "Defense".into(), ..Default::default() };
        p.meeting_type = MeetingType::PresentationQa;
        p.ai.strategy = Strategy::Fast;
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"meetingType\":\"presentation_qa\""));
        assert!(json.contains("\"strategy\":\"fast\""));
        let back: MeetingProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
        let sparse: MeetingProfile = serde_json::from_str(r#"{"id":"x","name":"Old"}"#).unwrap();
        assert_eq!(sparse.ai.strategy, Strategy::Balanced);
        assert_eq!(sparse.audio.output_mode, OutputMode::Text);
    }

    #[test]
    fn validation_rejects_unusable_environment_and_identical_fallback() {
        let mut p = MeetingProfile { name: "A".into(), ..Default::default() };
        p.environment.monitor_count = 0;
        assert!(p.validate().is_err());
        p.environment.monitor_count = 2;
        p.ai.primary_provider = Some("openai".into());
        p.ai.primary_model = Some("m".into());
        p.ai.fallback_provider = Some("openai".into());
        p.ai.fallback_model = Some("m".into());
        assert!(p.validate().unwrap_err().contains("differ"));
    }
}
