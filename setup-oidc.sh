#!/bin/bash
set -e

# Configuration - Update these if your repository name or branch differs
APP_NAME="OneHookGitHubActions"
REPO="pushpsood/OneHookUxEnhancement"
BRANCH="main"

echo "========================================="
echo " Setting up Azure OIDC for GitHub Actions"
echo "========================================="

# Extract owner and repo name from REPO
OWNER=$(echo "$REPO" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)

echo "1. Fetching GitHub owner and repo IDs (required for OIDC subject claim)..."
OWNER_ID=$(gh api "/users/$OWNER" --jq '.id')
REPO_ID=$(gh api "/repos/$REPO" --jq '.id')
echo "   Owner: $OWNER (ID: $OWNER_ID)"
echo "   Repo:  $REPO_NAME (ID: $REPO_ID)"

# GitHub's OIDC subject claim now includes numeric IDs
SUBJECT="repo:${OWNER}@${OWNER_ID}/${REPO_NAME}@${REPO_ID}:ref:refs/heads/${BRANCH}"
echo "   Subject: $SUBJECT"

echo "2. Creating Azure AD Application (Service Principal)..."
APP_ID=$(az ad app create --display-name $APP_NAME --query appId -o tsv)
# Wait a moment for Azure AD replication
sleep 5

echo "3. Creating Service Principal for the App..."
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv)
sleep 10

echo "4. Getting current Subscription ID..."
SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

echo "5. Assigning Roles to the Service Principal..."
# Contributor is needed for Terraform to create resources
az role assignment create --role Contributor --assignee $APP_ID --scope /subscriptions/$SUB_ID
# User Access Administrator is needed for Terraform to assign RBAC roles to Managed Identities
az role assignment create --role "User Access Administrator" --assignee $APP_ID --scope /subscriptions/$SUB_ID

echo "6. Setting up Federated Identity Credential for GitHub Actions..."
cat <<EOF > body.json
{
  "name": "github-actions-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "$SUBJECT",
  "description": "Allow GitHub Actions to deploy from main branch",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
az ad app federated-credential create --id $APP_ID --parameters @body.json
rm body.json

echo "7. Saving secrets to GitHub using GitHub CLI (gh)..."
gh secret set AZURE_CLIENT_ID -b "$APP_ID" -R $REPO
gh secret set AZURE_TENANT_ID -b "$TENANT_ID" -R $REPO
gh secret set AZURE_SUBSCRIPTION_ID -b "$SUB_ID" -R $REPO

echo "========================================="
echo " Success! OIDC trust is established."
echo " GitHub Secrets have been populated."
echo "========================================="
