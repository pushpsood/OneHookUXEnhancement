output "app_service_default_hostname" {
  value = azurerm_linux_web_app.app.default_hostname
}

output "app_service_name" {
  value = azurerm_linux_web_app.app.name
}

output "storage_account_name" {
  value = azurerm_storage_account.storage.name
}


output "openai_endpoint" {
  value = azurerm_cognitive_account.openai.endpoint
}

output "session_storage_container_name" {
  value = azurerm_storage_container.session_container.name
}


output "stage" {
  value = var.stage
}

# Public value written as the Route53 TXT record `asuid.<custom_domain>` (domain ownership proof).
# The provider flags it sensitive, but it is public by design (it is published in DNS).
output "custom_domain_verification_id" {
  value     = azurerm_linux_web_app.app.custom_domain_verification_id
  sensitive = true
}

output "custom_domain" {
  value = var.custom_domain
}

# The URL clients should use: the custom domain once bound, otherwise the default Azure hostname.
output "chatbot_url" {
  value = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${azurerm_linux_web_app.app.default_hostname}"
}

# Values OneHookBackend infra/config/mr-onehook.ts needs for the AWS role trust (none are secrets).
output "aws_federation" {
  value = {
    tenant_id                     = data.azurerm_client_config.current.tenant_id
    audience                      = local.aws_web_identity_audience
    managed_identity_principal_id = azurerm_linux_web_app.app.identity[0].principal_id
  }
}
