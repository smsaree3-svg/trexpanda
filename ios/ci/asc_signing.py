#!/usr/bin/env python3
"""App Store signing for CI through the App Store Connect API.

  setup:   create an Apple Distribution certificate (from a CSR made here) and
           App Store provisioning profiles for the app and keyboard, install
           them, and print the profile names as GitHub env lines.
  cleanup: remove the temporary keychain only.

The certificate and profiles must STAY VALID until Apple has reviewed the build:
revoking them right after the upload made App Review reject the build with
ITMS-90035 "Invalid Signature". Instead, setup retires only OLD CI certificates
(keeping the newest one, which may sign a build still in review) so the team
never hits Apple's distribution-certificate limit.
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


def retire_old_ci_certificates(keep=1):
    """Revoke CI-made distribution certificates beyond the newest `keep`.

    CI certificates are the ones used by profiles named "... AppStore CI <run>".
    Their profiles are deleted with them."""
    profs = call("GET", "/profiles?filter[profileType]=IOS_APP_STORE&limit=200")["data"]
    ci = [p for p in profs if " AppStore CI " in p["attributes"]["name"]]
    by_cert = {}
    for p in ci:
        for c in call("GET", f"/profiles/{p['id']}/certificates")["data"]:
            by_cert.setdefault(c["id"], {"cert": c, "profiles": []})["profiles"].append(p["id"])
    certs = sorted(by_cert.values(), key=lambda x: x["cert"]["attributes"].get("expirationDate") or "", reverse=True)
    for old in certs[keep:]:
        for pid in old["profiles"]:
            requests.delete(f"{API}/profiles/{pid}", headers={"Authorization": "Bearer " + token()}, timeout=60)
        requests.delete(f"{API}/certificates/{old['cert']['id']}", headers={"Authorization": "Bearer " + token()}, timeout=60)
        print(f"Retired old CI certificate {old['cert']['id']}", file=sys.stderr)


def setup():
    run = os.environ.get("GITHUB_RUN_ID", str(int(time.time())))
    try:
        retire_old_ci_certificates(keep=1)  # the newest may sign a build that's in review
    except (Exception, SystemExit) as e:
        print(f"::warning::Could not retire old CI certificates: {e}", file=sys.stderr)
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
    # The certificate and profiles are kept: the uploaded build needs them to stay
    # valid through App Review. Only the local keychain goes.
    kc = TMP / "ci.keychain-db"
    if kc.exists():
        subprocess.run(["security", "delete-keychain", str(kc)])


if __name__ == "__main__":
    {"setup": setup, "cleanup": cleanup}[sys.argv[1]]()
