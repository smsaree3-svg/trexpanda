#!/usr/bin/env python3
"""App Store signing for CI through the App Store Connect API.

  setup:   create a short-lived Apple Distribution certificate (from a CSR made
           here) and App Store provisioning profiles for the app and keyboard,
           install them, and print the profile names as GitHub env lines.
  cleanup: delete those profiles and revoke the certificate.

A revoked distribution certificate does not affect builds already uploaded to
App Store Connect, so no signing material ever has to be stored anywhere.
Needs KEY_ID, ISSUER_ID, KEY_PATH, RUNNER_TEMP, GITHUB_RUN_ID in the env.
"""
import base64, json, os, pathlib, subprocess, sys, time
import jwt, requests

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLES = {"APP": "com.lumisha.trexpanda", "KEYBOARD": "com.lumisha.trexpanda.keyboard"}
TMP = pathlib.Path(os.environ["RUNNER_TEMP"])
STATE = TMP / "asc_signing.json"


def token():
    key = pathlib.Path(os.environ["KEY_PATH"]).read_text()
    now = int(time.time())
    return jwt.encode({"iss": os.environ["ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      key, algorithm="ES256", headers={"kid": os.environ["KEY_ID"], "typ": "JWT"})


def call(method, path, body=None):
    r = requests.request(method, API + path, headers={"Authorization": "Bearer " + token()}, json=body, timeout=60)
    if r.status_code >= 300:
        sys.exit(f"::error::App Store Connect API {method} {path} -> {r.status_code}: {r.text[:600]}")
    return r.json() if r.content else {}


def setup():
    run = os.environ.get("GITHUB_RUN_ID", str(int(time.time())))
    key, csr = TMP / "dist.key", TMP / "dist.csr"
    subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr,
                    "-subj", "/CN=Trexpanda CI/O=Lumisha LLC/C=US"], check=True, capture_output=True)
    cert = call("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": "DISTRIBUTION", "csrContent": csr.read_text()}}})["data"]
    state = {"certificate": cert["id"], "profiles": []}
    STATE.write_text(json.dumps(state))
    der = TMP / "dist.cer"
    der.write_bytes(base64.b64decode(cert["attributes"]["certificateContent"]))

    # Temporary keychain holding the identity.
    kc, pw = str(TMP / "ci.keychain-db"), "ci-" + run
    pem, p12 = TMP / "dist.pem", TMP / "dist.p12"
    subprocess.run(["openssl", "x509", "-inform", "DER", "-in", der, "-out", pem], check=True)
    # OpenSSL 3 needs -legacy for a .p12 macOS can import; LibreSSL has no such flag.
    base = ["openssl", "pkcs12", "-export", "-inkey", key, "-in", pem, "-out", p12, "-passout", "pass:" + pw]
    if subprocess.run(base[:3] + ["-legacy"] + base[3:], capture_output=True).returncode != 0:
        subprocess.run(base, check=True)
    for cmd in (["create-keychain", "-p", pw, kc], ["set-keychain-settings", "-lut", "21600", kc],
                ["unlock-keychain", "-p", pw, kc],
                ["import", str(p12), "-P", pw, "-A", "-t", "cert", "-f", "pkcs12", "-k", kc],
                ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pw, kc]):
        subprocess.run(["security", *cmd], check=True, capture_output=True)
    existing = subprocess.run(["security", "list-keychains", "-d", "user"], capture_output=True, text=True).stdout
    subprocess.run(["security", "list-keychains", "-d", "user", "-s", kc,
                    *[k.strip().strip('"') for k in existing.split()]], check=True)

    env = [f"TREX_KEYCHAIN={kc}"]
    dirs = [pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles",
            pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    for label, ident in BUNDLES.items():
        bid = call("GET", f"/bundleIds?filter[identifier]={ident}&limit=5")["data"]
        bid = next(b for b in bid if b["attributes"]["identifier"] == ident)
        name = f"Trexpanda {label.title()} AppStore CI {run}"
        prof = call("POST", "/profiles", {"data": {"type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
            "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bid["id"]}},
                              "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]}}}})["data"]
        state["profiles"].append(prof["id"])
        STATE.write_text(json.dumps(state))
        content = base64.b64decode(prof["attributes"]["profileContent"])
        uuid = prof["attributes"]["uuid"]
        for d in dirs:
            (d / f"{uuid}.mobileprovision").write_bytes(content)
        env.append(f"TREX_PROFILE_{label}={name}")
    print("\n".join(env))


def cleanup():
    if not STATE.exists():
        return
    state = json.loads(STATE.read_text())
    for pid in state.get("profiles", []):
        requests.delete(f"{API}/profiles/{pid}", headers={"Authorization": "Bearer " + token()}, timeout=60)
    if state.get("certificate"):
        requests.delete(f"{API}/certificates/{state['certificate']}", headers={"Authorization": "Bearer " + token()}, timeout=60)
    kc = TMP / "ci.keychain-db"
    if kc.exists():
        subprocess.run(["security", "delete-keychain", str(kc)])


if __name__ == "__main__":
    {"setup": setup, "cleanup": cleanup}[sys.argv[1]]()
