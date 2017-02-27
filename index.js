var redis = require('redis')
var async = require('async')
var bitcoin = require('bitcoin-async')
var levelup = require('level')
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

levelup(config.levelLocation, function (err, db) {
  if (err) throw err
  var parserOptions = {
    redis: redisClient,
    bitcoin: bitcoinRpc,
    network: config.network,
    level: db,
    debug: config.debug
  }
  var parser = require('./src/block_parser')(parserOptions)
  parser.parse()  

})
