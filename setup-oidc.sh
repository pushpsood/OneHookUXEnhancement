#!/bin/bash
set -e

# Configuration - Update these if your repository name or branch differs
APP_NAME="OneHookGitHubActions"
REPO="pushpsood/onehook.club"
BRANCH="main"

echo "========================================="
echo " Setting up Azure OIDC for GitHub Actions"
echo "========================================="

echo "1. Creating Azure AD Application (Service Principal)..."
APP_ID=$(az ad app create --display-name $APP_NAME --query appId -o tsv)
# Wait a moment for Azure AD replication
sleep 5

echo "2. Creating Service Principal for the App..."
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv)
sleep 10

echo "3. Getting current Subscription ID..."
SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

echo "4. Assigning Roles to the Service Principal..."
# Contributor is needed for Terraform to create resources
az role assignment create --role Contributor --assignee $APP_ID --scope /subscriptions/$SUB_ID
# User Access Administrator is needed for Terraform to assign RBAC roles to Managed Identities
az role assignment create --role "User Access Administrator" --assignee $APP_ID --scope /subscriptions/$SUB_ID

echo "5. Setting up Federated Identity Credential for GitHub Actions..."
cat <<EOF > body.json
{
  "name": "github-actions-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$REPO:ref:refs/heads/$BRANCH",
  "description": "Allow GitHub Actions to deploy from main branch",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
az ad app federated-credential create --id $APP_ID --parameters @body.json
rm body.json

echo "6. Saving secrets to GitHub using GitHub CLI (gh)..."
gh secret set AZURE_CLIENT_ID -b "$APP_ID" -R $REPO
gh secret set AZURE_TENANT_ID -b "$TENANT_ID" -R $REPO
gh secret set AZURE_SUBSCRIPTION_ID -b "$SUB_ID" -R $REPO

echo "========================================="
echo " Success! OIDC trust is established."
echo " GitHub Secrets have been populated."
echo "========================================="
