import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Supabase URL + anon key come from local.properties (or environment variables),
// never hard-coded. They are public values (anon key), gated by RLS on the server.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(key: String): String = localProps.getProperty(key) ?: System.getenv(key) ?: ""

// Store version. CI passes these (-PtrexVersionCode / -PtrexVersionName); local
// builds use the defaults. versionCode must keep increasing for every Play upload,
// and stays above 11, the version of the APK already published on trexpanda.com.
val trexVersionCode = (project.findProperty("trexVersionCode") as String?)?.toInt() ?: 12
val trexVersionName = (project.findProperty("trexVersionName") as String?) ?: "0.3.5"

// Release (upload-key) signing. Locally: keystore.properties (git-ignored).
// In CI: ANDROID_KEYSTORE_FILE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS /
// ANDROID_KEY_PASSWORD environment variables from repository secrets. No signing
// material is ever committed. Without either, debug builds still work.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
fun signingValue(propKey: String, envKey: String): String? =
    (keystoreProps[propKey] as String?) ?: System.getenv(envKey)?.takeIf { it.isNotBlank() }
val releaseStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
val hasReleaseSigning = releaseStoreFile != null

android {
    namespace = "com.lumisha.trexpanda"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lumisha.trexpanda"
        minSdk = 26
        // Google Play requires new apps and updates to target Android 16 (API 36)
        // from 31 Aug 2026.
        targetSdk = 36
        versionCode = trexVersionCode
        versionName = trexVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "SUPABASE_URL", "\"${secret("SUPABASE_URL")}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${secret("SUPABASE_ANON_KEY")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Robolectric needs merged resources to inflate real layouts in unit tests.
        unitTests.isIncludeAndroidResources = true
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    // Launches the real activities on the JVM, so a startup crash fails CI.
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
}
