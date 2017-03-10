var redis = require('redis')
var async = require('async')
var bitcoin = require('bitcoin-async')
var config = require('./utils/config')('./properties.conf')

var redisOptions = {
  host: config.redisHost,
  port: config.redisPort,
  prefix: 'ccfullnode:' + config.network + ':'
}

var redisClient = redis.createClient(redisOptions)

var bitcoinOptions = {
  host: config.bitcoinHost,
  port: config.bitcoinPort,
  user: config.bitcoinUser,
  pass: config.bitcoinPass,
  path: config.bitcoinPath,
  timeout: config.bitcoinTimeout
}

var bitcoinRpc = new bitcoin.Client(bitcoinOptions)

var parserOptions = {
  redis: redisClient,
  bitcoin: bitcoinRpc,
  network: config.network,
  debug: config.debug
}
var parser = require('./src/block_parser')(parserOptions)
parser.parse(function (info) {
  console.log('info', info)
})
// parser.getAddressesUtxos(['mxNL1rF87rfBEKtUfQ8YDg2r4crYn6hUDh', 'mhPee3aTfto9f5MLyLwwPu2wD3KoWn85fo'], function (err, utxos) {
//   if (err) return console.error(err)
//   console.log('utxos', utxos)
// })
