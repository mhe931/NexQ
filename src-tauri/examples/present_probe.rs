//! Live check of the PowerPoint integration, without the app.
//!
//! ```text
//! cargo run --example present_probe -- list
//! cargo run --example present_probe -- diagnose
//! cargo run --example present_probe -- run "pp:C:\talks\deck.pptx" 2 3 1
//! cargo run --example present_probe -- open "C:\talks\deck.pptx" [slides]
//! ```
//! `run` binds to exactly that target, moves to each slide in turn (printing the
//! slide PowerPoint confirms and the call time), then runs the navigation test.
//! `open` does what NexQ does when a meeting starts: it opens the file only if no
//! matching presentation is open, waits, binds and verifies, and prints stages A–E.
//! Neither starts a slide show or touches a window other than the target.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use nexq_lib::presentation::launch::{open_and_bind, LaunchPlan, Source};
use nexq_lib::presentation::service::PresentationService;

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let service = PresentationService::new();
    match args.next().as_deref() {
        Some("list") => {
            let targets = service.targets()?;
            if targets.is_empty() {
                println!("No presentation targets (is PowerPoint running with a file open?).");
            }
            for t in targets {
                println!(
                    "{}\t{:?}\t{}\tcontrol={}\tshow={}\tprotected_view={}\tslides={:?}\tcurrent={:?}\t{}",
                    t.id, t.kind, t.title, t.supports_control, t.slideshow_running, t.protected_view, t.slide_count, t.current_slide,
                    t.note.unwrap_or_default()
                );
            }
            Ok(())
        }
        Some("diagnose") => {
            let d = service.diagnose()?;
            println!("{}", d.summary());
            println!("{}", serde_json::to_string_pretty(&d).map_err(|e| e.to_string())?);
            Ok(())
        }
        Some("open") => {
            let path = PathBuf::from(args.next().ok_or("open needs a file path")?);
            let slides = args.next().and_then(|s| s.parse().ok());
            let plan = LaunchPlan {
                source: Source::File { path },
                indexed_slides: slides,
                search_dirs: vec![],
                allow_launch: true,
                ready_timeout: Duration::from_secs(30),
                poll_every: Duration::from_millis(600),
            };
            let started = Instant::now();
            let report = open_and_bind(&service, &plan);
            for s in &report.stages {
                println!("{:<14} {:?}\t{}", s.id, s.state, s.detail);
            }
            println!("status: {:?} slide {:?}/{:?} — {}", report.status.state, report.status.target_slide, report.status.slide_count, report.status.message);
            println!("summary: {} ({} ms)", report.summary, started.elapsed().as_millis());
            Ok(())
        }
        Some("run") => {
            let id = args.next().ok_or("run needs a target id")?;
            let status = service.bind(&id)?;
            println!("bind: {:?} {} (slide {:?} of {:?})", status.state, status.message, status.target_slide, status.slide_count);
            for arg in args {
                let slide: u32 = arg.parse().map_err(|_| format!("not a slide number: {arg}"))?;
                let started = Instant::now();
                match service.goto(slide) {
                    Ok(r) => println!("goto {slide}: confirmed {} in {} ms ({:?})", r.confirmed_slide, started.elapsed().as_millis(), r.status.state),
                    Err(e) => println!("goto {slide}: FAILED {e}"),
                }
            }
            match service.test_navigation() {
                Ok(r) => println!("test_navigation: ok, back on slide {}", r.confirmed_slide),
                Err(e) => println!("test_navigation: FAILED {e}"),
            }
            let s = service.status(None)?;
            println!("final: {:?} slide {:?}", s.state, s.target_slide);
            Ok(())
        }
        Some("revalidate") => {
            let id = args.next().ok_or("revalidate needs a target id")?;
            let s = service.revalidate(&id, "saved presentation", nexq_lib::presentation::TargetKind::Powerpoint)?;
            println!("revalidate: {:?} — {}", s.state, s.message);
            Ok(())
        }
        _ => Err("usage: present_probe list | diagnose | run <target-id> <slide>... | open <file> [slides] | revalidate <target-id>".into()),
    }
}
