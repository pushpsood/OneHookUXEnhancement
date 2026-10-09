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
