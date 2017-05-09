#!/usr/bin/env node

const path = require('path')
const innoSetupCompiler = require('innosetup-compiler')

const DIST_PATH = path.join(__dirname, '..', 'dist')

// TODO: sign
innoSetupCompiler(path.join(__dirname, 'win.iss'), {
  O: DIST_PATH
}, function (err) {
  if (err) console.error('Error while trying to generate installer.')
  console.log('Done generating installer to', DIST_PATH)
})
