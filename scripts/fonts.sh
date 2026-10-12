#!/bin/bash
# Fetches the bundled fonts from Google Fonts as static TTF files (one per weight).
# All are under the SIL Open Font License or the Apache License 2.0, which allow
# use in videos, including commercial ones. Safe to run again; existing files are kept.
set -e
cd "$(dirname "$0")/.."
mkdir -p fonts
fetch() { # family-with-plus weight file
  local family="$1" weight="$2" file="$3"
  [ -f "fonts/$file" ] && return 0
  # An old Android browser identity makes Google serve plain TTF files instead of woff2.
  local url
  url=$(curl -sL --fail -A "Mozilla/5.0 (Linux; U; Android 2.3.3; en-us) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1" "https://fonts.googleapis.com/css?family=${family}:${weight}" | grep -o "url([^)]*)" | head -1 | sed 's/^url(//; s/)$//')
  if [ -z "$url" ]; then echo "could not find $family $weight"; return 0; fi
  curl -sL --fail -o "fonts/$file" "$url" || { echo "download failed for $family $weight"; rm -f "fonts/$file"; return 0; }
  # A TrueType file starts with 00 01 00 00 or "true"; anything else is not a font.
  case "$(head -c 4 "fonts/$file" | xxd -p)" in 00010000|74727565) echo "fonts/$file";; *) echo "unexpected file for $family $weight"; rm -f "fonts/$file";; esac
}
fetch Inter 500 Inter-500.ttf
fetch Inter 600 Inter-600.ttf
fetch Inter 700 Inter-700.ttf
fetch Inter 800 Inter-800.ttf
fetch Montserrat 700 Montserrat-700.ttf
fetch Montserrat 800 Montserrat-800.ttf
fetch Montserrat 900 Montserrat-900.ttf
fetch Poppins 600 Poppins-600.ttf
fetch Poppins 700 Poppins-700.ttf
fetch Poppins 800 Poppins-800.ttf
fetch Anton 400 Anton-400.ttf
fetch Bebas+Neue 400 BebasNeue-400.ttf
fetch Playfair+Display 700 PlayfairDisplay-700.ttf
fetch Playfair+Display 900 PlayfairDisplay-900.ttf
# The social pack: the looks that carry Reels, Shorts and TikTok text.
fetch Bangers 400 Bangers-400.ttf
fetch Luckiest+Guy 400 LuckiestGuy-400.ttf
fetch Permanent+Marker 400 PermanentMarker-400.ttf
fetch Pacifico 400 Pacifico-400.ttf
fetch Lobster 400 Lobster-400.ttf
fetch Dancing+Script 700 DancingScript-700.ttf
fetch Caveat 700 Caveat-700.ttf
fetch Oswald 700 Oswald-700.ttf
fetch Archivo+Black 400 ArchivoBlack-400.ttf
fetch Righteous 400 Righteous-400.ttf
fetch Fredoka 700 Fredoka-700.ttf
fetch Bungee 400 Bungee-400.ttf
fetch Alfa+Slab+One 400 AlfaSlabOne-400.ttf
fetch DM+Serif+Display 400 DMSerifDisplay-400.ttf
fetch Shrikhand 400 Shrikhand-400.ttf
fetch Comfortaa 700 Comfortaa-700.ttf
fetch Yellowtail 400 Yellowtail-400.ttf
fetch Space+Grotesk 700 SpaceGrotesk-700.ttf
fetch Cormorant+Garamond 700 CormorantGaramond-700.ttf
