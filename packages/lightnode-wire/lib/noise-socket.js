const assert = require('assert');
const winston = require('winston');
const { Duplex } = require('stream');
const { Socket } = require('net');
const NoiseError = require('./noise-error');

const READ_STATE = {
  PENDING: 0,
  AWAITING_HANDSHAKE_REPLY: 1,
  READY_FOR_LEN: 2,
  READY_FOR_BODY: 3,
  BLOCKED: 4,
};

class NoiseSocket extends Duplex {
  /**
    NoiseSocket is a Duplex Stream that wraps a standard TCP Socket
    and layers in the BOLT #8 implementation of the Noise Protocol
    Framework.

    This socket can be used for any communication that wants to
    benefit from the security and privacy enhancing used by the
    Noise Protocol Framework.

    @param {Object} opts
    @param {Socket} opts.socket socket that will be wrapped
    @param {NoiseState} opts.noiseState state machine for noise connections
    @param {boolean} opts.initiator connection is the initiator
   */
  constructor({ socket, noiseState, initiator = false }) {
    super();

    // perform type assertions
    assert.ok(socket instanceof Socket,new NoiseError('socket argument must be an instance of Socket')); // prettier-ignore

    /**
      Controls how reading and piping from the underlying
      TCP socket to the Duplex Streams read buffer works
      @private
     */
    this._readState = READ_STATE.PENDING;

    /**
      Private property that maintains the handshakes and
      encrypts and decrypts messages while maintaining the
      proper key rotation scheme used defined in BOLT #8.

      @private
      @type NoiseState
     */
    this._noiseState = noiseState;

    /**
      Indicates if the socket was the connection initiator
      which will determine how the handshake happens.

      @type Boolean
    */
    this.initiator = initiator;

    /** @type number */
    this.messagesReceived = 0;

    /** @type Socket */
    this._socket = socket;

    // TODO - implement proper close
    this._socket.on('close', hadError => this.emit('close', hadError));
    // TODO - configure connecting property
    this._socket.on('connect', this._onConnected.bind(this));
    this._socket.on('drain', () => this.emit('drain'));
    this._socket.on('end', () => this.emit('end'));
    this._socket.on('error', err => this.emit('error', err));
    this._socket.on('lookup', (e, a, f, h) => this.emit('lookup', e, a, f, h));
    this._socket.on('readable', this._onData.bind(this));
    this._socket.on('ready', () => this.emit('ready'));
    this._socket.on('timeout', () => this.emit('timeout'));
  }

  /**
    Ends the connection and emits a close event when the underlying
    socket has completely closed.
   */
  end() {
    this._socket.end(() => this.emit('close'));
    return this;
  }

  // TODO - terminate with error
  _terminate(err) {
    if (err) this.emit('error', err);
    this.end();
  }

  _onConnected() {
    try {
      if (this.initiator) {
        this._initiateHandshake();
      }
    } catch (err) {
      this._terminate(err);
    }
  }

  /**
    _onData is triggered by the "readable" event on the
    underlying TCP socket. It is called each time there is new data
    received. It is responsible for reading data from the socket and
    performing the appropriate action given the current read state.

    @private
   */
  _onData() {
    try {
      // Loop while there was still data to process on the socket's
      // buffer. This will stop when we don't have enough data or
      // we encounter a back pressure issue;
      let readMore = true;
      do {
        switch (this._readState) {
          case READ_STATE.PENDING:
            readMore = false;
            break;
          case READ_STATE.AWAITING_HANDSHAKE_REPLY:
            readMore = this._processHandshakeReply();
            break;
          case READ_STATE.READY_FOR_LEN:
            readMore = this._processPacketLength();
            break;
          case READ_STATE.READY_FOR_BODY:
            readMore = this._processPacketBody();
            break;
          case READ_STATE.BLOCKED:
            readMore = false;
            break;
          default:
            throw new NoiseError('Unknown state', { state: this._readState });
        }
      } while (readMore);
    } catch (err) {
      // Terminate on failures as we won't be able to recovery
      // since the noise state has rotated nonce and we won't
      // be able to any more data without additional errors.
      this._terminate(err);
    }
  }

  _initiateHandshake() {
    let m = this._noiseState.initiatorAct1();
    this._socket.write(m);
    this._readState = READ_STATE.AWAITING_HANDSHAKE_REPLY;
  }

  _processHandshakeReply() {
    // must read 50 bytes
    let m = this._socket.read(50);
    if (!m) return;

    // process reply
    this._noiseState.initiatorAct2(m);

    // create final act of the handshake
    m = this._noiseState.initiatorAct3();

    // send final handshake
    this._socket.write(m);

    // transition
    this._readState = READ_STATE.READY_FOR_LEN;

    // emit that we're ready!
    this.emit('connect');
    this.emit('ready');

    // return true to continue processing
    return true;
  }

  _processPacketLength() {
    const LEN_CIPHER_BYTES = 2;
    const LEN_MAC_BYTES = 16;

    // Try to read the length cipher bytes and the length MAC bytes
    // If we cannot read the 18 bytes, the attempt to process the
    // message will abort.
    let lc = this._socket.read(LEN_CIPHER_BYTES + LEN_MAC_BYTES);
    if (!lc) return;

    // Decrypt the length including the MAC
    let l = this._noiseState.decryptLength(lc);

    // We need to store the value in a local variable in case
    // we are unable to read the message body in its entirety.
    // This allows us to skip the length read and prevents
    // nonce issues since we've already decrypted the length.
    this._l = l;

    // Transition state
    this._readState = READ_STATE.READY_FOR_BODY;

    // return true to continue reading
    return true;
  }

  _processPacketBody() {
    const MESSAGE_MAC_BYTES = 16;

    // With the length, we can attempt to read the message plus
    // the MAC for the message. If we are unable to read because
    // there is not enough data in the read buffer, we need to
    // store l. We are not able to simply unshift it becuase we
    // have already rotated the keys.
    let c = this._socket.read(this._l + MESSAGE_MAC_BYTES);
    if (!c) return;

    // Decrypt the full message cipher + MAC
    let m = this._noiseState.decryptMessage(c);

    // Now that we've read the message, we can remove the
    // cached length before we transition states
    this._l = null;

    // Increment the number of messages received
    this.messagesReceived++;

    // Push the message onto the read buffer for the consumer to
    // read. We are mindful of slow reads by the consumer and
    // will respect backpressure signals.
    let pushOk = this.push(m);
    if (pushOk) {
      this._readState = READ_STATE.READY_FOR_LEN;
      return true;
    } else {
      winston.debug('socket read is blocked');
      this._readState = READ_STATE.BLOCKED;
      return false;
    }
  }

  _read() {
    if (this._readState === READ_STATE.BLOCKED) {
      winston.debug('socket read is unblocked');
      this._readState = READ_STATE.READY_FOR_LEN;
    }
    // Trigger a read but wait until the end of the event loop.
    // This is necessary when reading in paused mode where
    // _read was triggered by stream.read() originating inside
    // a "readable" event handler. Attempting to push more data
    // synchronously will not trigger another "readable" event.
    setImmediate(() => this._onData('from _read'));
  }

  // TODO - respect write backpressure
  _write(data) {
    winston.debug('sending ' + data.toString('hex'));
    let c = this._noiseState.encryptMessage(data);
    this._socket.write(c);
  }

  _final() {}
}

NoiseSocket.READ_STATE = READ_STATE;

module.exports = NoiseSocket;