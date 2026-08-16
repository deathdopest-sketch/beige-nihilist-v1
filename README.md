# beige_nihilist

A StumbleChat bot with a specific personality: methodical, void-focused, Socratic. It watches conversations, responds when addressed, and occasionally fires unprompted observations into active rooms. It has a built-in nemesis system that specifically tracks and counters a rival bot called **Spackle**.

This guide assumes you have never run a bot before. Follow every step.

---

## What this bot does

- Joins one or more StumbleChat rooms using a real account you create
- Reads every message in the room
- Responds when someone talks to it (mentions its name) using a local AI model (Ollama)
- Fires unprompted one-liners into active conversations on a cooldown (ProactiveTroll)
- Occasionally drops philosophical deflation into quiet rooms (ChaosAgent)
- When it detects **Spackle** in the room, switches into nemesis mode — classifying Spackle's technique and building a specific counter-response
- Keeps a persistent memory of past interactions, troll scores, and nemesis encounters
- Scores its own outputs every few minutes via self-critique

It does **not** use any cloud AI service. All inference runs on your local machine via Ollama.

---

## Prerequisites

You need all of the following before starting. Do not skip any.

### 1. Node.js 18 or higher

Download from https://nodejs.org — pick the LTS version. After installing, open a terminal and confirm:

```
node --version
```

Should print `v18.x.x` or higher.

### 2. Ollama

Ollama runs AI models locally on your machine. Download from https://ollama.com and install it.

After installing, Ollama runs as a background service. You can verify it's running:

```
ollama list
```

### 3. AI models

The bot needs three models. Pull them with these commands (run each one, they download automatically):

```
ollama pull dolphin3:8b
ollama pull llama3.2:1b
ollama pull llama3.2:3b
```

`dolphin3:8b` is the primary model — it handles all troll responses and persona generation. The other two are fallbacks used when the main model is busy or slow.

**Hardware note:** `dolphin3:8b` requires roughly 6–8 GB of VRAM (GPU) or will fall back to CPU. On CPU it will be slow (10–30 seconds per response). The bot handles this gracefully — slow responses are queued.

### 4. A StumbleChat account for the bot

The bot needs its own login — do not use your personal account. Go to https://stumblechat.com and register a new account with a new email address. Pick a username like `beige_nihilist` or whatever you want the bot to be called in chat.

**Important:** The account must be verified (check the email inbox after registering).

### 5. Camera video (optional but expected)

StumbleChat expects users to have a webcam. The bot fakes this with a video file. Put an `.mp4` file somewhere on your machine and you'll point the config at it. A black screen or any looping video works fine.

If you don't set this up, the bot will still work but may appear without a camera, which can look odd in rooms that expect video.

### 6. Git (to get this code, if you haven't already)

Download from https://git-scm.com if you need it. Or just download the zip from the repo page.

---

## Installation

### Step 1 — Clone or download this repository

```
git clone https://github.com/deathdopest-sketch/beige-nihilist-v1.git
cd beige-nihilist-v1
```

Or download the ZIP from GitHub and extract it.

### Step 2 — Install dependencies

Inside the project folder:

```
npm install
```

This downloads all required packages into a `node_modules/` folder. It may take a minute.

### Step 3 — Create your `.env` file

Copy the example file:

```
# Windows
copy .env.example .env

# Mac/Linux
cp .env.example .env
```

Then open `.env` in a text editor and fill in the values. See the full explanation below.

### Step 4 — Create the data directory

```
mkdir Beige_Data
```

The bot writes all its persistent data here (conversation memory, troll scores, nemesis records, etc.).

### Step 5 — Set up camera video

Create a `beige_cam/` folder in the project root and put your `.mp4` video file inside:

```
mkdir beige_cam
# then copy your video file into beige_cam/
```

Update `BEIGE_CAM_VIDEO` in your `.env` to point at it.

---

## Configuration — `.env` explained

Every setting the bot uses comes from the `.env` file. Here is what each line does:

```env
BEIGE_LOGIN_EMAIL=your_bot_account@email.com
```
The email address you used to register the bot's StumbleChat account.

