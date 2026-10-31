import Foundation

/// Cross-device merge: the Swift port of Android's `SyncMerge` and the desktop
/// `mergeSnippetsForSync`. Last write wins per id by timestamp (ties go to the
/// remote); deletions travel both ways as tombstones; tombstones older than the
/// TTL are pruned. Pure, so it behaves identically on every platform.
enum SyncMerge {
    static let tombstoneTTLms: Int64 = 120 * 24 * 60 * 60 * 1000 // 120 days

    struct Result {
        var live: [Snippet]
        var tombstones: [Tombstone]
        /// Rows to upsert. A row with `deletedAt != nil` is a deletion.
        var push: [Snippet]
    }

    private struct LocalState {
        let dead: Bool
        let ts: Int64
        let snippet: Snippet?
        let tombstone: Tombstone?
    }

    static func merge(live: [Snippet], tombstones: [Tombstone], remote: [Snippet],
                      now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> Result {
        var localById: [String: LocalState] = [:]
        var order: [String] = []
        for s in live {
            if localById[s.id] == nil { order.append(s.id) }
            localById[s.id] = LocalState(dead: false, ts: s.updatedAt, snippet: s, tombstone: nil)
        }
        for t in tombstones {
            if let existing = localById[t.id], t.deletedAt <= existing.ts { continue }
            if localById[t.id] == nil { order.append(t.id) }
            localById[t.id] = LocalState(dead: true, ts: t.deletedAt, snippet: nil, tombstone: t)
        }
        var remoteById: [String: Snippet] = [:]
        for r in remote {
            if localById[r.id] == nil && remoteById[r.id] == nil { order.append(r.id) }
            remoteById[r.id] = r
        }

        var out = Result(live: [], tombstones: [], push: [])
        func keepTomb(_ t: Tombstone) {
            if now - t.deletedAt <= tombstoneTTLms { out.tombstones.append(t) }
        }
        func adoptRemote(_ r: Snippet) {
            if let d = r.deletedAt { keepTomb(Tombstone(id: r.id, deletedAt: d)) } else { out.live.append(r) }
        }
        func pushLocal(_ l: LocalState) {
            if l.dead, let t = l.tombstone {
                keepTomb(t)
                out.push.append(deletionRow(t))
            } else if let s = l.snippet {
                out.live.append(s)
                out.push.append(s)
            }
        }

        for id in order {
            switch (localById[id], remoteById[id]) {
            case (nil, let r?):
                adoptRemote(r)                       // never seen locally: adopt, don't push
            case (let l?, nil):
                pushLocal(l)                         // remote never saw it: push
            case (let l?, let r?):
                let remoteTs = r.deletedAt ?? r.updatedAt
                // An image/file is only removed on purpose in the editor: if the
                // winning copy simply lacks it, keep the other copy's attachment.
                if l.ts > remoteTs {
                    if !l.dead, var s = l.snippet, s.attachment == nil, r.deletedAt == nil,
                       let ra = r.attachment, s.attachmentCleared != true {
                        s.attachment = ra
                        pushLocal(LocalState(dead: false, ts: l.ts, snippet: s, tombstone: nil))
                    } else { pushLocal(l) }
                } else if r.deletedAt == nil, r.attachment == nil, r.attachmentCleared != true, !l.dead, let la = l.snippet?.attachment {
                    var s = r
                    s.attachment = la
                    s.updatedAt = max(r.updatedAt, l.ts)
                    out.live.append(s)
                    out.push.append(s)               // the cloud copy lost it: send it back
                } else { adoptRemote(r) }
            default:
                break
            }
        }
        return out
    }

    private static func deletionRow(_ t: Tombstone) -> Snippet {
        // `trigger` isn't known for a tombstone; the server column is nullable and
        // the deletion is identified by id. Empty string keeps the model non-optional.
        Snippet(id: t.id, trigger: "", replacement: "", updatedAt: t.deletedAt, deletedAt: t.deletedAt)
    }
}

/// When the user saves the list from the UI: stamp only real changes, tombstone
/// removed ids, and cancel tombstones for re-added ids (port of SnippetReconcile).
enum SnippetReconcile {
    static func reconcile(current: [Snippet], tombstones: [Tombstone], incoming: [Snippet],
                          now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> ([Snippet], [Tombstone]) {
        let currentById = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        var tombById = Dictionary(tombstones.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        var outLive: [Snippet] = []
        var kept = Set<String>()
        for var inc in incoming {
            if inc.id.isEmpty { inc.id = UUID().uuidString.lowercased() }
            if inc.attachment != nil { inc.attachmentCleared = nil }
            else if let existing = currentById[inc.id], existing.attachment != nil || existing.attachmentCleared == true {
                inc.attachmentCleared = true             // removed on purpose here
            }
            if let existing = currentById[inc.id], signature(existing) == signature(inc) {
                inc.updatedAt = existing.updatedAt
            } else {
                inc.updatedAt = now
            }
            inc.deletedAt = nil
            outLive.append(inc)
            kept.insert(inc.id)
            tombById[inc.id] = nil
        }
        for c in current where !kept.contains(c.id) {
            tombById[c.id] = Tombstone(id: c.id, deletedAt: now)
        }
        return (outLive, Array(tombById.values))
    }

    private static func signature(_ s: Snippet) -> String {
        let att = s.attachment.map { "\($0.type)|\($0.name)|\($0.mime)|\($0.data.count)|\($0.data.suffix(64))" } ?? ""
        return [s.trigger, s.replacement, s.label ?? "", s.html ?? "", s.enabled ? "1" : "0", att].joined(separator: "\u{1F}")
    }
}
