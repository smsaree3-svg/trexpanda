#!/usr/bin/env python3
"""TestFlight setup through the App Store Connect API.

Creates (once) an internal tester group with access to every build, adds the
testers, waits for the newest build to finish processing, answers export
compliance, and reports what happened as GitHub notices.
Needs KEY_ID, ISSUER_ID, KEY_PATH; TESTERS="email:First:Last,..." optional.
"""
import os, pathlib, sys, time
import jwt, requests

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE = "com.lumisha.trexpanda"
GROUP = "Lumisha team"


def token():
    now = int(time.time())
    return jwt.encode({"iss": os.environ["ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      pathlib.Path(os.environ["KEY_PATH"]).read_text(), algorithm="ES256",
                      headers={"kid": os.environ["KEY_ID"], "typ": "JWT"})


def call(method, path, body=None, ok_fail=False):
    r = requests.request(method, API + path, headers={"Authorization": "Bearer " + token()}, json=body, timeout=60)
    if r.status_code >= 300:
        if ok_fail:
            return {"_error": r.status_code, "_text": r.text[:400]}
        sys.exit(f"::error::{method} {path} -> {r.status_code}: {r.text[:600]}")
    return r.json() if r.content else {}


def note(msg):
    print(f"::notice::{msg}", flush=True)


def main():
    app = call("GET", f"/apps?filter[bundleId]={BUNDLE}")["data"][0]
    app_id = app["id"]
    note(f"App: {app['attributes']['name']} ({app_id})")

    # Newest build: wait until Apple has processed it.
    build = None
    for _ in range(60):
        builds = call("GET", f"/builds?filter[app]={app_id}&sort=-uploadedDate&limit=1")["data"]
        if builds:
            build = builds[0]
            state = build["attributes"]["processingState"]
            if state != "PROCESSING":
                break
        time.sleep(30)
    if not build:
        sys.exit("::error::No build found in App Store Connect yet.")
    a = build["attributes"]
    note(f"Build {a['version']} state {a['processingState']}, expires {a.get('expirationDate')}")
    if a.get("usesNonExemptEncryption") is None:
        res = call("PATCH", f"/builds/{build['id']}", {"data": {"type": "builds", "id": build["id"],
                   "attributes": {"usesNonExemptEncryption": False}}}, ok_fail=True)
        note("Export compliance: " + ("answered (standard encryption only)" if "_error" not in res else str(res)))

    # Internal group with access to all builds (new builds reach testers automatically).
    groups = call("GET", f"/apps/{app_id}/betaGroups?limit=50")["data"]
    group = next((g for g in groups if g["attributes"]["name"] == GROUP), None)
    if not group:
        group = call("POST", "/betaGroups", {"data": {"type": "betaGroups",
            "attributes": {"name": GROUP, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
        note(f"Created internal group '{GROUP}'")
    else:
        note(f"Internal group '{GROUP}' exists")

    for spec in [t for t in os.environ.get("TESTERS", "").split(",") if t.strip()]:
        email, first, last = (spec.split(":") + ["", ""])[:3]
        res = call("POST", "/betaTesters", {"data": {"type": "betaTesters",
            "attributes": {"email": email, "firstName": first or None, "lastName": last or None},
            "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": group["id"]}]}}}}, ok_fail=True)
        if "_error" not in res:
            note(f"Tester added: {email}")
            continue
        # Internal testers must be team members: invite them to the team first.
        inv = call("POST", "/userInvitations", {"data": {"type": "userInvitations", "attributes": {
            "email": email, "firstName": first or "Tester", "lastName": last or "Trexpanda",
            "roles": ["DEVELOPER"], "allAppsVisible": True, "provisioningAllowed": False}}}, ok_fail=True)
        note(f"Tester {email}: not on the team yet ({res['_error']}). Team invite: " +
             ("sent - accept the email, then re-run" if "_error" not in inv else f"failed {inv['_error']} {inv['_text']}"))

    testers = call("GET", f"/betaGroups/{group['id']}/betaTesters?limit=50")["data"]
    note("Group testers: " + ", ".join(f"{t['attributes'].get('email')} ({t['attributes'].get('state')})" for t in testers))


if __name__ == "__main__":
    main()
