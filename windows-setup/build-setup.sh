#!/usr/bin/env bash
# ------------------------------------------------------------------
#  Build the Windows setup package on Mac/Linux.
#
#    ./build-setup.sh            -> dist/LIS-Catalog-Setup.zip (installers downloaded on Windows)
#    ./build-setup.sh --offline  -> also bundle XAMPP / Bun / cloudflared / VC++ (~250 MB)
#
#  Before building:
#    - cp config.example.ini config.ini   and fill in CLOUDFLARE_TOKEN, GEMINI_API_KEY
#    - put your database export (*.sql) in database/
#    - (optional) put PHP site files (e.g. OpenBiblio) in htdocs/
# ------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
APP_SRC="$HERE/.."
OUT="$HERE/dist/LIS-Catalog-Setup"
DL="$HERE/downloads"

OFFLINE=0
[[ "${1:-}" == "--offline" ]] && OFFLINE=1

# --- config.ini ---
if [[ ! -f config.ini ]]; then
  cp config.example.ini config.ini
  # prefill Gemini key from the app .env if present
  if [[ -f "$APP_SRC/.env" ]]; then
    KEY=$(grep -E '^GEMINI_API_KEY=' "$APP_SRC/.env" | tail -1 | cut -d= -f2- | tr -d '"' || true)
    if [[ -n "$KEY" ]]; then
      sed -i '' "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$KEY|" config.ini 2>/dev/null || sed -i "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$KEY|" config.ini
    fi
  fi
  echo "Created config.ini (GEMINI_API_KEY copied from app/.env if found)."
fi
grep -qE '^CLOUDFLARE_TOKEN=.+' config.ini || echo "WARNING: CLOUDFLARE_TOKEN is empty in config.ini"
ls database/*.sql >/dev/null 2>&1 || echo "WARNING: no database/*.sql - DB will be empty"

# --- assemble ---
rm -rf "$HERE/dist"
mkdir -p "$OUT"
cp SETUP.bat setup.ps1 config.ini config.example.ini README.md "$OUT/"
cp -R tools database htdocs "$OUT/"

rsync -a \
  --exclude node_modules --exclude .git --exclude .env --exclude cert --exclude generated \
  --exclude .DS_Store --exclude .agents --exclude .claude --exclude .windsurf \
  --exclude package-lock.json --exclude '*.log' --exclude windows-setup \
  "$APP_SRC/" "$OUT/app/"

# --- optional: pre-download installers ---
if [[ $OFFLINE == 1 ]]; then
  mkdir -p "$DL"
  get() { # name url
    if [[ ! -s "$DL/$1" ]]; then
      echo "Downloading $1 ..."
      curl -L --fail --retry 3 -o "$DL/$1.part" "$2" && mv "$DL/$1.part" "$DL/$1"
    fi
  }
  get vcredist_2012_x86.exe "https://download.microsoft.com/download/1/6/B/16B06F60-3B20-4FF2-B699-5E9B7962F9AE/VSU_4/vcredist_x86.exe"
  get xampp-portable-win32-1.8.3-5-VC11.zip "https://downloads.sourceforge.net/project/xampp/XAMPP%20Windows/1.8.3/xampp-portable-win32-1.8.3-5-VC11.zip"
  get bun-windows-x64-baseline.zip "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64-baseline.zip"
  get cloudflared-windows-amd64.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  mkdir -p "$OUT/downloads"
  cp "$DL"/* "$OUT/downloads/"
fi

# --- Windows line endings for scripts ---
find "$OUT" -maxdepth 2 \( -name '*.bat' -o -name '*.ps1' -o -name '*.ini' \) -not -path '*/app/*' -print0 |
  while IFS= read -r -d '' f; do perl -pi -e 's/\r?\n/\r\n/' "$f"; done

# --- zip ---
(cd "$HERE/dist" && zip -qr LIS-Catalog-Setup.zip LIS-Catalog-Setup)
echo ""
echo "Done: $HERE/dist/LIS-Catalog-Setup.zip ($(du -h "$HERE/dist/LIS-Catalog-Setup.zip" | cut -f1))"
echo "Copy it to the Windows machine, unzip, double-click SETUP.bat"
