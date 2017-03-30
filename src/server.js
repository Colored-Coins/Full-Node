var express = require('express')
var bodyParser = require('body-parser')
var fs = require('fs')
var http = require('http')
var https = require('https')
var morgan = require('morgan')('dev')
var auth = require('basic-auth')
var path = require('path-extra')
var ospath = require('ospath')

var propertiesFilePath = path.join(ospath.data(), 'cc_full_node', 'properties.conf')
// console.log('1', path.join(__dirname ,'/../utils/config'))
// console.log('2', path.join(__dirname ,'/../src/block_parser.js'))
// console.log('propertiesFilePath', propertiesFilePath)
var config = require(path.join(__dirname ,'/../utils/config.js'))(propertiesFilePath)
var parser = require(path.join(__dirname ,'/../src/block_parser.js'))(config)

var sslCredentials
if (config.server.usessl && config.server.privateKeyPath && config.server.certificatePath) {
  try {
    var privateKey = fs.readFileSync(config.server.privateKeyPath, 'utf8')
    var certificate = fs.readFileSync(config.server.certificatePath, 'utf8')
    sslCredentials = {key: privateKey, cert: certificate}
  } catch (e) {}
}

var launchServer = function (type) {
  var server = (type === 'https') ? https.createServer(sslCredentials, app) : http.createServer(app)
  var port = (type === 'https') ? config.server.httpsPort : config.server.httpPort
  server.listen(port, config.server.host, function () {
    console.log(type + ' server started on port', port)
    app.emit('connect', type)
  })
  server.on('error', function (err) {
    console.error('err = ', err)
    process.exit(-1)
  })
}

var handleResponse = function (err, ans, res, next) {
  if (err) return next(err)
  res.send(ans)
}

var app = express()
app.use(morgan)
app.use(bodyParser.json())                              // Support for JSON-encoded bodies
app.use(bodyParser.urlencoded({ extended: true }))      // Support for URL-encoded bodies

if (config.server.useBasicAuth && config.server.userName && config.server.password) {
  app.use(function (req, res, next) {
    var basicAuthCredentials = auth(req)
    if (!basicAuthCredentials || basicAuthCredentials.name !== config.server.userName || basicAuthCredentials.pass !== config.server.password) {
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', 'Basic realm=""')
      res.end('Access denied')
    } else {
      next()
    }
  })
}

app.post('/getAddressesUtxos', function (req, res, next) {
  var addresses = req.body.addresses
  if (!addresses) return next('addresses is required')
  var numOfConfirmations = req.body.numOfConfirmations || 0
  parser.getAddressesUtxos(addresses, numOfConfirmations, function (err, ans) {
    handleResponse(err, ans, res, next)
  })
})

app.post('/getAddressesTransactions', function (req, res, next) {
  var addresses = req.body.addresses
  if (!addresses) return next('addresses is required')
  parser.getAddressesTransactions(addresses, function (err, ans) {
    handleResponse(err, ans, res, next)
  })
})

app.post('/transmit', function (req, res, next) {
  var txHex = req.body.txHex
  if (!txHex) return next('txHex is required')
  parser.transmit(txHex, function (err, ans) {
    handleResponse(err, ans, res, next)
  })
})

app.get('/getInfo', function (req, res, next) {
  parser.getInfo(function (err, ans) {
    handleResponse(err, ans, res, next)
  })
})

app.use(function (req, res, next) {
  res.status(404)
  if (req.accepts('json')) return res.send({ error: 'Not found' })
  res.type('txt').send('Not found')
})

parser.parse(function (info) {
  console.log('info', info)
})

if (sslCredentials) {
  launchServer('https')

  if (config.server.useBoth) {
    launchServer('http')
  }
} else {
  launchServer('http')
}

// parser.getAddressesUtxos(['mxNL1rF87rfBEKtUfQ8YDg2r4crYn6hUDh', 'mhPee3aTfto9f5MLyLwwPu2wD3KoWn85fo'], function (err, utxos) {
//   if (err) return console.error(err)
//   console.log('utxos', JSON.stringify(utxos))
// })
// parser.getAddressesTransactions(['mxNL1rF87rfBEKtUfQ8YDg2r4crYn6hUDh', 'mhPee3aTfto9f5MLyLwwPu2wD3KoWn85fo'], function (err, transactions) {
//   if (err) return console.error(err)
//   console.log('transactions', JSON.stringify(transactions))
// })

// setTimeout(function () {
//   parser.getInfo(function (err, info) {
//     console.log(err, info)
//   })
// }, 12000)
