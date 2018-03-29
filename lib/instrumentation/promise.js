'use strict'

var util = require('util')
var properties = require('../util/properties')
var shimmer = require('../shimmer')
var logger = require('../logger').child({component: 'promise'})


/**
 * @namespace Library.Spec
 *
 * @property {string} name
 *  The name of this promise library.
 *
 * @property {?string} constructor
 *  Optional. The name of the property that is the Promise constructor. Default
 *  is to use the library itself as the Promise constructor.
 *
 * @property {?bool} executor
 *  Optional. If true, the Promise constructor itself will be wrapped for the
 *  executor. If false then `_proto`, `_static`, or `_library` must have an
 *  `executor` field whose value is the name of the executor function. Default
 *  is false.
 *
 * @property {Library.Spec.Mapping} $proto
 *  The mapping for Promise instance method concepts (i.e. `then`). These are
 *  mapped on the Promise class' prototype.
 *
 * @property {Library.Spec.Mapping} $static
 *  The mapping for Promise static method concepts (i.e. `all`, `race`). These
 *  are mapped on the Promise class itself.
 *
 * @property {?Library.Spec.Mapping} $library
 *  The mapping for library-level static method concepts (i.e. `fcall`, `when`).
 *  These are mapped on the library containing the Promise class. NOTE: in most
 *  promise implementations, the Promise class is itself the library thus this
 *  property is unnecessary.
 */

/**
 * @namespace Library.Spec.Mapping
 *
 * @desc
 *   A mapping of promise concepts (i.e. `then`) to this library's implementation
 *   name(s) (i.e. `["then", "chain"]`). Each value can by either a single string
 *   or an array of strings if the concept exists under multiple keys. If any
 *   given concept doesn't exist in this library, it is simply skipped.
 *
 * @property {array} $copy
 *  An array of properties or methods to just directly copy without wrapping.
 *  This field only matters when `Library.Spec.executor` is `true`.
 *
 * @property {string|array} executor
 *
 *
 * @property {string|array} then
 *
 *
 * @property {string|array} all
 *
 *
 * @property {string|array} race
 *
 *
 * @property {string|array} resolve
 *  Indicates methods to wrap which are resolve factories. This method only
 *  requires wrapping if the library doesn't use an executor internally to
 *  implement it.
 *
 * @property {string|array} reject
 *  Indicates methods to wrap which are reject factories. Like `resolve`, this
 *  method only requires wrapping if the library doesn't use an executor
 *  internally to implement it.
 */

/**
 * Instruments a promise library.
 *
 * @param {Agent}         agent   - The New Relic APM agent.
 * @param {function}      library - The promise library.
 * @param {?Library.Spec} spec    - Spec for this promise library mapping.
 */
