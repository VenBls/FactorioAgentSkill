#!/bin/sh
set -eu

binary=/runtime/bin/x64/factorio
config=/lab/config/config.ini
mods=/lab/data/mods
save=/lab/data/saves/codex-lab.zip

set -- /lab/data/saves/*.zip
if [ ! -f "$1" ]; then
  "$binary" --config "$config" --mod-directory "$mods" \
    --create "$save" --map-gen-seed 1206120 --map-gen-settings /lab/config/map-gen-settings.json
fi

exec "$binary" --config "$config" --mod-directory "$mods" \
  --start-server-load-latest --server-settings /lab/config/server-settings.json \
  --bind 0.0.0.0:34197 --rcon-bind 0.0.0.0:27015 \
  --rcon-password "$(cat /lab/config/rcon-password)"
