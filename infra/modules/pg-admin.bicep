// Makes the cell's managed identity the Microsoft Entra administrator of its database.
// A separate module because the administrator's name is the identity's object ID,
// which is only known once the identity exists.
param serverName string
param principalId string
param principalName string

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2022-12-01' = {
  parent: pg
  name: principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: principalName
    tenantId: subscription().tenantId
  }
}
