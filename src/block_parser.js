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
    // console.log('getting block', height)
    // console.time('getting block', height)
    bitcoin.cmd('getblockhash', [height], function (err, hash) {
      if (err) {
        if (err.code && err.code === -8) {
          return cb(null, null)
        }
        return cb(err)
      }
      bitcoin.cmd('getblock', [hash, false], function (err, rawBlock) {
        if (err) return cb(err)
        // console.log('blockhex', rawBlock)
        var block = bitcoinjs.Block.fromHex(rawBlock)
        block.height = height
        block.hash = hash
        block.previousblockhash = bufferReverse(block.prevHash).toString('hex')
        block.transactions = block.transactions.map(function (transaction) {
          return decodeRawTransaction(transaction)
        })
        // console.timeEnd('getting block', height)
        cb(null, block)
      })
    })
  }

  var checkNextBlock = function (block, cb) {
    if (!block) return cb(null, blockStates.NOT_EXISTS, block)
    redis.hget('blocks', block.height - 1, function (err, hash) {
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
    console.log('forking block', blockHeight)
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

  var getUtxosChangesForMempoolTransaction = function (txid, cb) {
    level.get('rev_mempool_tx_' + txid, function (err, utxosChanges) {
      if (err) return cb(err)
      utxosChanges = JSON.parse(utxosChanges)
      cb(null, utxosChanges)
    })
  }

  var setUnusedUtxos = function (used, cb) {
    async.each(Object.keys(used), function (key, cb) {
      redis.hmset(key, 'used', false, cb)
    }, cb)
  }

  var revertMempoolTransaction = function (txid, cb) {
    console.log('revertMempoolTransaction', txid)
    var utxosChanges
    async.waterfall([
      function (cb) {
        getUtxosChangesForMempoolTransaction(txid, cb)
      },
      function (_utxosChanges, cb) {
        utxosChanges = _utxosChanges
        setUnusedUtxos(utxosChanges.used, cb)
      },
      function (cb) {
        removeSpents(utxosChanges.unused, cb)
      }
    ], cb)
  }

  var conditionalParseNextBlock = function (state, block, cb) {
    if (state === blockStates.NOT_EXISTS) {
      return mempoolParse(cb)
    }
    console.log('block', block.hash, block.height, 'txs:', block.transactions.length, 'state', state)
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
    var coloredData = getColoredData(transaction)
    // console.log('txid', transaction.txid, 'coloredData', coloredData)
    transaction.ccdata = [coloredData]
    async.each(transaction.vin, function (input, cb) {
      var previousOutput = input.txid + ':' + input.vout
      if (utxosChanges.unused[previousOutput]) {
        utxosChanges.used[previousOutput] = utxosChanges.unused[previousOutput]
        input.assets = JSON.parse(utxosChanges.unused[previousOutput].assets)
        if (~blockHeight) {
          delete utxosChanges.unused[previousOutput]
        } else {
          utxosChanges.unused[previousOutput].used = true
        }
        return cb()
      }
      redis.hgetall(previousOutput, function (err, utxo) {
        if (err) return cb(err)
        input.assets = utxo && utxo.assets && JSON.parse(utxo && utxo.assets) || []
        if (input.assets.length) {
          utxosChanges.used[previousOutput] = utxo
          utxosChanges.used[previousOutput].used = true
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      if (!coloredData) return cb()
      var outputsAssets = getAssetsOutputs(transaction)
      async.eachSeries(outputsAssets, function (assets, cb) {
        if (!assets || !assets.length) {
          return cb()
        }
        var outputIndex = outputsAssets.indexOf(assets)
        redis.hgetall(transaction.txid + ':' + outputIndex, function (err, utxo) {
          if (err) return cb(err)
          utxosChanges.unused[transaction.txid + ':' + outputIndex] = utxo ? utxo : {
            assets: JSON.stringify(assets),
            used: false
          }
          utxosChanges.unused[transaction.txid + ':' + outputIndex].blockHeight = blockHeight
          cb()
        })
      }, cb)
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

  var usedSpents = function (utxos, cb) {
    async.each(Object.keys(utxos), function (key, cb) {
      var utxo = utxos[key]
      redis.hmset(key, utxo, cb)
    }, cb)
  }

  var updateLastBlock = function (blockHeight, blockHash, cb) {
    if (typeof blockHash === 'function') {
      return redis.hmset('blocks', 'lastBlockHeight', blockHeight, blockHash)
    }
    redis.hmset('blocks', blockHeight, blockHash, 'lastBlockHeight', blockHeight, cb)
  }

  var removeToRevertTxids = function (txids, cb) {
    async.waterfall([
      function (cb) {
        redis.hgetall('mempool', cb)
      },
      function (mempool, cb) {
        mempoolRevert = JSON.parse(mempool && mempool.torevert || '[]')
        mempoolRevert = _.difference(mempoolRevert, txids)
        mempoolParsed = JSON.parse(mempool && mempool.parsed || '[]')
        mempoolParsed = _.difference(mempoolParsed, txids)
        redis.hmset('mempool', 'torevert', JSON.stringify(mempoolRevert), 'parsed', JSON.stringify(mempoolParsed), cb)
      }
    ], function (err) {
      cb(err)
    })
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
        removeToRevertTxids(utxosChanges.txids, cb)
      },
      function (cb) {
        updateLastBlock(block.height, block.hash, cb)
      }
    ], cb)
  }

  var saveUtxoMempoolTransactionChangeObject = function (txid, utxosChanges, cb) {
    level.put('rev_mempool_tx_' + txid, JSON.stringify(utxosChanges), {sync: true}, cb)
  }

  var updateParsedMempoolTxid = function (txids, cb) {
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

  var updateMempoolTransactionUtxodChanges = function (txid, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        saveUtxoMempoolTransactionChangeObject(txid, utxosChanges, cb)
      },
      function (cb) {
        saveNewUtxos(utxosChanges.unused, cb)
      },
      function (cb) {
        usedSpents(utxosChanges.used, cb)
      },
      function (cb) {
        updateParsedMempoolTxid([txid], cb)
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
    var utxosChanges = {
      used: {},
      unused: {},
      txids: []
    }
    var txids = []
    async.waterfall([
      function (cb) {
        console.log('parsing block transactions')
        console.time('parsing block transactions')
        async.eachSeries(block.transactions, function (transaction, cb) {
          utxosChanges.txids.push(transaction.txid)
          parseTransaction(transaction, utxosChanges, block.height, cb)
        }, cb)
      }
    ], function (err) {
      if (err) return cb(err)
      console.timeEnd('parsing block transactions')
      console.log('updating block transactions')
      console.time('updating block transactions')
      // console.log('utxosChanges', JSON.stringify(utxosChanges))
      updateUtxosChanges(block, utxosChanges, function (err) {
        console.timeEnd('updating block transactions')
        cb(err)
      })
    })
  }

  var revertMempoolTransactions = function (cb) {
    async.waterfall([
      function (cb) {
        redis.hget('mempool', 'torevert', cb)
      },
      function (mempoolRevert, cb) {
        mempoolRevert = JSON.parse(mempoolRevert || '[]')
        var txids = []
        async.eachSeries(mempoolRevert, function (txid, cb) {
          txids.push(txid)
          revertMempoolTransaction(txid, cb)
        }, function (err) {
          if (err) return cb(err)
          removeToRevertTxids(txids, cb)
        }) 
      }
    ], cb)
  }

  var getMempoolTxids = function (cb) {
    bitcoin.cmd('getrawmempool', [], cb)
  }

  var categorizeMempoolTxids = function (mempoolTxids, cb) {
    // console.log('mempoolTxids', mempoolTxids)
    var newMempoolTxids
    async.waterfall([
      function (cb) {
        redis.hget('mempool', 'parsed', cb)
      },
      function (mempool, cb) {
        mempool = mempool || '[]'
        var parsedMempoolTxids = JSON.parse(mempool)
        // console.log('parsedMempoolTxids', parsedMempoolTxids)
        newMempoolTxids = _.difference(mempoolTxids, parsedMempoolTxids)
        // console.log('newMempoolTxids', newMempoolTxids)
        var toRevertMempoolTxids = _.difference(parsedMempoolTxids, mempoolTxids)
        // console.log('toRevertMempoolTxids', toRevertMempoolTxids)
        redis.hmset('mempool', 'torevert', JSON.stringify(toRevertMempoolTxids), cb)
      }, function (res, cb) {
        cb(null, newMempoolTxids)
      }
    ], cb)
  }

  var getNewMempoolTransaction = function (newMempoolTxids, cb) {
    var commandsArr = newMempoolTxids.map(function (txid) {
      return { method: 'getrawtransaction', params: [txid, 0]}
    })
    var newMempoolTransactions = []
    bitcoin.cmd(commandsArr, function (rawTrasaction, cb) {
      var newMempoolTransaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTrasaction))
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
    // console.log('ordered newMempoolTransactions', newMempoolTransactions.map(transaction => {return transaction.txid}))
    async.eachSeries(newMempoolTransactions, function (newMempoolTransaction, cb) {
      var utxosChanges = {
        used: {},
        unused: {}
      }
      parseTransaction(newMempoolTransaction, utxosChanges, -1, function (err) {
        if (err) return cb(err)
        // console.log(newMempoolTransaction.txid, utxosChanges)
        updateMempoolTransactionUtxodChanges(newMempoolTransaction.txid, utxosChanges, cb)
      })
    }, cb)
  }

  var mempoolParse = function (cb) {
    console.log('parsing mempool')
    async.waterfall([
      revertMempoolTransactions,
      getMempoolTxids,
      categorizeMempoolTxids,
      getNewMempoolTransaction,
      parseNewMempoolTransactions
    ], cb)
  }

  var finishParsing = function (err)  {
    if (err) console.error(err)
    // setTimeout(parse, 1000)
    parse()
  }

  var parse = function () {
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