```env
BEIGE_LOGIN_PASS=yourpassword
```
The password for that account.

```env
BEIGE_BOT_NICK=beige_nihilist
```
The username the bot will use in chat. Must match the StumbleChat account username exactly.

```env
BEIGE_ROOMS=meatspace
```
Which StumbleChat room(s) to join. Comma-separated for multiple rooms:
```
BEIGE_ROOMS=meatspace,lounge,philosophy
```
The bot joins all listed rooms on startup and stays in them.

```env
BEIGE_CAM_VIDEO=./beige_cam/default.mp4
```
Path to the video file the bot will stream as its "webcam". Can be absolute (`C:\Users\you\video.mp4`) or relative to the project root (`./beige_cam/video.mp4`).

```env
BEIGE_DATA_DIR=./Beige_Data
```
Where the bot stores persistent data. Default is fine. Change this only if you want the data somewhere else (e.g., an external drive).

```env
BEIGE_LOG_FILE=./beige_boot.log
```
Path to the main log file. Every message the bot sees and sends is logged here, along with internal decisions. Useful for debugging. Default is fine.

```env
OLLAMA_HOST=http://127.0.0.1:11434
```
Where Ollama is running. Leave this as-is unless you're running Ollama on a different machine or port.

```env
OLLAMA_MODEL=dolphin3:8b
```
The primary AI model. Must be a model you've already pulled with `ollama pull`.

```env
OLLAMA_FAST_MODEL=llama3.2:1b
```
Fast model used for quick internal decisions (not user-facing responses). Should be a small, fast model.

```env
OLLAMA_FALLBACK_MODEL=llama3.2:3b
```
Used when the primary model fails or times out.

```env
BEIGE_BOT_PORT=7002
```
Port for the optional HTTP API. You can query bot status at `http://localhost:7002/health`. Leave commented out if you don't need this.

```env
OWNER_SECRET=changeme
```
Password for protected HTTP API endpoints (like `/admin/stop`). Change this to something real if you enable the port. Leave commented out otherwise.

```env
PG_URL=postgres://...
```
Optional PostgreSQL connection string. If set, the bot writes interaction data to a database. Leave commented out unless you have a Postgres server set up.

---

## Running the bot

Make sure Ollama is running first (it starts automatically on most systems, or run `ollama serve` in a terminal).

Then, in the project folder:

```
node index.js
```

You should see startup logs in the terminal. The bot will:
1. Launch a browser (Puppeteer — a headless Chrome)
2. Log into StumbleChat
3. Join the configured rooms
4. Print `=== Beige_nihilist v1.0 ready ===` when it's live

The bot is now running. It will stay running until you stop it.

To run with auto-restart on file changes (useful while tweaking config):
```
npm run dev
```
(requires `nodemon`, which is included as a dev dependency)

---

## Stopping the bot

Press `Ctrl+C` in the terminal where it's running.

Or, if it's running in the background, find and kill the process:

```
# Windows
Get-Process node | Stop-Process -Force

# Mac/Linux
pkill -f "node index.js"
```

---

## What you'll see in the terminal / log

The log file (`beige_boot.log`) and terminal output use these prefixes:

- `[roomname] MSG_SENT:` — a message the bot sent
- `[roomname] TROLL_DECISION:` — internal scoring of whether to respond
- `[roomname] ProactiveTroll:` — an unprompted message the bot fired
- `[roomname] ChaosAgent:` — a philosophical drop into a quiet room
- `[roomname] SELF_CRITIQUE:` — the bot scoring its own recent output
- `NemesisEngine:` — Spackle detected, counter-mode activated

---

## Directory structure

