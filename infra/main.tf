terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  backend "azurerm" {
    resource_group_name  = "onehook-tfstate-rg"
    storage_account_name = "onehooktfstate4x"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
    use_oidc             = true
  }
}

provider "azurerm" {
  features {}
  storage_use_azuread = true
}

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
}

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_storage_account" "storage" {
  name                            = "${var.storage_account_name}${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
}

resource "azurerm_storage_container" "context_container" {
  name                  = var.storage_container_name
  storage_account_name  = azurerm_storage_account.storage.name
  container_access_type = "private"

  depends_on = [azurerm_role_assignment.storage_contributor]
}

resource "azurerm_storage_container" "session_container" {
  name                  = var.session_storage_container_name
  storage_account_name  = azurerm_storage_account.storage.name
  container_access_type = "private"

  depends_on = [azurerm_role_assignment.storage_contributor]
}

resource "azurerm_storage_management_policy" "session_retention" {
  storage_account_id = azurerm_storage_account.storage.id

  rule {
    name    = "delete-expired-chat-sessions"
    enabled = true

    filters {
      prefix_match = ["${azurerm_storage_container.session_container.name}/sessions/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.chat_session_max_retention_days
      }
    }
  }

  rule {
    name    = "delete-expired-session-quotas"
    enabled = true

    filters {
      prefix_match = ["${azurerm_storage_container.session_container.name}/session-quotas/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.chat_session_max_retention_days
      }
    }
  }
}

# Grant the executing service principal (GitHub Action OIDC) contributor access
resource "azurerm_role_assignment" "storage_contributor" {
  scope                = azurerm_storage_account.storage.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Azure OpenAI
resource "azurerm_cognitive_account" "openai" {
  name                = var.openai_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  kind                = "OpenAI"
  sku_name            = "S0"
  local_auth_enabled  = false
}

# Azure OpenAI Model Deployment
resource "azurerm_cognitive_deployment" "gpt" {
  name                 = var.openai_deployment_name
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = var.openai_model_name
    version = var.openai_model_version
  }

  scale {
    type     = "Standard"
    capacity = 10
  }
}

# App Service Plan (Linux)
resource "azurerm_service_plan" "asp" {
  name                = var.app_service_plan_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  os_type             = "Linux"
  sku_name            = "B1"
}

# App Service (Node.js API)
resource "azurerm_linux_web_app" "app" {
  name                = var.app_service_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  service_plan_id     = azurerm_service_plan.asp.id

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "20-lts"
    }
    health_check_path = "/health"
  }

  app_settings = {
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE" = "false"
    "SCM_DO_BUILD_DURING_DEPLOYMENT"      = "false"
    "AZURE_OPENAI_ENDPOINT"               = azurerm_cognitive_account.openai.endpoint
    "AZURE_OPENAI_DEPLOYMENT"             = var.openai_deployment_name
    "AZURE_STORAGE_ACCOUNT"               = azurerm_storage_account.storage.name
    "AZURE_STORAGE_CONTAINER"             = azurerm_storage_container.context_container.name
    "AZURE_SESSION_CONTAINER"             = azurerm_storage_container.session_container.name
    "CONTEXTUAL_AI_ENABLED"               = tostring(var.contextual_ai_enabled)
    "AUTH_ISSUER"                         = var.auth_issuer
    "AUTH_AUDIENCE"                       = var.auth_audience
    "AUTH_JWKS_URI"                       = var.auth_jwks_uri
    "CORS_ALLOWED_ORIGINS"                = join(",", var.cors_allowed_origins)
    "ONEHOOK_DATA_API_URL"                = var.onehook_data_api_url
    "ONEHOOK_DATA_API_SCOPE"              = var.onehook_data_api_scope
    "EPHEMERAL_CONTEXT_MAX_MESSAGES"      = tostring(var.ephemeral_context_max_messages)
    "EPHEMERAL_CONTEXT_MAX_CHARACTERS"    = tostring(var.ephemeral_context_max_characters)
    "CONTEXT_REQUEST_MAX_MESSAGES"        = tostring(var.context_request_max_messages)
    "CHAT_SESSION_STORAGE_ENABLED"        = tostring(var.chat_session_storage_enabled)
    "AUTH_TIER_CLAIM"                     = var.auth_tier_claim
    "CHAT_SESSION_MAX_RETENTION_DAYS"     = tostring(var.chat_session_max_retention_days)
    "CHAT_SESSION_TIER_POLICIES" = jsonencode({
      for tier, policy in var.chat_session_tier_policies : lower(tier) => {
        enabled       = policy.enabled
        maxSessions   = policy.max_sessions
        maxMessages   = policy.max_messages
        retentionDays = policy.retention_days
      }
    })
  }
}

# Grant App Service identity access to Storage Account
resource "azurerm_role_assignment" "app_storage_reader" {
  scope                = "${azurerm_storage_account.storage.id}/blobServices/default/containers/${azurerm_storage_container.context_container.name}"
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id

  depends_on = [azurerm_storage_container.context_container]
}

# Grant App Service identity access to OpenAI
resource "azurerm_role_assignment" "app_openai_user" {
  scope                = azurerm_cognitive_account.openai.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id
}

# AI session runtime writes are scoped to the dedicated private session container.
resource "azurerm_role_assignment" "app_session_storage_contributor" {
  scope                = "${azurerm_storage_account.storage.id}/blobServices/default/containers/${azurerm_storage_container.session_container.name}"
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id

  depends_on = [azurerm_storage_container.session_container]
}
