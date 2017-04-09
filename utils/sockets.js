
var channels = ['newblock', 'newtransaction', 'newcctransaction', 'info']

module.exports = function (args) {

  var io = args.io
  var emitter = args.emitter

  var events = io.of('/events')

  channels.forEach(channel => {
    emitter.on(channel, data => {
      events
      // .local
      .emit(channel, data)
    })
  })

  return {

  }
}