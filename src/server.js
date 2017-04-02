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
var config = require(path.join(__dirname ,'/../utils/config.js'))(propertiesFilePath)
var parser = require(path.join(__dirname ,'/../src/block_parser.js'))(config)
var router = require(path.join(__dirname ,'/../router/router.js'))

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

router(app, parser)

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
