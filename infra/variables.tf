variable "stage" {
  description = "Deployment stage (gamma | prod). Selects naming and the per-stage state key via stages/<stage>.*"
  type        = string
  default     = "gamma"

  validation {
    condition     = contains(["gamma", "prod"], var.stage)
    error_message = "stage must be 'gamma' or 'prod'."
  }
}

variable "custom_domain" {
  description = "User-facing hostname for this stage, following the platform convention: chatbot.gamma.onehook.club (gamma) / chatbot.onehook.club (prod). Empty disables the binding."
  type        = string
  default     = ""
}

variable "custom_domain_enabled" {
  description = "Bind custom_domain + issue its managed certificate. Keep false until the Route53 CNAME and asuid TXT records resolve publicly."
  type        = bool
  default     = false
}

variable "deployer_principal_id" {
  description = "Object id of the deploying principal (GitHub Actions OIDC SP) granted blob access to the context storage. Empty = whoever runs terraform."
  type        = string
  default     = ""
}

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
  default     = true
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
  description = "Base URL of the authoritative OneHook AI-visible match projection API. For SigV4 (AWS_IAM) auth this MUST be the API Gateway execute-api invoke URL, not the CloudFront ingress — SigV4 signs the Host header, and the ingress rewrites Host to the origin, so signing against the ingress host would 403."
  type        = string
  default     = "https://n74oye7v0i.execute-api.ap-south-1.amazonaws.com/prod"
}

variable "onehook_matching_api_url" {
  description = "OneHook Matching execute-api invoke URL including stage (e.g. https://abc.execute-api.ap-south-1.amazonaws.com/gamma). Mr OneHook records a member's \"find me ...\" suggestion with a SigV4-signed POST {url}/matching/internal/users/{userId}/suggestions using its federated AWS role. Must be the execute-api host, not the CloudFront ingress (SigV4 signs Host). Empty disables recording."
  type        = string
  default     = ""
}

variable "onehook_data_api_scope" {
  description = "Managed-identity OAuth scope for the authoritative OneHook data API (bearer auth mode only)"
  type        = string
  default     = "https://api.gamma.onehook.club/.default"
}

variable "onehook_data_api_auth_mode" {
  description = "How the backend authenticates to the data API: 'sigv4' (AWS_IAM route) or 'bearer' (token authorizer)"
  type        = string
  default     = "sigv4"

  validation {
    condition     = contains(["sigv4", "bearer"], var.onehook_data_api_auth_mode)
    error_message = "onehook_data_api_auth_mode must be 'sigv4' or 'bearer'."
  }
}

variable "onehook_data_api_aws_region" {
  description = "AWS region of the data API's API Gateway, used to SigV4-sign requests to the AWS_IAM route"
  type        = string
  default     = "ap-south-1"
}

variable "onehook_data_api_aws_role_arn" {
  description = "ARN of OneHook-MrOneHook-<stage>-Role (OneHookBackend Matching stack output MrOneHookRoleArn). The App Service managed identity assumes it via STS web-identity to call the AI-context and internal suggestion routes. Empty disables the cross-cloud exchange."
  type        = string
  default     = ""
}

variable "aws_federation_enabled" {
  description = "Manage the Entra app registration whose identifier URI is the audience the AWS role trusts."
  type        = bool
  default     = false
}

variable "aws_audience_display_name" {
  description = "Display name of the Entra app registration used as the AWS federation audience."
  type        = string
  default     = ""
}

variable "aws_audience_import_object_id" {
  description = "Object id of a pre-existing audience app registration to adopt into state (gamma). Empty creates a new one."
  type        = string
  default     = ""
}

variable "aws_audience_import_identifier_uri" {
  description = "Identifier URI of the pre-existing registration being adopted (must be api://<its appId>)."
  type        = string
  default     = ""
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
  description = "Enable Cognito-tier-gated Mr OneHook chat-session persistence (Super/Infinity only, per the tier policies). Requires the private aisessions blob container + the App Service identity's Storage Blob Data Contributor role on it (provisioned in main.tf)."
  type        = bool
  default     = true
}

variable "auth_tier_claim" {
  description = "Verified Cognito token claim containing the membership tier (Must / Super / Infinity); use cognito:groups to resolve against groups"
  type        = string
  default     = "custom:subscriptionTier"
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
  description = "Server-side Mr OneHook AI-session policies keyed by membership tier (must / super / infinity, any case; normalized server-side via onehook-api-client). Must is intentionally absent — it does not get persisted AI sessions, per the membership matrix. Super and Infinity do."
  type = map(object({
    enabled        = bool
    max_sessions   = number
    max_messages   = number
    retention_days = number
  }))
  default = {
    # Super: unlimited Mr OneHook AI per the membership matrix; persisted sessions enabled.
    super = {
      enabled        = true
      max_sessions   = 10
      max_messages   = 50
      retention_days = 30
    }
    # Infinity: up to 3 concurrent connections, so a higher session allowance.
    infinity = {
      enabled        = true
      max_sessions   = 25
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
