#!/usr/bin/env python3
"""Fill in the App Store listing through the App Store Connect API.

Version string + copyright, English (U.S.) description/keywords/URLs, subtitle,
privacy policy URL, category, age rating, free price, availability everywhere,
review contact + notes, the newest build, and 6.9-inch iPhone screenshots.
Each part reports a GitHub notice (ok) or warning (skipped, with the reason).
Needs KEY_ID, ISSUER_ID, KEY_PATH. Screenshots from store/appstore/iphone-69-*.png.
"""
import glob, hashlib, os, pathlib, re, sys, time
import jwt, requests

API = "https://api.appstoreconnect.apple.com"
BUNDLE = "com.lumisha.trexpanda"
VERSION = os.environ.get("APP_VERSION", "0.3.12")

DESCRIPTION = """Stop typing the same things over and over. Trexpanda turns short triggers into full text: your address, an email sign-off, a meeting link, or a reply you send every day.

- Type ;addr and it becomes your full address, in any app, with the Trexpanda keyboard
- Suggestions appear as you type, so you never forget a trigger
- Attach an image or a file to a snippet and send it along with the text
- Dates and times fill themselves in with {date} and {time}
- Put the cursor exactly where you want it after expanding
- Optional sign-in keeps your snippets in sync with Trexpanda on your computer and Android phone
- Works fully offline without an account

Private by design: Trexpanda never records or sends what you type. The keyboard only reads the snippets you saved in the app. You can delete your account and all cloud data at any time from inside the app."""
KEYWORDS = "text expander,snippets,shortcuts,keyboard,autotext,templates,typing,productivity,quick replies"
PROMO = "Type a short trigger like ;addr and get your full text, image or file. Synced with your PC and Android."
NOTES = """Trexpanda is a text-expansion keyboard. To test: open the app, tap "Set up the Trexpanda keyboard", then in Settings > Keyboards enable Trexpanda and Allow Full Access. In Notes, switch to the Trexpanda keyboard (globe key) and type ;ty - it expands to "Thank you so much!". Sample snippets are pre-loaded; no account is needed.
Full Access is used only to read the snippets saved in the app (shared App Group container) and to copy a snippet's attachment to the clipboard. The keyboard does not use the network and does not log keystrokes.
Sign-in is optional (Sign in with Apple or Google) and only used for syncing snippets. Account deletion: Account > Delete account (Sign in with Apple tokens are revoked)."""


def token():
    now = int(time.time())
    return jwt.encode({"iss": os.environ["ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      pathlib.Path(os.environ["KEY_PATH"]).read_text(), algorithm="ES256",
                      headers={"kid": os.environ["KEY_ID"], "typ": "JWT"})


def call(method, path, body=None):
    url = path if path.startswith("http") else API + (path if path.startswith("/v") else "/v1" + path)
    r = requests.request(method, url, headers={"Authorization": "Bearer " + token()}, json=body, timeout=120)
    if r.status_code >= 300:
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:700]}")
    return r.json() if r.content else {}


def note(msg): print(f"::notice::{msg}", flush=True)
def warn(msg): print(f"::warning::{msg}", flush=True)


def step(name, fn):
    try:
        fn(); note(f"{name}: done")
    except Exception as e:  # keep going; report every part
        warn(f"{name}: {e}")


def patch_dropping_unknown(path, typ, oid, attrs):
    """PATCH, dropping attributes this API version doesn't know about."""
    attrs = dict(attrs)
    for _ in range(25):
        try:
            return call("PATCH", path, {"data": {"type": typ, "id": oid, "attributes": attrs}})
        except RuntimeError as e:
            m = re.search(r"/data/attributes/(\w+)", str(e))
            if not m or m.group(1) not in attrs:
                raise
            attrs.pop(m.group(1))


