// Kgotla on Azure: one shared platform plus one isolated "cell" per country.
//
// Shared (resource group <prefix>-shared): container registry, Log Analytics,
// Container Apps environment.
// Per cell (resource group <prefix>-<cc>): managed identity, Key Vault,
// PostgreSQL Flexible Server (Microsoft Entra sign-in only, no passwords),
// and the Container App running the country's KGOTLA_COUNTRY pack.
//
// Deployed in two passes by .github/workflows/deploy.yml:
//   1. deployApps=false creates the platform and each cell's vault and database;
//      the workflow then puts the cell secrets in Key Vault and pushes the image.
//   2. deployApps=true adds the Container Apps on that image.
targetScope = 'subscription'

@description('Azure region for every resource. South Africa North keeps Phase 1-2 data in the region.')
param location string = 'southafricanorth'

@description('Name prefix for resource groups and resources.')
@minLength(2)
@maxLength(10)
param prefix string = 'kgotla'

@description('Country cells to run, by ISO code. Botswana first; add ZA, NA, ZM, ZW as each is ready.')
param cells array = ['BW']

@description('Demo cells seed example people and money. Turn off only for a real pilot with real integrations.')
param demoMode bool = true

@description('Second pass: deploy the Container Apps. The first pass leaves them out.')
param deployApps bool = false

@description('Image tag in the shared registry, for example the git commit SHA. Required when deployApps is true.')
param imageTag string = ''

@description('Object ID of the identity running the deployment (the GitHub Actions service principal). It gets rights to write cell secrets and push images.')
param deployerObjectId string = ''

@description('Minimum replicas per cell. 0 scales to zero when idle (cheapest; the first request after a quiet spell waits a few seconds).')
@minValue(0)
@maxValue(10)
param minReplicas int = 0

@description('PayPal environment for every cell: sandbox (test money) or live (real money).')
@allowed(['sandbox', 'live'])
param paypalEnv string = 'sandbox'

@description('Local currency per 1 USD for PayPal charges, for example 13.6 for BWP. Empty uses a rough built-in default.')
param paypalFxRate string = ''

@description('DPO Pay service type number (from the DPO merchant account). Empty turns DPO off.')
param dpoServiceType string = ''

@description('Twilio sender (phone number like +1555... or an approved alphanumeric id). Empty: SMS is only logged.')
param twilioFrom string = ''

@description('Tags on every resource.')
param tags object = {
  app: 'kgotla'
  phase: '2'
}

var suffix = uniqueString(subscription().id, prefix)

resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${prefix}-shared'
  location: location
  tags: tags
}

module shared 'modules/shared.bicep' = {
  name: 'kgotla-shared'
  scope: sharedRg
  params: {
    location: location
    prefix: prefix
    suffix: suffix
    tags: tags
    deployerObjectId: deployerObjectId
  }
}

resource cellRgs 'Microsoft.Resources/resourceGroups@2024-03-01' = [for code in cells: {
  name: '${prefix}-${toLower(code)}'
  location: location
  tags: union(tags, { country: toUpper(code) })
}]

module cellMods 'modules/cell.bicep' = [for (code, i) in cells: {
  name: 'kgotla-cell-${toLower(code)}'
  scope: cellRgs[i]
  params: {
    location: location
    prefix: prefix
    code: toUpper(code)
    tags: union(tags, { country: toUpper(code) })
    deployerObjectId: deployerObjectId
    environmentId: shared.outputs.environmentId
    environmentDomain: shared.outputs.environmentDomain
    registryServer: shared.outputs.registryServer
    deployApp: deployApps
    image: deployApps ? '${shared.outputs.registryServer}/kgotla:${imageTag}' : ''
    demoMode: demoMode
    minReplicas: minReplicas
    paypalEnv: paypalEnv
    paypalFxRate: paypalFxRate
    dpoServiceType: dpoServiceType
    twilioFrom: twilioFrom
  }
}]

// Each cell identity may pull images from the shared registry.
module acrPull 'modules/acr-pull.bicep' = [for (code, i) in cells: {
  name: 'kgotla-acrpull-${toLower(code)}'
  scope: sharedRg
  params: {
    registryName: shared.outputs.registryName
    principalId: cellMods[i].outputs.identityPrincipalId
  }
}]

output registryName string = shared.outputs.registryName
output registryServer string = shared.outputs.registryServer
output cells array = [for (code, i) in cells: {
  code: toUpper(code)
  resourceGroup: cellRgs[i].name
  keyVaultName: cellMods[i].outputs.keyVaultName
  postgresHost: cellMods[i].outputs.postgresHost
  url: cellMods[i].outputs.url
}]
