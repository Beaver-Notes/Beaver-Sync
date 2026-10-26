# Rotates the self-generated hex secrets in an env file, in place.
# External credentials (R2, Resend, Stripe, Apple) are never touched.
# shortcut: safe only BEFORE the stack has booted — MLKEM_SEED is the only key
# into encrypted note metadata and POSTGRES_PASSWORD is read on first init only;
# rotating either once data exists means losing it.
set -eu
FILE="${1:-.env.droplet}"
[ -f "$FILE" ] || { echo "usage: rotate-secrets.sh <env-file>" >&2; exit 1; }

rotate() {
  key=$1
  val=$(openssl rand -hex "$2")
  perl -pi -e "s/^\Q$key\E=.*/$key=$val/" "$FILE"
  echo "rotated $key"
}

rotate POSTGRES_PASSWORD 24
for k in SESSION_HMAC_KEY EMAIL_HMAC_KEY COOKIE_SECRET NOTE_HMAC_KEY \
         INTERNAL_API_SECRET LINK_TOKEN_SECRET INBOUND_WEBHOOK_SECRET; do
  rotate "$k" 32
done
rotate MLKEM_SEED 64

echo "done: $FILE (stays where it is, so re-upload or re-run deploy)"
