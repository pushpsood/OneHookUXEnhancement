# Mr OneHook chatbot - prod. Fully isolated from gamma: own resource group, plan, app, OpenAI,
# storage, and Terraform state (stages/prod.backend.hcl).
stage = "prod"

resource_group_name   = "onehook-chatbot-prod-rg"
app_service_plan_name = "onehook-chatbot-prod-asp"
app_service_name      = "onehook-chatbot-api-prod"
openai_name           = "onehook-openai-prod-svc"
storage_account_name  = "onehookprod"

# User-facing hostname, matching api.onehook.club / graphql.api.onehook.club.
custom_domain         = "chatbot.onehook.club"
custom_domain_enabled = true

deployer_principal_id = "a5166148-039b-4379-9b64-82c957e4b93a"

cors_allowed_origins = ["https://onehook.club", "https://www.onehook.club"]

# The prod AWS backend (Cognito pool, AI-context API, cross-cloud IAM role) is NOT deployed yet.
# Contextual (member) routes stay OFF and trust nothing until it is: the service still serves
# /health and the public product chat, and clients report member features as "not configured".
# Never point prod at the gamma Cognito pool. Fill these from the OneHook-*-prod stack outputs and
# set contextual_ai_enabled = true once prod is live.
contextual_ai_enabled                      = false
chat_session_storage_enabled               = false
auth_issuer                                = ""
auth_audience                              = ""
auth_jwks_uri                              = ""
onehook_data_api_url                       = ""
onehook_data_api_scope                     = "https://api.onehook.club/.default"
onehook_data_api_aws_role_arn              = ""
onehook_data_api_aws_web_identity_audience = ""
