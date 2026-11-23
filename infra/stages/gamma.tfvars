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

# AWS federation: the role is created by OneHookBackend CDK (Matching stack); the Entra audience app
# registration is managed here, adopting the one that already existed.
onehook_data_api_aws_role_arn      = "arn:aws:iam::627367419734:role/OneHook-MrOneHook-gamma-Role"
aws_federation_enabled             = true
aws_audience_display_name          = "onehook-aws-aicontext-audience"
aws_audience_import_object_id      = "13d5115f-d20a-47c5-a730-94ffb54e2c2e"
aws_audience_import_identifier_uri = "api://8a078d5e-ad9d-4156-b89d-419871233992"

# Account deletion: UserDeleted reaches this queue (created next to the role by the Matching stack) and
# the backend erases the member's AI sessions and quota ledger. Same account and region as the role
# above; equals the Matching stack output UxErasureQueueUrl, so re-check it there after a redeploy.
ux_erasure_queue_url = "https://sqs.ap-south-1.amazonaws.com/627367419734/OneHook-Matching-gamma-UxErasure"


# Mr OneHook Pro: purchases with the fake payment provider (moves no money; refused in prod) until a real
# rail is plugged in. Members whose tier includes Pro (Infinity) get it without buying.
mr_onehook_pro_enabled          = true
mr_onehook_pro_payment_provider = "fake"
# The membership's Pro handover queue (OneHookBackend Matching stack output MrOneHookEntitlementsQueueUrl).
# Deploy that stack first: until the queue exists the worker only logs failed receives with backoff. While
# State's MR_ONEHOOK_PRO_HANDOVER_ENABLED is on for gamma, upgrades into Infinity wait for this worker.
mr_onehook_entitlement_queue_url = "https://sqs.ap-south-1.amazonaws.com/627367419734/OneHook-Matching-gamma-MrOneHookEntitlements"

# Pro attachments: images (vision on the gpt-4o deployment), documents (Document Intelligence) and text.
# Audio and video need a speech-to-text deployment: set openai_transcription_deployment once the model
# and version are confirmed in the Foundry catalog for southindia (gpt-transcribe lists India South).
chat_attachments_enabled      = true
document_intelligence_enabled = true
