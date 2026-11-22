# CiviFix AI — Native Android Architecture Guide

Welcome to the **CiviFix AI** Android project repository.

## 📱 Tech Stack
- **Language**: Kotlin 2.0+
- **UI Toolkit**: Jetpack Compose with Material 3
- **Architecture**: MVI / MVVM with Compose State & Coroutines
- **Target SDK**: Android 35 (minSdk 26 - Android 8.0+)
- **Theme**: Civic Green (#15803D), White (#FFFFFF), and Deep Navy Blue (#0F1E36)

## 📁 Project Directory Structure
```
android/
├── app/
│   ├── build.gradle.kts           // Dependencies, Compose BOM, SDK 35
│   └── src/main/
│       ├── AndroidManifest.xml    // Location, Camera, Internet permissions
│       └── java/org/civifix/ai/
│           ├── MainActivity.kt    // Compose Root Container
│           ├── ui/
│           │   ├── theme/         // Color.kt, Theme.kt, Type.kt
│           │   ├── navigation/    // CiviFixNavGraph.kt (6-Tab Scaffold)
│           │   └── screens/       // HomeScreen, ReportIssueScreen, etc.
│           └── data/              // Models, Repositories, Storage
└── README.md
```

## 🔒 Security & Backend Integration Blueprint
1. **Zero Secret Exposure**: Never bundle municipal private tokens or Gemini API keys inside the APK. Route all requests through a secure backend proxy.
2. **Authentication**: Planned Firebase Phone Auth (SMS OTP) & Google Sign-In.
3. **Database & Storage**: Planned Cloud Firestore for geo-tagged tickets and Cloud Storage for camera images.
4. **Authority Redressal**: Webhook synchronization with City Municipal Grievance portals.
