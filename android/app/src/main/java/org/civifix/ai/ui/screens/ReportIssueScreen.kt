package org.civifix.ai.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ReportIssueScreen(
    onReportSubmitted: () -> Unit
) {
    var selectedCategory by remember { mutableStateOf("Garbage Accumulation") }
    var issueTitle by remember { mutableStateOf("") }
    var issueDescription by remember { mutableStateOf("") }
    var locationAddress by remember { mutableStateOf("Ward 47 - Metro Green Zone") }
    var isSubmitting by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("Report Civic Problem", style = MaterialTheme.typography.headlineMedium)

        // Transparency Disclaimer
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    text = "Citizen Prototype Notice: In this initial client architecture, reports are stored locally. Official submission requires integration with municipal ULB grievance endpoints.",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        OutlinedTextField(
            value = issueTitle,
            onValueChange = { issueTitle = it },
            label = { Text("Issue Title (e.g., Overflowing dumpster)") },
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = issueDescription,
            onValueChange = { issueDescription = it },
            label = { Text("Detailed Description") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = locationAddress,
            onValueChange = { locationAddress = it },
            label = { Text("Location / Landmark") },
            modifier = Modifier.fillMaxWidth()
        )

        Button(
            onClick = {
                isSubmitting = true
                onReportSubmitted()
            },
            enabled = issueTitle.isNotBlank() && !isSubmitting,
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp)
        ) {
            Text("Submit Civic Report")
        }
    }
}
