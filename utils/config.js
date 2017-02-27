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
  properties.network = properties.network || process.env.NETWORK || 'testnet'
  properties.bitcoinHost = properties.bitcoinHost || process.env.BITCOIN_HOST || '127.0.0.1'
  properties.bitcoinPort = properties.bitcoinPort || process.env.BITCOIN_PORT || '18332'
  properties.bitcoinUser = properties.bitcoinUser || process.env.RPCUSERNAME || 'rpcuser'
  properties.bitcoinPass = properties.bitcoinPass || process.env.RPCPASSWORD || 'rpcpass'
  properties.bitcoinPath = properties.bitcoinPath || process.env.BITCOINPATH || '/'
  properties.bitcoinTimeout = parseInt(properties.bitcoinTimeout || process.env.BITCOINTIMEOUT || 30000, 10)
  properties.levelLocation = properties.levelLocation || process.env.LEVEL_LOCATION || './db'
  properties.debug = (properties.debug || process.env.FULL_NODE_DEBUG || 'false') == 'true'

  return properties
}