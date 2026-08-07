output "app_service_default_hostname" {
  value = azurerm_linux_web_app.app.default_hostname
}

output "storage_account_name" {
  value = azurerm_storage_account.storage.name
}
