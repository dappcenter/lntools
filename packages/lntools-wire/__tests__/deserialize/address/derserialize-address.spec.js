const { expect } = require("chai");
const { BufferCursor } = require("@lntools/buffer-cursor");
const { deserializeAddress: sut } = require("../../../lib/deserialize/address/deserialize-address");

const { AddressIPv4 } = require("../../../lib/domain/address-ipv4");
const { AddressIPv6 } = require("../../../lib/domain/address-ipv6");
const { AddressTor2 } = require("../../../lib/domain/address-tor2");
const { AddressTor3 } = require("../../../lib/domain/address-tor3");

let tests = [
  [
    'IPv4 loopback address',
    [1, new BufferCursor(Buffer.from([127,0,0,1,38,7]))],
    new AddressIPv4('127.0.0.1', 9735),
  ],
  [
    'IPv4 address',
    [1, new BufferCursor(Buffer.from([38, 87, 54, 163, 38, 7]))],
    new AddressIPv4('38.87.54.163', 9735),
  ],
  [
    'IPv6 loopback address',
    [2, new BufferCursor(Buffer.from('000000000000000000000000000000012607', 'hex'))],
    new AddressIPv6('::1',9735),
  ],
  [
    'IPv6 address',
    [2, new BufferCursor(Buffer.from('2604a880000200d000000000219cc0012607', 'hex'))],
    new AddressIPv6('2604:a880:2:d0::219c:c001', 9735),
  ],
  [
    'Tor 2 address',
    [3, new BufferCursor(Buffer.from('85cd3caee6205a6cc2662607', 'hex'))],
    new AddressTor2('qxgtzlxgebngzqtg.onion', 9735),
  ],
  [
    'Tor 3 address',
    [4, new BufferCursor(Buffer.from('a11df6b470ea5b216cc6d95ed8a775f08841d6244f611eae7e7beb198ff7babdc821032607', 'hex'))],
    new AddressTor3('ueo7nndq5jnsc3gg3fpnrj3v6ceedvrej5qr5lt6ppvrtd7xxk64qiid.onion', 9735),
  ],
]; // prettier-ignore

describe("deserializeAddress", () => {
  for (let [title, input, expected] of tests) {
    it(title, () => {
      let actual = sut.apply(this, input);
      expect(actual).to.deep.equal(expected);
    });
  }
});
