---
name: yt-transcript
description: >
  Fetch YouTube captions/transcripts via the mini-social-media-ai-scraper CLI — single video,
  playlist, or channel bulk — or a public Instagram reel (mp4/mp3 plus a local whisper.cpp
  transcript), and optionally convert transcripts into agent SKILL.md packages.
  Use when the user asks for YouTube subtitles, captions, transcripts, bulk channel scrapes,
  Instagram reel transcripts, or "faster than yt-dlp for captions only". Prefer this over generic
  scrapers for YouTube and Instagram reel CLI work. Trigger phrases: /yt-transcript, youtube captions cli, mini-social-media-ai-scraper, transcript to skill.
---

# YouTube transcript via mini-social-media-ai-scraper

## Install (if needed)

```bash
npm install -g mini-social-media-ai-scraper
# or: npm install && npm run build  (from repo root)
# binary: mini-social-media-ai-scraper
```

Requires Node.js 20+. Optional: `yt-dlp` on PATH for `extractor=ytdlp` / auto fallback.

## Single video

```bash
mini-social-media-ai-scraper url=https://www.youtube.com/watch?v=VIDEO_ID lang=en auto output-format=txt
# short form
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto output-format=txt out-dir=./scraped-yt
```

## Bulk playlist / channel

```bash
mini-social-media-ai-scraper url='https://www.youtube.com/playlist?list=LIST_ID' lang=en auto concurrency=8 max-videos=50 output-format=txt
mini-social-media-ai-scraper url=https://www.youtube.com/@handle lang=en auto concurrency=8 output-format=txt
mini-social-media-ai-scraper url=https://www.youtube.com/@handle/shorts lang=en auto concurrency=8 output-format=txt
```

## Instagram reel (media + transcript)

```bash
# needs ffmpeg and whisper-cli on PATH: brew install ffmpeg whisper-cpp
mini-social-media-ai-scraper url=https://www.instagram.com/reel/SHORTCODE/                    # mp4 + transcript
mini-social-media-ai-scraper url=https://www.instagram.com/reel/SHORTCODE/ media=mp3          # mp3 + transcript
mini-social-media-ai-scraper url=https://www.instagram.com/reel/SHORTCODE/ whisper-model=base # smaller model
```

Writes `./scraped-instagram/<shortcode>.mp4` (or `.mp3`) and `<shortcode>.<lang>.txt`. The speech model downloads once to `~/.cache/mini-social-media-ai-scraper/whisper/`.

## Cache / force refresh

```bash
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto output-format=txt        # uses ~/.cache by default
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto force output-format=txt  # bypass cache
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto no-cache output-format=txt
```

## Extractor modes

```bash
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto extractor=auto    # native Innertube, then yt-dlp
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto extractor=native
mini-social-media-ai-scraper url=VIDEO_ID lang=en auto extractor=ytdlp   # requires yt-dlp on PATH
```

## Transcript → agent skill package

```bash
mini-social-media-ai-scraper url=VIDEO_ID agent=grok model=grok-4.5 reasoning-effort=medium
mini-social-media-ai-scraper url=VIDEO_ID agent=codex model=gpt-5.3-codex-spark
```

Writes under `scraped-yt/agents/<agent>/<model[_effort]>/<videoId>/` including `SKILL.md` packages and `metrics.json`.

## When NOT to use

- Playlist/channel media download or private content → use **yt-dlp**
- Other sites, Instagram profiles/stories, or login-only posts → use **yt-dlp**
- Browser-only one-liner without CLI → `youtube-transcript` npm (often captcha/rate-limited)

## Output

Default directory: `./scraped-yt/<videoId>.en.txt` for YouTube, `./scraped-instagram/` for Instagram (or `out-dir=`).

## More

See repo `llms.txt` and README benchmarks (vs yt-dlp captions-only).
