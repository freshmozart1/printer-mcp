#!/usr/bin/env bash
# Generate a TLS certificate so the server can speak HTTPS on the LAN.
#
# Creates a small local certificate authority once, then issues a leaf certificate
# for this machine's current addresses. Trusting the CA is a one-off: when your IP
# changes, re-run this script to reissue the leaf and the CA stays trusted.
set -euo pipefail

DIR="$HOME/.config/printer-mcp"
CA_KEY="$DIR/ca-key.pem"
CA_CERT="$DIR/ca-cert.pem"
KEY="$DIR/key.pem"
CERT="$DIR/cert.pem"

mkdir -p "$DIR"
chmod 700 "$DIR"

# Every name and address the server might legitimately be reached on.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
LOCAL_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
HOST_NAME="$(hostname)"

if [[ ! -f "$CA_CERT" || ! -f "$CA_KEY" ]]; then
  echo "Creating local certificate authority..."
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$CA_KEY" -out "$CA_CERT" \
    -subj "/CN=printer-mcp local CA/O=printer-mcp" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 "$CA_KEY"
fi

echo "Issuing certificate for: $LAN_IP, $LOCAL_HOST, $HOST_NAME, localhost"

SAN="DNS:localhost,DNS:$LOCAL_HOST,DNS:$HOST_NAME,IP:127.0.0.1,IP:::1,IP:$LAN_IP"

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$KEY" -out "$DIR/csr.pem" \
  -subj "/CN=$LOCAL_HOST/O=printer-mcp" 2>/dev/null

# Apple rejects TLS server certificates valid for more than 398 days.
openssl x509 -req -in "$DIR/csr.pem" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$CERT" -days 397 -sha256 \
  -extfile <(printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$SAN") 2>/dev/null

rm -f "$DIR/csr.pem"
chmod 600 "$KEY"
chmod 644 "$CERT" "$CA_CERT"

echo
echo "Certificate written to $CERT"
echo "Valid for: $SAN"
echo
echo "The server will now serve HTTPS. To make this Mac trust it (one time, asks for"
echo "your password — run it yourself, it changes system trust settings):"
echo
echo "  sudo security add-trusted-cert -d -r trustRoot \\"
echo "    -k /Library/Keychains/System.keychain \"$CA_CERT\""
echo
