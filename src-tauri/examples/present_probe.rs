//! Live check of the PowerPoint integration, without the app.
//!
//! ```text
//! cargo run --example present_probe -- list
//! cargo run --example present_probe -- run "pp:C:\talks\deck.pptx" 2 3 1
//! ```
//! `run` binds to exactly that target, moves to each slide in turn (printing the
//! slide PowerPoint confirms and the call time), then runs the navigation test.
//! It never starts PowerPoint and never touches a window other than the target.

use std::time::Instant;

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
                    "{}\t{:?}\t{}\tcontrol={}\tshow={}\tslides={:?}\tcurrent={:?}",
                    t.id, t.kind, t.title, t.supports_control, t.slideshow_running, t.slide_count, t.current_slide
                );
            }
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
        _ => Err("usage: present_probe list | present_probe run <target-id> <slide>...".into()),
    }
}
