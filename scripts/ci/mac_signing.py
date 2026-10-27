#!/usr/bin/env python3
"""Prepare macOS Developer ID signing + notarization for electron-builder in CI.

The Developer ID private key is the only stored secret (MAC_DEVID_KEY, PEM).
The matching public certificate is fetched from Apple through the App Store
Connect API, combined with the key into a .p12, and handed to electron-builder
via CSC_LINK (base64). The same API key is used for notarization.
Prints GitHub env lines.
"""
import base64, os, pathlib, secrets, subprocess, sys, time
import jwt, requests

TMP = pathlib.Path(os.environ["RUNNER_TEMP"])
CERT_ID = os.environ.get("MAC_DEVID_CERT_ID", "5K8LGR2TX2")


def token():
    now = int(time.time())
    return jwt.encode({"iss": os.environ["ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      pathlib.Path(os.environ["KEY_PATH"]).read_text(), algorithm="ES256",
                      headers={"kid": os.environ["KEY_ID"], "typ": "JWT"})


r = requests.get(f"https://api.appstoreconnect.apple.com/v1/certificates/{CERT_ID}",
                 headers={"Authorization": "Bearer " + token()}, timeout=60)
if r.status_code >= 300:
    sys.exit(f"::error::Could not fetch the Developer ID certificate: {r.status_code} {' '.join(r.text.split())[:400]}")
der = TMP / "devid.cer"
der.write_bytes(base64.b64decode(r.json()["data"]["attributes"]["certificateContent"]))
key = TMP / "devid.key"
key.write_text(os.environ["MAC_DEVID_KEY"].replace("\\n", "\n").strip() + "\n")
pem, p12 = TMP / "devid.pem", TMP / "devid.p12"
subprocess.run(["openssl", "x509", "-inform", "DER", "-in", der, "-out", pem], check=True)
pw = secrets.token_urlsafe(18)
base = ["openssl", "pkcs12", "-export", "-inkey", key, "-in", pem, "-out", p12, "-passout", "pass:" + pw]
if subprocess.run(base[:3] + ["-legacy"] + base[3:], capture_output=True).returncode != 0:
    subprocess.run(base, check=True)
key.unlink()
print("CSC_LINK=" + base64.b64encode(p12.read_bytes()).decode())
print("CSC_KEY_PASSWORD=" + pw)
