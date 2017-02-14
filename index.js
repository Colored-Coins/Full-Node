var redis = require('redis')
var async = require('async')
var bitcoin = require('bitcoin-async')
var levelup = require('level')

var redisHost = process.env.REDIS_HOST || 'localhost'
var redisPort = process.env.REDIS_PORT || '6379'
var network = process.env.NETWORK || 'testnet'
// var bitcoinHost = process.env.BITCOIN_HOST || 'testnet.api.colu.co'
var bitcoinHost = process.env.BITCOIN_HOST || '127.0.0.1'
var bitcoinPort = process.env.BITCOIN_PORT || '8332'
// var bitcoinUser = process.env.RPCUSERNAME || 'colu'
var bitcoinUser = process.env.RPCUSERNAME || 'tal'
// var bitcoinPass = process.env.RPCPASSWORD || '123123'
var bitcoinPass = process.env.RPCPASSWORD || 'YutvwTMUFQYg5UDY6ysX'
var bitcoinPath = process.env.BITCOINPATH || '/'
var bitcoinTimeout = parseInt(process.env.BITCOINTIMEOUT || 30000, 10)
var levelLocation = process.env.LEVEL_LOCATION || './db'

var redisOptions = {
  host: redisHost,
  port: redisPort,
  prefix: 'ccfullnode:' + network + ':'
}

var redisClient = redis.createClient(redisOptions)

var bitcoinOptions = {
  host: bitcoinHost,
  port: bitcoinPort,
  user: bitcoinUser,
  pass: bitcoinPass,
  path: bitcoinPath,
  timeout: bitcoinTimeout
}

var bitcoinRpc = new bitcoin.Client(bitcoinOptions)

levelup(levelLocation, function (err, db) {
  if (err) throw err
  var parserOptions = {
    redis: redisClient,
    bitcoin: bitcoinRpc,
    network: network,
    level: db
  }
  var parser = require('./src/block_parser')(parserOptions)
  parser.parse()  

})
