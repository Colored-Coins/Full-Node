var ini = require('iniparser')
var _ = require('lodash')

module.exports = function (propertiesFile) {
  var properties = {}
  if (propertiesFile) {
    try {
      properties = ini.parseSync(propertiesFile)
    } catch (e) { 
      console.warn('Can\'t find properties file:', propertiesFile)
    }
  }

  properties.redisHost = properties.redisHost || process.env.REDIS_HOST || 'localhost'
  properties.redisPort = properties.redisPort || process.env.REDIS_PORT || '6379'
  properties.redisPassword = properties.redisPassword || process.env.REDIS_PASSWORD

  properties.network = properties.network || process.env.NETWORK || 'testnet'
  properties.bitcoinHost = properties.bitcoinHost || process.env.BITCOIND_HOST || 'localhost'
  properties.bitcoinPort = properties.bitcoinPort || process.env.BITCOIND_PORT || '18332'
  properties.bitcoinUser = properties.bitcoinUser || process.env.BITCOIND_USER || 'rpcuser'
  properties.bitcoinPass = properties.bitcoinPass || process.env.BITCOIND_PASS || 'rpcpass'
  properties.bitcoinPath = properties.bitcoinPath || process.env.BITCOIND_PATH || '/'
  properties.bitcoinTimeout = parseInt(properties.bitcoinTimeout || process.env.BITCOIND_TIMEOUT || 30000, 10)

  properties.server = properties.server || {}
  properties.server.httpPort = properties.server.httpPort || process.env.CCFULLNODE_HTTP_PORT || process.env.PORT || 80 // Optional
  properties.server.httpsPort = properties.server.httpsPort || process.env.CCFULLNODE_HTTPS_PORT || 443 // Optional
  properties.server.host = properties.server.host || process.env.CCFULLNODE_HOST || '0.0.0.0' // Optional

  properties.server.usessl = properties.server.usessl || (process.env.CCFULLNODE_USE_SSL === 'true') // Optional
  properties.server.useBoth = properties.server.useBoth || (process.env.CCFULLNODE_USE_BOTH === 'true') // both HTTP and HTTPS - Optional
  properties.server.privateKeyPath = properties.server.privateKeyPath || process.env.CCFULLNODE_PRIVATE_KEY_PATH // Mandatory in case CCFULLNODE_USE_SSL or CCFULLNODE_USE_BOTH is true
  properties.server.certificatePath = properties.server.certificatePath || process.env.CCFULLNODE_CERTIFICATE_PATH // Mandatory in case CCFULLNODE_USE_SSL or CCFULLNODE_USE_BOTH is true

  properties.server.useBasicAuth = properties.server.useBasicAuth || (process.env.CCFULLNODE_USE_BASIC_AUTH === 'true') // Optional
  properties.server.userName = properties.server.userName || process.env.CCFULLNODE_USER // Manadatory in case CCFULLNODE_USE_BASIC_AUTH is true
  properties.server.password = properties.server.password || process.env.CCFULLNODE_PASS // Manadatory in case CCFULLNODE_USE_BASIC_AUTH is true

  return properties
}