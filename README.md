# OneHook UX Enhancement Backend & Infrastructure

This directory contains the stateless Node.js Chatbot Backend and the Terraform infrastructure configuration required to run it securely on Azure.

## First Time Setup: Secretless Deployment via OIDC

We use Azure Managed Identities and OpenID Connect (OIDC) to securely deploy this application from GitHub Actions to Azure **without needing any passwords or secret keys**. 

To establish the initial trust between GitHub and your Azure account, you only need to run the provided setup script once.

### Prerequisites
Before running the setup script, ensure you have the following installed and are logged in:
1. **Azure CLI**: `az login`
2. **GitHub CLI**: `gh auth login`

### Setup Instructions
1. Open your terminal in this directory (`OneHookUxEnhancement`).
2. Make the setup script executable:
   ```bash
   chmod +x setup-oidc.sh
   ```
3. Run the script:
   ```bash
   ./setup-oidc.sh
   ```

### What does this script do?
- Creates an **Azure AD Application (Service Principal)**.
- Grants it **Contributor** and **User Access Administrator** roles on your subscription so it can provision resources via Terraform and assign roles (like giving your App Service access to Blob Storage).
- Creates a **Federated Identity Credential** that tells Azure to only trust tokens coming from the `pushpsood/onehook.club` repository on the `main` branch.
- Automatically saves `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` to your GitHub repository secrets using the GitHub CLI.

Once this script successfully runs, any code you push to the `main` branch will be automatically deployed by the `.github/workflows/deploy.yml` workflow!
