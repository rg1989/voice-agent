# WebUI

The WebUI is the browser conversation client. The Gateway serves it as static
pages on its own origin — no separate frontend service to deploy.

## Opening

With the Gateway running, open the WebUI in another terminal:

```bash
qwenaudio webui
```

This prints the page URL (default `http://127.0.0.1:3101`) and opens it in your
default browser. The browser asks for microphone permission on first use; allow
it to enable voice.

Options:

| Option | Meaning |
| --- | --- |
| `--url URL` | Connect to a Gateway at another address (default `http://127.0.0.1:3101`) |
| `--session ID` | Resume a specific voice session |
| `--no-open` | Print the URL only, without opening a browser |

## What you can do

- **Full-duplex voice** — speak and interrupt naturally, with live transcripts.
- **Text and attachments** — type messages or add images and files. Ordinary attachments can be handled by the backend; the voice model need not understand images directly.
- **Task view** — follow background tasks dispatched to the backend agent,
  including progress and final results.

See [Conversation & Attachments](../guides/conversation.md) for the difference between ordinary files and realtime visual capture.
The top “Knowledge Library” button [imports host documents](../guides/knowledge.md), not chat attachments.

## Header controls

The browser WebUI has three header controls that the desktop conversation window does not show.

### Folder switcher

The folder chip shows the name of the folder that the backend agent works in. The tooltip shows the full path. If no folder is set, the chip shows **Default scratch folder**.

Click the chip to open the folder browser:

- To open a folder, type its path and select **Go**, or click a subfolder. `~` is your home folder.
- To open the parent folder, select **← Up one level**.
- To use the open folder, select **Work here**.

