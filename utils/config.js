var ini = require('iniparser')
var _ = require('lodash')
var path = require('path-extra')
var ospath = require('ospath')
var cp = require('child_process')

var tryPopulateBitcoinConfAuto = function (properties) {
  var bitcoindConfPath = path.join(ospath.data(), 'Bitcoin', 'bitcoin.conf')
  var bitcoindProperties
  try {
    bitcoindProperties = ini.parseSync(bitcoindConfPath)
  } catch (e) { 
    console.warn('Can\'t find bitcoind properties file for auto config:', bitcoindConfPath)
    return false
  }
  if (!bitcoindProperties) return false
  console.log('bitcoindProperties', bitcoindProperties)
  // properties.network = (bitcoindProperties.testnet === '1' || bitcoindProperties === 'true') ? 'testnet' : 'mainnet'
  properties.bitcoinHost = 'localhost'
  properties.bitcoinPort = bitcoindProperties.rpcport || (properties.network === 'testnet' ? '18332' : '8332')
  properties.bitcoinUser = bitcoindProperties.rpcuser || 'rpcuser'
  properties.bitcoinPass = bitcoindProperties.rpcpassword || 'rpcpass'
  properties.bitcoinPath = '/'
  properties.bitcoinTimeout = parseInt(bitcoindProperties.rpctimeout || '30', 10) * 1000
}

var tryRunBitcoindWin32 = function (properties) {
  var cwd = 'C:\\Program Files\\Bitcoin\\daemon\\'
  var command = 'bitcoind.exe'
  var args = ['--server', '--txindex']
  if (properties.network === 'testnet') {
    args.push('--testnet')
  }
  var spawn = cp.spawn
  var bitcoind = spawn(command, args, {cwd: cwd})


  bitcoind.stdout.on('data', function (data) {
    console.log('bitcoind:', data.toString())
  })

  bitcoind.stderr.on('data', function (data) {
    console.error('bitcoind error:', data.toString())
  })

  bitcoind.on('close', function (code) {
    console.error('bitcoind closed with code,', code)
  })

  bitcoind.on('error', function (code) {
    console.log('bitcoind exited with error code,', code)
  })
}

var tryRunBitcoind = function (properties) {
  switch (this.__platform || process.platform) {
    case 'win32': 
      return tryRunBitcoindWin32(properties)
    case 'darwin': 
      return false
    default: 
      return false
  }
}

var tryRunRedisWin32 = function (properties) {
  var command = 'net'
  var args = ['start', 'redis']
  var spawn = cp.spawn
  var redis = spawn(command, args)


  redis.stdout.on('data', function (data) {
    console.log('redis:', data.toString())
  })

  redis.stderr.on('data', function (data) {
    console.error('redis error:', data.toString())
  })

  redis.on('close', function (code) {
    if (code == 0 || code == 2) return
    console.error('redis closed with code,', code)
  })

  redis.on('error', function (code) {
    console.log('redis exited with error code,', code)
  })
}

var tryRunRedis = function (properties) {
  switch (this.__platform || process.platform) {
    case 'win32': 
      return tryRunRedisWin32(properties)
    case 'darwin': 
      return false
    default: 
      return false
  }
}

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

  properties.bitcoindAutoConf = (properties.bitcoindAutoConf || process.env.BITCOIND_AUTO_CONF === 'true')

  var bitcoindAutoConf = false
  if (properties.bitcoindAutoConf) {
    bitcoindAutoConf = tryPopulateBitcoinConfAuto(properties)
  }

  if (!bitcoindAutoConf) {
    properties.network = properties.network || process.env.NETWORK || 'testnet'
    properties.bitcoinHost = properties.bitcoinHost || process.env.BITCOIND_HOST || 'localhost'
    properties.bitcoinPort = properties.bitcoinPort || process.env.BITCOIND_PORT || '18332'
    properties.bitcoinUser = properties.bitcoinUser || process.env.BITCOIND_USER || 'rpcuser'
    properties.bitcoinPass = properties.bitcoinPass || process.env.BITCOIND_PASS || 'rpcpass'
    properties.bitcoinPath = properties.bitcoinPath || process.env.BITCOIND_PATH || '/'
    properties.bitcoinTimeout = parseInt(properties.bitcoinTimeout || process.env.BITCOIND_TIMEOUT || 30000, 10)
  }

  properties.bitcoindAutoRun = (properties.bitcoindAutoRun || process.env.BITCOIND_AUTO_RUN === 'true')

  if (properties.bitcoindAutoRun) {
    tryRunBitcoind(properties)
  }
  properties.redisAutoRun = (properties.redisAutoRun || process.env.BITCOIND_AUTO_RUN === 'true')

  if (properties.redisAutoRun) {
    tryRunRedis(properties)
  }

  properties.server = properties.server || {}
  properties.server.httpPort = properties.server.httpPort || process.env.CCFULLNODE_HTTP_PORT || process.env.PORT || 80 // Optional
  properties.server.httpsPort = properties.server.httpsPort || process.env.CCFULLNODE_HTTPS_PORT || 443 // Optional
  properties.server.host = properties.server.host || process.env.CCFULLNODE_HOST || '0.0.0.0' // Optional

  properties.server.usessl = (properties.server.usessl || process.env.CCFULLNODE_USE_SSL === 'true') // Optional
  properties.server.useBoth = (properties.server.useBoth || process.env.CCFULLNODE_USE_BOTH === 'true') // both HTTP and HTTPS - Optional
  properties.server.privateKeyPath = properties.server.privateKeyPath || process.env.CCFULLNODE_PRIVATE_KEY_PATH // Mandatory in case CCFULLNODE_USE_SSL or CCFULLNODE_USE_BOTH is true
  properties.server.certificatePath = properties.server.certificatePath || process.env.CCFULLNODE_CERTIFICATE_PATH // Mandatory in case CCFULLNODE_USE_SSL or CCFULLNODE_USE_BOTH is true

  properties.server.useBasicAuth = properties.server.useBasicAuth || (process.env.CCFULLNODE_USE_BASIC_AUTH === 'true') // Optional
  properties.server.userName = properties.server.userName || process.env.CCFULLNODE_USER // Manadatory in case CCFULLNODE_USE_BASIC_AUTH is true
  properties.server.password = properties.server.password || process.env.CCFULLNODE_PASS // Manadatory in case CCFULLNODE_USE_BASIC_AUTH is true

  return properties
}