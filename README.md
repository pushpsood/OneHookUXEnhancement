# OneHook UX Enhancement — Backend & Infrastructure

AI-driven chatbot API powered by **Azure OpenAI (GPT-4 Turbo)**, deployed to **Azure App Service** via **Terraform** and **GitHub Actions** with secretless **OIDC** authentication.

---

## Architecture

```
Client Request
    │
    ▼
Azure App Service (Node.js 20)
    ├── /health          → Health check (App Service probes)
    └── /api/chat        → AI chatbot endpoint
            │
            ├── Azure Redis Cache   → Rate limiting (10 req/60s per IP)
            ├── Azure Blob Storage  → Code context (Managed Identity)
            └── Azure OpenAI        → GPT-4 Turbo completions (Managed Identity)
```

All Azure service communication uses **System-Assigned Managed Identity** — no secrets stored in the app.

### What Terraform Provisions

| Resource | Purpose |
|---|---|
| Resource Group | Container for all resources |
| App Service Plan (B1 Linux) | Hosts the Node.js backend |
| App Service | The chatbot API |
| Azure OpenAI (Cognitive Services) | AI service |
| GPT-4 Turbo Model Deployment | The actual model the backend calls |
| Redis Cache (Basic C0) | Rate limiting |
| Storage Account + Blob Container | Code context for the chatbot |
| RBAC Role Assignments | Managed Identity access to OpenAI, Storage |

---

## Local Development

### Prerequisites

- Node.js 20+
- Azure CLI (`az login` for Managed Identity locally)
- Redis (local instance or Azure)

### Setup

```bash
cd backend

# Install dependencies
npm install

# Create a .env file with your Azure resource values (see Environment Variables below)

# Start development server (auto-restarts on changes)
npm run dev
```

### Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource URL | — | ✅ |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name | `gpt-4` | ⚠️ Recommended |
| `REDIS_HOST` | Redis hostname | `localhost` | ✅ |
| `REDIS_PASSWORD` | Redis access key | — | ✅ (Azure) |
| `AZURE_STORAGE_ACCOUNT` | Storage account name | — | ✅ |
| `AZURE_STORAGE_CONTAINER` | Blob container name | `codecontext` | — |
| `PORT` | Server port | `8080` | — |

In production, all variables are injected by Terraform via App Service `app_settings` — no manual config needed.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{ status: "ok", timestamp }` |
| `POST` | `/api/chat` | AI chatbot — accepts `{ messages, userDemographics }` |

---

## Deployment

### First-Time Setup: OIDC Trust

We use **Azure OIDC** so GitHub Actions can deploy to Azure **without storing any secret keys**.

#### Prerequisites
1. **Azure CLI**: `az login`
2. **GitHub CLI**: `gh auth login`

#### Run the setup script (once)
```bash
chmod +x setup-oidc.sh
./setup-oidc.sh
```

This script:
- Fetches your **GitHub owner and repo numeric IDs** (required by GitHub's OIDC subject claim format)
- Creates an **Azure AD Application** (Service Principal)
- Grants **Contributor** + **User Access Administrator** roles on your subscription
- Creates a **Federated Identity Credential** with the correct subject claim: `repo:pushpsood@<owner_id>/OneHookUxEnhancement@<repo_id>:ref:refs/heads/main`
- Saves `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` to GitHub Secrets

> **Note:** If the OIDC subject claim format changes in the future, you can update just the credential without re-creating the entire app. See [Troubleshooting](#troubleshooting).

### CI/CD Pipeline

Every push to `main` that touches `backend/` or `infra/` triggers the pipeline:

```
Push to main
    │
    ▼
┌─────────────────────┐
│  Job 1: Terraform   │
│  ├─ Azure Login     │
│  ├─ terraform init  │
│  ├─ terraform plan  │
│  └─ terraform apply │
└────────┬────────────┘
         │ (on success)
         ▼
┌─────────────────────┐
│  Job 2: Deploy API  │
│  ├─ npm ci          │
│  ├─ Azure Login     │
│  └─ Deploy to App   │
│     Service         │
└─────────────────────┘
```

The workflow also supports **manual trigger** via `workflow_dispatch` from the Actions tab.

### Manual Deployment

If you need to deploy manually:

```bash
# 1. Login to Azure
az login