The Gateway lists the folders of the machine that it runs on. The folder browser does not show folders whose names start with `.`, and it shows at most 500 subfolders. A new folder restarts the Gateway (see [Settings panel](#settings-panel)). The page reloads when the Gateway is back.

The folder switcher works only on the computer that runs the Gateway. It does not work on a paired phone or other remote device.

### Session history

Select the clock icon (**Session history**) to open the list of your sessions. The list comes from the Gateway Session Journal. It shows only sessions that have at least one message, with the newest session first. Each row shows the first thing that you said, the time of the last message and the number of messages. The session on screen has the label **current**.

- To switch to a session, select its row.
- To delete a session, select the trash icon, then select **Delete**. The Gateway deletes the journal of the session from the disk. You cannot undo the deletion.
- If you delete the session on screen, the WebUI starts a new session.

Press Esc or click outside the list to close it.

### Spend readout

The spend readout shows the estimated cost of the voice model for today, in US dollars. It also shows the estimated percentage of free quota that is left. The tooltip shows the details:

| Tooltip line | Meaning |
| --- | --- |
| **This session: … tokens, about …** | Tokens since the Gateway started. The count starts again at 0 when the Gateway restarts. |
| **Today: … tokens, about …** | Tokens and cost for the current date in UTC. |
| **About … of free quota left** | The free quota of 1,000,000 tokens for each model, minus the tokens that the Gateway counted for that model. |

The voice provider reports the token use at the end of each response. The Gateway prices the tokens with a built-in price table for the configured model. The table has separate prices for text and audio, for input and output. The Gateway keeps up to 90 days of counts in `usage.json` in its state directory. Voice previews count too.

All numbers are estimates, not your bill. The price table comes with the app, and the Gateway sees only its own use. The provider has no API for the free quota balance. The readout shows **quota spent** only after the provider refuses a request because the free quota is used up. If the price table has no entry for the model, the readout is hidden. The readout refreshes every 10 seconds.

## Settings panel

Select the gear icon (**Settings**) to open the panel. The Gateway saves most settings in `config.env` in the configuration directory (`~/.config/qwaudio/` by default). Persona text goes into separate files.

Some changes apply at once. The other changes restart the Gateway, which interrupts any task in progress:

| Applies at once | Restarts the Gateway |
| --- | --- |
| Voice, Robotic voice, Persona, Listening, Media | Brain, Computer control, Working folder, Turn taking, Privacy |

During a restart, the panel shows a notice. The page reloads when the Gateway is back. If the Gateway is not back after 45 seconds, the panel shows **Restart timed out. Please refresh the page.**

On a paired phone or other remote device, you can change Voice, Robotic voice, Persona and Listening. The other settings, including Media, and the folder browser work only on the computer that runs the Gateway.

### Brain

Select the agent that does the work. Each agent uses its own model and login.

| Option | Details |
| --- | --- |
| **Claude Code** | Uses your existing `~/.claude` login. |
| **Codex** | Uses your existing Codex login. |
| **Oh My Pi** | Uses the provider and model that you set in Oh My Pi (`~/.omp`), for example a Z.AI coding plan subscription. |
| **No agent** | Voice conversation only. |

The panel shows **Oh My Pi** only when the Gateway finds the `omp` command. The Gateway looks at `OMP_BIN`, `~/.bun/bin/omp`, `/usr/local/bin/omp` and `/opt/homebrew/bin/omp`, in this order.

### Persona

Each voice has its own character. The voice model and the brain both speak as the character of the selected voice. The text box shows the character of the selected voice.

- Each character is a file, `personas/<Voice>.md`, in the configuration directory.
- The default characters come from `config/frontend-agent/personas/` in the repository. A default file is copied only when the file is missing, so your edits stay after an update.
- **Save persona** writes the file. The text cannot be empty, and it can have at most 4000 characters.
- The change applies from the next reply. The Gateway sends the new instructions to open voice sessions.
- If a frontend profile or `QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH` sets an assistant profile, the text box edits that file for all voices.
- A voice without a character file uses `ASSISTANT.md` in the configuration directory until you save.
- If you select another voice, the panel discards the unsaved text in the box.

### Listening

- **Always listening** (default): everything that the microphone hears goes to the voice model.
- **Wake word**: nothing goes to the voice model until the Gateway hears the wake word.

When **Wake word** is selected, the panel also shows these settings:

- The wake word: **Hey Jarvis** (the default, marked **Recommended**), **Hey Lisa**, **Hey Megan**, **Hey Mycroft** or **GLaDOS**.
- **Keep listening after a reply**: 0 to 10 seconds, in steps of 1 second. The default is 5 seconds.

For details, see [Wake word listening](#wake-word-listening).

### Media

These settings control the browser that plays YouTube and YouTube Music when you ask by voice. The changes apply at once, without a restart.

Select the player browser:

| Option | Details |
| --- | --- |
| **Automatic** (default) | Uses the first installed browser. On macOS the order is Google Chrome, Microsoft Edge, Brave, Chromium. On Linux the order is Chromium, Google Chrome, Brave, Microsoft Edge. |
| **Google Chrome**, **Microsoft Edge**, **Chromium**, **Brave** | Uses this browser. A browser that is not installed shows **Not installed**, and you cannot select it. |

If the Gateway finds no supported browser, the panel shows **No supported browser found. Install Google Chrome, Microsoft Edge, Brave or Chromium.**

The player keeps its own profile, `player/<browser>/` in the configuration directory. It does not use the profile of your everyday browser.

- **Set up player** opens YouTube in the player, in a normal window. Sign in to your account one time. Later playback uses that sign-in. If the player does not open, the panel shows **The player did not open**.
- **Pause while we talk** is on by default. The player pauses when you start to speak, and it plays again after the assistant answers.
- **Return to the assistant when playback stops** is off by default. When it is on and playback stops, for example because you stop it or close the player, a client that can show the conversation brings its conversation window forward. The desktop app is such a client.

### Computer control

This setting controls whether the agent can see your screen and use your mouse and keyboard, and when it must ask you first:

| Option | Behavior |
| --- | --- |
| **Ask once per task** (default) | Asks the first time a task needs your computer. The task then keeps the permission until it ends. |
| **Ask every time** | Asks before every screenshot, click and keystroke. |
| **Never ask** | Uses your screen, mouse and keyboard without a question. Use this option only if you trust every task. |
| **Off** | The agent cannot see your screen or use your mouse and keyboard. |

When the agent asks, the WebUI shows **Allow** and **Deny** for the request. **Allow** gives the scope of the setting: the rest of the task, or one step. Computer control has no **Always allow** button.

### Working folder

**Choose folder** opens the same folder browser as the header. Select **Use this folder** to save the folder. For details, see [Folder switcher](#folder-switcher).

### Voice

Select a voice to use it. The list has Jennifer, Aiden, Ryan, Mione, Tina, Andre, Cindy, Lenn and Siiri. The new voice applies at once, without a restart:

- If a voice session is open, the current reply stops. The session reconnects with the new voice, and the conversation stays.
- The persona changes to the character of the new voice.

To hear a sample line, select **▶** next to a voice. A separate short voice session speaks the sample, so nothing goes into the conversation. The spend readout counts the sample.

**Robotic voice** adds a slight pitch lift, a short metallic echo and a slow sweep to the reply audio. The Gateway applies the filter, and voice previews use it too. The change applies at once.

### Turn taking

| Slider | Range | Effect |
| --- | --- | --- |
| **Pause before it replies** | 0.2 to 6 seconds, in steps of 0.1 second | The silence after which the assistant takes your turn as finished. A higher value lets you pause to think. The voice service supports at most 6 seconds. |
| **Microphone sensitivity** | 0 to 1, in steps of 0.05 | A higher value makes echo and room noise less likely to interrupt the assistant. |

The panel saves a slider value when you release the slider. Each save restarts the Gateway. If `config.env` has no value, the voice model uses its own default, and the sliders show 0.8 seconds and 0.50.

### Privacy

**Let the voice model search the web itself** is off by default. When it is off, lookups go to the agent, which reads the sources and cross-checks them. When it is on, the voice model gets its own `web_search` and `fetch_url` tools. This is faster but shallower, and your search terms go to the search provider.

**Send only a one-line summary to the voice model** is off by default. When it is off, the Gateway sends the full reply of the agent to the voice provider, so that the voice model can read it out. When it is on, the Gateway sends only the `VOICE:` line that the agent wrote, and it shortens a line that is longer than 900 characters. If the agent wrote no `VOICE:` line, the Gateway sends only `Done. The full result is on screen.` The full result still shows on screen. Reminders and permission prompts do not change.

## Wake word listening

Only the browser WebUI uses the wake word gate. Other clients, such as the desktop app and the TUI, ignore the **Listening** setting. They keep listening, and stop phrases have no effect on them.

### How a wake works

In wake word mode, the microphone audio goes only to a wake word detector in the Gateway. Nothing goes to the voice model, so the provider does not bill it. The header status shows **Waiting for wake word**. The hint under the orb shows **Say “Hey Jarvis”**, with the selected wake word.

When the detector hears the wake word, these steps occur:

1. The WebUI plays the wake chime.
2. The Gateway sends the last 1.5 seconds of audio, and all audio after it, to the voice model.
3. The Gateway checks the first transcript. If the transcript does not contain the wake word, the Gateway cancels the turn before you hear a reply. It removes the turn from the conversation and waits for the wake word again.
4. If you say only the wake word, the assistant does not reply. It waits for your request.

If you say nothing after the wake word, the Gateway waits for the wake word again. The wait is 6 seconds, or the **Keep listening after a reply** time plus 3 seconds if that is longer.

The first time the gate waits for a wake word, the Gateway downloads the detector models for that wake word from GitHub into its cache directory. The Gateway downloads each file only once. It keeps a file only if its checksum matches a pinned value. If the detector cannot start, the WebUI shows `Wake word detection is unavailable`. The Gateway tries again after 30 seconds.

### After a reply

When the assistant finishes speaking, the follow-up window starts. The WebUI shows **Still listening… keep talking** and a bar that gets shorter. If you speak before the bar ends, you do not need the wake word. When the window ends, the Gateway waits for the wake word again. If **Keep listening after a reply** is 0 seconds, the Gateway waits for the wake word as soon as the reply ends.

The assistant can also speak on its own while the Gateway waits for the wake word, for example to report a task result or to ask a question. You can then answer without the wake word. The same follow-up window starts when the assistant finishes.

- The window starts when the reply audio ends, not when the voice model finishes the reply.
- Your speech or a new reply hides the bar. The window starts again after the next reply.
- The Gateway waits 0.5 seconds more after the bar ends, so it does not cut off speech that starts at the last moment.
- Input that the voice model ignores, such as noise or speech to other people, does not make the window longer.
- In wake word mode, muting the microphone ends the window.

### Barge-in

While the assistant replies, you can talk over it. Your speech stops the reply, and the assistant answers your new request. You do not need the wake word for this. The follow-up window starts after the new reply ends.

A bare "stop" only interrupts the reply. It does not stop listening.

### Stop phrases

To make the assistant wait for the wake word again, say one of these phrases:

| Phrase | Listening mode |
| --- | --- |
| "stop listening", "stop listening now", "go to sleep", "that's all", "停止监听", "别听了" | Both modes |
| "never mind", "nevermind", "不用了" | **Wake word** only |

- The phrase must be all that you say. It can start with the wake word, for example "Hey Jarvis, stop listening".
- The assistant does not reply to a stop phrase. It also cancels a reply that is on its way.
- A stop phrase also works in **Always listening** mode. The Gateway then waits for the wake word. After a confirmed wake, it listens always again.
- If you ask it to stop listening in other words, the voice model can call its `stop_listening` tool. The result is the same.
- In **Always listening** mode, "never mind" does not stop listening.

### Wake chime

The wake chime is a short rising two-tone sound, E5 then B5, that lasts 0.25 seconds. The WebUI plays it once for each wake by the wake word. It does not play when a follow-up window opens or when the assistant speaks on its own. The microphone keeps sending audio while the chime plays, so you can speak right after the wake word. Stopping playback does not cut the chime.

## Relationship to other clients

The TUI, WebUI, and desktop orb all use the same Gateway Client Protocol. A
Gateway accepts **one active Client connection per user**; another client can take over after confirmation, disconnecting the previous one. The desktop app can also run its own
Gateway process while sharing user configuration with the CLI. The same WebUI
page powers the desktop conversation window, so presentation behavior stays
consistent across surfaces.
The header controls, the Settings panel and wake word listening are only in the browser WebUI.

> Exposing the WebUI beyond your own machine crosses a trust boundary: put an
> HTTPS reverse proxy with authentication in front and follow
> [Remote Access Security](../configuration/advanced.md#remote-access-security).
