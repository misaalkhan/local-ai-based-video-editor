# Local Studio

A local AI video editor and planner for reels and creator content. Drop in footage, describe the edit, tweak on a timeline, export. A planner page keeps your footage library, your goals and a content plan, and starts the edits for you. Everything runs on this Mac; only chat requests go to Claude.

## Start

    npm run setup      # one-time: ffmpeg, whisper.cpp, the speech and alignment models, fonts, music, sounds
    npm start          # builds the interface and serves it at http://localhost:4747

Or double-click `Local Studio.command` in Finder: it starts the app and opens it in your browser. Close that Terminal window to stop it.

Requirements: macOS on Apple Silicon, [Homebrew](https://brew.sh), Node 23.6 or newer, and the `claude` command signed in to your Claude account (the assistants run through it, so their work counts against your Claude plan).

## How it works

**Home.** Drop clips (or pick a whole folder with "Choose files on this Mac", which uses the files where they are), type what you want, choose a format, press Start. The project opens, the clips are prepared (preview copy, word-timed transcript, face tracking) and your request runs. "Start with an empty project" skips the request.

**The editor.** Left: Media, Music, Sounds, Memes, Captions, Text, Overlays, Effects, Transitions and Edit. Middle: the preview (Fit or zoom in). Right: the Assistant and the Transcript. Bottom: the timeline.

- Assistant: describe the edit ("make this a tight 40-second reel with a hook"). It reads the transcript, cuts, adds captions and graphics, then looks at rendered frames of its own work and fixes what is off. Every request can be undone from its message. Stop ends a run.
- Transcript: select words and press delete to cut them from the video; cut words stay struck through and can be restored. Fix a misheard word, emphasise a word in the captions, move a sentence earlier or to the start, and choose between repeated takes. When more than one person talks, the transcript shows who (S1, S2) at each change of speaker.
- Timeline: drag, trim, split (S), duplicate (⌘D), delete, undo (⌘Z). Drag clips, text styles, overlays and sound effects from the side panels onto it. Clean up: remove silences, remove fillers, add captions, cut clips to the beat of the music.
- Captions come from the transcript and follow every cut. Fourteen styles (pop, outline, one word at a time, karaoke, highlight, underline, neon glow, glass, typewriter, band, retro, comic, clean, boxed), any of the bundled fonts, and style recipes (a whole look: captions, fonts, colour, pacing, music level) that you can save from a project and apply to the next.
- Text: sixteen styles (hook, title, meme, comic, sticker, neon, handwritten, marker, quote, glitch, gradient, typewriter and more) with entrances (pop, bounce, zoom, typewriter, slides).
- Effects: punch-ins, slow push-ins, shake, framing (follow the face, fill or show the whole picture with a blurred background), nineteen colour looks plus warmth, vignette, sepia, film grain, cinema bars and mirror. Transitions: fade, dip, flash, slides, whip pan, zoom, blur, glitch.
- Layers: blend modes (screen, multiply, overlay, add and more), rectangle and ellipse masks with feather, corner radius and invert, and green-screen keying with colour pick from the corners, similarity, smoothness and spill removal, all on picture-in-picture clips.
- Keyframes: motion on any clip's picture (push in, pull out, pan, tilt, Ken Burns drift, or your own keyframes of zoom and focus) and placement keyframes on picture-in-picture clips and graphics (fly in from a side, grow in, or any position, size, rotation and opacity over time), with easing per keyframe. Keyframes show as diamonds on the timeline; the framing sliders write to the keyframe at the playhead.
- Speed: plain speed, speed ramps (presets: slow moment, hero, ramp in, ramp out, burst; or your own points, each holding a speed and changing evenly to the next), reverse, freeze frames (hold any frame for a chosen time, framed and graded like the clip), and smooth slow motion on export with frame blending or optical flow. The preview plays ramps live and steps through reversed clips; the export reads the source at its own frame rate and plays ramps, reverse and audio tempo exactly.
- Colour grading per clip, Lightroom style: exposure, highlights, shadows, whites, blacks, temperature, tint, vibrance, tone curves (RGB and per channel), HSL by hue range, and LUTs (import .cube files; they are kept in the library). Copy a grade to every clip to match them. The assistant grades from a brief too ("fix the orange cast", "matte film look", "match the clips"). Picture-in-picture for b-roll. Overlays: animated cards, labels, counters, and a reaction GIF search (Tenor key in Settings) that drops a small looping GIF at the playhead, clear of the face.
- Sounds: a library of 100 sound effects (the social set: keyboard, phone typing, pings, shutters, coins, cash, record scratch, doorbell; the comedy set: vine boom, sad trombone, rimshot, crickets, laughs, buzzers) with search, favourites and shelves. Drop your own sound files on the tab to keep them for every project, and search Freesound for more (free key in Settings; CC0 and CC BY only, credit lines kept).
- Memes: the meme sounds, reaction GIF search, meme templates (Imgflip's public list) with top and bottom text in the meme style, and the meme text styles.
- Music: your music or the bundled library (named by mood), voiceover in 26 natural voices (English, Hindi, Spanish, French, Italian, Portuguese, Japanese and Chinese) or the Mac's own, and the final mix: loudness normalisation, noise reduction and voice clean-up on export.
- Export: 9:16, 16:9, 1:1 or 4:5, 720p to 4K, with the sound brought to -14 LUFS. Files go to `~/Documents/Local Studio` (change it in Settings).

**Plan** (button on the home screen). Your footage library in one place: drop everything you have shot and the planner describes each clip. It asks about your account, audience, platforms, goals and capacity, saves a profile, keeps notes on what works on each platform, turns posts you like into style cards, and builds a dated content plan with a hook, storyline, footage, caption and hashtags per post. "Make it" creates the project and queues the edit, which runs when you open it. Nothing is posted anywhere by the app.

**Settings** (home screen): which Claude model the assistants use, the export folder, a Tenor key for reaction GIF search and a Freesound key for sound search.

## Languages

If your videos are in more than one language, set them on the Plan page (You → Edit → Languages). Speech detection is then limited to those, and a clip detected as something else falls back to the first one. Hindi and Hinglish are a special case: with `hi` in the list, every clip is transcribed in whisper's Hindi mode, which hears the Hindi right and keeps the English in English. Put `en` first (`en, hi`) for Hinglish captions in Latin letters (Hindi passages are romanised: "ladki", "accha", "kya hua"); put `hi` first to keep Hindi passages in Devanagari. Captions render in Devanagari, Arabic and other scripts.

## Where things live

- `data/` holds projects, the footage library and the planner's files (set `STUDIO_DATA` to move it). Projects reference your files where they are; nothing is copied unless you upload through the browser.
- `library/` holds the music, sound effects and b-roll shared by every project; add your own files there.
- `models/` holds the speech models, downloaded by setup.

## Licences

The code is under the MIT License (`LICENSE`). Fonts in `fonts/` are under the SIL Open Font License or Apache 2.0 (`fonts/LICENSE-*.txt`). Bundled music is by Kevin MacLeod under CC BY 4.0; the assistant gives you the credit line for the caption when it uses a track (`library/music/LICENSE-music.txt`). The sound packs come from Mixkit under its free licence (`library/sfx/LICENSE-pack.txt`); sounds saved from Freesound are CC0 or CC BY and keep their author and licence in `library/sfx/mine/mine.json`. Meme templates are fetched from Imgflip's public list when picked and are not bundled. Model files keep their own licences.

## Development

    npm run dev        # serves with live reload
    npm test           # unit tests
    npm run typecheck

Layout: `shared/` (timeline model, edit operations, drawing code used by both preview and export, captions, beat tracking), `server/` (API, media pipeline, transcription and alignment, export, the assistants and their tools, the planner), `src/` (React interface), `scripts/` (setup, font, music and sound downloads, maintenance checks), `test/`.
