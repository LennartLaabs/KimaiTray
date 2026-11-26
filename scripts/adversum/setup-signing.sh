#!/bin/sh
# ADVERSUM: one-time setup of the local code-signing certificate.
#
#   ./scripts/adversum/setup-signing.sh
#
# Creates the self-signed certificate "Adversum Dev" (code signing only, valid
# ten years) with its private key in the login keychain and trusts it for code
# signing for this user. Safe to run again: it only does what is missing.
#
# macOS asks twice, and nobody can answer that for you:
#   1. now, to change the certificate trust settings (password or Touch ID);
#   2. at the first build, "codesign wants to sign using key Adversum Dev":
#      enter the login password and choose "Always Allow".
#
# The certificate is only trusted on this Mac. It does not satisfy Gatekeeper
# anywhere else; that needs an Apple Developer ID.
set -eu

NAME="${ADVERSUM_SIGN_IDENTITY:-Adversum Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "\"${NAME}\""; then
  echo "==> \"${NAME}\" is already a valid code-signing identity."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
umask 077

if ! security find-identity -p codesigning | grep -q "\"${NAME}\""; then
  echo "==> Creating the certificate \"${NAME}\""
  cat > "$WORK/cert.cnf" <<CONFIG
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${NAME}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CONFIG
  # The system's LibreSSL writes a PKCS#12 file that `security import` reads;
  # OpenSSL 3 from Homebrew does not without -legacy.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
  passphrase="$(/usr/bin/openssl rand -hex 16)"
  /usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$NAME" -out "$WORK/identity.p12" -passout "pass:${passphrase}"
  security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$passphrase" -T /usr/bin/codesign
fi

echo "==> Trusting \"${NAME}\" for code signing (macOS asks for your password)"
security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$WORK/trust.pem"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/trust.pem"

if security find-identity -v -p codesigning | grep -q "\"${NAME}\""; then
  echo "==> Done. Release builds are now signed with \"${NAME}\"."
else
  echo "The certificate is still not a valid code-signing identity." >&2
  exit 1
fi
