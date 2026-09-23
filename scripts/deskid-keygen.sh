#!/usr/bin/env bash
# Generate the RS256 key pair the real DeskId container (compose profile
# "deskid") mounts at /run/secrets. Output dir defaults to ./.deskid
# (gitignored); override with DESKID_JWT_PRIVATE_KEY_FILE /
# DESKID_JWT_PUBLIC_KEY_FILE in .env.
set -euo pipefail
DIR="${1:-.deskid}"
mkdir -p "$DIR"
if [ -f "$DIR/private.pem" ]; then
  echo "keys already exist in $DIR — refusing to overwrite" >&2
  exit 1
fi
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$DIR/private.pem" 2>/dev/null
openssl rsa -in "$DIR/private.pem" -pubout -out "$DIR/public.pem" 2>/dev/null
chmod 600 "$DIR/private.pem"
echo "wrote $DIR/private.pem and $DIR/public.pem"