module.exports = function initialize(agent, library, spec) {
  logger.trace('Promise instrumentation: initialize')
  // Wrap library-level methods.
  wrapStaticMethods(library, spec.name, spec.$library)

  // Wrap prototype methods.
  var Promise = library[spec.constructor]
  wrapPrototype(Promise.prototype)
  wrapStaticMethods(Promise, spec.constructor, spec.$static)

  // See if we are wrapping the class itself.
  if (spec.executor) {
    shimmer.wrapMethod(library, spec.name, spec.constructor, wrapPromise)
  }

  /**
   * Wraps the Promise constructor as the executor.
   */
  function wrapPromise() {
    logger.trace('Promise instrumentation: wrapPromise')
    // Copy all unwrapped properties over.
    if (spec.$static && spec.$static.$copy) {
      spec.$static.$copy.forEach(function copyKeys(key) {
        if (!wrappedPromise[key]) {
          wrappedPromise[key] = Promise[key]
        }
      })
    }

    var passThrough = spec.$static && spec.$static.$passThrough
    if (passThrough) {
      passThrough.forEach(function assignProxy(proxyProp) {
        if (!properties.hasOwn(wrappedPromise, proxyProp)) {
          Object.defineProperty(wrappedPromise, proxyProp, {
            enumerable: true,
            configurable: true,
            get: function getOriginal() {
              return Promise[proxyProp]
            },
            set: function setOriginal(newValue) {
              Promise[proxyProp] = newValue
            }
          })
        }
      })
    }

    // Inherit to pass `instanceof` checks.
    util.inherits(wrappedPromise, Promise)

    // Make the wrapper.
    return wrappedPromise
  }

  function wrappedPromise(executor) {
    logger.trace('Promise instrumentation: wrappedPromise')
    if (!(this instanceof wrappedPromise)) {
      logger.trace(
        'Promise instrumentation: exiting wrappedPromise because ' +
        '!(this instanceof wrappedPromise)'
      )
      return Promise(executor) // eslint-disable-line new-cap
    }

    var parent = agent.tracer.segment
    var promise = null
    if (
      !parent ||
      !parent.transaction.isActive() ||
      typeof executor !== 'function' ||
      arguments.length !== 1
    ) {
      // We are expecting one function argument for executor, anything else is
      // non-standard, do not attempt to wrap. Also do not attempt to wrap if we
      // are not in a transaction.
      var cnstrctArgs = agent.tracer.slice(arguments)
      cnstrctArgs.unshift(Promise) // `unshift` === `push_front`
      promise = new (Promise.bind.apply(Promise, cnstrctArgs))()
    } else {
      var segmentName = 'Promise ' + (executor.name || '<anonymous>')
      var context = {
        promise: null,
        self: null,
        args: null
      }
      promise = new Promise(wrapExecutorContext(context))
      context.promise = promise
      var segment = _createSegment(segmentName)
      Contextualizer.link(null, promise, segment)

      agent.tracer.segment = segment
      segment.start()
      try {
        // Must run after promise is defined so that `__NR_wrapper` can be set.
        executor.apply(context.self, context.args)
      } catch (e) {
        context.args[1](e)
      } finally {
        agent.tracer.segment = parent
        segment.touch()
      }
    }

    // The Promise must be created using the "real" Promise constructor (using
    // normal Promise.apply(this) method does not work). But the prototype
    // chain must include the wrappedPromise.prototype, V8's promise
    // implementation uses promise.constructor to create new Promises for
    // calls to `then`, `chain` and `catch` which allows these Promises to
    // also be instrumented.
    promise.__proto__ = wrappedPromise.prototype  // eslint-disable-line no-proto

    return promise
  }

  function wrapPrototype(PromiseProto, name) {
    logger.trace('Promise instrumentation: wrapPrototype')
    // Don't wrap the proto if there is no spec for it.
    if (!spec.$proto) {
      logger.trace(
        'Promise instrumentation: exiting wrapPrototype because ' +
        '!spec.$proto'
      )
      return
    }

    name = name || (spec.constructor + '.prototype')

    // Wrap up instance methods.
    _safeWrap(PromiseProto, name, spec.$proto.executor, wrapExecutorCaller)
    _safeWrap(PromiseProto, name, spec.$proto.then, wrapThen)
    _safeWrap(PromiseProto, name, spec.$proto.cast, wrapCast)
    _safeWrap(PromiseProto, name, spec.$proto.catch, wrapCatch)
  }

  function wrapStaticMethods(lib, name, staticSpec) {
    logger.trace('Promise instrumentation: wrapStaticMethods')
    // Don't bother with empty specs.
    if (!staticSpec) {
      logger.trace(
        'Promise instrumentation: exiting wrapStaticMethods because ' +
        '!staticSpec'
      )
      return
    }

    _safeWrap(lib, name, staticSpec.cast, wrapCast)
    _safeWrap(lib, name, staticSpec.promisify, wrapPromisifiy)
  }

  function wrapExecutorCaller(caller) {
    logger.trace('Promise instrumentation: wrapExecutorCaller')
    return function wrappedExecutorCaller(executor) {
      logger.trace('Promise instrumentation: wrappedExecutorCaller')
      var parent = agent.tracer.getSegment()
      if (!(this instanceof Promise) || !parent || !parent.transaction.isActive()) {
        logger.trace(
          'Promise instrumentation: exiting wrapExecutorCaller because ' +
          '!(this instanceof Promise) || !parent || !parent.transaction.isActive()'
        )
        return caller.apply(this, arguments)
      }

      var context = {
        promise: this,
        self: null,
        args: null
      }
      if (!this.__NR_context) {
        var segmentName = 'Promise ' + executor.name || '<anonymous>'
        var segment = _createSegment(segmentName)
        Contextualizer.link(null, this, segment)
      }
      var args = [].slice.call(arguments)
      args[0] = wrapExecutorContext(context, this.__NR_context.getSegment())
      var ret = caller.apply(this, args)

      // Bluebird catches executor errors and auto-rejects when it catches them,
      // thus we need to do so as well.
      //
      // When adding new libraries, make sure to check that they behave the same
      // way. We may need to enhance the promise spec to handle this variance.
      try {
        executor.apply(context.self, context.args)
      } catch (e) {
        context.args[1](e)
      }
      logger.trace('Promise instrumentation: wrappedExecutorCaller end')
      return ret
    }
  }

  /**
   * Creates a function which will export the context and arguments of its
   * execution.
   *
   * @param {object} context - The object to export the execution context with.
   *
   * @return {function} A function which, when executed, will add its context
   *  and arguments to the `context` parameter.
   */
  function wrapExecutorContext(context) {
    logger.trace('Promise instrumentation: entering wrapExecutorContext')
    return function contextExporter(resolve, reject) {
      context.self = this
      context.args = [].slice.call(arguments)
      context.args[0] = wrapResolver(context, resolve, 'resolve')
      context.args[1] = wrapResolver(context, reject, 'reject')
    }
  }

  function wrapResolver(context, fn, name) {
    logger.trace('Promise instrumentation: entering wrapResolver with %s', name)
    return function wrappedResolveReject(val) {
      logger.trace('Promise instrumentation: wrappedResolveReject (%s)', name)
      var promise = context.promise
      if (promise && promise.__NR_context) {
        promise.__NR_context.getSegment().touch()
      }
      fn(val)
    }
  }

  /**
   * Creates a wrapper for `Promise#then` that extends the transaction context.
   *
   * @return {function} A wrapped version of `Promise#then`.
   */
  function wrapThen(then, name) {
    return _wrapThen(then, name, true)
  }

  /**
   * Creates a wrapper for `Promise#catch` that extends the transaction context.
   *
   * @return {function} A wrapped version of `Promise#catch`.
   */
  function wrapCatch(cach, name) {
    return _wrapThen(cach, name, false)
  }

  /**
   * Creates a wrapper for promise chain extending methods.
   *
   * @param {function} then
   *  The function we are to wrap as a chain extender.
   *
   * @param {bool} useAllParams
   *  When true, all parameters which are functions will be wrapped. Otherwise,
   *  only the last parameter will be wrapped.
   *
   * @return {function} A wrapped version of the function.
   */
  function _wrapThen(then, name, useAllParams) {
    logger.trace('Promise instrumentation: _wrapThen')
    // Don't wrap non-functions.
    if (typeof then !== 'function' || then.name === '__NR_wrappedThen') {
      logger.trace(
        'Promise instrumentation: exiting _wrapThen because ' +
        'typeof then !== `function` || then.name === `__NR_wrappedThen`'
      )
      return then
    }

    return function __NR_wrappedThen() {
      logger.trace('Promise instrumentation: __NR_wrappedThen')
      if (!(this instanceof Promise)) {
        logger.trace(
          'Promise instrumentation: exiting __NR_wrappedThen because ' +
          '!(this instanceof Promise)'
        )
        return then.apply(this, arguments)
      }

      var segmentNamePrefix = 'Promise#' + name + ' '
      var thenSegment = agent.tracer.getSegment()
      var promise = this

      // Wrap up the arguments and execute the real then.
      var isWrapped = false
      var args = [].map.call(arguments, wrapHandler)
      var next = then.apply(this, args)

      // If we got a promise (which we should have), link the parent's context.
      if (!isWrapped && next instanceof Promise && next !== promise) {
        Contextualizer.link(promise, next, thenSegment)
      }
      return next

      function wrapHandler(fn, i, arr) {
        logger.trace('Promise instrumentation: wrapHandler')
        if (
          typeof fn !== 'function' ||               // Not a function
          fn.name === '__NR_wrappedThenHandler' ||  // Already wrapped
          (!useAllParams && i !== (arr.length - 1)) // Don't want all and not last
        ) {
          logger.trace(
            'Promise instrumentation: exiting wrapHandler because ' +
            'typeof fn !== `function` || fn.name === `__NR_wrappedThenHandler` ' +
            '|| (!useAllParams && i !== (arr.length - 1))'
          )
          isWrapped = fn && fn.name === '__NR_wrappedThenHandler'
          return fn
        }

        return function __NR_wrappedThenHandler() {
          logger.trace('Promise instrumentation: __NR_wrappedThenHandler')
          if (!next || !next.__NR_context) {
            logger.trace(
              'Promise instrumentation: exiting __NR_wrappedThenHandler because ' +
              '!next || !next.__NR_context'
            )
            return fn.apply(this, arguments)
          }

          var promSegment = next.__NR_context.getSegment()
          var segmentName = segmentNamePrefix + (fn.name || '<anonymous>')
          var segment = _createSegment(segmentName, promSegment)
          if (segment && segment !== promSegment) {
            next.__NR_context.setSegment(segment)
            promSegment = segment
          }

          var ret = null
          try {
            logger.trace(
              'Promise instrumentation: __NR_wrapedThenHandler ' +
              'calling bindFunction'
            )
            ret = agent.tracer.bindFunction(fn, promSegment, true).apply(this, arguments)
          } finally {
            if (ret && typeof ret.then === 'function') {
              ret = next.__NR_context.continue(ret)
            }
          }
          logger.trace('Promise instrumentation: __NR_wrapedThenHandler end')
          return ret
        }
      }
    }
  }

  /**
   * Creates a wrapper around the static `Promise` factory method.
   */
  function wrapCast(cast, name) {
    logger.trace('Promise instrumentation: wrapCast')
    if (typeof cast !== 'function' || cast.name === '__NR_wrappedCast') {
      logger.trace(
        'Promise instrumentation: exiting wrapCast because ' +
        'typeof cast !== `function` || cast.name === `__NR_wrappedCast`'
      )
      return cast
    }

    var CAST_SEGMENT_NAME = 'Promise.' + name
    return function __NR_wrappedCast() {
      logger.trace('Promise instrumentation: __NR_wrappedCast')
      var segment = _createSegment(CAST_SEGMENT_NAME)
      var prom = cast.apply(this, arguments)
      if (segment) {
        Contextualizer.link(null, prom, segment)
      }
      logger.trace('Promise instrumentation: __NR_wrappedCast end')
      return prom
    }
  }

  function wrapPromisifiy(promisify, name) {
    logger.trace('Promise instrumentation: wrapPromisifiy')
    if (typeof promisify !== 'function' || promisify.name === '__NR_wrappedPromisify') {
      logger.trace(
        'Promise instrumentation: exiting wrapPromisifiy because ' +
        'typeof promisify !== `function` || promisify.name === `__NR_wrappedPromisify`'
      )
      return promisify
    }

    var WRAP_SEGMENT_NAME = 'Promise.' + name
    return function __NR_wrappedPromisify() {
      logger.trace('Promise instrumentation: __NR_wrappedPromisify')
      var promisified = promisify.apply(this, arguments)
      if (typeof promisified !== 'function') {
        logger.trace(
          'Promise instrumentation: exiting __NR_wrappedPromisify because ' +
          'typeof promisified !== `function`'
        )
        return promisified
      }

      Object.keys(promisified).forEach(function forEachProperty(prop) {
        __NR_wrappedPromisified[prop] = promisified[prop]
      })

      return __NR_wrappedPromisified
      function __NR_wrappedPromisified() {
        var segment = _createSegment(WRAP_SEGMENT_NAME)
        var prom = agent.tracer.bindFunction(promisified, segment, true)
          .apply(this, arguments)

        if (segment) {
          Contextualizer.link(null, prom, segment)
        }

        logger.trace('Promise instrumentation: __NR_wrappedPromisified end')
        return prom
      }
    }
  }

  function _createSegment(name, parent) {
    logger.trace('Promise instrumentation: _createSegment')
    return agent.config.feature_flag.promise_segments === true
      ? agent.tracer.createSegment(name, null, parent)
      : (parent || agent.tracer.getSegment())
  }
}