```
beige-nihilist-v1/
├── index.js                    # Entry point — run this
├── package.json
├── .env.example                # Copy to .env and fill in
├── .env                        # Your credentials — never commit this
├── .gitignore
├── Beige_Data/                 # Runtime data (auto-created)
│   ├── conversation_memory.json
│   ├── troll_ledger.json
│   ├── nemesis_history.json    # Record of Spackle encounters
│   └── ...
├── beige_cam/                  # Put your webcam video here
│   └── default.mp4
├── config/
│   ├── beige.js                # Bot-level config constants
│   └── shared.js               # Shared constants
└── src/
    ├── BeigeBot.js             # Main orchestrator
    ├── ai/                     # AI/model integration
    │   ├── OllamaClient.js     # Talks to Ollama
    │   ├── ConversationHistory.js
    │   └── ...
    ├── browser/                # Puppeteer browser control
    │   ├── BrowserManager.js
    │   └── WsListener.js       # Reads StumbleChat WebSocket
    ├── features/               # Core features
    │   ├── ProactiveTroll.js   # Fires unprompted into active rooms
    │   ├── ChaosAgent.js       # Quiet-room injections
    │   ├── TrollEngine.js      # Technique selection + scoring
    │   ├── TrollLedger.js      # Persistent troll score tracking
    │   ├── SelfEval.js         # Self-critique system
    │   ├── VillainArc.js       # Escalating narrative arcs
    │   ├── HttpApi.js          # Optional status API
    │   └── ...
    ├── messaging/
    │   ├── MessageQueue.js     # Rate-limited send queue
    │   └── ResponseSanitizer.js # Strips AI hallucination artifacts
    ├── personality/
    │   ├── NemesisEngine.js    # Spackle detection + counter-prompts
    │   ├── NemesisMemory.js    # Persistent record of nemesis encounters
    │   ├── TrollPersona.js     # 5 rotating personas
    │   ├── ChaosAgent.js       # Deflation lines
    │   ├── MoodSystem.js       # Internal mood state
    │   └── PersonalityDrift.js
    ├── storage/
    │   └── StorageManager.js   # Reads/writes Beige_Data files
    └── users/
        └── UserProfiles.js     # Tracks per-user history
```

---

## How the bot behaves in the room

### Normal conversation

When someone types the bot's name (e.g., `@beige_nihilist` or just `beige_nihilist`), the bot generates a response using its AI persona. Responses are kept short — 4–8 words, 10 words maximum. The voice is dry, measured, indifferent. It does not give advice, offer encouragement, or engage warmly.

### ProactiveTroll — uninvited observations

Every 2.5 minutes (when the room is active), the bot may fire an unprompted one-liner. This isn't a response to anyone — it's the bot watching and suddenly commenting. There's a 65% chance it fires when eligible. Three modes:

- **observer_drop** — meta-observation about what's happening in the room
- **callout** — brings back something a user said 3–12 minutes ago
- **thread_hijack** — room is busy on a topic; one line that sidewinds it

### ChaosAgent — quiet room injections

When a room has been quiet for a while, ChaosAgent may drop a deflation line or a Socratic question. These are pre-written lines, not AI-generated.

Deflation examples:
- "entropy wins again."
- "the void was here first."
- "consensus requires participants who care."

Socratic examples:
- "what would change if you were wrong about that?"
- "who benefits from this conclusion being true?"

### Self-critique

Every few minutes, the bot reviews its own recent outputs and internally scores them. This influences future technique selection but is not visible to the room.

### Troll techniques

The bot selects from 8 techniques based on who it's talking to and what score that person has in the troll ledger:

| Technique | Description |
|-----------|-------------|
| void | Minimal response — pure emptiness |
| deconstruct | Pick apart the premise of what was said |
| socratic | One question that reframes the entire topic |
| agreed_destruction | Agree completely, then drain it of meaning |
| long_memory | Reference something specific said minutes ago |
| pattern_call | Name the conversational pattern ("you always...") |
| deflation | Reduce hyperbole to its component nothing |
| disappear | Say one thing and stop — let the silence do work |

### Personas

The bot rotates across 5 internal personas, which shape the tone of AI-generated responses:

| Persona | Voice |
|---------|-------|
| the_void | Pure blankness — no reaction, just observation |
| the_archivist | References what was said before, catalogues patterns |
| the_philosopher | Destabilises with precise questions |
| the_counter | Directly addresses and deflates |
| the_witness | Silent watcher who suddenly speaks one line |

