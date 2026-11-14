//! Installed font families for the presenter's font picker.
//!
//! Windows lists installed fonts (system-wide and per-user) under the
//! `...\Windows NT\CurrentVersion\Fonts` registry key as values like
//! `Segoe UI Semibold (TrueType)`. Only value *names* are read.

const STYLE_WORDS: &[&str] = &[
    "bold", "italic", "oblique", "regular", "light", "semilight", "semibold", "demibold", "medium",
    "black", "thin", "extralight", "extrabold", "heavy", "ultralight", "book", "roman", "condensed",
];

/// Fonts commonly available that render Latin and Persian/Arabic script well,
/// offered even when registry listing is unavailable.
const FALLBACK_FAMILIES: &[&str] = &[
    "Segoe UI", "Tahoma", "Arial", "Calibri", "Verdana", "Times New Roman", "Georgia", "Consolas",
    "Cambria", "Trebuchet MS", "Arial Unicode MS",
];

/// `"Segoe UI Semibold (TrueType)"` → `["Segoe UI"]`;
/// `"Cambria & Cambria Math (TrueType)"` → `["Cambria", "Cambria Math"]`.
pub fn families_from_value_name(name: &str) -> Vec<String> {
    let base = match name.rfind(" (") {
        Some(i) if name.ends_with(')') => &name[..i],
        _ => name,
    };
    base.split(" & ")
        .map(|part| {
            let mut words: Vec<&str> = part.split_whitespace().collect();
            while words.len() > 1 && STYLE_WORDS.contains(&words[words.len() - 1].to_lowercase().as_str()) {
                words.pop();
            }
            words.join(" ")
        })
        .filter(|f| !f.is_empty() && f.chars().all(|c| !c.is_control()))
        .collect()
}

#[cfg(windows)]
fn registry_value_names() -> Vec<String> {
    use windows::core::{w, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    let mut names = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let mut key = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(root, w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"), Some(0), KEY_READ, &mut key)
        };
        if opened.is_err() {
            continue;
        }
        let mut index = 0u32;
        loop {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let status = unsafe {
                RegEnumValueW(key, index, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None)
            };
            if status.is_err() {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
            index += 1;
        }
        unsafe {
            let _ = RegCloseKey(key);
        }
    }
    names
}

#[cfg(not(windows))]
fn registry_value_names() -> Vec<String> {
    Vec::new()
}

pub fn installed_font_families() -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for name in registry_value_names() {
        for family in families_from_value_name(&name) {
            set.insert(family);
        }
    }
    for f in FALLBACK_FAMILIES {
        set.insert((*f).to_string());
    }
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_names_become_plain_families() {
        assert_eq!(families_from_value_name("Segoe UI Semibold (TrueType)"), ["Segoe UI"]);
        assert_eq!(families_from_value_name("Segoe UI Bold Italic (TrueType)"), ["Segoe UI"]);
        assert_eq!(families_from_value_name("Cambria & Cambria Math (TrueType)"), ["Cambria", "Cambria Math"]);
        assert_eq!(families_from_value_name("B Nazanin (TrueType)"), ["B Nazanin"]);
        assert_eq!(families_from_value_name("Vazirmatn Medium (OpenType)"), ["Vazirmatn"]);
        // A family that is only a style word keeps its name.
        assert_eq!(families_from_value_name("Black (TrueType)"), ["Black"]);
        assert!(families_from_value_name("").is_empty());
    }

    #[test]
    fn the_list_is_sorted_unique_and_never_empty() {
        let fonts = installed_font_families();
        assert!(fonts.contains(&"Tahoma".to_string()));
        let mut sorted = fonts.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(fonts, sorted);
    }
}
