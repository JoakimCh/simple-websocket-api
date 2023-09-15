
/** A simple API to run on top of a WebSocket. Supports commands with replies (and optionally throwable errors). Any command received emits an event with the title of the command. Any command sent without a listener on the other side will throw an error. Can send/receive any JSON convertible object, or binary data (which is transmitted without JSON conversion). */

// const CONNECTING = 0
const OPEN = 1
// const CLOSING = 2
const CLOSED = 3

/** Can be identified using `error?.name == 'SimpleWebSocketAPI_Error'` */
class SimpleWebSocketAPI_Error extends Error {
  constructor(message, code = 'INVALID_PARAMETER') {
    super(message)
    this.name = this.constructor.name
    this.code = code
  }
}

export class SimpleWebSocketAPI extends EventEmitter {
  jsonReplacer; debug

  #ws; #wsListeners; #binaryType
  #msgId = 0
  #awaitingReply = new Map()
  #awaitingBinaryReply
  #destroyOnClose
  #destroyed

  get ws() {return this.#ws}
  get isOpen() {return this.#ws?.readyState == OPEN}
  get isClosed() {return this.#ws?.readyState == CLOSED}

  constructor({
    ws, // the WebSocket to use
    debug, // whether to debug protocol IO
    jsonReplacer, // optional JSON replacer
    binaryType = globalThis.process?.versions?.node ? 'nodebuffer' : 'arraybuffer', // the binary format to use over the WebSocket (if sending binary data)
    destroyOnClose
  } = {}) {
    super()
    Object.seal(this) // useful to prevent mistakes
    this.#binaryType = binaryType
    this.#destroyOnClose = destroyOnClose
    this.jsonReplacer = jsonReplacer
    this.debug = !debug ? null : (text, value) => {
      if (value != undefined) {
        console.log(text+': ')
        console.dir(value, {depth: null, colors: true})
      } else {
        console.log(text)
      }
    }
    this.#wsListeners = {
      'open':     () => this.emit('open'),
      'error': event => this.emit('error', event),
      'close': event => this.emit('close', event),
      'message': this.#onMessage.bind(this)
    }
    if (ws) this.changeWebSocket(ws)
  }

  #removeWsListeners() {
    if (this.#ws) {
      for (const [event, listener] of Object.entries(this.#wsListeners)) {
        this.#ws.removeEventListener(event, listener)
      }
    }
  }

  changeWebSocket(newWebSocket) {
    if (this.#destroyed) return
    this.#removeWsListeners()
    this.once('close', () => {
      this.#removeWsListeners()
      if (this.#destroyOnClose) this.destroy()
    })
    this.#ws = newWebSocket
    if (this.isClosed) { // if newWebSocket is already closed
      setTimeout(0, this.emit.bind(this), 'close', {code: 4001, reason: 'Socket already closed.'})
      return
    }
    this.#ws.binaryType = this.#binaryType
    for (const [event, listener] of Object.entries(this.#wsListeners)) {
      this.#ws.addEventListener(event, listener, {once: event != 'message'})
    }
    if (this.isOpen) setTimeout(0, this.emit.bind(this), 'open')
  }

  /** Closes the WebSocket and emits a close event with code 4000 (if not already closed) and then removes any event listeners (since no more events will be sent). Now this instance is ready to be garbage collected if there are no more references to it. */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#awaitingReply.clear()
    if (this.#ws && this.#ws.readyState != CLOSED) {
      this.#ws.close()
      this.emit('close', {code: 4000, reason: 'SimpleWebSocketAPI destroy call', wasClean: true})
    }
    this.removeAllListeners() // remove own listeners
  }

  send(cmd, payload, replyTimeout = 2000) {
    if (this.#destroyed || this.#ws?.readyState != OPEN) return
    if (typeof cmd != 'string') throw new SimpleWebSocketAPI_Error(`cmd must be a string.`)
    if (cmd.startsWith('int:')) throw new SimpleWebSocketAPI_Error(`Only internal commands can start with "int:".`)
    if (['open','close','error','newListener','removeListener'].includes(cmd)) throw new SimpleWebSocketAPI_Error(`A command can not be named ${cmd} because that's an event emitted by this class.`)
    const id = this.#msgId ++
    this.debug?.('outgoing', {cmd, payload, id})
    this.#ws.send(JSON.stringify({cmd, payload, id}, this.jsonReplacer))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(reject, replyTimeout, new SimpleWebSocketAPI_Error(`A reply for "${cmd}" was not received within the replyTimeout period of ${replyTimeout} ms.`, 'REPLY_TIMEOUT'))
      this.#awaitingReply.set(id, {
        resolve: result => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  #reply(id, payload, isError) {
    if (this.#destroyed || this.#ws?.readyState != OPEN) return
    this.debug?.('outgoing', {cmd: isError ? 'int:errorReply' : 'int:reply', payload, id})
    if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload) || payload instanceof Blob) {
      if (isError) throw new SimpleWebSocketAPI_Error(`Can't send a binary error reply.`)
      this.#ws.send(JSON.stringify({cmd: 'int:binaryReply', id}, this.jsonReplacer))
      this.#ws.send(payload)
    } else {
      this.#ws.send(JSON.stringify({cmd: isError ? 'int:errorReply' : 'int:reply', payload, id}, this.jsonReplacer))
    }
  }

  #replyFunc(id) {
    return async (payload, isError) => {
      try {
        if (typeof payload == 'function') {
          this.#reply(id, await payload(), isError)
        } else {
          this.#reply(id, await payload, isError)
        }
      } catch (error) {
        this.#reply(id, error, true)
      }
    }
  }

  #onMessage({data}) {
    if (this.#destroyed) return
    if (typeof data != 'string') {
      if (this.#awaitingBinaryReply) {
        this.debug?.('incoming binary', {size: data.byteLength})
        this.#awaitingBinaryReply(data)
        this.#awaitingBinaryReply = null
      } else {
        this.debug?.('Un-awaited binary payload.')
      }
      return
    }
    const {cmd, payload, id} = JSON.parse(data)
    this.debug?.('incoming', {cmd, payload, id})
    switch (cmd) {
      case undefined:
        this.debug?.('Invalid message received', arguments)
      break
      default:
        if (!this.emit(cmd, this.#replyFunc(id), payload)) { // if no event listener
          this.#reply(id, 'No listener for command: '+cmd, true)
        }
      break
      case 'int:reply': case 'int:errorReply': case 'int:binaryReply': {
        const {resolve, reject} = this.#awaitingReply.get(id)
        if (resolve) {
          switch (cmd) {
            case 'int:reply': resolve(payload); break
            case 'int:errorReply': reject(payload); break
            case 'int:binaryReply': this.#awaitingBinaryReply = resolve; break
          }
          this.#awaitingReply.delete(id)
        } else {
          this.debug?.('Un-awaited '+cmd+':', payload)
        }
      } break
    }
  }
}
