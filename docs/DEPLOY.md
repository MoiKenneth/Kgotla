# Deploying to Azure

Kgotla runs on Azure as **one shared platform plus one isolated cell per country**. Botswana is deployed first; South Africa, Namibia, Zambia and Zimbabwe are added by changing one setting.

```
Subscription
├── kgotla-shared         container registry · Container Apps environment · Log Analytics
├── kgotla-bw             managed identity · Key Vault · PostgreSQL 16 · Container App "kgotla-bw"
├── kgotla-za             (same, for South Africa, when enabled)
└── …
```

- **No passwords anywhere.** GitHub signs in to Azure with OpenID Connect. Each cell's app signs in to its own database with its managed identity (Microsoft Entra authentication; password sign-in is switched off on the server). App secrets are generated on the first deploy, kept in that cell's Key Vault and never touch git.
- **Cells share nothing but the platform.** Each country has its own database, vault and identity, and the app refuses to start against another country's database.
- **Two-pass deploy.** Pass 1 creates the platform, vaults and databases. The workflow then creates the cell secrets and pushes the image. Pass 2 creates the apps on that image and smoke-tests each one.

## One-time setup (starting with no Azure subscription)

You need about 20 minutes and a card for Microsoft's identity check.

1. **Create a subscription.** Go to <https://azure.microsoft.com/free> and sign up. The free account gives starting credit and, for the first year, a free allowance of the small PostgreSQL server size Kgotla uses. Check the current terms on that page. If you already have a work Azure tenant, ask its administrator for a subscription where you are **Owner** instead.
2. **Open Cloud Shell.** Sign in at <https://portal.azure.com>, click the `>_` icon at the top, and choose **Bash**. If it asks for storage, accept the defaults.
3. **Run the bootstrap script:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/MoiKenneth/Kgotla/main/infra/bootstrap.sh -o bootstrap.sh
   bash bootstrap.sh MoiKenneth/Kgotla
   ```
   It registers the Azure services Kgotla uses, creates an app registration called `kgotla-github-deploy` that only GitHub Actions for this repository (environment `azure`) can sign in as, and gives it **Contributor** and **Role Based Access Control Administrator** on the subscription. It then prints three values.
4. **Add the three values as GitHub secrets.** In the repository, open **Settings → Secrets and variables → Actions → New repository secret** and add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. (If the GitHub CLI is signed in inside Cloud Shell, the script offers to do this for you.) Optionally add `ANTHROPIC_API_KEY` to turn on the Claude assistant; without it the assistant runs in basic mode.
5. **Deploy.** Open **Actions → Deploy to Azure → Run workflow**. The first run takes about 15 minutes, most of it creating the database. The run summary lists each cell's address, for example `https://kgotla-bw.<random>.southafricanorth.azurecontainerapps.io`.

After this, every push to `main` that passes the tests deploys automatically. Until the three secrets exist, the workflow skips itself with a notice, so nothing breaks.

## Adding countries

Set a repository **variable** (Settings → Secrets and variables → Actions → Variables):

| Variable | Example | Default |
|---|---|---|
| `KGOTLA_CELLS` | `["BW","ZA","NA","ZM","ZW"]` | `["BW"]` |
| `AZURE_LOCATION` | `southafricanorth` | `southafricanorth` |

Then run the workflow again. You can also type a list into the **Run workflow** box for a one-off run. Removing a country from the list stops deploying it but does not delete it; delete it on purpose with `az group delete --name kgotla-za`.

## Day-to-day

| Task | How |
|---|---|
| Officer console password for a demo cell | `az keyvault secret show --vault-name <vault> --name demo-officer-password --query value -o tsv` (the vault name is in the workflow's pass 1 output, or `az keyvault list -g kgotla-bw -o table`) |
| Logs | Portal → `kgotla-bw` Container App → Log stream, or Log Analytics workspace `kgotla-logs` |
| Change the assistant key | Update the `ANTHROPIC_API_KEY` GitHub secret and re-run the workflow |
| Keep a cell always warm | Set `minReplicas` to `1` in `infra/main.parameters.json` (costs more; at `0` the first request after a quiet spell waits a few seconds) |
| Integrity check | Sign in to the officer console as `admin`: ledger trial balance and audit hash chain are on the Overview tab |

## Cost

Rough figures for demo cells at list prices; confirm with the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) for your region and currency.

| Item | Monthly, roughly |
|---|---|
| Shared: container registry (Basic) and logs | about US$5–10 |
| Per cell: PostgreSQL Flexible Server B1ms with 32 GB | about US$15–20 (covered for one server by the free account's first-year allowance) |
| Per cell: Container App scaled to zero | usually within the monthly free grant for a demo |

So Botswana alone is about US$20–30 a month after free allowances, and each extra country adds about US$15–20.

## Where the data lives

Every resource is created in **South Africa North (Johannesburg)**. Azure has no region in Botswana, Namibia, Zambia or Zimbabwe, so for those countries citizen data in a hosted cell leaves the country. That is acceptable for demo cells with example data. Before a real pilot, each country's regulator must approve it or the cell must move to in-country hosting:

- Botswana: Data Protection Act, Information and Data Protection Commission.
- South Africa: POPIA, Information Regulator (data stays in South Africa).
- Namibia, Zambia (Data Protection Act 2021), Zimbabwe (Cyber and Data Protection Act): confirm transfer rules with each regulator.

The templates take the region as a parameter, so a cell can move without code changes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `LocationIsOfferRestricted` or "not available in this region" on PostgreSQL | Some free and trial subscriptions are limited by region. Set `AZURE_LOCATION` to a region your subscription allows, or ask Azure support to lift the restriction. |
| `VaultAlreadyExists` after deleting a cell | Key Vault keeps deleted vaults for 30 days. Run `az keyvault purge --name <vault>`, then re-run. |
| `AuthorizationFailed` on Key Vault or the registry on the very first run | New role assignments can take a few minutes to apply. The workflow waits; if it still fails, re-run it. |
| Workflow says "Azure not connected yet" | One of the three secrets is missing or misspelt. |
| `AADSTS70021: No matching federated identity record` | The workflow must run in the `azure` environment from `MoiKenneth/Kgotla`. If you renamed or forked the repository, run `bootstrap.sh <owner>/<repo>` again. |
| App starts then restarts | Portal → Container App → Log stream. A database mismatch error means the cell was pointed at another country's database. |

## Before real citizens use a cell

Demo cells set `DEMO_MODE=true`, seed example people and money, and show SMS codes on screen. For a pilot:

1. Replace the mock adapters (registry, liveness, SMS, mobile money, utility vending) — see [PILOT.md](PILOT.md).
2. Set `demoMode` to `false` in `infra/main.parameters.json` (the app then runs with `NODE_ENV=production`, which refuses demo mode).
3. Put PostgreSQL and Key Vault behind private endpoints in a VNet-integrated Container Apps environment and remove the "Allow Azure services" firewall rule.
4. Give the app a least-privilege database role instead of the Entra administrator, with migrations run by a separate job.
5. Turn on zone-redundant high availability and geo-redundant backups for the database, and `minReplicas` of at least 2.
6. Add a custom domain with a managed certificate, and Azure Front Door with WAF.
7. Restrict the deploy identity's role-assignment rights to the specific roles the templates grant (an ABAC condition on Role Based Access Control Administrator).
