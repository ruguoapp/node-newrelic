'use strict'

const logger = require('../logger').child({component: 'transactionHandle'})
const DistributedTracePayloadStub = require('./dt-payload').Stub


module.exports = class TransactionHandle {
  /**
  * A light representation of a transaction instance, returned by calling
  * {@link API#getTransaction}.
  *
  * @constructor
  */
  constructor(transaction) {
    this._transaction = transaction
  }

  /**
  * End the transaction.
  *
  * @param  {Function} callback
  */
  end(callback) {
    this._transaction.end(callback)
  }

  /**
  * Mark the transaction to be ignored.
  */
  ignore() {
    this._transaction.setForceIgnore(true)
  }

  /**
  * Proxy method for Transaction#createDistrubtedTracePayload.
  *
  * @returns {DistributedTracePayload} The created payload object.
  */
  createDistributedTracePayload(options) {
    return this._transaction.createDistributedTracePayload(options)
  }

  createDistributedTraceHeaders(options) {
    return this._transaction.createDistributedTraceHeaders(options)
  }

  /**
  * Proxy method for Transaction#acceptDistributedTracePayload
  *
  * @param {String} payload The payload to accept as the parent to the current trace.
  */
  acceptDistributedTracePayload(parent, state) {
    if (this._transaction.agent.config.feature_flag.trace_context) {
      return this._transaction.acceptTraceContextPayload(parent, state)
    }
    return this._transaction.acceptDistributedTracePayload(parent, state)
  }
}

module.exports.Stub = class TransactionHandleStub {
  end(callback) {
    if (callback instanceof Function) {
      setImmediate(callback)
    }
    logger.debug('No transaction found when calling Transaction.end')
  }

  ignore() {
    logger.debug('No transaction found when calling Transaction.ignore')
  }

  createDistributedTracePayload() {
    logger.debug(
      'No transaction found when calling Transaction.createDistributedTracePayload'
    )
    return new DistributedTracePayloadStub()
  }

  createDistributedTraceHeaders() {
    logger.debug(
      'No transaction found when calling Transaction.createDistributedTraceHeaders'
    )
    return {parent: '', state: ''}
  }

  acceptDistributedTracePayload() {
    logger.debug(
      'No transaction found when calling Transaction.acceptDistributedTracePayload'
    )
  }
}
