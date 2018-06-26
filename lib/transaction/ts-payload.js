'use strict'
var logger = require('../logger').child({component: 'traceStatePayload'})
var makeBuffer = require('../util/hashes').makeBuffer

// binary representation order
// [version] (2 bytes, 1 byte per specifier)
// type (1 bit)
// sampled (1 bit, possibly omittable)
// guid (15 bytes, padded with spaces on the left)
// priority (7 bytes, first 5 decimal places assuming single digit integral part)
// trace id (15 bytes, padded with spaces on the left)
// account id (10 bytes)
// timestamp (8 bytes)
// app id (unbounded size)
// checksum (2 bytes)

const version = [0,1]

module.exports = class TraceStatePayload {
  constructor(payload) {
    logger.trace('TraceStatePayload created with %s', payload)
    this.payload = payload

    this.jsonPayload = null
    this.binaryPayload = null
  }

  text(isBinary) {
    logger.trace('TraceStatePayload text: %s', this.plainTextPayload)
    if (isBinary) {
      return this.getBinaryPayload().toString('utf-8')
    }

    if (!this.jsonPayload) {
      this.jsonPayload = JSON.stringify({
        v: version,
        d: this.payload
      })
    }

    return this.jsonPayload
  }

  httpSafe(isBinary) {
    if (isBinary) {
      return this.getBinaryPayload().toString('base64')
    }

    if (!this.jsonPayload) {
      this.jsonPayload = JSON.stringify({
        v: version,
        d: this.payload
      })
    }

    return makeBuffer(this.jsonPayload, 'utf-8').toString('base64')
  }

  getBinaryPayload() {
    if (!this.binaryPayload) {
      const payload = this.payload
      const buf = this.binaryPayload = Buffer.alloc(60 + payload.ap.length)
      buf.writeUInt8(version[0], 0)
      buf.writeUInt8(version[1], 1)

      // Consolidate all enum types into a single byte.
      // `type` only has two options: App and Mobile
      const type = payload.ty === 'App' ? 1 : 0
      const sampled = payload.sa ? 1 : 0

      buf.writeUInt8((type << 1) | sampled, 2)

      buf.write(pad(payload.id, 15), 3)

      buf.write(payload.pr.toFixed(5), 18)

      buf.write(pad(payload.tr, 15), 25)

      buf.write(pad(payload.ac, 10), 40)

      buf.writeUIntBE(payload.ti, 50, 8)

      buf.write(payload.ap, 58)

      buf.writeUInt16BE(buf.reduce((a, b) => a + b, 0) % Math.pow(2, 16), buf.length - 2)
    }
    console.log('encoded', this.payload)
    return this.binaryPayload
  }

  static parseBinary(binaryPayload) {
    // TODO: check if the major version is one we know how to parse
    //
    const checksum = binaryPayload.readUInt16BE(binaryPayload.length - 2)
    const values = binaryPayload.slice(0, binaryPayload.length - 2)
    const sum = values.reduce((a, b) => a + b, 0) % Math.pow(2, 16)

    if (checksum !== sum) {
      console.log('No match on checksum')
      return null
    }

    const bitFlags = binaryPayload.readUInt8(2)
    const type = bitFlags & 2
    const sampled = bitFlags & 1

    return {
      v: [binaryPayload.readUInt8(0), binaryPayload.readUInt8(1)],
      d: {
        ty: type ? 'App' : 'Mobile',
        sa: !!sampled,
        id: binaryPayload.toString('utf-8', 3, 18).trim(),
        pr: parseFloat(binaryPayload.toString('utf-8', 18, 25)),
        tr: binaryPayload.toString('utf-8', 25, 40).trim(),
        ac: binaryPayload.toString('utf-8', 40, 50).trim(),
        ti: binaryPayload.readUIntBE(50, 8),
        ap: binaryPayload.toString('utf-8', 58, binaryPayload.length - 2)
      }
    }
  }
}

module.exports.Stub = class TraceStatePayloadStub {
  text() {
    logger.debug('TraceStatePayloadStub text')
    return ''
  }

  httpSafe() {
    logger.debug('TraceStatePayloadStub httpSafe')
    return ''
  }
}

function pad(string, length) {
  if (string.length >= length) {
    return string
  }
  return (new Array(length - string.length)).fill(' ').join('') + string
}
