variable "location" {
  description = "The Azure Region in which all resources in this example should be created."
  type        = string
  default     = "southindia"
}

variable "resource_group_name" {
  description = "The name of the resource group"
  type        = string
  default     = "onehook-chatbot-rg"
}

variable "app_service_plan_name" {
  description = "The name of the app service plan"
  type        = string
  default     = "onehook-chatbot-asp"
}

variable "app_service_name" {
  description = "The name of the app service"
  type        = string
  default     = "onehook-chatbot-api"
}

variable "openai_name" {
  description = "The name of the Azure OpenAI service"
  type        = string
  default     = "onehook-openai-svc"
}

variable "openai_deployment_name" {
  description = "The name of the Azure OpenAI model deployment"
  type        = string
  default     = "gpt-4o"
}

variable "openai_model_name" {
  description = "The Azure OpenAI model to deploy (e.g. gpt-4o, gpt-4o-mini)"
  type        = string
  default     = "gpt-4o"
}

variable "openai_model_version" {
  description = "The version of the model to deploy. Check availability in your region at https://learn.microsoft.com/azure/ai-services/openai/concepts/models"
  type        = string
  default     = "2024-11-20"
}


variable "storage_account_name" {
  description = "The name of the Storage Account"
  type        = string
  default     = "onehookstorage"
}

variable "storage_container_name" {
  description = "The name of the Blob Storage Container for context"
  type        = string
  default     = "codecontext"
}

variable "session_storage_container_name" {
  description = "Private Blob container for tier-gated Mr OneHook AI sessions"
  type        = string
  default     = "aisessions"
}

variable "contextual_ai_enabled" {
  description = "Enable authenticated contextual routes after all integration values are configured"
  type        = bool
  default     = false
}

variable "auth_issuer" {
  description = "Exact issuer expected in OneHook user access tokens"
  type        = string
  default     = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_7cHT1Kxr6"
}

variable "auth_audience" {
  description = "Exact audience expected by the authenticated member API"
  type        = string
  default     = "4h10ahqrnoqt7755cofj2dq9eo"
}

variable "cors_allowed_origins" {
  description = "Exact browser origins allowed to call the API when contextual AI is enabled"
  type        = list(string)
  default     = ["https://onehook.club", "https://www.onehook.club", "https://gamma.onehook.club"]
}

variable "auth_jwks_uri" {
  description = "HTTPS JWKS endpoint for validating OneHook access tokens"
  type        = string
  default     = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_7cHT1Kxr6/.well-known/jwks.json"
}

variable "onehook_data_api_url" {
  description = "Base URL of the authoritative OneHook AI-visible match projection API"
  type        = string
  default     = "https://api.gamma.onehook.club"
}

variable "onehook_data_api_scope" {
  description = "Managed-identity OAuth scope for the authoritative OneHook data API"
  type        = string
  default     = "https://api.gamma.onehook.club/.default"
}

variable "ephemeral_context_max_messages" {
  description = "Maximum app-selected match-message excerpts accepted per member request"
  type        = number
  default     = 30

  validation {
    condition     = var.ephemeral_context_max_messages >= 1 && var.ephemeral_context_max_messages <= 100
    error_message = "ephemeral_context_max_messages must be between 1 and 100."
  }
}

variable "ephemeral_context_max_characters" {
  description = "Maximum total characters across app-selected ephemeral excerpts"
  type        = number
  default     = 12000

  validation {
    condition     = var.ephemeral_context_max_characters >= 500 && var.ephemeral_context_max_characters <= 50000
    error_message = "ephemeral_context_max_characters must be between 500 and 50000."
  }
}

variable "context_request_max_messages" {
  description = "Maximum messages Mr OneHook may request the app to search locally on retry"
  type        = number
  default     = 8

  validation {
    condition     = var.context_request_max_messages >= 1 && var.context_request_max_messages <= 20
    error_message = "context_request_max_messages must be between 1 and 20."
  }
}

variable "chat_session_storage_enabled" {
  description = "Enable Cognito-tier-gated Mr OneHook chat-session persistence"
  type        = bool
  default     = false
}

variable "auth_tier_claim" {
  description = "Verified Cognito token claim containing the tier; use cognito:groups to resolve against groups"
  type        = string
  default     = "custom:tier"
}

variable "chat_session_max_retention_days" {
  description = "Infrastructure hard cap for private Mr OneHook chat-session retention"
  type        = number
  default     = 90

  validation {
    condition     = var.chat_session_max_retention_days >= 1 && var.chat_session_max_retention_days <= 365
    error_message = "chat_session_max_retention_days must be between 1 and 365."
  }
}

variable "chat_session_tier_policies" {
  description = "Server-side policies keyed by normalized Cognito tier; omitted/disabled tiers cannot persist sessions"
  type = map(object({
    enabled        = bool
    max_sessions   = number
    max_messages   = number
    retention_days = number
  }))
  default = {
    premium = {
      enabled        = true
      max_sessions   = 10
      max_messages   = 50
      retention_days = 30
    }
  }

  validation {
    condition = alltrue([
      for tier, policy in var.chat_session_tier_policies :
      can(regex("^[a-z0-9][a-z0-9_-]{0,63}$", lower(tier))) &&
      policy.max_sessions >= 1 && policy.max_sessions <= 100 &&
      policy.max_messages >= 2 && policy.max_messages <= 200 &&
      policy.retention_days >= 1 && policy.retention_days <= var.chat_session_max_retention_days
    ])
    error_message = "Tier names and session limits must stay within the backend safety bounds."
  }
}
