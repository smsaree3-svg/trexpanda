package com.lumisha.trexpanda

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UsageStatsTest {

    @Test
    fun recordsCountsAndSavedCharacters() {
        val c = ApplicationProvider.getApplicationContext<Context>()
        UsageStats.reset(c)
        UsageStats.record(c, "a", 5, 28)
        UsageStats.record(c, "a", 5, 28)
        UsageStats.record(c, "t:;x", 5, 2)
        val u = UsageStats.local(c)
        assertEquals(2, u.getJSONObject("byKey").getJSONObject("a").getInt("count"))
        assertEquals(3L, u.getJSONObject("totals").getLong("expansions"))
        assertEquals(46L, u.getJSONObject("totals").getLong("savedChars"))
    }

    @Test
    fun combinesDevicesAndSkipsOwnRow() {
        val local = JSONObject("""{"byKey":{"a":{"count":3,"lastUsedAt":"2026-10-02T00:00:00Z"}},"totals":{"expansions":3,"savedChars":60}}""")
        val rows = listOf(
            JSONObject("""{"device_id":"me","by_key":{"a":{"count":1}},"totals":{"expansions":1,"savedChars":20}}"""),
            JSONObject("""{"device_id":"pc","by_key":{"a":{"count":5,"lastUsedAt":"2026-10-05T00:00:00Z"},"b":{"count":2}},"totals":{"expansions":7,"savedChars":140}}"""),
        )
        val c = UsageStats.combine(local, rows, "me")
        assertEquals(8, c.getJSONObject("byKey").getJSONObject("a").getInt("count"))
        assertEquals("2026-10-05T00:00:00Z", c.getJSONObject("byKey").getJSONObject("a").getString("lastUsedAt"))
        assertEquals(10L, c.getJSONObject("totals").getLong("expansions"))
        assertEquals(200L, c.getJSONObject("totals").getLong("savedChars"))
        assertEquals(2, c.getJSONObject("totals").getInt("devices"))
        // 200 chars = 40 words; at 35 WPM that's ~1.14 minutes.
        assertEquals(40.0 / 35.0, UsageStats.minutesSaved(c, 35), 1e-9)
    }
}
