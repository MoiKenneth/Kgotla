// One country cell: its own identity, vault, database and app. Cells share no data.
param location string
param prefix string
@description('Country code: BW, ZA, NA, ZM or ZW.')
param code string
param tags object
param deployerObjectId string
param environmentId string
param environmentDomain string
param registryServer string
param deployApp bool
param image string
param demoMode bool
param minReplicas int
@description('PayPal environment: sandbox (test money) or live.')
param paypalEnv string = 'sandbox'
@description('Local currency per 1 USD for PayPal charges. Empty uses the built-in default; set the real rate.')
param paypalFxRate string = ''
@description('DPO Pay service type number from the DPO merchant account.')
param dpoServiceType string = ''
@description('Twilio sender: a phone number or alphanumeric sender id.')
param twilioFrom string = ''

var cc = toLower(code)
var suffix = uniqueString(resourceGroup().id)
var appName = '${prefix}-${cc}'
var secretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'
var secretsOfficerRole = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-${cc}-id'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kg${cc}${suffix}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    publicNetworkAccess: 'Enabled'
  }
}

// The app reads its secrets; the deployer writes them (generated once, never in git).
resource appReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, secretsUserRole)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRole)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerWritesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  name: guid(vault.id, deployerObjectId, secretsOfficerRole)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRole)
    principalId: deployerObjectId
    principalType: 'ServicePrincipal'
  }
}

// PostgreSQL with Microsoft Entra sign-in only. The cell identity is the
// database administrator, so the app connects with a short-lived token.
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: take('${prefix}-${cc}-pg-${suffix}', 63)
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
  }
}

module pgAdmin 'pg-admin.bicep' = {
  name: 'kgotla-pgadmin-${cc}'
  params: {
    serverName: pg.name
    principalId: identity.properties.principalId
    principalName: identity.name
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  parent: pg
  name: 'kgotla'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [pgAdmin]
}

// Demo cells: reachable from Azure services only. A real pilot moves this to a
// private endpoint inside a VNet-integrated Container Apps environment.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
  dependsOn: [db]
}

var secretNames = [
  'kgotla-secret'
  'anthropic-api-key'
  'demo-officer-password'
  'admin-bootstrap-password'
  'paypal-client-id'
  'paypal-client-secret'
  'dpo-company-token'
  'twilio-account-sid'
  'twilio-auth-token'
]

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: registryServer, identity: identity.id }
      ]
      secrets: [for name in secretNames: {
        name: name
        keyVaultUrl: '${vault.properties.vaultUri}secrets/${name}'
        identity: identity.id
      }]
    }
    template: {
      containers: [
        {
          name: 'kgotla'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'KGOTLA_COUNTRY', value: code }
            { name: 'KGOTLA_CLOUD', value: 'true' }
            { name: 'NODE_ENV', value: demoMode ? 'staging' : 'production' }
            { name: 'DEMO_MODE', value: string(demoMode) }
            { name: 'PUBLIC_BASE_URL', value: 'https://${appName}.${environmentDomain}' }
            { name: 'PGHOST', value: pg.properties.fullyQualifiedDomainName }
            { name: 'PGPORT', value: '5432' }
            { name: 'PGDATABASE', value: 'kgotla' }
            { name: 'PGUSER', value: identity.name }
            { name: 'PGSSLMODE', value: 'require' }
            { name: 'PGAUTH', value: 'entra' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'KGOTLA_SECRET', secretRef: 'kgotla-secret' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'DEMO_OFFICER_PASSWORD', secretRef: 'demo-officer-password' }
            // Live cells: open sign-up (no registry link yet), the first admin, real payments and SMS.
            { name: 'REGISTRY_MODE', value: demoMode ? 'mock' : 'open' }
            { name: 'ADMIN_BOOTSTRAP_PASSWORD', secretRef: 'admin-bootstrap-password' }
            { name: 'PAYPAL_CLIENT_ID', secretRef: 'paypal-client-id' }
            { name: 'PAYPAL_CLIENT_SECRET', secretRef: 'paypal-client-secret' }
            { name: 'PAYPAL_ENV', value: paypalEnv }
            { name: 'PAYPAL_FX_RATE', value: paypalFxRate }
            { name: 'DPO_COMPANY_TOKEN', secretRef: 'dpo-company-token' }
            { name: 'DPO_SERVICE_TYPE', value: dpoServiceType }
            { name: 'TWILIO_ACCOUNT_SID', secretRef: 'twilio-account-sid' }
            { name: 'TWILIO_AUTH_TOKEN', secretRef: 'twilio-auth-token' }
            { name: 'TWILIO_FROM', value: twilioFrom }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 3
              periodSeconds: 5
              failureThreshold: 24
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 3
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '50' } } }
        ]
      }
    }
  }
  dependsOn: [appReadsSecrets, allowAzure]
}

output identityPrincipalId string = identity.properties.principalId
output keyVaultName string = vault.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
output url string = 'https://${appName}.${environmentDomain}'
