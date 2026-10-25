# pi-discord-comms

Discord as a second channel for a running [Pi](https://pi.dev) session. It pings you when a run finishes, shows you what it said, and lets you answer approval prompts—or send the agent a new instruction—from your phone. The terminal stays the primary interface; Discord is the remote control.

**Zero runtime dependencies.** Node ≥ 22 built-in `WebSocket` and `fetch`, with a hand-written Discord Gateway client. No `discord.js`, no database, no public URL, no ngrok, no telemetry.

## What you get

| Direction | Behaviour |
|---|---|
| **Outbound** | `✅ Done — waiting for input` with the last assistant message when a run settles; `⚠️ Run stopped` on abort; `⏸ Pi is waiting at a confirm` when the agent blocks on a terminal prompt |
| **Approvals** | Risky `bash`/`write`/`edit` calls post an embed with **Allow once · Always · Deny · Detail**, and block the tool until you answer. Your terminal dialog and the Discord buttons race; the first answer wins and the other surface is dismissed |
| **Inbound** | Plain text in the channel becomes a user message to the agent (queued as a follow-up while it streams, `steer` if configured). `!stop` aborts the current run, `!status` reports connection and policy state. Bot reacts 👀 so you can see it landed |

## Setup

### Discord (one time, ~5 minutes)

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** → name it `pi`.
2. **Bot** → **Reset Token** → copy it immediately. Discord shows it once and then never again; if you miss it you must reset again. Leave **Public Bot** off.
3. **Bot → Privileged Gateway Intents → enable Message Content Intent.** Needed to read messages you type in a server channel. Free for bots in fewer than 100 servers, no review, applies on the next gateway connect.
4. **OAuth2 → URL Generator** → scope `bot`; permissions `View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files` → open the generated URL → authorize on your server.
5. Enable Developer Mode (Settings → Advanced) and copy your **channel ID** (right-click a channel) and **user ID** (right-click your name).

Slash commands are deliberately not used: everything is embeds, buttons, and plain text, so there is no command sync step.

### Pi

```bash
pi install git:github.com/jaaamesk/pi-discord-comms
```

Or for development, add the repo path to `packages` in `~/.pi/agent/settings.json` and restart Pi.

Create `~/.pi/agent/discord-comms.json` and `chmod 600` it:

```json
{
  "token": "your bot token",
  "userId": "1723...",
  "channelId": "1723..."
}
```

Verify without starting Pi:

```bash
npm run doctor
```

That checks the token, that the bot can see the channel, that the bot is actually in the guild, that your user ID resolves, and then posts a real embed. It never prints the token, so its output is safe to paste into a bug report.

## Configuration

| Key | Meaning | Default |
|---|---|---|
| `token` | Bot token (**required**) | — |
| `userId` | Your Discord user ID — the only author the extension listens to (**required**) | — |
| `channelId` | Channel to talk in, or `"dm"` to open a DM instead (**required**) | — |
| `approvals` | `off` · `dangerous` (pattern policy) · `all` (every tool call) | `dangerous` |
| `raceTerminal` | Show the terminal dialog and Discord buttons at once; first answer wins | `true` |
| `approvalTimeoutMs` | Auto-deny after this long with no answer | `300000` |
| `deliverAs` | How inbound text is queued while a run is streaming: `followUp` or `steer` | `followUp` |
| `level` | `quiet` (approvals only) · `milestones` (+ done/blocked pings) · `verbose` (+ run started) | `milestones` |

Environment overrides: `PI_DISCORD_TOKEN`, `PI_DISCORD_USER_ID`, `PI_DISCORD_CHANNEL_ID`, `PI_DISCORD_LEVEL`.

## Commands

**In the terminal:** `/discord status` · `/discord test` · `/discord connect` · `/discord disconnect` · `/discord level quiet|milestones|verbose` · `/discord risk <command>` (dry-run the approval policy on a command without executing it).

The footer shows `● discord · #<channel> · <4-char session tag> · connected`, or `○ discord · <why it is dormant>`.

`/discord status` also prints what a diagnosis needs: how many button clicks arrived, how many resolved a blocked call, how many answered a question, how many were stale or refused, whether the prompt bridge is live or the mirror is all there is, and the last problem it hit. Anything Discord refuses (a rejected ack, a failed embed, a reply it could not send) is reported in the terminal the moment it happens instead of being swallowed.

**In Discord:** type anything to talk to the agent, `!stop` to abort the current run, `!status` for a state dump. Buttons carry a `pi:<action>:<tag>:<id>` id for approvals and an `ask:<tag>:<id>:<choice>` id for questions, so a click resolves exactly the thing it came from and can never answer another Pi session's request.

## Answering a question from Discord

When the agent asks you something with `ask_user`, the question arrives as an embed with a button per option and the way to answer printed underneath. This needs the forked `pi-ask-user` (upstream publishes the question but nothing that would answer it); with the published package you still get the question, mirrored read-only, and the embed says so.

| You type | It means |
|---|---|
| `2` | option 2 of the question being asked |
| `2 Ship it` | option 2 of question 2, when more than one question is waiting |
| `Ship it` | the option whose title matches exactly, case-insensitively |
| any other text | a freeform answer, for a question that takes one |
| `1,3` then `Send` | a multi-select answer: tap the options, or name the numbers |
| `Send` | submit the review step at the end of a multi-question call |
| `!back 2` | go back and re-answer question 2 before sending |
| `!cancel` | cancel, exactly as Escape does in the terminal |
| `!skip` | no answer, where the question can be skipped |
| `!chat <text>` | talk to the agent instead of answering — this is the way out |

First answer wins, as with approvals: answer at the desk and the embed rewrites itself to say so, and an embed whose question was answered, cancelled or timed out elsewhere is greyed out rather than left looking clickable.

## Approval policy

`approvals: "dangerous"` gates:

- **shell** (`bash`, `powershell`): force/recursive `rm`, `sudo`/`doas`, world-writable `chmod`/`chown`, `dd of=/dev/…`, `mkfs`/`shutdown`/`reboot`, `git push --force`, `git reset --hard` / `clean -f`, `curl … | sh`, `npm|pnpm|yarn|bun publish`, `kubectl delete` / `docker rm`, `DROP TABLE` / `TRUNCATE` / `DELETE FROM` without `WHERE`, fork bombs
- **`write` / `edit`**: any path outside the project directory, and sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`, `.ssh/`, `.aws/`, `credentials.*`)
- **third-party/MCP tools** that declare `destructiveHint`. Pi's own tools declare no annotations, so they are judged by the rules above instead

Anything allowed runs silently. A denial returns a reason the model can read, e.g. `bash blocked: denied by the user via discord (force/recursive delete)`. Choosing **Always** turns gating off for the rest of that session and says so in the terminal. If neither surface can answer — no live gateway and no terminal dialog — the call blocks immediately with the reason instead of waiting out the timeout.

## How it works

`session_start` claims `~/.pi/agent/discord-comms.lock` and opens one gateway connection. Discord permits a single live gateway session per token per shard, so a second Pi process — another terminal, another project, a spawned subagent — stays dormant and names the current owner instead of fighting for it. Locks left by dead processes are reclaimed; a lock held by a live process of another user still counts as live.

The gateway client identifies with `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT` (33281), heartbeats at Discord's advertised interval, treats a missing ACK as a zombie session and reconnects, resumes with `session_id` + `seq` after a drop, and stops retrying on codes it cannot fix (`4004` auth, `4013`/`4014` intents). REST calls are serialised, retry once on `429`, refuse to sit out a rate limit longer than 15 s, and each attempt is capped at 15 s so a hung request cannot stall the queue a blocked approval is waiting on.

A click is an `INTERACTION_CREATE` of type `MESSAGE_COMPONENT` (**3** — type 2 is a slash command, so comparing against 2 answers nothing and Discord reports `This interaction failed` on the user's side). The router answers within the 3 s window with callback type 6 (`DEFERRED_UPDATE_MESSAGE`, which shows no loading state) and then edits the embed to the outcome with disabled buttons; `Detail` and refusals come back as followups, ephemeral in a guild channel and plain in a DM, where flag 64 is rejected.

Every embed footer carries a random four-character session tag, so parallel Pi work stays attributable in a single channel.

## Security

Read this before pointing it at a shared server.

- **The bot token is a password.** Anyone holding it can post as the bot and read anything the bot can see. Keep it in the `chmod 600` config file; never commit it, never pass it as a command-line argument. If it leaks, **Reset Token** in the portal invalidates it instantly (and any running Pi session will start reporting `code 4004`).
- **Inbound text becomes live agent input.** Only messages authored by `userId` in `channelId` reach the agent; everyone else is ignored, and non-allowlisted button clicks get an ephemeral refusal. Treat the allowlist as the security boundary and keep `userId` as a snowflake, not a name.
- **Prefer a channel you own.** Set the channel's permissions so only you can speak in it. Defence in depth: the extension filters by user ID *and* channel ID.
- **Deny by default when nobody answers**: an approval that expires blocks the tool, and a gated tool with no reachable approval surface (no channel, no terminal dialog) blocks immediately rather than running.
- **No telemetry, no third-party endpoints.** The only network traffic is `discord.com/api/v10` and `gateway.discord.gg`. Nothing is logged to disk; the single state file is the lock, which contains only pid, cwd, and a tag.
- **Sweep before publishing.** The extension never writes your token into session entries, and the test suite uses a scratch `PI_CODING_AGENT_DIR` so it can never touch your real config.

## Development

```bash
npm run check          # typecheck
npm run test           # approval policy + interaction routing + race semantics + question mirror + dormancy rules (no network)
npm run test:gateway   # real gateway handshake, proves 4004 is treated as fatal (hits Discord)
npm run doctor         # pre-flight against your own channel (hits Discord)
npm run probe          # posts real buttons, then a real click must resolve them (hits Discord, needs a click)
```

`devDependencies` exist only so `npm run check` can type against Pi's public types; the extension itself imports nothing from Pi at runtime beyond erased `import type` declarations, so no second copy of Pi's module graph is ever loaded inside the running agent.

## When it is not working

`npm run doctor` first: it proves the token, the channel, the guild membership, your user ID, and that an embed lands, all over REST. That leaves two things it cannot prove, and they are the two that break.

| Symptom | What it means |
|---|---|
| Embeds arrive, buttons do nothing, Discord toasts `This interaction failed` | No `INTERACTION_CREATE` reached the process, or the ack was rejected. Run `/discord status`: `0 clicks` means the socket, the app's presence in the guild, or another gateway owner; a non-zero count with `0 answered` means the click was refused, and the refusal text tells you whether it was the user ID or a stale request. |
| Embeds arrive but nothing you type in the channel ever reaches the agent | The gateway is not `ready` (inbound messages and clicks both arrive over it). Footer and `/discord status` name the state and the reason. |
| `/discord status` says `dormant` | Another live Pi process holds the single gateway connection. `/discord disconnect` there, `/discord connect` here. |
| Approvals never appear | `/discord risk <command>` shows whether the policy gates that call at all, and `!status` in the channel shows the live `approvals` mode. |
| A question appears with no buttons and says to answer in the terminal | No bridge: the published `pi-ask-user` is loaded, which can show a question but not accept one from outside. `/discord status` says `no bridge: read-only mirror`. |
| You answered a question and it says nothing was answered | Either surface can win, and the loser is told rather than ignored. Check the terminal: the question is closed if the keyboard got there first, and if it is still open the answer named an option that question does not offer. |

`npm run probe` is the way to settle a click question for certain: it connects to the gateway on its own, posts a real approval embed with real buttons, prints the `INTERACTION_CREATE` frame it receives (type, `custom_id`, clicker, channel — never the continuation token), and exits 0 only when a click actually resolves the blocked call. It refuses to run while a live Pi session holds the lock, because a second gateway connection evicts that one; stop it first or pass `--force`.

## Known limits

- One gateway owner per token. Only the window holding it gets notifications; move it with `/discord disconnect` in the old window then `/discord connect` in the new one, and see who holds it with `/discord status`. A lock orphaned by a killed process is reclaimed automatically. A hub daemon that fans out to several Pi sessions over a Unix socket — one bot, one gateway connection, one channel per project — is the planned fix.
- Prompts owned by **other** extensions get a mirrored copy, not remote buttons. `ui_prompt_start` reports only the prompt kind, and Pi passes no title at all for `custom` prompts, so this extension re-reads the pending tool call to recover the question, its context, and its numbered options. You still answer at the keyboard: nothing in Pi lets another extension inject an answer into a prompt it does not own. Answerable questions would mean this extension owning the tool, which replaces the other extension's terminal UI.
- No live progress line yet, so a long run is silent until it settles; a `Detail` follow-up message is the current way to see full tool input.
- `channelId: "dm"` works, but bots may only open a DM with a user who shares a guild with them, so the invite step is still required.

## License

MIT
