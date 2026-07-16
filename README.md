# hush

**Noise-canceling for Claude.**

A calm front door for Claude Code. You type (or dictate) a thought onto a
quiet, fuzzy, near-blank screen. Claude interviews *you* — one small question
at a time, yes/no whenever possible — until it has the context it needs. Then
it runs the real prompt and gives you **one** answer with **one** next step.
No streaming text, no walls of options, no slot machine.

## Why

Claude's answers are often so thorough they overwhelm: five options, twelve
caveats, three follow-up questions, all scrolling in at once. That's decision
fatigue by firehose. hush inverts the flow — the model absorbs the burden of
deciding what matters, and hands you back the smallest possible surface.

Design principles:

- **One thing on screen at a time.** A question, an answer, or a breath.
- **Nothing streams, nothing scrolls in.** Content resolves from a soft blur
  into focus, like fog lifting. Waiting is a breathing circle, not a spinner.
- **Yes/no beats open-ended.** Binary questions cost nothing to answer.
  A hard cap of 5 questions, with "enough — just answer" always available.
- **The calm answer contract.** One recommendation, never a menu. Under ~250
  words. Ends with exactly one smallest next step.
- **Coaching, quietly.** Before running, hush names the one piece of context
  that most sharpened the plan — so you learn what to include next time.

## Run it

Requires Node 18+ and the [`claude` CLI](https://claude.com/claude-code)
logged in (`claude` once, interactively, to authenticate). Your existing
OAuth account is used — no API key.

```sh
node server.mjs          # then open http://localhost:4117
```

or, for a chromeless app-style window on macOS:

```sh
bin/hush
```

## How it works

A ~350-line dependency-free Node server shells out to `claude -p` in headless
mode with `--output-format json`, resuming one conversation per session with
`--resume <session-id>`:

1. **Elicit** — an appended system prompt turns Claude into a strict-JSON
   interviewer (`ask_yesno` / `ask_open` / `ready`). Runs on Sonnet for fast,
   cheap turns. The server enforces the 5-question cap.
2. **Ready** — Claude returns a summary, a coaching note, and the full
   refined prompt (inspectable behind a quiet disclosure). You confirm.
3. **Run** — the same conversation continues under the calm answer contract,
   on your account's default model, with web search allowed.

Sessions run in an isolated workspace (`~/.hush/workspace`) so they never
touch your repos' project context.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `HUSH_PORT` | `4117` | server port |
| `HUSH_ELICIT_MODEL` | `sonnet` | model for interview turns |
| `HUSH_RUN_MODEL` | account default | model for the final run |
| `HUSH_MAX_QUESTIONS` | `5` | hard cap on interview questions |
| `HUSH_WORKSPACE` | `~/.hush/workspace` | cwd for claude sessions |
| `HUSH_CLAUDE_BIN` | `claude` | path to the claude CLI |

## Roadmap

- Global hotkey / menu-bar summon (Raycast script command or Hammerspoon)
- A "project mode" that points the workspace at a repo so the run phase can
  read code
- Session history (quiet, opt-in)
