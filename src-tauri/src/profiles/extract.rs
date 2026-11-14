//! Text extraction with source locators (section, page, slide).
//!
//! The XML handling is deliberately small (string scanning, no new
//! dependency), matching the existing DOCX extractor. Slide order and the
//! slide→notes mapping follow the presentation's own relationships rather
//! than file numbering, so reordered decks keep the right notes with each slide.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

pub const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "pdf", "docx", "pptx", "pptm", "ppsx", "html", "htm"];

/// PowerPoint package formats that carry slides and notes in the same layout.
pub fn is_presentation_ext(ext: &str) -> bool {
    matches!(ext, "pptx" | "pptm" | "ppsx")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// Human-readable origin, e.g. `section "Methods"`, `page 3`, `slide 5 notes`.
    pub locator: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlideData {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub notes: String,
}

#[derive(Debug, Clone, Default)]
pub struct Extracted {
    pub file_type: String,
    pub sections: Vec<Section>,
    pub slides: Vec<SlideData>,
}

pub fn extension_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn is_supported(path: &Path) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension_of(path).as_str())
}

pub fn extract(path: &Path) -> Result<Extracted, String> {
    let ext = extension_of(path);
    let path_str = path.to_str().ok_or("The file path is not valid Unicode.")?;
    let mut out = match ext.as_str() {
        "md" | "markdown" => Extracted {
            file_type: "md".into(),
            sections: markdown_sections(&read_text(path_str)?),
            ..Default::default()
        },
        "txt" => Extracted {
            file_type: "txt".into(),
            sections: vec![Section { locator: "text".into(), text: read_text(path_str)? }],
            ..Default::default()
        },
        "pdf" => Extracted {
            file_type: "pdf".into(),
            sections: pdf_pages(&crate::context::pdf_extractor::extract_text_from_pdf(path_str)?),
            ..Default::default()
        },
        "docx" => Extracted {
            file_type: "docx".into(),
            sections: docx_sections(&read_zip_entry(path, "word/document.xml")?),
            ..Default::default()
        },
        "pptx" | "pptm" | "ppsx" => extract_pptx(path)?,
        "html" | "htm" => Extracted {
            file_type: "html".into(),
            sections: html_sections(&String::from_utf8_lossy(
                &std::fs::read(path).map_err(|e| format!("Cannot read the file: {e}"))?,
            )),
            ..Default::default()
        },
        other => {
            return Err(format!(
                "Unsupported file type .{other}. Supported: {}.",
                SUPPORTED_EXTENSIONS.join(", ")
            ))
        }
    };
    out.sections.retain(|s| !s.text.trim().is_empty());
    if out.sections.is_empty() && out.slides.is_empty() {
        return Err("No readable text was found (a scanned or image-only file?).".into());
    }
    Ok(out)
}

/// The document as lines of text in reading order (for notes documents).
/// Markdown and text keep their raw lines so `# Slide 1` headings survive.
pub fn plain_text(path: &Path) -> Result<String, String> {
    match extension_of(path).as_str() {
        "md" | "markdown" | "txt" => read_text(path.to_str().ok_or("The file path is not valid Unicode.")?),
        _ => Ok(extract(path)?.sections.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n")),
    }
}

fn read_text(path: &str) -> Result<String, String> {
    crate::context::file_loader::load_text_file(path)
}

fn read_zip_entry(path: &Path, name: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open the file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid Office file: {e}"))?;
    zip_text(&mut zip, name)
}

fn zip_text<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Result<String, String> {
    let mut entry = zip.by_name(name).map_err(|_| format!("The file is missing {name}."))?;
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(|e| format!("Cannot read {name}: {e}"))?;
    Ok(text)
}

/// Decodes the five predefined XML entities in a single pass, so
/// `&amp;lt;` becomes `&lt;` and not `<`.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let (rep, len) = if tail.starts_with("&lt;") {
            ("<", 4)
        } else if tail.starts_with("&gt;") {
            (">", 4)
        } else if tail.starts_with("&amp;") {
            ("&", 5)
        } else if tail.starts_with("&quot;") {
            ("\"", 6)
        } else if tail.starts_with("&apos;") {
            ("'", 6)
        } else {
            ("&", 1)
        };
        out.push_str(rep);
        rest = &tail[len..];
    }
    out.push_str(rest);
    out
}

