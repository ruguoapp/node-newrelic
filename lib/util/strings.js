'use strict'

exports.leftPad = leftPad
exports.rightPad = rightPad

function leftPad(str, length, pad) {
  pad = pad || ' '
  if (str.length < length) {
    return pad.repeat(length - str.length) + str
  }
  return str
}

function rightPad(str, length, pad) {
  str = str || ''
  pad = pad || ' '
  if (str.length < length) {
    return str + pad.repeat(length - str.length)
  }
  return str
}