/**
 * Performs a `wrapMethod` if and only if `methods` is truthy and has a length
 * greater than zero.
 *
 * @param {object}        obj     - The source of the methods to wrap.
 * @param {string}        name    - The name of this source.
 * @param {string|array}  methods - The names of the methods to wrap.
 * @param {function}      wrapper - The function which wraps the methods.
 */
function _safeWrap(obj, name, methods, wrapper) {
  logger.trace('Promise instrumentation: _safeWrap')
  if (methods && methods.length) {
    shimmer.wrapMethod(obj, name, methods, wrapper)
  }
}

function Context(segment) {
  logger.trace('Promise instrumentation: Context constructor')
  this.segments = [segment]
}

Context.prototype = Object.create(null)

Context.prototype.branch = function branch() {
  logger.trace('Promise instrumentation: Context.branch')
  return this.segments.push(null) - 1
}

function Contextualizer(idx, context) {
  logger.trace('Promise instrumentation: Contextualizer constructor')
  this.parentIdx = -1
  this.idx = idx
  this.context = context
  this.child = null
}
module.exports.Contextualizer = Contextualizer

Contextualizer.link = function link(prev, next, segment) {
  logger.trace('Promise instrumentation: entering Contextualizer.link')
  var ctxlzr = prev && prev.__NR_context
  if (ctxlzr && !ctxlzr.isActive()) {
    ctxlzr = prev.__NR_context = null
  }

  if (ctxlzr) {
    logger.trace('Promise instrumentation: Contextualizer.link: !!ctxlzr')
    // If prev has one child already, branch the context and update the child.
    if (ctxlzr.child) {
      logger.trace('Promise instrumentation: Contextualizer.link: !!ctxlzr.child')
      // When the branch-point is the 2nd through nth link in the chain, it is
      // necessary to track its segment separately so the branches can parent
      // their segments on the branch-point.
      if (ctxlzr.parentIdx !== -1) {
        ctxlzr.idx = ctxlzr.context.branch()
      }

      // The first child needs to be updated to have its own branch as well. And
      // each of that child's children must be updated with the new parent index.
      // This is the only non-constant-time action for linking, but it only
      // happens with branching promise chains specifically when the 2nd branch
      // is added.
      //
      // Note: This does not account for branches of branches. That may result
      // in improperly parented segments.
      var parent = ctxlzr
      var child = ctxlzr.child
      var branchIdx = ctxlzr.context.branch()
      do {
        child.parentIdx = parent.idx
        child.idx = branchIdx
        parent = child
        child = child.child
      } while (child)

      // We set the child to something falsey that isn't `null` so we can
      // distinguish between having no child, having one child, and having
      // multiple children.
      ctxlzr.child = false
    }

    // If this is a branching link then create a new branch for the next promise.
    // Otherwise, we can just piggy-back on the previous link's spot.
    var idx = ctxlzr.child === false ? ctxlzr.context.branch() : ctxlzr.idx

    // Create a new context for this next promise.
    next.__NR_context = new Contextualizer(idx, ctxlzr.context)
    next.__NR_context.parentIdx = ctxlzr.idx

    // If this was our first child, remember it in case we have a 2nd.
    if (ctxlzr.child === null) {
      ctxlzr.child = next.__NR_context
    }
  } else if (segment) {
    logger.trace('Promise instrumentation: Contextualizer.link: !ctxlzr && segment')
    // This next promise is the root of a chain. Either there was no previous
    // promise or the promise was created out of context.
    next.__NR_context = new Contextualizer(0, new Context(segment))
  }
  logger.trace('Promise instrumentation: Contextualizer.link end')
}

