package com.lumisha.trexpanda

import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Starts the main screen the way a phone does (create → start → resume) and
 * checks it renders. Guards against crash-on-launch regressions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LaunchSmokeTest {

    @Test
    fun mainActivityLaunchesSignedOut() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        assertNotNull(activity.findViewById<View>(R.id.recycler))
        assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.signInButton).visibility)
        controller.pause().stop().destroy()
    }

    @Test
    fun keyboardServiceCreates() {
        val service = Robolectric.buildService(TrexpandaImeService::class.java).create().get()
        assertNotNull(service)
    }
}
