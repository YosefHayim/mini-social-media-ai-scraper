# mini-social-media-ai-scraper — agent instructions

Small [Node.js](https://nodejs.org/en) / [TypeScript](https://www.typescriptlang.org/) CLI: download public [YouTube](https://www.youtube.com/) captions (video, playlist, channel Videos, or channel Shorts), save public [Instagram](https://www.instagram.com/) reels as mp4 or mp3 with a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) transcript, optionally convert transcripts into portable [`SKILL.md`](https://agentskills.io/specification) packages via a local coding agent.

Human landing page: [README.md](README.md). Visual: [assets/hero.png](assets/hero.png).

## Source of truth

| Concern | Canonical file |
| --- | --- |
| Agent contract (this file) | `AGENTS.md` |
| Code style and file map | `CODE-STYLE.md` |
| Shared types (SSOT) | `src/types.ts` |
| Package scripts | `package.json` |
| Human pitch / usage | `README.md` |

Keep one instruction hub here. Do not invent parallel root guides for each coding agent.

## Read order

1. This file
2. `CODE-STYLE.md` when changing structure, naming, or logging
3. `src/types.ts` for contracts
4. The specific `src/*.ts` file you touch

## Commands

```bash
npm start -- url=<video|playlist|@channel|@channel/shorts|instagram-reel> [format=vtt] [lang=en] [auto] [stdout] [download] [media=mp4|mp3] [whisper-model=large-v3-turbo-q5_0] [out-dir=./scraped-yt] [output-format=txt|md|json|jsonl] [cookies=./cookies.txt] [agent=codex|grok|…] [model=<id>] [reasoning-effort=low|medium|high] [system-prompt="..."]
npm run typecheck
npm run build
```

CLI options (see `src/cli.ts`):

- `format=` — subtitle formats; default `vtt`
- `lang=` — language tokens; default `en`
- `auto` — allow auto-generated captions
- `stdout` — print captions instead of writing files
- `download` — download a single video as mp4 via the native player API (no yt-dlp)
- `media=` — Instagram only: keep the reel as `mp4` or `mp3`; default `mp4`
- `whisper-model=` — Instagram only: whisper.cpp model name; default `large-v3-turbo-q5_0`, cached under `~/.cache/mini-social-media-ai-scraper/whisper/`
- `cookies=` — optional Netscape cookies for public session
- `agent=` — local agent for skill scaffold
- `model=` / `reasoning-effort=` — agent model and effort when supported
- `system-prompt=` — **extra** guidance appended to the official skill-authoring prompt (`emptySystemPrompt` = use official only)
- `out-dir=` — base output directory; default `./scraped-yt` (YouTube) or `./scraped-instagram` (Instagram)

Bulk output roots (under `out-dir`):

| Input | Folder |
| --- | --- |
| Channel Videos (`@handle` or `…/videos`) | `channel-<name>/` |
| Channel Shorts (`…/shorts`) | `shorts-<name>/` |
| Single video / playlist | `out-dir` root |
| Instagram reel | `out-dir` root (`<shortcode>.mp4` or `.mp3`, `<shortcode>.<lang>.txt`) |

## Layout (summary)

| File | Role |
| --- | --- |
| `src/main.ts` | CLI entry + orchestration |
| `src/cli.ts` | Argument parsing (+ interactive) |
| `src/captions.ts` | Caption track selection / URLs |
| `src/playlist.ts` | Playlist video IDs |
| `src/channel.ts` | Channel Videos/Shorts discovery + bulk folder names |
| `src/player-api.ts` | Multi-client Innertube player (+ streaming-format payload) |
| `src/video.ts` | mp4 download (progressive / adaptive pair + ffmpeg mux) |
| `src/media-download.ts` | Parallel ranged-chunk media download to a file |
| `src/ffmpeg.ts` | `ffmpeg` runner + mp3 extraction |
| `src/instagram.ts` | Instagram reel page parse + mp4 download |
| `src/whisper-model.ts` | whisper.cpp model download + cache |
| `src/transcribe.ts` | Local speech-to-text via `whisper-cli` |
| `src/http.ts` | Fetch + 429 backoff + session cookies |
| `src/cookies.ts` | Netscape jar |
| `src/output.ts` | Caption → txt/md/json/jsonl |
| `src/agent.ts` | Local agent spawn + metrics parse |
| `src/agentModels.ts` | Model list / flags |
| `src/skill-prompt.ts` | Per-agent official skill system prompt |
| `src/skill-output.ts` | Multi-file `SKILL.md` package parse/write |
| `src/types.ts` | Shared types only |
| `src/constants.ts` | Shared literals when present |

Full style rules: `CODE-STYLE.md`. No type re-export shims; import contracts from `types.ts`.

## Agent skill packages

When `agent=` is set:

```text
<out-dir>/[channel-|shorts-<name>/]agents/<agent>/<model[_effort]>/<videoId or shortcode>/
  transcript.txt
  agent-raw.md
  metrics.json
  <skill-name>/SKILL.md
```

- Skill prompt: official agent docs when known ([Claude skills](https://code.claude.com/docs/en/skills), [Codex skills](https://github.com/openai/codex/blob/main/docs/skills.md), [agentskills.io](https://agentskills.io/specification))
- `metrics.json`: requested model/effort, tokens when stdout exposes them, `unavailableNotes` for nulls

## Working rules

- Keep the project small; no heavy abstractions.
- Fail fast with clear errors; no silent fallbacks that hide causes.
- Domain-specific names (see `CODE-STYLE.md`); no backward-compat aliases for renames.
- Prefer [Effect](https://effect.website/) where already used; do not add frameworks casually.
- Do not grow into yt-dlp (no full A/V pipeline, no private-content scraping). Native `download` stays limited to mp4 (combined stream, or adaptive pair muxed via `ffmpeg`); full adaptive quality is unlocked by a `visitorData` bootstrap (android → visionos, android_vr as fallback), with parallel chunked downloads to dodge the CDN's per-connection throttle. `YT_PO_TOKEN` / `YT_PO_TOKEN_COMMAND` remain the documented pot fallback. Instagram stays limited to one public reel or video post per run (no login, profiles, or stories).

## Verify before done

- `npm run typecheck` must pass.
- Smoke-test with a public video, playlist, channel, shorts, or Instagram reel URL when network is available.

## Safety

- Public pages only; optional cookies are for public session resilience, not private content.
- Do not commit secrets or large caption dumps (`scraped-yt/` and `scraped-instagram/` are gitignored).
- Keep playlist/channel throttling; leave `dist/` and `node_modules/` alone unless the task is about them.