Contextualizer.prototype = Object.create(null)

Contextualizer.prototype.isActive = function isActive() {
  var segments = this.context.segments
  var segment = segments[this.idx] || segments[this.parentIdx] || segments[0]
  var res = segment && segment.transaction.isActive()
  logger.trace('Promise instrumentation: Contextualizer.isActive: ', res)
  return res
}

Contextualizer.prototype.getSegment = function getSegment() {
  var segments = this.context.segments
  var segment = segments[this.idx]
  if (segment == null) {
    segment = segments[this.idx] = segments[this.parentIdx] || segments[0]
  }
  logger.trace(
    'Promise instrumentation: Contextualizer.getSegment: ',
    segment && segment.name
  )
  return segment
}

Contextualizer.prototype.setSegment = function setSegment(segment) {
  logger.trace('Promise instrumentation: Contextualizer.setSegment')
  return this.context.segments[this.idx] = segment
}

Contextualizer.prototype.toJSON = function toJSON() {
  // No-op.
}

Contextualizer.prototype.continue = function continueContext(prom) {
  logger.trace('Promise instrumentation: Contextualizer.continue')
  var self = this
  var nextContext = prom.__NR_context
  if (!nextContext) {
    logger.trace(
      'Promise instrumentation: exiting Contextualizer.continue because !nextContext'
    )
    return prom
  }

  // If we have `finally`, use that to sneak our context update.
  if (typeof prom.finally === 'function') {
    logger.trace(
      'Promise instrumentation: exiting Contextualizer.continue ' +
      'because typeof prom.finally === `function`'
    )
    return prom.finally(__NR_continueContext)
  }

  // No `finally` means we need to hook into resolve and reject individually and
  // pass through whatever happened.
  return prom.then(function __NR_thenContext(val) {
    logger.trace('Promise instrumentation: __NR_thenContext')
    __NR_continueContext()
    return val
  }, function __NR_catchContext(err) {
    logger.trace('Promise instrumentation: __NR_catchContext')
    __NR_continueContext()
    throw err // Re-throwing promise rejection, this is not New Relic's error.
  })

  function __NR_continueContext() {
    logger.trace('Promise instrumentation: __NR_continueContext')
    self.setSegment(nextContext.getSegment())
  }
}
