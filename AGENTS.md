# Agent instructions for NexQ

Standing rules for every coding agent (GitHub Copilot, Claude, Codex, …) working in this repository.
The human contributor workflow is in [CONTRIBUTING.md](CONTRIBUTING.md); build details are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Design context is in [.impeccable.md](.impeccable.md).

## A. Ownership

- Take responsibility from investigation to **verified delivery**. A plan, a code edit or a green unit test is not delivery.
- **Reproduce a real failure before claiming a fix**, with the real artifact (the Windows executable, not a browser preview), and show the failure is gone afterwards.
- Continue independently through implementation, integration, testing and safe Git operations. Report genuine blockers (missing permission, unavailable hardware, a decision only the owner can make); do not hand ordinary engineering work back to the user.
- Keep outcomes distinct in every report: **VERIFIED**, **REPORTED** (claimed by a tool or person, not checked), **BLOCKED**, **FAILED**, **NOT VERIFIED**.
- Preserve user data and unrelated or uncommitted work. Never use a user's real data for tests without a backup and a restore.

## B. Subagents

- Discover the specialist subagents and tools that are available, and delegate independent work where it saves time (for example: startup/packaging, window lifecycle, installation/shortcuts, frontend UX acceptance, independent test/security review).
- Keep **one accountable primary agent**. It coordinates, prevents conflicting edits (give each subagent a disjoint set of files), reviews every subagent change, integrates, runs the final end-to-end tests and owns Git and the delivery report. A subagent's report is a claim until the primary agent has checked it.
- Builds are slow and share one Cargo target directory: serialise native builds, and never let a helper overwrite the executable that is being tested or installed.
- For frontend work use the PULSAR Frontend UX skill when it is installed, for its transferable principles only (loading and error states, accessibility, real screenshots of the running app). Do not import PULSAR-specific queues, routes or assumptions.

## C. Git and pull requests

Manage Git proactively for every task:

1. Inspect `git status`, branches, remotes, recent commits and open PRs first.
2. Fetch the relevant remote state; if the PR you were continuing has been merged, branch from the updated `main`.
3. Preserve uncommitted and unrelated work. Use an existing feature branch when it fits; create a new one only when warranted (`fix/…`, `feat/…`).
4. Make focused commits (Conventional Commits). Mixed files are split with whole-file variants, not zero-context patch hunks (they misplace insertions).
5. Run the checks below before pushing; push to the authorised repository `mhe931/NexQ`.
6. Create or update the correct pull request using the repository template (`.github/PULL_REQUEST_TEMPLATE.md`), with exact commands and results.
7. Inspect CI and fix failures caused by your change; say plainly which failures are pre-existing.
8. Review the final diff and the PR status; report branch, commit hashes and PR URL.

Rules:

- **`gh` defaults to the upstream repository (`naxhq/NexQ`).** Always pass `--repo mhe931/NexQ` when addressing the owner's PRs (`gh pr view 2 --repo mhe931/NexQ`). Inspect an existing PR before deciding whether to continue it or open another; do not duplicate its work.
- Pushing may need the GitHub CLI as credential helper: `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push …`.
- Never force-push, discard unrelated work, delete branches or merge without explicit authorisation.
- A clean Git tree is not evidence that the application works.

## D. Definition of done

A task is complete only when all of these hold, or the gap is named explicitly:

- The requested behaviour works, shown on the real artifact. For the desktop app that means the native Windows build launched the way a user launches it (desktop shortcut), not `npm run dev` or a Vite preview.
- Relevant tests pass: `npx tsc --noEmit`; `npx vitest run --maxWorkers=3`; `cargo test --lib --release --target x86_64-pc-windows-gnu --locked` in `src-tauri/` (after `. .\scripts\native-env.ps1`); `node scripts/secret-scan.mjs`.
- Regressions were looked for and investigated.
- The changes are committed and pushed, the PR is created or updated, and its checks were reviewed.
- Unresolved acceptance gaps are listed.

## Project facts that have bitten before

- **Build the app with `npx tauri build`**, never with plain `cargo build` / `cargo test --test …` for anything a person will run. A `nexq.exe` without Tauri's `custom-protocol` feature has no bundled UI and loads `http://localhost:5173`, which shows "localhost refused to connect" without a Vite server. Cargo commands that build the bin target (`--test`, `cargo build`) overwrite `src-tauri\target\…\release\nexq.exe` with exactly such a binary. `nexq.exe --self-test` exits 0 for a bundled build and 3 for a developer build.
- Run NexQ from the per-user install (`scripts\install-user.ps1`, shortcut **NexQ** on the Desktop), never from `src-tauri\target` or a temporary folder.
- Closing the main window exits NexQ; stop NexQ-owned processes only by exact executable path or PID, never by name, and never touch PowerPoint, Zoom, Teams or browsers.
- The Windows Desktop folder may be redirected (OneDrive): resolve it with `[Environment]::GetFolderPath('Desktop')`.
- When a Tauri window is automated for tests, back up `%APPDATA%\com.nexq.app` first and restore it afterwards.