def main():
    app = call("GET", f"/apps?filter[bundleId]={BUNDLE}")["data"][0]
    app_id = app["id"]
    versions = call("GET", f"/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=10")["data"]
    ver = next(v for v in versions if v["attributes"]["appStoreState"] in
               ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"))
    vid = ver["id"]

    step("Version and copyright", lambda: call("PATCH", f"/appStoreVersions/{vid}", {"data": {
        "type": "appStoreVersions", "id": vid,
        "attributes": {"versionString": VERSION, "copyright": "2026 Lumisha LLC"}}}))

    def localization():
        locs = call("GET", f"/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]
        loc = next(l for l in locs if l["attributes"]["locale"] == "en-US")
        call("PATCH", f"/appStoreVersionLocalizations/{loc['id']}", {"data": {
            "type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": {
                "description": DESCRIPTION, "keywords": KEYWORDS, "promotionalText": PROMO,
                "supportUrl": "https://trexpanda.com", "marketingUrl": "https://trexpanda.com"}}})
        return loc["id"]
    loc_id = {}
    step("Description, keywords and URLs", lambda: loc_id.setdefault("id", localization()))

    infos = call("GET", f"/apps/{app_id}/appInfos")["data"]
    info = next((i for i in infos if i["attributes"].get("appStoreState", i["attributes"].get("state")) not in
                 ("READY_FOR_SALE", "READY_FOR_DISTRIBUTION")), infos[0])

    def app_info():
        ils = call("GET", f"/appInfos/{info['id']}/appInfoLocalizations")["data"]
        il = next(l for l in ils if l["attributes"]["locale"] == "en-US")
        call("PATCH", f"/appInfoLocalizations/{il['id']}", {"data": {"type": "appInfoLocalizations", "id": il["id"],
             "attributes": {"subtitle": "Text expander keyboard", "privacyPolicyUrl": "https://trexpanda.com/privacy.html"}}})
        call("PATCH", f"/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
            "primaryCategory": {"data": {"type": "appCategories", "id": "PRODUCTIVITY"}},
            "secondaryCategory": {"data": {"type": "appCategories", "id": "BUSINESS"}}}}})
    step("Subtitle, privacy policy and category", app_info)

    def age():
        decl = call("GET", f"/appInfos/{info['id']}/ageRatingDeclaration")["data"]
        none = "NONE"
        patch_dropping_unknown(f"/ageRatingDeclarations/{decl['id']}", "ageRatingDeclarations", decl["id"], {
            "alcoholTobaccoOrDrugUseOrReferences": none, "contests": none, "gamblingSimulated": none,
            "gunsOrOtherWeapons": none, "horrorOrFearThemes": none, "matureOrSuggestiveThemes": none,
            "medicalOrTreatmentInformation": none, "profanityOrCrudeHumor": none,
            "sexualContentGraphicAndNudity": none, "sexualContentOrNudity": none,
            "violenceCartoonOrFantasy": none, "violenceRealistic": none,
            "violenceRealisticProlongedGraphicOrSadistic": none,
            "gambling": False, "unrestrictedWebAccess": False, "lootBox": False, "messagingAndChat": False,
            "userGeneratedContent": False, "advertising": False, "ageAssurance": False,
            "healthOrWellnessTopics": False, "parentalControls": False, "kidsAgeBand": None})
    step("Age rating (4+)", age)

    def price():
        pts = call("GET", f"/apps/{app_id}/appPricePoints?filter[territory]=USA&limit=200")["data"]
        free = next(p for p in pts if float(p["attributes"]["customerPrice"]) == 0)
        call("POST", "/appPriceSchedules", {"data": {"type": "appPriceSchedules", "relationships": {
            "app": {"data": {"type": "apps", "id": app_id}},
            "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
            "manualPrices": {"data": [{"type": "appPrices", "id": "${p0}"}]}}},
            "included": [{"type": "appPrices", "id": "${p0}", "attributes": {"startDate": None},
                          "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}]})
    step("Price: free", price)

    def availability():
        terr = call("GET", "/territories?limit=200")["data"]
        inc = [{"type": "territoryAvailabilities", "id": f"${{t{i}}}", "attributes": {"available": True},
                "relationships": {"territory": {"data": {"type": "territories", "id": t["id"]}}}}
               for i, t in enumerate(terr)]
        call("POST", "/v2/appAvailabilities", {"data": {"type": "appAvailabilities",
            "attributes": {"availableInNewTerritories": True},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}},
                              "territoryAvailabilities": {"data": [{"type": i["type"], "id": i["id"]} for i in inc]}}},
            "included": inc})
    step("Availability: all countries", availability)

    def review():
        attrs = {"contactFirstName": "Amit", "contactLastName": "Roda", "contactEmail": "amit@lumisha.in",
                 "demoAccountRequired": False, "notes": NOTES}
        if os.environ.get("REVIEW_PHONE"):
            attrs["contactPhone"] = os.environ["REVIEW_PHONE"]
        try:
            d = call("GET", f"/appStoreVersions/{vid}/appStoreReviewDetail")["data"]
        except RuntimeError:
            d = None
        if d:
            call("PATCH", f"/appStoreReviewDetails/{d['id']}", {"data": {"type": "appStoreReviewDetails", "id": d["id"], "attributes": attrs}})
        else:
            call("POST", "/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": attrs,
                 "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
    step("App Review contact and notes", review)

    def build():
        for _ in range(60):  # wait for Apple to finish processing the newest upload
            b = call("GET", f"/builds?filter[app]={app_id}&filter[preReleaseVersion.version]={VERSION}"
                             f"&sort=-uploadedDate&limit=1")["data"][0]
            if b["attributes"]["processingState"] != "PROCESSING":
                break
            time.sleep(30)
        if b["attributes"]["processingState"] != "VALID":
            raise RuntimeError(f"newest build {b['attributes']['version']} is {b['attributes']['processingState']}")
        call("PATCH", f"/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": b["id"]}})
        note(f"Attached build {b['attributes']['version']}")
    step("Attach build", build)

    def screenshots():
        lid = loc_id.get("id") or localization()
        sets = call("GET", f"/appStoreVersionLocalizations/{lid}/appScreenshotSets")["data"]
        ss = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == "APP_IPHONE_67"), None)
        if ss:
            for old in call("GET", f"/appScreenshotSets/{ss['id']}/appScreenshots")["data"]:
                call("DELETE", f"/appScreenshots/{old['id']}")
        else:
            ss = call("POST", "/appScreenshotSets", {"data": {"type": "appScreenshotSets",
                 "attributes": {"screenshotDisplayType": "APP_IPHONE_67"},
                 "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": lid}}}}})["data"]
        for f in sorted(glob.glob("store/appstore/iphone-69-*.png")):
            data = pathlib.Path(f).read_bytes()
            shot = call("POST", "/appScreenshots", {"data": {"type": "appScreenshots",
                "attributes": {"fileName": os.path.basename(f), "fileSize": len(data)},
                "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": ss["id"]}}}}})["data"]
            for op in shot["attributes"]["uploadOperations"]:
                chunk = data[op["offset"]:op["offset"] + op["length"]]
                requests.request(op["method"], op["url"], data=chunk,
                                 headers={h["name"]: h["value"] for h in op["requestHeaders"]}, timeout=120).raise_for_status()
            call("PATCH", f"/appScreenshots/{shot['id']}", {"data": {"type": "appScreenshots", "id": shot["id"],
                 "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    step("iPhone 6.9-inch screenshots", screenshots)


if __name__ == "__main__":
    main()
