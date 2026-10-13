#!/usr/bin/env bash
# One-time Azure setup for Kgotla deployments from GitHub Actions.
#
# Run in Azure Cloud Shell (Bash) as an Owner of the subscription:
#   curl -fsSL https://raw.githubusercontent.com/MoiKenneth/Kgotla/main/infra/bootstrap.sh -o bootstrap.sh
#   bash bootstrap.sh MoiKenneth/Kgotla
#
# It creates an app registration that GitHub can sign in as (OpenID Connect,
# so no password is stored anywhere), lets it deploy to this subscription,
# registers the Azure services Kgotla uses, and prints the three GitHub secrets.
# Running it again is safe.
set -euo pipefail

REPO="${1:-MoiKenneth/Kgotla}"
APP_NAME="${APP_NAME:-kgotla-github-deploy}"
ENVIRONMENT="${ENVIRONMENT:-azure}"

SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
SUB_NAME=$(az account show --query name -o tsv)
echo "Subscription: $SUB_NAME ($SUB_ID)"
echo "GitHub repository: $REPO, environment: $ENVIRONMENT"
read -r -p "Continue? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] || exit 1

echo "Registering Azure services (takes a minute or two)…"
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.KeyVault \
          Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" -o none
done

APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
  echo "Created app registration $APP_NAME"
fi
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
if [ -z "$SP_ID" ]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
fi

SUBJECT="repo:${REPO}:environment:${ENVIRONMENT}"
if ! az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"github-${ENVIRONMENT}\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"${SUBJECT}\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" -o none
  echo "Trusted GitHub Actions for $SUBJECT"
fi

SCOPE="/subscriptions/$SUB_ID"
assign() {
  if ! az role assignment list --assignee "$SP_ID" --role "$1" --scope "$SCOPE" --query "[0].id" -o tsv | grep -q .; then
    # Retry: a brand-new service principal can take a moment to appear everywhere.
    for i in 1 2 3 4 5 6; do
      az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
        --role "$1" --scope "$SCOPE" -o none && break
      sleep 10
    done
    echo "Granted $1"
  fi
}
assign "Contributor"
# Lets the deployment give each cell's identity access to its own vault and the registry.
assign "Role Based Access Control Administrator"

cat <<OUT

Done. Add these as repository secrets on GitHub
(https://github.com/${REPO}/settings/secrets/actions > New repository secret):

  AZURE_CLIENT_ID        ${APP_ID}
  AZURE_TENANT_ID        ${TENANT_ID}
  AZURE_SUBSCRIPTION_ID  ${SUB_ID}

Optional:
  ANTHROPIC_API_KEY      your Claude API key, to turn on the assistant in every cell

Then open https://github.com/${REPO}/actions/workflows/deploy.yml and press "Run workflow".
OUT

if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
  read -r -p "The GitHub CLI is signed in here. Set the three secrets now? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    gh secret set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
    gh secret set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT_ID"
    gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUB_ID"
    echo "Secrets set."
  fi
fi