# 2. Apply Terraform
cd infra
terraform init
terraform plan
terraform apply

# 3. Deploy backend
cd ../backend
npm ci --production
az webapp deploy \
  --resource-group onehook-chatbot-rg \
  --name onehook-chatbot-api \
  --src-path .
```

---

## Cross-Repo Dependency: OneHookClient Context

The **OneHookClient** repo has a `push-context.yml` workflow that uploads its source code to this project's Azure Blob Storage container (`codecontext`). The chatbot uses this context to answer questions about the platform.

**Deploy order matters:** This repo's Terraform must run first to create the storage account before OneHookClient's push-context workflow can upload to it.

The contract between the repos:
| Value | Defined in Terraform (`variables.tf`) | Used by OneHookClient (`push-context.yml`) |
|---|---|---|
| Resource Group | `onehook-chatbot-rg` | Hardcoded |
| Container Name | `codecontext` | Hardcoded |
| Storage Account | Dynamic (random suffix) | Discovered via `az storage account list` |

---

## Rollback

```bash
# Option 1: Redeploy a previous commit via GitHub Actions
# Go to the Actions tab → select a successful past run → "Re-run all jobs"

# Option 2: Redeploy from CLI
git checkout <previous-commit-sha>
cd backend
az webapp deploy \
  --resource-group onehook-chatbot-rg \
  --name onehook-chatbot-api \
  --src-path .
```

To roll back **infrastructure changes**, revert the Terraform files and push:
```bash
git revert <commit-sha>
git push origin main
```

---

## Monitoring & Logging

### App Service Logs

```bash
# Stream live logs
az webapp log tail \
  --resource-group onehook-chatbot-rg \
  --name onehook-chatbot-api

# Download log files
az webapp log download \
  --resource-group onehook-chatbot-rg \
  --name onehook-chatbot-api \
  --log-file logs.zip
```

### Health Check

The App Service is configured with a health check at `/health`. Azure will automatically restart the app if the health check fails consecutively.

### Recommended: Application Insights

For production monitoring, add Azure Application Insights to the Terraform config for:
- Request tracing and latency metrics
- Error rate dashboards
- Custom alerts on 5xx rates or response times

---

## Troubleshooting

### OIDC Login Fails (`AADSTS700213: No matching federated identity record`)

GitHub's OIDC subject claim includes numeric owner/repo IDs. If the format changes or credentials were created with an old format, update just the credential:

```bash
APP_ID=$(az ad app list --display-name OneHookGitHubActions --query '[0].appId' -o tsv)
az ad app federated-credential delete --id $APP_ID --federated-credential-id github-actions-main

OWNER_ID=$(gh api /users/pushpsood --jq '.id')
REPO_ID=$(gh api /repos/pushpsood/OneHookUxEnhancement --jq '.id')

az ad app federated-credential create --id $APP_ID --parameters "{
  \"name\": \"github-actions-main\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:pushpsood@${OWNER_ID}/OneHookUxEnhancement@${REPO_ID}:ref:refs/heads/main\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"
```

---

## Terraform State

> **Note:** Terraform state is currently stored locally within the CI runner, meaning it is ephemeral. For production use, configure a remote backend (Azure Storage) by adding a `backend` block to `main.tf`:
>
> ```hcl
> terraform {
>   backend "azurerm" {
>     resource_group_name  = "terraform-state-rg"
>     storage_account_name = "tfstateonehook"
>     container_name       = "tfstate"
>     key                  = "ux-enhancement.tfstate"
>   }
> }
> ```

---

## Project Structure

```
OneHookUxEnhancement/
├── .github/
│   └── workflows/
│       └── deploy.yml      # CI/CD pipeline (Terraform + App Service deploy)
├── backend/
│   ├── index.js            # Express.js API server
│   ├── package.json         # Dependencies and scripts
│   └── node_modules/        # (gitignored)
├── infra/
│   ├── main.tf              # Azure resources + GPT-4 Turbo deployment
│   ├── variables.tf         # Configurable variables with defaults
│   └── outputs.tf           # Terraform outputs (hostnames, endpoints)
├── setup-oidc.sh            # One-time Azure OIDC trust setup
├── .gitignore
└── README.md                # This file
```
