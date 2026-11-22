package org.civifix.ai.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddAlert
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.compose.*
import org.civifix.ai.ui.screens.*

sealed class Screen(val route: String, val title: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    object Home : Screen("home", "Home", Icons.Default.Home)
    object Report : Screen("report", "Report", Icons.Default.AddAlert)
    object Reports : Screen("reports", "My Reports", Icons.Default.Assignment)
    object CivicAI : Screen("civic_ai", "Civic AI", Icons.Default.AutoAwesome)
    object Awareness : Screen("awareness", "Awareness", Icons.Default.Info)
    object Profile : Screen("profile", "Profile", Icons.Default.Person)
}

@Composable
fun CiviFixNavGraph() {
    val navController = rememberNavController()
    var isUserLoggedIn by remember { mutableStateOf(true) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentRoute = navBackStackEntry?.destination?.route
                val items = listOf(
                    Screen.Home, Screen.Report, Screen.Reports,
                    Screen.CivicAI, Screen.Awareness, Screen.Profile
                )

                items.forEach { screen ->
                    NavigationBarItem(
                        icon = { Icon(screen.icon, contentDescription = screen.title) },
                        label = { Text(screen.title) },
                        selected = currentRoute == screen.route,
                        onClick = {
                            if (currentRoute != screen.route) {
                                navController.navigate(screen.route) {
                                    popUpTo(Screen.Home.route) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Screen.Home.route,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Home.route) {
                HomeScreen(
                    onNavigateToReport = { navController.navigate(Screen.Report.route) },
                    onNavigateToReports = { navController.navigate(Screen.Reports.route) },
                    onNavigateToCivicAI = { navController.navigate(Screen.CivicAI.route) },
                    onNavigateToAwareness = { navController.navigate(Screen.Awareness.route) }
                )
            }
            composable(Screen.Report.route) {
                ReportIssueScreen(onReportSubmitted = { navController.navigate(Screen.Reports.route) })
            }
            composable(Screen.Reports.route) {
                MyReportsScreen(onNewReportClick = { navController.navigate(Screen.Report.route) })
            }
            composable(Screen.CivicAI.route) {
                CivicAiScreen()
            }
            composable(Screen.Awareness.route) {
                AwarenessScreen()
            }
            composable(Screen.Profile.route) {
                ProfileScreen(onSignOut = { isUserLoggedIn = false })
            }
        }
    }
}
