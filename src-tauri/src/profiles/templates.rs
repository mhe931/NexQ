//! Built-in meeting templates and writing/speaking style profiles.
//!
//! Templates are starting points: creating a meeting copies the text into the
//! profile, where it stays fully editable. A style profile is a manner of
//! writing and speaking, never a synthesized voice.

use serde::Serialize;

use super::model::{MeetingProfile, MeetingType, ResponseFormat, ResponseLength, SessionKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub meeting_type: MeetingType,
    pub system_prompt: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfile {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub instruction: &'static str,
}

pub const ACADEMIC_QA_PROMPT: &str = "\
You help the user answer examiners' questions after presenting their own work. \
Answer from the meeting's reference documents first. Lead with a direct answer in one or two sentences, \
then one brief supporting explanation, then name the supporting source (document and section or slide). \
State method limits and uncertainty plainly. If the documents do not contain the answer, say so and \
suggest what the user could honestly say instead of guessing.";

pub const TECHNICAL_INTERVIEW_PROMPT: &str = "\
You help the user during a technical interview. Use the meeting's resume, role description and project \
documentation. Give a concise answer the user can say aloud. When the question calls for a demonstration \
or a screen-sharing step, list each step the user must perform as its own action line first. \
Never invent experience, employers, dates or results that are not in the documents.";

pub const GENERAL_MEETING_PROMPT: &str = "\
You are a concise meeting assistant. Answer the question that was just asked using the meeting's documents \
and recent transcript. Keep answers short, factual and easy to say aloud. Say when something is not covered.";

pub fn templates() -> Vec<MeetingTemplate> {
    vec![
        MeetingTemplate {
            id: "academic_qa",
            name: "Presentation + Academic Q&A",
            description: "Present with notes, then answer examiner questions from your documents.",
            meeting_type: MeetingType::PresentationQa,
            system_prompt: ACADEMIC_QA_PROMPT,
        },
        MeetingTemplate {
            id: "technical_interview",
            name: "Technical Interview",
            description: "Questions and answers with explicit on-screen action steps.",
            meeting_type: MeetingType::Interview,
            system_prompt: TECHNICAL_INTERVIEW_PROMPT,
        },
        MeetingTemplate {
            id: "general_meeting",
            name: "General Meeting",
            description: "Short answers from your documents during an ordinary meeting.",
            meeting_type: MeetingType::General,
            system_prompt: GENERAL_MEETING_PROMPT,
        },
        MeetingTemplate {
            id: "custom",
            name: "Custom",
            description: "Start empty and write your own instructions.",
            meeting_type: MeetingType::Custom,
            system_prompt: "",
        },
    ]
}

pub const DANIEL_ACADEMIC_VOICE: &str = "\
Write and speak in natural first-person English: professional, academically appropriate and concise. \
Be evidence-based and explain technical ideas clearly. Sound confident without exaggeration. \
Never invent qualifications, research results, citations or accomplishments. \
When unsure or when the evidence is limited, say so honestly.";

pub fn style_profiles() -> Vec<StyleProfile> {
    vec![
        StyleProfile {
            id: "daniel_academic_voice",
            name: "Daniel Academic Voice",
            description: "First-person, concise, evidence-based and honest about uncertainty.",
            instruction: DANIEL_ACADEMIC_VOICE,
        },
        StyleProfile {
            id: "plain_professional",
            name: "Plain Professional",
            description: "Clear, neutral business English without jargon.",
            instruction: "Use plain, professional first-person English. Prefer short sentences and avoid jargon.",
        },
    ]
}

pub fn style_instruction(id: &str) -> Option<&'static str> {
    style_profiles().into_iter().find(|s| s.id == id).map(|s| s.instruction)
}

/// A new profile pre-filled from a template (still fully editable).
pub fn profile_from_template(name: &str, template_id: &str) -> MeetingProfile {
    let template = templates()
        .into_iter()
        .find(|t| t.id == template_id)
        .unwrap_or_else(|| templates().pop().expect("templates are never empty"));
    let mut profile = MeetingProfile {
        name: name.to_string(),
        meeting_type: template.meeting_type,
        template: template.id.to_string(),
        system_prompt: template.system_prompt.to_string(),
        session_kind: SessionKind::Rehearsal,
        ..Default::default()
    };
    match template.meeting_type {
        MeetingType::PresentationQa => {
            profile.environment.monitor_count = 2;
            profile.environment.presentation_monitor = 1;
            profile.ai.response_length = ResponseLength::Short;
        }
        MeetingType::Interview => {
            profile.ai.response_format = ResponseFormat::ActionAnswer;
        }
        _ => {}
    }
    profile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_four_templates_exist_and_seed_editable_profiles() {
        let ids: Vec<_> = templates().iter().map(|t| t.id).collect();
        assert_eq!(ids, ["academic_qa", "technical_interview", "general_meeting", "custom"]);
        let p = profile_from_template("Defense", "academic_qa");
        assert_eq!(p.meeting_type, MeetingType::PresentationQa);
        assert!(p.system_prompt.contains("examiners"));
        assert_eq!(p.environment.monitor_count, 2);
        let i = profile_from_template("Round 1", "technical_interview");
        assert_eq!(i.ai.response_format, ResponseFormat::ActionAnswer);
        assert!(profile_from_template("x", "custom").system_prompt.is_empty());
    }

    #[test]
    fn daniel_academic_voice_is_a_style_not_a_voice_model() {
        let text = style_instruction("daniel_academic_voice").unwrap();
        assert!(text.contains("first-person") && text.contains("Never invent"));
        assert!(!text.to_lowercase().contains("clone"));
        assert!(style_instruction("missing").is_none());
    }
}