fn markdown_sections(text: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut heading = String::from("introduction");
    let mut buf = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        let is_heading = !in_fence && line.starts_with('#') && line.trim_start_matches('#').starts_with(' ');
        if is_heading {
            if !buf.trim().is_empty() {
                sections.push(Section { locator: format!("section \"{heading}\""), text: std::mem::take(&mut buf) });
            }
            buf.clear();
            heading = line.trim_start_matches('#').trim().to_string();
            // Keep the heading in the text so a heading-only match is retrievable.
            buf.push_str(&heading);
            buf.push('\n');
        } else {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if !buf.trim().is_empty() {
        sections.push(Section { locator: format!("section \"{heading}\""), text: buf });
    }
    sections
}

/// Visible text of an HTML page (scripts and styles dropped), split at h1-h3 headings.
fn html_sections(html: &str) -> Vec<Section> {
    let lower = html.to_ascii_lowercase();
    let mut kept = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        let skipped = ["script", "style", "noscript", "svg"].iter().find_map(|tag| {
            lower[i..].starts_with(&format!("<{tag}")).then(|| {
                let close = format!("</{tag}>");
                lower[i..].find(&close).map(|e| i + e + close.len()).unwrap_or(html.len())
            })
        });
        if let Some(next) = skipped {
            i = next;
            continue;
        }
        let rest = &html[i..];
        if rest.starts_with('<') {
            let end = rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
            let tag = rest[1..end.saturating_sub(1)].trim_start_matches('/').to_ascii_lowercase();
            let name: String = tag.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            match name.as_str() {
                "h1" | "h2" | "h3" if !rest.starts_with("</") => kept.push_str("\n\u{1}"),
                "p" | "div" | "br" | "li" | "tr" | "section" | "article" | "h1" | "h2" | "h3" | "h4" | "ul" | "ol" => {
                    kept.push('\n')
                }
                _ => {}
            }
            i += end;
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            kept.push_str(&rest[..end]);
            i += end;
        }
    }
    let text = decode_entities(&kept);
    let mut sections = Vec::new();
    let mut heading = String::from("page");
    let mut buf = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(h) = line.strip_prefix('\u{1}') {
            if !buf.trim().is_empty() {
                sections.push(Section { locator: format!("section \"{heading}\""), text: std::mem::take(&mut buf) });
            }
            heading = h.trim().to_string();
            buf.push_str(&heading);
            buf.push('\n');
        } else {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if !buf.trim().is_empty() {
        sections.push(Section { locator: format!("section \"{heading}\""), text: buf });
    }
    sections
}

fn pdf_pages(text: &str) -> Vec<Section> {
    let pages: Vec<&str> = text.split('\u{c}').collect();
    if pages.len() <= 1 {
        return vec![Section { locator: "pdf".into(), text: text.to_string() }];
    }
    pages
        .iter()
        .enumerate()
        .map(|(i, p)| Section { locator: format!("page {}", i + 1), text: p.to_string() })
        .collect()
}

/// Text of every `<tag ...>text</tag>` run in `xml`, in order.
fn runs<'a>(xml: &'a str, tag: &str) -> Vec<String> {
    let open_exact = format!("<{tag}>");
    let open_attr = format!("<{tag} ");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut i = 0;
    while i < xml.len() {
        let rest = &xml[i..];
        let a = rest.find(&open_exact).map(|p| (p, open_exact.len()));
        let b = rest.find(&open_attr).map(|p| (p, 0usize));
        let Some((pos, skip)) = [a, b].into_iter().flatten().min_by_key(|(p, _)| *p) else { break };
        let after_open = &rest[pos..];
        let content_start = if skip > 0 { skip } else { after_open.find('>').map(|g| g + 1).unwrap_or(after_open.len()) };
        let body = &after_open[content_start..];
        let Some(end) = body.find(&close) else { break };
        out.push(decode_entities(&body[..end]));
        i += pos + content_start + end + close.len();
    }
    out
}

