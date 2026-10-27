# Mr OneHook chatbot - gamma. Resource names are the variable defaults (the original, pre-stage
# deployment); they are immutable Azure names, so gamma intentionally keeps them unsuffixed.
stage = "gamma"

# User-facing hostname, matching api.gamma.onehook.club / graphql.api.gamma.onehook.club.
custom_domain         = "chatbot.gamma.onehook.club"
custom_domain_enabled = true

# GitHub Actions OIDC service principal (the principal that originally created this stack).
deployer_principal_id = "a5166148-039b-4379-9b64-82c957e4b93a"

# Mr OneHook records "find me ..." suggestions in the gamma Matching service (IAM route, SigV4 with
# OneHook-UX-AiContext-gamma). From SSM /onehook/gamma/matching/api-url.
onehook_matching_api_url = "https://lrzxqy7y1g.execute-api.ap-south-1.amazonaws.com/gamma"
