#!/bin/sh
# tile.sh <dir-or-glob> <cols>x<rows> <out.png> [width]  — contact sheet of PNG stills (for review)
W=${4:-960}
/opt/homebrew/bin/ffmpeg -v error -y -pattern_type glob -i "$1" -vf "format=rgb24,scale=$W:-1:flags=area,tile=$2:padding=6:color=0x222222" -frames:v 1 "$3"
