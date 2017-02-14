var async = require('async')
var CCTransaction = require('cc-transaction')
var getAssetsOutputs = require('cc-get-assets-outputs')
var bitcoinjs = require('bitcoinjs-lib')
var bufferReverse = require('buffer-reverse')

var mainnetFirstColoredBlock = 364548
var testnetFirstColoredBlock = 462320

var blockStates = {
  NOT_EXISTS: 0,
  GOOD: 1,
  FORKED: 2
}

module.exports = function (args) {

  var redis = args.redis
  var bitcoin = args.bitcoin
  var network = args.network
  var bitcoinNetwork = (network === 'mainnet') ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet
  var level = args.level

  var getNextBlockHeight = function (cb) {
    redis.hget('blocks', 'lastBlockHeight', function (err, lastBlockHeight) {
      if (err) return cb(err)
      lastBlockHeight = lastBlockHeight || ((network === 'mainnet' ? mainnetFirstColoredBlock : testnetFirstColoredBlock) - 1)
      lastBlockHeight = parseInt(lastBlockHeight)
      cb(null, lastBlockHeight + 1)
    })
  }

  var getNextBlock = function (height, cb) {
    console.log('getting block', height)
    console.time('getting block', height)
    bitcoin.cmd('getblockhash', [height], function (err, hash) {
      if (err) return cb(err)
      bitcoin.cmd('getblock', [hash, false], function (err, rawBlock) {
        if (err) return cb(err)
        var block = bitcoinjs.Block.fromHex(rawBlock)
        block.height = height
        block.hash = hash
        block.previousblockhash = bufferReverse(block.prevHash).toString('hex')
        block.transactions = block.transactions.map(function (transaction) {
          return decodeRawTransaction(transaction)
        })
        console.timeEnd('getting block', height)
        cb(null, block)
      })
    })
  }

  var checkNextBlock = function (block, cb) {
    if (!block) return cb(null, blockStates.NOT_EXISTS, block)
    redis.hget('block', block.height - 1, function (err, hash) {
      if (!hash || hash === block.previousblockhash) return cb(null, blockStates.GOOD, block)
      return cb(null, blockStates.FORKED, block)
    })
  }

  var getUtxosChanges = function (blockHeight, cb) {
    level.get('rev_block_' + blockHeight, function (err, utxosChanges) {
      if (err) return cb(err)
      utxosChanges = JSON.parse(utxosChanges)
      cb(null, utxosChanges)
    })
  }

  var revertBlock = function (blockHeight, cb) {
    var utxosChanges
    async.waterfall([
      function (cb) {
        getUtxosChanges(blockHeight, cb)
      },
      function (_utxosChanges, cb) {
        utxosChanges = _utxosChanges
        saveNewUtxos(utxosChanges.used, cb)
      },
      function (cb) {
        removeSpents(utxosChanges.unused, cb)
      },
      function (cb) {
        updateLastBlock(blockHeight - 1, cb)
      }
    ], cb)
  }

  var conditionalParseNextBlock = function (state, block, cb) {
    console.log('block', block.hash, block.height, 'txs:', block.transactions.length, 'state', state)
    if (state === blockStates.NOT_EXISTS) {
      return mempoolParse(cb)
    }
    if (state === blockStates.GOOD) {
      return parseNewBlock(block, cb)
    }
    if (state === blockStates.FORKED) {
      return revertBlock(blockHeight - 1, cb)
    }
    cb('Unknown block state')
  }

  var checkVersion = function (hex) {
    var version = hex.toString('hex').substring(0, 4)
    return (version.toLowerCase() === '4343')
  }

  var getColoredData = function (transaction) {
    var coloredData = null
    transaction.vout.some(function (vout) {
      if (!vout.scriptPubKey || !vout.scriptPubKey.type === 'nulldata') return null
      var hex = vout.scriptPubKey.asm.substring('OP_RETURN '.length)
      if (checkVersion(hex)) {
        try {
          coloredData = CCTransaction.fromHex(hex).toJson()
        } catch (e) {
          console.log('Invalid CC transaction.')
        }
      }
      return coloredData
    })
    return coloredData
  }

  var parseTransaction = function (transaction, utxosChanges, blockHeight, cb) {
    // console.log('txid', transaction.txid)
    var coloredData = getColoredData(transaction)
    // console.log('coloredData', coloredData)
    transaction.ccdata = [coloredData]
    async.each(transaction.vin, function (input, cb) {
      var previousOutput = input.txid + ':' + input.vout
      if (utxosChanges.unused[previousOutput]) {
        input.assets = JSON.parse(utxosChanges.unused[previousOutput].assets)
        delete utxosChanges.unused[previousOutput]
        return cb()
      }
      redis.hgetall(previousOutput, function (err, utxo) {
        if (err) return cb(err)
        input.assets = utxo && utxo.assets && JSON.parse(utxo && utxo.assets) || []
        if (input.assets.length) {
          utxosChanges.used[previousOutput] = utxo
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      if (!coloredData) return cb()
      var outputsAssets = getAssetsOutputs(transaction)
      outputsAssets.forEach(function (assets, outputIndex) {
        if (assets.length) {
          utxosChanges.unused[transaction.txid + ':' + outputIndex] = {
            assets: JSON.stringify(assets),
            used: false,
            blockHeight: blockHeight
          }
        }
      })
      cb()
    })
  }
  var saveUtxoChangeObject = function (blockHeight, utxosChanges, cb) {
    level.put('rev_block_' + blockHeight, JSON.stringify(utxosChanges), {sync: true}, cb)
  }

  var saveNewUtxos = function (utxos, cb) {
    async.each(Object.keys(utxos), function (key, cb) {
      var utxo = utxos[key]
      redis.hmset(key, utxo, cb)
    }, cb)
  }

  var removeSpents = function (used, cb) {
    async.each(Object.keys(used), function (txo, cb) {
      redis.del(txo, cb)
    }, cb)
  }

  var updateLastBlock = function (blockHeight, blockHash, cb) {
    if (typeof blockHash === 'function') {
      cb = blockHash
      blockHash = '00'
    }
    redis.hmset('blocks', blockHeight, blockHash, 'lastBlockHeight', blockHeight, cb)
  }

  var updateUtxosChanges = function (block, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        console.time('saveUtxoChangeObject')
        saveUtxoChangeObject(block.height, utxosChanges, cb)
      },
      function (cb) {
        console.timeEnd('saveUtxoChangeObject')
        saveNewUtxos(utxosChanges.unused, cb)
      },
      function (cb) {
        removeSpents(utxosChanges.used, cb)
      },
      function (cb) {
        updateLastBlock(block.height, block.hash, cb)
      }
    ], function (err) {
      if (utxosChanges.unused.length && utxosChanges.used.length) {
        throw ('last update:', utxosChanges)
      }
      cb()
    })
  }

  var decodeRawTransaction = function (tx) {
    var r = {}
    r['txid'] = tx.getId()
    r['version'] = tx.version
    r['locktime'] = tx.lock_time
    r['vin'] = []
    r['vout'] = []

    tx.ins.forEach(function (txin) {
        var txid = txin.hash.reverse().toString('hex')
        var n = txin.index
        var seq = txin.sequence
        var hex = txin.script.toString('hex')
        if (n == 4294967295) {
          r['vin'].push({'txid': txid, 'vout': n, 'coinbase' : hex, 'sequence' : seq})
        } else {
          var asm = bitcoinjs.script.toASM(txin.script)
          r['vin'].push({'txid': txid, 'vout': n, 'scriptSig' : {'asm': asm, 'hex': hex}, 'sequence':seq})
        }
    })

    tx.outs.forEach(function (txout, i) {
        var value = txout.value
        var hex = txout.script.toString('hex')
        var asm = bitcoinjs.script.toASM(txout.script)
        var type = bitcoinjs.script.classifyOutput(txout.script)
        var addresses = []
        if (~['pubkeyhash', 'scripthash'].indexOf(type)) {
          addresses.push(bitcoinjs.address.fromOutputScript(bitcoinjs.script.decompile(txout.script), bitcoinNetwork))
        } 
        var answer = {'value' : value, 'n': i, 'scriptPubKey': {'asm': asm, 'hex': hex, 'addresses': addresses, 'type': type}}

        r['vout'].push(answer)
    })
    return r
  }

  var parseNewBlock = function (block, cb) {
    var utxosChanges = {
      used: {},
      unused: {}
    }
    var inputs = {}
    var txs = {}
    async.waterfall([
      function (cb) {
        console.log('parsing block transactions')
        console.time('parsing block transactions')
        async.eachSeries(block.transactions, function (transaction, cb) {
          parseTransaction(transaction, utxosChanges, block.height, cb)
        }, cb)
      }
    ], function (err) {
      if (err) return cb(err)
      console.timeEnd('parsing block transactions')
      console.log('updating block transactions')
      console.time('updating block transactions')
      console.log('utxosChanges', JSON.stringify(utxosChanges))
      updateUtxosChanges(block, utxosChanges, cb)
    })
  }

  var mempoolParse = function (cb) {
    return cb()
  }

  var finishParsing = function (err)  {
    console.timeEnd('updating block transactions')
    if (err) console.error(err)
    // setTimeout(parse, 1000)
    parse()
  }

  var parse = function () {
    console.log('starting parse loop')
    async.waterfall([
      getNextBlockHeight,
      getNextBlock,
      checkNextBlock,
      conditionalParseNextBlock
    ], finishParsing)
  }

  return {
    parse: parse
  }  
}