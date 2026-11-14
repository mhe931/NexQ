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
    /// Asked once per meeting (during setup, or at the first Start listening) and kept;
    /// it is not repeated on pause/resume, Q&A transitions or questions.
    pub listening_consent_confirmed: bool,
    /// When that acknowledgement was given (RFC 3339), for the user's own records.
    pub listening_acknowledged_at: Option<String>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            transcription_engine: TranscriptionEngine::Auto,
            mic_device_id: None,
            output_device_id: None,
            output_mode: OutputMode::Text,
            listening_consent_confirmed: false,
            listening_acknowledged_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextDirection {
    /// Each paragraph follows its own first strong character (mixed Persian/English).
    Auto,
    Ltr,
    Rtl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorPreset {
    /// Follows `high_contrast`.
    Auto,
    WhiteOnBlack,
    YellowOnBlack,
    GreenOnBlack,
    BlackOnWhite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TeleprompterSettings {
    pub font_size: u32,
    /// Preferred font family; empty uses the built-in stack. Always rendered
    /// with fallbacks so Latin and Persian text stay readable.
    pub font_family: String,
    pub text_direction: TextDirection,
    pub color_preset: ColorPreset,
    /// Line height multiplier.
    pub line_spacing: f32,
    /// Maximum line length in characters (0 = fill the window).
    pub line_chars: u32,
    /// Opacity of the whole presenter window, 0.2 to 1.0. It replaces the old
    /// background-only `opacity`, whose saved value is ignored on load.
    pub window_opacity: f32,
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
            font_family: String::new(),
            text_direction: TextDirection::Auto,
            color_preset: ColorPreset::Auto,
            line_spacing: 1.45,
            line_chars: 60,
            window_opacity: 1.0,
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

/// Which notes win when a slide has both embedded and external notes.
/// A slide's own manually edited copy always wins over both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotesPriority {
    /// edited > external speaker-notes document > embedded (default)
    ExternalFirst,
    /// edited > embedded > external
    EmbeddedFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundKind {
    Powerpoint,
    GoogleSlides,
    Other,
}

/// The presentation this meeting was last bound to. It is only a hint:
/// the target is looked up again (and may be gone) every time it is used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationBinding {
    pub id: String,
    pub title: String,
    pub kind: BoundKind,
    pub bound_at: String,
}

/// Keyboard keys (`KeyboardEvent.key`) for each presenter action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    pub next: Vec<String>,
    pub prev: Vec<String>,
    pub first: Vec<String>,
    pub last: Vec<String>,
    pub start_qa: Vec<String>,
}

impl Default for Shortcuts {
    fn default() -> Self {
        let keys = |k: &[&str]| k.iter().map(|s| s.to_string()).collect();
        Self {
            next: keys(&["ArrowRight", "PageDown", "n"]),
            prev: keys(&["ArrowLeft", "PageUp", "p"]),
            first: keys(&["Home"]),
            last: keys(&["End"]),
            start_qa: keys(&["q"]),
        }
    }
}

impl Shortcuts {
    fn validate(&self) -> Result<(), String> {
        let groups = [
            ("next slide", &self.next), ("previous slide", &self.prev), ("first slide", &self.first),
            ("last slide", &self.last), ("start Q&A", &self.start_qa),
        ];
        let mut seen = std::collections::HashMap::new();
        for (label, keys) in groups {
            if keys.is_empty() {
                return Err(format!("The shortcut for {label} needs at least one key."));
            }
            for key in keys {
                if key.is_empty() || key.chars().count() > 20 {
                    return Err(format!("Invalid key for {label}."));
                }
                // Arrow up/down and H are reserved for scrolling and hiding.
                if matches!(key.as_str(), "ArrowUp" | "ArrowDown" | "h" | "H") {
                    return Err(format!("{key} is reserved (scrolling / hide) and cannot be used for {label}."));
                }
                if let Some(other) = seen.insert(key.to_lowercase(), label) {
                    return Err(format!("{key} is assigned to both {other} and {label}."));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PresentationSettings {
    pub source: PresentationSource,
    pub google_slides_url: String,
    /// Follow slide changes made directly in the bound presentation.
    /// Only effective where the integration can report the current slide.
    pub auto_follow: bool,
    pub current_slide: u32,
    pub notes_priority: NotesPriority,
    pub binding: Option<PresentationBinding>,
    pub shortcuts: Shortcuts,
}

impl Default for PresentationSettings {
    fn default() -> Self {
        Self {
            source: PresentationSource::None,
            google_slides_url: String::new(),
            auto_follow: true,
            current_slide: 1,
            notes_priority: NotesPriority::ExternalFirst,
            binding: None,
            shortcuts: Shortcuts::default(),
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
        // Below 0.2 the window is too easy to lose on a busy screen.
        if !(0.2..=1.0).contains(&t.window_opacity) {
            return Err("Window opacity must be between 20% and 100%.".into());
        }
        if !(1.0..=2.5).contains(&t.line_spacing) {
            return Err("Teleprompter line spacing must be between 1.0 and 2.5.".into());
        }
        if t.line_chars != 0 && !(20..=200).contains(&t.line_chars) {
            return Err("Teleprompter line length must be 0 (full width) or between 20 and 200 characters.".into());
        }
        if t.font_family.chars().count() > 80
            || t.font_family.chars().any(|c| c.is_control() || matches!(c, '"' | '\'' | ';' | '{' | '}' | '<' | '>' | '\\'))
        {
            return Err("The font name contains characters that are not allowed.".into());
        }
        self.presentation.shortcuts.validate()?;
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
    fn presenter_text_preferences_are_bounded_and_older_profiles_get_defaults() {
        let mut p = MeetingProfile { name: "A".into(), ..Default::default() };
        p.environment.teleprompter.window_opacity = 0.1;
        assert!(p.validate().unwrap_err().contains("opacity"));
        p.environment.teleprompter.window_opacity = 0.2;
        assert!(p.validate().is_ok());
        p.environment.teleprompter.window_opacity = 0.5;
        p.environment.teleprompter.line_spacing = 3.0;
        assert!(p.validate().is_err());
        p.environment.teleprompter.line_spacing = 1.6;
        p.environment.teleprompter.font_family = "Vazirmatn; } body{display:none".into();
        assert!(p.validate().unwrap_err().contains("font"));
        p.environment.teleprompter.font_family = "B Nazanin".into();
        p.environment.teleprompter.text_direction = TextDirection::Rtl;
        assert!(p.validate().is_ok());

        // A profile saved before these fields existed keeps working.
        let old: MeetingProfile = serde_json::from_str(
            r#"{"id":"x","name":"Old","environment":{"teleprompter":{"fontSize":30}}}"#).unwrap();
        assert_eq!(old.environment.teleprompter.font_size, 30);
        assert_eq!(old.environment.teleprompter.text_direction, TextDirection::Auto);
        assert_eq!(old.presentation.notes_priority, NotesPriority::ExternalFirst);
        assert!(old.presentation.auto_follow && old.presentation.binding.is_none());
        assert_eq!(old.environment.teleprompter.window_opacity, 1.0);

        // The former background-only value is not reused as a window opacity.
        let legacy: MeetingProfile = serde_json::from_str(
            r#"{"id":"x","name":"Old","environment":{"teleprompter":{"opacity":0.4}}}"#).unwrap();
        assert_eq!(legacy.environment.teleprompter.window_opacity, 1.0);
        let saved: MeetingProfile = serde_json::from_str(
            r#"{"id":"x","name":"New","environment":{"teleprompter":{"windowOpacity":0.4}}}"#).unwrap();
        assert_eq!(saved.environment.teleprompter.window_opacity, 0.4);
    }

    #[test]
    fn shortcuts_must_be_unique_non_empty_and_not_reserved() {
        let mut p = MeetingProfile { name: "A".into(), ..Default::default() };
        assert!(p.validate().is_ok());
        p.presentation.shortcuts.first = vec!["ArrowRight".into()];
        assert!(p.validate().unwrap_err().contains("assigned to both"));
        p.presentation.shortcuts.first = vec!["Home".into()];
        p.presentation.shortcuts.last = vec![];
        assert!(p.validate().unwrap_err().contains("at least one"));
        p.presentation.shortcuts.last = vec!["h".into()];
        assert!(p.validate().unwrap_err().contains("reserved"));
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
