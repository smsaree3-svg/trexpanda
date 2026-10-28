import Foundation

/// Snippet use counts and characters saved — same shape as the desktop and
/// Android apps (`usage_stats` row). The keyboard records uses into the App
/// Group container (it needs "Allow Full Access" to write there); the app
/// uploads them as this iPhone's row and caches the all-devices total.
struct UsageEntry: Codable, Equatable {
    var count: Int
    var lastUsedAt: String?
}

struct UsageTotals: Codable, Equatable {
    var expansions: Int = 0
    var savedChars: Int = 0
    var typedChars: Int = 0
    var since: String?
    var devices: Int?
}

struct UsageData: Codable, Equatable {
    var byKey: [String: UsageEntry] = [:]
    var totals = UsageTotals()

    func count(for s: Snippet) -> Int {
        let c = byKey[s.id]?.count ?? 0
        return c > 0 ? c : (byKey["t:" + s.trigger]?.count ?? 0)
    }

    /// Minutes saved at `wpm` words per minute (5 characters = 1 word).
    func minutesSaved(wpm: Int = 35) -> Double { Double(totals.savedChars) / 5.0 / Double(max(5, wpm)) }

    static func formatDuration(_ min: Double) -> String {
        if min <= 0 { return "0 min" }
        if min < 1 { return "\(max(1, Int(min * 60))) sec" }
        if min < 60 { return "\(Int(min.rounded())) min" }
        let h = Int(min / 60)
        return "\(h)h \(Int((min - Double(h) * 60).rounded()))m"
    }
}

enum UsageLog {
    private static let localFile = "usage-local.json"
    private static let combinedFile = "usage-combined.json"
    private static let deviceFile = "usage-device.json"

    private static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedStore.appGroup)
    }

    static func local() -> UsageData { read(UsageData.self, localFile) ?? UsageData() }
    static func combined() -> UsageData { read(UsageData.self, combinedFile) ?? local() }
    static func saveCombined(_ u: UsageData) { write(u, combinedFile) }
    static func reset() { write(UsageData(), localFile); write(UsageData(), combinedFile) }

    static func deviceId() -> String {
        if let id = read(String.self, deviceFile) { return id }
        let id = UUID().uuidString.lowercased()
        write(id, deviceFile)
        return id
    }

    /// Record one expansion (called by the keyboard).
    static func record(key: String, typedChars: Int, outChars: Int) {
        let now = ISO8601DateFormatter().string(from: Date())
        let saved = max(0, outChars - max(0, typedChars))
        func bump(_ u: inout UsageData) {
            if !key.isEmpty { u.byKey[key] = UsageEntry(count: (u.byKey[key]?.count ?? 0) + 1, lastUsedAt: now) }
            u.totals.expansions += 1
            u.totals.savedChars += saved
            u.totals.typedChars += max(0, typedChars)
            if u.totals.since == nil { u.totals.since = now }
        }
        var u = local(); bump(&u); write(u, localFile)
        if var c = read(UsageData.self, combinedFile) { bump(&c); write(c, combinedFile) }
    }

    /// Combine this device's numbers with the other devices' cloud rows.
    static func combine(local: UsageData, rows: [[String: Any]], deviceId: String) -> UsageData {
        var out = UsageData()
        var devices = 0
        func add(_ byKey: [String: Any], _ t: [String: Any]) {
            devices += 1
            for (k, v) in byKey {
                guard let e = v as? [String: Any] else { continue }
                var cur = out.byKey[k] ?? UsageEntry(count: 0, lastUsedAt: nil)
                cur.count += max(0, (e["count"] as? NSNumber)?.intValue ?? 0)
                if let lu = e["lastUsedAt"] as? String, cur.lastUsedAt == nil || lu > cur.lastUsedAt! { cur.lastUsedAt = lu }
                out.byKey[k] = cur
            }
            out.totals.expansions += max(0, (t["expansions"] as? NSNumber)?.intValue ?? 0)
            out.totals.savedChars += max(0, (t["savedChars"] as? NSNumber)?.intValue ?? 0)
            out.totals.typedChars += max(0, (t["typedChars"] as? NSNumber)?.intValue ?? 0)
            if let s = t["since"] as? String, out.totals.since == nil || s < out.totals.since! { out.totals.since = s }
        }
        add(toJSON(local.byKey), toJSON(local.totals))
        for r in rows where (r["device_id"] as? String) != deviceId {
            add(r["by_key"] as? [String: Any] ?? [:], r["totals"] as? [String: Any] ?? [:])
        }
        out.totals.devices = devices
        return out
    }

    static func toJSON<T: Encodable>(_ v: T) -> [String: Any] {
        guard let d = try? JSONEncoder().encode(v) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    }

    private static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let u = container?.appendingPathComponent(name), let data = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func write<T: Encodable>(_ value: T, _ name: String) {
        guard let u = container?.appendingPathComponent(name), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: u, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
