#!/bin/bash
# Fetches a starter set of music into library/music so the assistant has tracks to choose from.
# All tracks are by Kevin MacLeod (incompetech.com), licensed CC BY 4.0: free to use in any
# video, including monetised ones, as long as the credit line in LICENSE-music.txt is given.
# Safe to run again; existing files are kept.
set -e
cd "$(dirname "$0")/.."
mkdir -p library/music
base="https://incompetech.com/music/royalty-free/mp3-royaltyfree"
fetch() { # "Title on incompetech" "Mood words"
  local title="$1" mood="$2"
  local file="library/music/${mood} - ${title} (Kevin MacLeod, CC BY).mp3"
  [ -f "$file" ] && return 0
  local enc; enc=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$title")
  curl -sL --fail -o "$file" "$base/$enc.mp3" && echo "$file" || { echo "could not fetch $title"; rm -f "$file"; }
}
fetch "Carefree" "Upbeat acoustic, happy, travel"
fetch "Life of Riley" "Cheerful folk, feel-good, family"
fetch "Wallpaper" "Light and breezy, everyday vlog"
fetch "Fluffing a Duck" "Quirky comedy, silly, fails"
fetch "Monkeys Spinning Monkeys" "Comedy chaos, playful, memes"
fetch "Sneaky Snitch" "Sneaky mischief, comedy, suspense-lite"
fetch "Cold Funk" "Funky groove, confident, swagger"
fetch "Bossa Antigua" "Chill bossa, cafe, relaxed"
fetch "Deliberate Thought" "Calm piano, thoughtful, talking head"
fetch "Clear Waters" "Calm ambient, reflective, nature"
fetch "Dreamy Flashback" "Dreamy nostalgia, memories, soft"
fetch "Inspired" "Uplifting cinematic, emotional, motivation"
fetch "Impact Moderato" "Dramatic trailer, big reveal, epic"
fetch "Investigations" "Suspense mystery, tense, true crime"
fetch "Cipher2" "Electronic tech, tense, product"
fetch "Severe Tire Damage" "Energetic rock, driving, sport"
cat > library/music/LICENSE-music.txt <<'TXT'
The tracks in this folder marked "Kevin MacLeod, CC BY" are by Kevin MacLeod (incompetech.com)
and are licensed under Creative Commons: By Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).
You may use them in any video, including ones you monetise, if you credit them. Put this line in
the caption or description of each post that uses one:

  Music: "<track title>" Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0

The assistant gives you the exact line when it adds a track.
TXT
