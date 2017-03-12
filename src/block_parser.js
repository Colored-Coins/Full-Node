var async = require('async')
var CCTransaction = require('cc-transaction')
var getAssetsOutputs = require('cc-get-assets-outputs')
var bitcoinjs = require('bitcoinjs-lib')
var bufferReverse = require('buffer-reverse')
var _ = require('lodash')
var toposort = require('toposort')

var mainnetFirstColoredBlock = 364548
var testnetFirstColoredBlock = 462320

var blockStates = {
  NOT_EXISTS: 0,
  GOOD: 1,
  FORKED: 2
}

var label = 'cc-full-node'

module.exports = function (args) {

  var redis = args.redis
  var bitcoin = args.bitcoin
  var network = args.network
  var bitcoinNetwork = (network === 'mainnet') ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet
  var debug = args.debug
  
  if (!debug) {
    console.log = function () {}
  }

  var info = {}

  var getNextBlockHeight = function (cb) {
    redis.hget('blocks', 'lastBlockHeight', function (err, lastBlockHeight) {
      if (err) return cb(err)
      lastBlockHeight = lastBlockHeight || ((network === 'mainnet' ? mainnetFirstColoredBlock : testnetFirstColoredBlock) - 1)
      lastBlockHeight = parseInt(lastBlockHeight)
      cb(null, lastBlockHeight + 1)
    })
  }

  var getNextBlock = function (height, cb) {
    bitcoin.cmd('getblockhash', [height], function (err, hash) {
      if (err) {
        if (err.code && err.code === -8) {
          return cb(null, null)
        }
        return cb(err)
      }
      bitcoin.cmd('getblock', [hash, false], function (err, rawBlock) {
        if (err) return cb(err)
        var block = bitcoinjs.Block.fromHex(rawBlock)
        block.height = height
        block.hash = hash
        block.previousblockhash = bufferReverse(block.prevHash).toString('hex')
        block.transactions = block.transactions.map(function (transaction) {
          return decodeRawTransaction(transaction)
        })
        cb(null, block)
      })
    })
  }

  var checkNextBlock = function (block, cb) {
    if (!block) return cb(null, blockStates.NOT_EXISTS, block)
    redis.hget('blocks', block.height - 1, function (err, hash) {
      if (!hash || hash === block.previousblockhash) return cb(null, blockStates.GOOD, block)
      cb(null, blockStates.FORKED, block)
    })
  }

  var revertBlock = function (blockHeight, cb) {
    console.log('forking block', blockHeight)
    updateLastBlock(blockHeight - 1, cb)
  }

  var conditionalParseNextBlock = function (state, block, cb) {
    if (state === blockStates.NOT_EXISTS) {
      return mempoolParse(cb)
    }
    // console.log('block', block.hash, block.height, 'txs:', block.transactions.length, 'state', state)
    if (state === blockStates.GOOD) {
      return parseNewBlock(block, cb)
    }
    if (state === blockStates.FORKED) {
      return revertBlock(block.height - 1, cb)
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
    async.each(transaction.vin, function (input, cb) {
      var previousOutput = input.txid + ':' + input.vout
      if (utxosChanges.unused[previousOutput]) {
        input.assets = JSON.parse(utxosChanges.unused[previousOutput])
        return process.nextTick(cb)
      }
      redis.hget('utxos', previousOutput, function (err, assets) {
        if (err) return cb(err)
        input.assets = assets && JSON.parse(assets) || []
        if (input.assets.length) {
          utxosChanges.used[previousOutput] = assets
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      var outputsAssets = getAssetsOutputs(transaction)
      outputsAssets.forEach(function (assets, outputIndex) {
        if (assets && assets.length) {
          utxosChanges.unused[transaction.txid + ':' + outputIndex] = JSON.stringify(assets)
        }
      })
      cb()
    })
  }

  var setTxos = function (utxos, cb) {
    async.each(Object.keys(utxos), function (utxo, cb) {
      var assets = utxos[utxo]
      redis.hmset('utxos', utxo, assets, cb)
    }, cb)
  }

  var updateLastBlock = function (blockHeight, blockHash, timestamp, cb) {
    if (typeof blockHash === 'function') {
      return redis.hmset('blocks', 'lastBlockHeight', blockHeight, blockHash)
    }
    redis.hmset('blocks', blockHeight, blockHash, 'lastBlockHeight', blockHeight, 'lastTimestamp', timestamp, function (err) {
      cb(err)
    })
  }

  var updateUtxosChanges = function (block, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateLastBlock(block.height, block.hash, block.timestamp, cb)
      }
    ], cb)
  }

  var updateParsedMempoolTxids = function (txids, cb) {
    async.waterfall([
      function (cb) {
        redis.hget('mempool', 'parsed', cb)
      },
      function (parsedMempool, cb) {
        parsedMempool = JSON.parse(parsedMempool || '[]')
        parsedMempool = parsedMempool.concat(txids)
        parsedMempool = _.uniq(parsedMempool)
        redis.hmset('mempool', 'parsed', JSON.stringify(parsedMempool), cb)
      }
    ], function (err) {
      cb(err)
    })
  }

  var updateMempoolTransactionUtxosChanges = function (txid, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateParsedMempoolTxids([txid], cb)
      }
    ], cb)
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
    info.timestamp = block.timestamp
    info.height = block.height
    var utxosChanges = {
      used: {},
      unused: {},
      txids: []
    }
    async.eachSeries(block.transactions, function (transaction, cb) {
      utxosChanges.txids.push(transaction.txid)
      var coloredData = getColoredData(transaction)
      if (!coloredData) return process.nextTick(cb)
      transaction.ccdata = [coloredData]
      parseTransaction(transaction, utxosChanges, block.height, cb)
    }, function (err) {
      if (err) return cb(err)
      updateUtxosChanges(block, utxosChanges, cb)
    })
  }

  var getMempoolTxids = function (cb) {
    bitcoin.cmd('getrawmempool', [], cb)
  }

  var getNewMempoolTxids = function (mempoolTxids, cb) {
    redis.hget('mempool', 'parsed', function (err, mempool) {
      if (err) return cb(err)
      mempool = mempool || '[]'
      var parsedMempoolTxids = JSON.parse(mempool)
      newMempoolTxids = _.difference(mempoolTxids, parsedMempoolTxids)
      cb(null, newMempoolTxids)
    })
  }

  var getNewMempoolTransaction = function (newMempoolTxids, cb) {
    var commandsArr = newMempoolTxids.map(function (txid) {
      return { method: 'getrawtransaction', params: [txid, 0]}
    })
    var newMempoolTransactions = []
    bitcoin.cmd(commandsArr, function (rawTransaction, cb) {
      var newMempoolTransaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
      newMempoolTransactions.push(newMempoolTransaction)
      cb()
    },
    function (err) {
      cb(err, newMempoolTransactions)
    })
  }

  var orderByDependencies = function (transactions) {
    var txids = {}
    transactions.forEach(function (transaction) { 
      txids[transaction.txid] = transaction
    })
    var edges = []
    transactions.forEach(function (transaction) {
      transaction.vin.forEach(function (input) {
        if (txids[input.txid]) {
          edges.push([input.txid, transaction.txid])
        }
      })
    })
    var sortedTxids = toposort.array(Object.keys(txids), edges)
    return sortedTxids.map(function (txid) { return txids[txid] } )
  }

  var parseNewMempoolTransactions = function (newMempoolTransactions, cb) {
    newMempoolTransactions = orderByDependencies(newMempoolTransactions)
    var nonColoredTxids  = []
    async.eachSeries(newMempoolTransactions, function (newMempoolTransaction, cb) {
      var utxosChanges = {
        used: {},
        unused: {}
      }
      var coloredData = getColoredData(newMempoolTransaction)
      if (!coloredData) {
        nonColoredTxids.push(newMempoolTransaction.txid)
        return process.nextTick(cb)
      }
      newMempoolTransaction.ccdata = [coloredData]
      parseTransaction(newMempoolTransaction, utxosChanges, -1, function (err) {
        if (err) return cb(err)
        updateMempoolTransactionUtxosChanges(newMempoolTransaction.txid, utxosChanges, cb)
      })
    }, function (err) {
      if (err) return cb(err)
      updateParsedMempoolTxids(nonColoredTxids, cb)
    })
  }

  var updateInfo = function (cb) {
    if (info.height && info.timestamp) return process.nextTick(cb)
    redis.hmget('blocks', 'lastBlockHeight', 'lastTimestamp', function (err, arr) {
      if (err) return cb(err)
      if (!arr || arr.length < 2) return process.nextTick(cb)
      info.height = arr[0]
      info.timestamp = arr[1]
      cb()
    })
  }

  var mempoolParse = function (cb) {
    // console.log('parsing mempool')
    async.waterfall([
      updateInfo,
      getMempoolTxids,
      getNewMempoolTxids,
      getNewMempoolTransaction,
      parseNewMempoolTransactions
    ], cb)
  }

  var finishParsing = function (err)  {
    if (err) console.error(err)
    parse()
  }

  var importAddresses = function (addresses, cb) {
    var newAddresses
    var importedAddresses
    async.waterfall([
      function (cb) {
        redis.hget('addresses', 'imported', cb)
      },
      function (_importedAddresses, cb) {
        importedAddresses = _importedAddresses || '[]'
        importedAddresses = JSON.parse(importedAddresses)
        newAddresses = _.difference(addresses, importedAddresses)
        if (newAddresses.length < 2) return process.nextTick(cb)
        var commandsArr = newAddresses.splice(0, newAddresses.length - 1).map(function (address) {
          return {
            method: 'importaddress',
            params: [address, label, false]
          }
        })
        bitcoin.cmd(commandsArr, function (ans, cb) { return process.nextTick(cb)}, cb)
      },
      function (cb) {
        if (!newAddresses.length) return process.nextTick(cb)
        var waitForBitcoinReparse = function (err) {
          if (err) {
            return setTimeout(function() { 
              console.log('Waiting for bitcoin to finnish reparsing...')
              bitcoin.cmd('getinfo', [], waitForBitcoinReparse)
            }, 1000)
          }
          cb()
        }
        bitcoin.cmd('importaddress', [newAddresses[0], label, true], waitForBitcoinReparse)
      },
      function (cb) {
        newAddresses = _.difference(addresses, importedAddresses)
        if (!newAddresses.length) return process.nextTick(cb)
        importedAddresses = importedAddresses.concat(newAddresses)
        redis.hmset('addresses', 'imported', JSON.stringify(importedAddresses), function (err) {
          cb(err)
        })
      }
    ] ,cb)
  }

  var parse = function (addresses, progressCallback) {
    if (typeof addresses === 'function') {
      progressCallback = addresses
      addresses = null
    }

    if (progressCallback) {
      setInterval(function () { progressCallback(info) }, 5000);
    }

    async.waterfall([
      function (cb) {
        if (!addresses || !Array.isArray(addresses)) return process.nextTick(cb)
        importAddresses(addresses, cb)
      },
      getNextBlockHeight,
      getNextBlock,
      checkNextBlock,
      conditionalParseNextBlock
    ], finishParsing) 
  }

  var getAddressesUtxos = function (addresses, numOfConfirmations, cb) {
    if (typeof numOfConfirmations === 'function') {
      cb = numOfConfirmations
      numOfConfirmations = 0
    }
    bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
      if (err) return cb(err)
      async.each(utxos, function (utxo, cb) {
        redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, assets) {
          if (err) return cb(err)
          utxo.assets = assets && JSON.parse(assets) || []
          cb()
        })
      }, function (err) {
        if (err) return cb(err)
        cb(null, utxos)
      })
    })
  }

  var transmit = function (txHex, cb) {
    bitcoin_rpc.cmd('sendrawtransaction', [txHex], cb)
  }

  var addColoredInputs = function (transaction, cb) {
    async.each(transaction.vin, function (input, cb) {
      redis.hget('utxos', input.txid + ':' + input.vout, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        input.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredOutputs = function (transaction, cb) {
    async.each(transaction.vout, function (output, cb) {
      redis.hget('utxos', transaction.txid + ':' + output.n, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        output.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredIOs = function (transaction, cb) {
    async.waterfall([
      function (cb) {
        addColoredInputs(transaction, cb)
      },
      function (transaction, cb) {
        addColoredOutputs(transaction, cb)
      }
    ], cb)
  }

  var getAddressesTransactions = function (addresses, cb) {
    var next = true
    var txids = []
    var skip = 0
    var count = 10
    async.whilst(function () { return next }, function (cb) {
      bitcoin.cmd('listtransactions', [label, count, skip, true], function (err, transactions) {
        if (err) return cb(err)
        skip+=count
        transactions.forEach(function (transaction) {
          if (~addresses.indexOf(transaction.address) && !~txids.indexOf(transaction.txid)) {
            txids.push(transaction.txid)
          }
        })
        if (transactions.length < count) {
          next = false
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      async.map(txids, function (txid, cb) {
        bitcoin.cmd('getrawtransaction', [txid], function (err, rawTransaction) {
          if (err) return cb(err)
          var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
          addColoredIOs(transaction, cb)
        })
      }, cb)
    })
  }

  return {
    parse: parse,
    getAddressesUtxos: getAddressesUtxos,
    getAddressesTransactions: getAddressesTransactions,
    transmit: transmit
  }  
}