fn docx_sections(xml: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut heading = String::from("document start");
    let mut buf = String::new();
    for para in xml.split("</w:p>") {
        let Some(start) = para.rfind("<w:p>").or_else(|| para.rfind("<w:p ")) else { continue };
        let para = &para[start..];
        let text: String = runs(para, "w:t").concat();
        if text.trim().is_empty() {
            continue;
        }
        let style = para
            .find("w:pStyle w:val=\"")
            .map(|p| &para[p + 16..])
            .and_then(|s| s.split('"').next())
            .unwrap_or("");
        let is_heading = style.starts_with("Heading") || style == "Title";
        if is_heading {
            if !buf.trim().is_empty() {
                sections.push(Section { locator: format!("section \"{heading}\""), text: std::mem::take(&mut buf) });
            }
            heading = text.trim().to_string();
        }
        buf.push_str(&text);
        buf.push('\n');
    }
    if !buf.trim().is_empty() {
        sections.push(Section { locator: format!("section \"{heading}\""), text: buf });
    }
    sections
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}=\"");
    let start = tag.find(&key)? + key.len();
    tag[start..].split('"').next()
}

/// `(Id → Target)` for a relationships part.
fn relationships(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for tag in xml.split("<Relationship ").skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        if let (Some(id), Some(target)) = (attribute(tag, "Id"), attribute(tag, "Target")) {
            map.insert(id.to_string(), target.to_string());
        }
    }
    map
}

