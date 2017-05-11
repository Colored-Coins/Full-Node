#!/usr/bin/env node

const path = require('path')
const fs = require('fs')
const async = require('async')
const argv = require('yargs').argv
const download = require('download')
const innoSetupCompiler = require('innosetup-compiler')

const DEPENDENCIES_PATH = path.join(__dirname, '..', 'dependencies')
const DIST_PATH = path.join(__dirname, '..', 'dist')

var architecture = 'all'
if (argv._[0]) {
  if (['all', 32, 64].indexOf(argv._[0]) === -1) {
    return console.warn("arch parameter must be one of 'all', '64' or '32'.")
  }
  architecture = argv._[0].toString()
}

function done (err) {
  if (err) return console.error('Error occurred while trying to package windows installer: ', err)
  console.log('Done.')
}

async.waterfall([
  function (cb) {
    if (architecture === 'all' || architecture === '64') {
      return packageWindowsInstaller(64, cb)
    }
    cb()
  },
  function (cb) {
    if (architecture === 'all' || architecture === '32') {
      return packageWindowsInstaller(32, cb)
    }
    cb()
  }
], done)

// bits: '64' or '32'
function packageWindowsInstaller (bits, callback) {
  console.log('Packaging windows installer ' + bits + 'bit ...')
  async.waterfall([
    function (cb) {
      console.log('  downloading Bitcoin-Core ' + bits + 'bit setup...')
      download('https://bitcoin.org/bin/bitcoin-core-0.14.1/bitcoin-0.14.1-win' + bits + '-setup.exe', DEPENDENCIES_PATH).then(() => {
        console.log('  done downloading Bitcoin-Core setup.')
        cb()
      })
    },
    function (cb) {
      console.log('  downloading Redis ' + bits + 'bit setup...')
      download('http://ruilopes.com/redis-setup/binaries/redis-2.4.6-setup-' + bits + '-bit.exe', DEPENDENCIES_PATH).then(() => {
        console.log('  done downloading Redis setup.')
        cb()
      })
    },
    function (cb) {
      innoSetupCompiler(path.join(__dirname, 'win' + bits + '.iss'), {O: DIST_PATH}, cb)
    }
  ],
  function (err) {
    if (err) return callback(err)
    console.log('Packaging windows installer ' + bits + 'bit - Done.')
    callback()
  })
}
