# Meeting detection

When a call starts in Zoom, Microsoft Teams, Google Meet or Webex, NexQ shows a small prompt at the top of your screen. Click **Start NexQ** to begin transcribing and get the AI copilot. The meeting is named after the call, so you can find it later.

## How it works

NexQ checks which app is using your microphone every 3 seconds (you can change this from every second to every 10 seconds). Each check takes a few milliseconds. When a call app holds the microphone for a few seconds, NexQ treats that as a meeting. **It never listens to audio before you click Start**: it only reads which process has the microphone open, and the titles of that app's windows.

- **Desktop apps.** Zoom, Teams and Webex count as soon as they use the microphone.
- **Browsers.** A browser that uses the microphone counts only when its active tab is a meeting (Google Meet, Teams, Zoom or Webex on the web, plus Jitsi Meet and Whereby). Browsers use the microphone for other things too, such as voice typing and recorders. Once a browser call is recognised it stays the same call while that browser keeps the microphone, even if you switch to another tab (for example your slides). NexQ reads only the window title: no cookies, no browser debugging port, no accounts.
- **One prompt per call.** If you dismiss the prompt, it won't come back for the same call. A call counts as ended about 10 seconds after the app releases the microphone, and the prompt closes then.
- **Never while recording.** No prompt appears while a NexQ meeting is already running.
- **Nothing starts by itself.** Detection never starts audio capture, recording, screen sharing or the external meeting. Only the buttons on the prompt do.

## Recent meetings and Presentation + Q&A

Under the card, **Recent meetings** lists your saved meetings, most recently used first (with their type, presentation and last-used date). Pick one and press **Start NexQ**: it starts with that meeting's documents, notes, AI provider, presentation settings and history. A meeting that cannot start yet (for example no AI provider chosen) opens its setup with the reason instead.

**Presentation + Q&A** is the explicit presentation action: it lists your Presentation + Q&A meetings, preselects the latest, and starts exactly the one you confirm. With none saved, **New Presentation + Q&A for “<call name>”** prepares one named after the call (an existing meeting of the same name is reused, never duplicated) and opens its setup so you can import your deck; it does not start by itself.

If the meeting has a presentation, NexQ then opens it and binds to it — see [Presenting → Opening your presentation automatically](meeting-profiles.md#opening-your-presentation-automatically).

## The meeting name

The prompt fills in the call's title when the app shows one:

| App | Title source |
|---|---|
| Microsoft Teams | The meeting window's title (`Weekly sync \| Microsoft Teams` gives "Weekly sync") |
| Google Meet | The tab title when Meet shows the calendar event's name. A bare meeting code (`abc-defg-hij`) means no title. |
| Zoom | Zoom's meeting window is usually titled just "Zoom Meeting", so the name is often blank. |
| Webex | The meeting window's title, when it has one |

Click the name in the prompt to type your own. NexQ puts it in front of the usual name, for example `Weekly sync — Meeting 2026-10-23 15:02`. With no title, the app's name is used: `Zoom — Meeting 2026-10-23 15:02`.

The chevron next to **Start NexQ** picks the meeting type (Team Meeting, Interview, Lecture…) for this call.

## Settings

**Settings → General → Detect meetings** has these options:

- **On/off.** Detection is on by default.
- **Apps.** Zoom, Microsoft Teams, Google Meet, Webex, Jitsi Meet (browser), Whereby (browser), Slack huddles and Discord. Slack and Discord are off by default.
- **Start as.** The meeting type a prompt starts with.
- **Check for calls.** How often NexQ checks: every 1, 2, 3 (default), 5 or 10 seconds.
- **Hide the prompt after.** 30 seconds, 1 minute, 2 minutes, or until the call ends. The timer pauses while your mouse is over the prompt.

Keyboard: **Enter** starts the meeting and **Esc** dismisses the prompt. When [stealth mode](../../README.md#whats-new) is on, the prompt is hidden from screen sharing too.

> Meeting detection is available on Windows. macOS support is planned.

Please always let the other participants know that the meeting is being transcribed.