fn resolve_target(base_dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Paragraph text of the shapes (`<p:sp>`) of a slide part, with each shape's placeholder type.
fn shapes(xml: &str) -> Vec<(Option<String>, String)> {
    xml.split("<p:sp>")
        .skip(1)
        .chain(xml.split("<p:sp ").skip(1))
        .map(|block| {
            let block = block.split("</p:sp>").next().unwrap_or("");
            let ph = block.find("<p:ph").map(|p| {
                let tag = block[p..].split('>').next().unwrap_or("");
                attribute(tag, "type").unwrap_or("body").to_string()
            });
            let paragraphs: Vec<String> = block
                .split("</a:p>")
                .map(|p| runs(p, "a:t").concat())
                .filter(|t| !t.trim().is_empty())
                .collect();
            (ph, paragraphs.join("\n"))
        })
        .collect()
}

fn extract_pptx(path: &Path) -> Result<Extracted, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open the file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid PowerPoint file: {e}"))?;

    // Slide order comes from presentation.xml, resolved through its relationships.
    let presentation = zip_text(&mut zip, "ppt/presentation.xml")?;
    let pres_rels = zip_text(&mut zip, "ppt/_rels/presentation.xml.rels")
        .map(|x| relationships(&x))
        .unwrap_or_default();
    let mut slide_parts: Vec<String> = Vec::new();
    for tag in presentation.split("<p:sldId ").skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        if let Some(target) = attribute(tag, "r:id").and_then(|id| pres_rels.get(id)) {
            slide_parts.push(resolve_target("ppt", target));
        }
    }
    if slide_parts.is_empty() {
        return Err("The presentation lists no slides.".into());
    }

    let mut out = Extracted { file_type: "pptx".into(), ..Default::default() };
    for (index, part) in slide_parts.iter().enumerate() {
        let number = index as u32 + 1;
        let slide_xml = zip_text(&mut zip, part)?;
        let (mut title, mut body_lines) = (String::new(), Vec::new());
        for (ph, text) in shapes(&slide_xml) {
            match ph.as_deref() {
                Some("title") | Some("ctrTitle") if title.is_empty() => title = text.replace('\n', " "),
                Some("sldNum") | Some("dt") | Some("ftr") => {}
                _ if !text.trim().is_empty() => body_lines.push(text),
                _ => {}
            }
        }

        let (dir, file_name) = part.rsplit_once('/').unwrap_or(("", part));
        let rels_path = format!("{dir}/_rels/{file_name}.rels");
        let mut notes = String::new();
        if let Ok(rels_xml) = zip_text(&mut zip, &rels_path) {
            let notes_part = relationships(&rels_xml)
                .into_values()
                .find(|t| t.contains("notesSlide"))
                .map(|t| resolve_target(dir, &t));
            if let Some(np) = notes_part {
                if let Ok(notes_xml) = zip_text(&mut zip, &np) {
                    notes = shapes(&notes_xml)
                        .into_iter()
                        .filter(|(ph, _)| ph.as_deref() == Some("body"))
                        .map(|(_, t)| t)
                        .collect::<Vec<_>>()
                        .join("\n");
                }
            }
        }

        let body = body_lines.join("\n");
        let slide_text = if title.is_empty() { body.clone() } else { format!("{title}\n{body}") };
        out.sections.push(Section { locator: format!("slide {number}"), text: slide_text });
        out.sections.push(Section { locator: format!("slide {number} notes"), text: notes.clone() });
        out.slides.push(SlideData { number, title, body, notes });
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::Write;

    /// Builds a minimal PPTX. `slides` are `(file_stem, title, body, notes)` in
    /// *file* order; `order` lists file stems in *presentation* order.
    pub fn pptx(path: &std::path::Path, slides: &[(&str, &str, &str, &str)], order: &[&str]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: String| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        let ids: String = order
            .iter()
            .enumerate()
            .map(|(i, _)| format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 256 + i, 10 + i))
            .collect();
        put("ppt/presentation.xml", format!("<p:presentation><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>"));
        let rels: String = order
            .iter()
            .enumerate()
            .map(|(i, stem)| {
                format!("<Relationship Id=\"rId{}\" Type=\"slide\" Target=\"slides/{stem}.xml\"/>", 10 + i)
            })
            .collect();
        put("ppt/_rels/presentation.xml.rels", format!("<Relationships>{rels}</Relationships>"));
        for (n, (stem, title, body, notes)) in slides.iter().enumerate() {
            put(
                &format!("ppt/slides/{stem}.xml"),
                format!(
                    "<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"title\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>\
                     <p:sp><p:nvSpPr><p:nvPr><p:ph idx=\"1\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>"
                ),
            );
            // Notes parts are numbered independently of the slides on purpose.
            let notes_no = 100 - n;
            put(
                &format!("ppt/slides/_rels/{stem}.xml.rels"),
                format!("<Relationships><Relationship Id=\"rId1\" Type=\"notesSlide\" Target=\"../notesSlides/notesSlide{notes_no}.xml\"/></Relationships>"),
            );
            put(
                &format!("ppt/notesSlides/notesSlide{notes_no}.xml"),
                format!(
                    "<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr></p:sp>\
                     <p:sp><p:nvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{notes}</a:t></a:r></a:p></p:txBody></p:sp>\
                     <p:sp><p:nvSpPr><p:nvPr><p:ph type=\"sldNum\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>99</a:t></a:r></a:p></p:txBody></p:sp></p:notes>"
                ),
            );
        }
        zip.finish().unwrap();
    }

    pub fn docx(path: &std::path::Path, paragraphs: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("word/document.xml", opts).unwrap();
        let body: String = paragraphs
            .iter()
            .map(|(style, text)| {
                let ppr = if style.is_empty() {
                    String::new()
                } else {
                    format!("<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>")
                };
                format!("<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>")
            })
            .collect();
        zip.write_all(format!("<w:document><w:body>{body}</w:body></w:document>").as_bytes()).unwrap();
        zip.finish().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-extract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pptx_notes_follow_presentation_order_not_file_numbering() {
        let d = dir();
        let p = d.join("deck.pptx");
        // File order: slide1, slide2, slide3. The presenter moved slide3 to the front.
        pptx(
            &p,
            &[
                ("slide1", "Methods", "SAR processing", "NOTES-METHODS"),
                ("slide2", "Results", "Accuracy 94%", "NOTES-RESULTS"),
                ("slide3", "Introduction", "Why ice matters", "NOTES-INTRO"),
            ],
            &["slide3", "slide1", "slide2"],
        );
        let x = extract(&p).unwrap();
        let got: Vec<_> = x.slides.iter().map(|s| (s.number, s.title.as_str(), s.notes.as_str())).collect();
        assert_eq!(
            got,
            [(1, "Introduction", "NOTES-INTRO"), (2, "Methods", "NOTES-METHODS"), (3, "Results", "NOTES-RESULTS")]
        );
        // The slide-number placeholder ("99") must not leak into the notes.
        assert!(x.slides.iter().all(|s| !s.notes.contains("99")));
        assert!(x.sections.iter().any(|s| s.locator == "slide 3 notes" && s.text == "NOTES-RESULTS"));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn docx_sections_follow_heading_styles_and_decode_entities_once() {
        let d = dir();
        let p = d.join("thesis.docx");
        docx(&p, &[("Heading1", "Methods"), ("", "NIR &lt; 0.04 &amp;lt; NDSI"), ("Heading1", "Results"), ("", "Done")]);
        let x = extract(&p).unwrap();
        assert_eq!(x.sections[0].locator, "section \"Methods\"");
        assert!(x.sections[0].text.contains("NIR < 0.04 &lt; NDSI"));
        assert_eq!(x.sections[1].locator, "section \"Results\"");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn markdown_sections_keep_headings_and_ignore_hashes_in_code_fences() {
        let s = markdown_sections("intro\n# One\nbody\n```\n# not a heading\n```\n## Two\nmore");
        let names: Vec<_> = s.iter().map(|s| s.locator.as_str()).collect();
        assert_eq!(names, ["section \"introduction\"", "section \"One\"", "section \"Two\""]);
        assert!(s[1].text.contains("# not a heading"));
    }

    #[test]
    fn unsupported_empty_and_corrupt_files_report_clear_errors() {
        let d = dir();
        let exe = d.join("tool.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert!(extract(&exe).unwrap_err().contains("Unsupported"));
        let bad = d.join("bad.pptx");
        std::fs::write(&bad, b"not a zip").unwrap();
        assert!(extract(&bad).unwrap_err().contains("PowerPoint"));
        let empty = d.join("empty.md");
        std::fs::write(&empty, "  \n").unwrap();
        assert!(extract(&empty).unwrap_err().contains("No readable text"));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn html_pages_keep_visible_text_by_heading_and_drop_scripts() {
        let s = html_sections(
            "<html><head><style>p{}</style><script>var secret=1;</script></head><body><h1>About</h1><p>Remote sensing &amp; SAR</p><h2>Skills</h2><ul><li>Python</li><li>Rust</li></ul></body></html>",
        );
        let all: String = s.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join("|");
        assert!(!all.contains("secret") && !all.contains("p{}"));
        assert_eq!(s[0].locator, "section \"About\"");
        assert!(s[0].text.contains("Remote sensing & SAR"));
        assert_eq!(s[1].locator, "section \"Skills\"");
        assert!(s[1].text.contains("Python") && s[1].text.contains("Rust"));
    }

    #[test]
    fn entity_decoding_is_single_pass() {
        assert_eq!(decode_entities("a &amp;lt; b &lt; c &unknown; &quot;x&quot;"), "a &lt; b < c &unknown; \"x\"");
    }
}
