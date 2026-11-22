package org.civifix.ai.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColorScheme = darkColorScheme(
    primary = CivicGreenPrimary,
    onPrimary = CivicGreenOnPrimary,
    primaryContainer = CivicGreenContainer,
    background = NavyPrimary,
    surface = NavySurface,
    onBackground = NavyOnSurface,
    onSurface = NavyOnSurface
)

private val LightColorScheme = lightColorScheme(
    primary = CivicGreenPrimary,
    onPrimary = CivicGreenOnPrimary,
    primaryContainer = CivicGreenContainer,
    background = CivicWhite,
    surface = CivicWhite,
    onBackground = NavyPrimary,
    onSurface = NavyPrimary
)

@Composable
fun CiviFixAITheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    val view = LocalView.current

    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
