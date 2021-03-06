// tslint:disable: max-classes-per-file
// tslint:disable: no-unused-expression
import * as noise from "@lntools/noise";
import { expect } from "chai";
import { EventEmitter } from "events";
import sinon from "sinon";
import { InitMessage } from "../lib/messages/init-message";
import { Peer } from "../lib/peer";
import { PeerState } from "../lib/peer-state";
import { PingPongState } from "../lib/pingpong-state";
import { createFakeLogger } from "./_test-utils";

class FakeSocket extends EventEmitter {
  [x: string]: any;

  constructor() {
    super();
    this.write = sinon.stub();
    this.end = sinon.stub();
  }
}

class FakeMessage {
  [x: string]: any;

  constructor(msg) {
    this.msg = msg;
  }
  public serialize() {
    return Buffer.from(this.msg);
  }
}

describe("Peer", () => {
  let sut: Peer;
  let sandbox: sinon.SinonSandbox;
  let socket: noise.NoiseSocket;

  beforeEach(() => {
    const initMessageFactory = () => {
      const msg = new InitMessage();
      msg.localDataLossProtect = true;
      return msg;
    };
    const ls = Buffer.alloc(32, 0);
    const rpk = Buffer.alloc(32, 1);
    const logger = createFakeLogger();
    sut = new Peer({ ls, rpk, initMessageFactory, logger });
    sut.socket = socket = new FakeSocket() as any;
    sut.pingPongState = sinon.createStubInstance(PingPongState);
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe(".connect()", () => {
    beforeEach(() => {
      sandbox.stub(noise, "connect").returns(socket);
      sandbox.stub(sut, "_onSocketReady");
      sandbox.stub(sut, "_onSocketClose");
      sandbox.stub(sut, "_onSocketError");
      sandbox.stub(sut, "_onSocketData");
      sut.connect();
    });

    it("should bind to ready", () => {
      socket.emit("ready");
      expect((sut as any)._onSocketReady.called).to.be.true;
    });

    it("should bind close", () => {
      socket.emit("close");
      expect((sut as any)._onSocketClose.called).to.be.true;
    });

    it("should bind error", () => {
      socket.emit("error");
      expect((sut as any)._onSocketError.called).to.be.true;
    });

    it("should bind data", () => {
      socket.emit("data");
      expect((sut as any)._onSocketData.called).to.be.true;
    });
  });

  describe(".sendMessage()", () => {
    it("should throw when not ready", () => {
      expect(() => sut.sendMessage(new FakeMessage("hello") as any)).to.throw();
    });

    it("should send the serialized message", () => {
      const input = new FakeMessage("test");
      sut.state = Peer.states.Ready;
      sut.sendMessage(input);
      expect((socket as any).write.args[0][0]).to.deep.equal(Buffer.from("test"));
    });

    it("should emit a sending message", done => {
      const input = new FakeMessage("test");
      sut.state = Peer.states.Ready;
      sut.on("sending", () => done());
      sut.sendMessage(input);
    });
  });

  describe(".disconnect()", () => {
    it("should stop the socket", () => {
      sut.disconnect();
      expect((sut.socket as any).end.called).to.be.true;
    });

    it("should change the peer state to disconnecting", () => {
      sut.disconnect();
      expect(sut.state).to.equal(PeerState.Disconnecting);
    });
  });

  describe(".reconnect()", () => {
    it("should stop the socket", () => {
      sut.reconnect();
      expect((sut.socket as any).end.called).to.be.true;
    });

    it("should retain the peer state", () => {
      const beforeState = sut.state;
      sut.reconnect();
      expect(sut.state).to.equal(beforeState);
    });
  });

  describe("._onSocketReady()", () => {
    it("should transition state to awaiting_peer_init", () => {
      (sut as any)._onSocketReady();
      expect(sut.state).to.equal(Peer.states.AwaitingPeerInit);
    });

    it("should send the init message to the peer", () => {
      (sut as any)._onSocketReady();
      expect((socket as any).write.args[0][0]).to.deep.equal(Buffer.from("00100000000102", "hex"));
    });
  });

  describe("_onSocketClose", () => {
    it("should stop the ping pong state", () => {
      sut.state = PeerState.Disconnecting;
      (sut as any)._onSocketClose();
      expect((sut as any).pingPongState.onDisconnecting.called).to.be.true;
    });

    describe("when disconnecting", () => {
      it("should emit the close event", done => {
        sut.state = PeerState.Disconnecting;
        sut.on("close", () => done());
        (sut as any)._onSocketClose();
      });
    });

    describe("when initiator", () => {
      it("should trigger reconnect", done => {
        sut.state = PeerState.Ready;
        sut.reconnectTimeoutMs = 0;
        sut.connect = sandbox.stub(sut, "connect");
        (sut as any)._onSocketClose();
        setTimeout(() => {
          expect((sut.connect as any).called).to.be.true;
          done();
        }, 50);
      });
    });
  });

  describe("_onSocketError", () => {
    it("should emit error event", done => {
      sut.on("error", () => done());
      (sut as any)._onSocketError();
    });
  });

  describe("_onSocketData", () => {
    beforeEach(() => {
      sandbox.stub(sut, "_processPeerInitMessage");
      sandbox.stub(sut, "_processMessage");
    });

    it("should read peer init message when awaiting_peer_init state", () => {
      sut.state = Peer.states.AwaitingPeerInit;
      (sut as any)._onSocketData("data");
      expect((sut as any)._processPeerInitMessage.called).to.be.true;
    });

    it("should process message when in ready state", () => {
      sut.state = Peer.states.Ready;
      (sut as any)._onSocketData("datat");
      expect((sut as any)._processMessage.called).to.be.true;
    });

    describe("on error", () => {
      it("should close the socket", () => {
        sut.state = Peer.states.Ready;
        (sut as any)._processMessage.throws(new Error("boom"));
        sut.on("error", () => {});
        (sut as any)._onSocketData("data");
        expect((socket as any).end.called).to.be.true;
      });

      it("should emit an error event", done => {
        sut.state = Peer.states.Ready;
        (sut as any)._processMessage.throws(new Error("boom"));
        sut.on("error", () => done());
        (sut as any)._onSocketData("data");
      });
    });
  });

  describe("_sendInitMessage", () => {
    it("should send the initialization message", () => {
      (sut as any)._sendInitMessage();
      expect((socket as any).write.args[0][0]).to.deep.equal(Buffer.from("00100000000102", "hex"));
    });
  });

  describe("_processPeerInitMessage", () => {
    let input;

    beforeEach(() => {
      input = Buffer.from("001000000000", "hex");
    });

    it("it should fail if not init message", () => {
      input = Buffer.from("001100000000", "hex");
      expect(() => (sut as any)._processPeerInitMessage(input)).to.throw();
    });

    it("should store the init message", () => {
      (sut as any)._processPeerInitMessage(input);
      expect(sut.remoteInit).to.be.instanceof(InitMessage);
    });

    it("should start ping state", () => {
      (sut as any)._processPeerInitMessage(input);
      expect((sut as any).pingPongState.start.called).to.be.true;
    });

    it("should change the state to ready", () => {
      (sut as any)._processPeerInitMessage(input);
      expect(sut.state).to.equal(Peer.states.Ready);
    });

    it("should emit ready", done => {
      sut.on("ready", () => done());
      (sut as any)._processPeerInitMessage(input);
    });
  });

  describe("_processMessage", () => {
    let input;

    beforeEach(() => {
      input = Buffer.from("001000000000", "hex");
    });

    describe("when valid message", () => {
      it("should log with ping service", () => {
        (sut as any)._processMessage(input);
        expect((sut as any).pingPongState.onMessage.called).to.be.true;
      });

      it("should emit the message", done => {
        sut.on("message", () => done());
        (sut as any)._processMessage(input);
      });
    });
  });
});
