var routes = [
  {
    path: '/getAddressesUtxos',
    method: 'post',
    functionName: 'getAddressesUtxos',
    params: ['addresses'],
    optionalParams: ['numOfConfirmations']
  },
  {
    path: '/getAddressesTransactions',
    method: 'post',
    functionName: 'getAddressesTransactions',
    params: ['addresses'],
    optionalParams: []
  },
  {
    path: '/transmit',
    method: 'post',
    functionName: 'transmit',
    params: ['txHex'],
    optionalParams: []
  },
  {
    path: '/getInfo',
    method: 'get',
    functionName: 'getInfo',
    params: [],
    optionalParams: []
  }
]

module.exports = function (app, parser) {

  var handleResponse = function (err, ans, res, next) {
    if (err) return next(err)
    res.send(ans)
  }

  routes.forEach(function (route) {
    app[route.method](route.path, function (req, res, next) {
      var args = {}
      var err
      route.params.some(function (param) {
        args[param] = req.body[param]
        if (!args[param]) {
          err = param + ' is required.'
          return true
        }
      })
      if (err) {
        res.status(400)
        return next(err)
      }
      route.optionalParams.forEach(function (param) {
        args[param] = req.body[param]
      })
      parser[route.functionName](args, function (err, ans) {
        handleResponse(err, ans, res, next)
      })
    })
  })
}