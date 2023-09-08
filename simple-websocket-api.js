
/** A simple API to run on top of a WebSocket. Supports commands with replies (and optionally throwable errors). Any command received emits an event with the title of the command. Any command sent without a listener on the other side will throw an error. Can send/receive any JSON convertible object, or binary data (which is transmitted without JSON conversion). */

// const CONNECTING = 0
const OPEN = 1
// const CLOSING = 2
// const CLOSED = 3

export class SimpleWebSocketAPI extends EventEmitter {
  jsonReplacer; debug

  #ws; #wsListeners; #binaryType
  #msgId = 0
  #awaitingReply = new Map()
  #awaitingBinaryReply
  #destroyed

  get ws() {return this.#ws}
  get isOpen() {return this.#ws?.readyState == OPEN}

  constructor({
    ws, // the WebSocket to use
    debug = false, // whether to debug protocol IO
    jsonReplacer = null, // optional JSON replacer
    binaryType = globalThis.process?.versions?.node ? 'nodebuffer' : 'arraybuffer', // the binary format to use over the WebSocket (if sending binary data)
  } = {}) {
    super()
    Object.seal(this) // useful to prevent mistakes
    this.#binaryType = binaryType
    this.jsonReplacer = jsonReplacer
    this.debug = !debug ? false : (text, value) => {
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
    this.#ws = newWebSocket
    this.#ws.binaryType = this.#binaryType
    for (const [event, listener] of Object.entries(this.#wsListeners)) {
      this.#ws.addEventListener(event, listener, {once: event != 'message'})
    }
    this.once('close', this.#removeWsListeners.bind(this))
    if (this.isOpen) this.emit('open')
  }

  /** Tries to clean up everything so the garbage collector can collect it and its WebSocket. */
  destroy() {
    if (this.#ws) this.#ws.close()
    this.#destroyed = true
    this.removeAllListeners() // remove own listeners
    this.#awaitingReply.clear()
  }

  send(cmd, payload, replyTimeout = 2000) {
    if (this.#destroyed || this.#ws?.readyState != OPEN) return
    if (typeof cmd != 'string') throw Error('cmd must be a string.')
    if (cmd.startsWith('int:')) throw Error('Only internal commands can start with "int:".')
    if (['open','close','error','newListener','removeListener'].includes(cmd)) throw Error(`A command can not be named ${cmd} because that's an event emitted by this class.`)
    const id = this.#msgId ++
    this.debug?.('outgoing', {cmd, payload, id})
    this.#ws.send(JSON.stringify({cmd, payload, id}, this.jsonReplacer))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(reject, replyTimeout)
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
      if (isError) throw Error('Can\'t send a binary error reply.')
      this.#ws.send(JSON.stringify({cmd: 'int:binaryReply', id}, this.jsonReplacer))
      this.#ws.send(payload)
    } else {
      this.#ws.send(JSON.stringify({cmd: isError ? 'int:errorReply' : 'int:reply', payload, id}, this.jsonReplacer))
    }
  }

  #replyFunc(id) {
    return async (payload, isError) => {
      if (typeof payload != 'function') {
        this.#reply(id, payload, isError)
      } else {
        try {
          this.#reply(id, await payload(), isError)
        } catch (error) {
          this.#reply(id, error, true)
        }
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
