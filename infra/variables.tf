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