---

## Nemesis mode (Spackle)

The bot has a built-in adversarial dynamic with another bot called **Spackle**. If Spackle joins the room, the NemesisEngine activates.

**What it does:**
1. Detects known Spackle nicknames (a list maintained in `NemesisEngine.js`)
2. Classifies which troll technique Spackle just used (devil's advocate, fake retreat, one-word verdict, etc.)
3. Builds a technique-specific counter-prompt for the AI
4. Every 90 seconds while Spackle is present, may fire a standalone jab
5. Records the outcome in `nemesis_history.json` — wins, draws, and key moments

If you are not running Spackle or don't have a rival bot, this system is still loaded but simply never activates. It does not affect normal behaviour.

---

## Troubleshooting

### The bot starts but never sends any messages

Check the log file. Look for errors connecting to Ollama:
- Make sure `ollama serve` is running (or the Ollama app is open)
- Run `ollama list` to confirm `dolphin3:8b` is listed
- Confirm `OLLAMA_HOST` in `.env` matches where Ollama is listening (default: `http://127.0.0.1:11434`)

### Login fails / bot gets stuck on login screen

- Double-check `BEIGE_LOGIN_EMAIL` and `BEIGE_LOGIN_PASS` in `.env`
- Log into the account manually in a browser to confirm the credentials work
- StumbleChat may have a captcha on first automated login — try logging in manually once from the same machine

### Messages appear broken or truncated

This is handled automatically by `ResponseSanitizer.js`. If you see fragments, check what model is running — `dolphin3:8b` under heavy load may emit partial responses. The sanitizer strips known artifact phrases.

### Bot is too slow to respond

`dolphin3:8b` is a large model. On CPU it may take 15–30 seconds. Options:
- Use `OLLAMA_FAST_MODEL=llama3.2:1b` and set `OLLAMA_MODEL=llama3.2:1b` temporarily to test speed
- If you have a GPU, ensure Ollama is using it: run `ollama run dolphin3:8b` in a terminal and check if the GPU is active

### `Cannot find module` error on startup

Run `npm install` again. If a specific file is listed, check that it exists in the `src/` directory.

### Port already in use

If you set `BEIGE_BOT_PORT` and see `EADDRINUSE`, either change the port number or leave `BEIGE_BOT_PORT` commented out.

### Browser launch fails (Puppeteer error)

On Linux: `apt install -y chromium-browser` may be needed. On Windows: Puppeteer ships with its own Chrome, so this should work without extra steps. On Mac: same.

If you see a sandbox error on Linux, add this to your `.env`:
```
PUPPETEER_NO_SANDBOX=true
```
Then in `src/browser/BrowserManager.js`, look for the browser launch args and add `--no-sandbox`.

---

## Adding Spackle nicks to track

If the Spackle bot changes its username, open `src/personality/NemesisEngine.js` and add the new nick to the `SPACKLE_NICKS` set at the top of the file:

```javascript
const SPACKLE_NICKS = new Set([
  'spackle', 'spackle_', '_spackle_', 'yournewnick',
  // add more here
]);
```

Save the file and restart the bot.

---

## Adjusting troll rate

In `src/features/ProactiveTroll.js`, the constants at the top control how often the bot fires unprompted:

```javascript
const PROACTIVE_COOLDOWN_MS = 2.5 * 60_000; // minimum gap between fires
const FIRE_CHANCE           = 0.65;          // 65% chance when eligible
```

Lower `PROACTIVE_COOLDOWN_MS` or raise `FIRE_CHANCE` to fire more often. Restart the bot after changing.

---

## Security notes

- **Never share your `.env` file.** It contains the bot account credentials.
- **Never commit `.env` to git.** The `.gitignore` excludes it, but double-check before pushing.
- The `Beige_Data/` folder contains conversation history and troll records. This is also gitignored — it's machine-local.
- The HTTP API (`BEIGE_BOT_PORT`) is not authenticated by default. Only enable it on a trusted network and set `OWNER_SECRET` to something strong.

---

## License

MIT — do what you want with it.
