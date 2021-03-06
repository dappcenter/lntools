import { Bitmask } from "../../bitmask";
import { Encoder } from "../../serialize/encoder";
import { EncodingType } from "../../serialize/encoding-type";
import { TlvValueReader } from "../../serialize/tlv-value-reader";
import { TlvValueWriter } from "../../serialize/tlv-value-writer";
import { Tlv } from "./tlv";

export class QueryShortChannelIdsFlags extends Tlv {
  public static type = BigInt(1);

  public static deserialize(reader: TlvValueReader): QueryShortChannelIdsFlags {
    const instance = new QueryShortChannelIdsFlags();
    const encodedBytes = reader.readBytes();
    const rawBytes = new Encoder().decode(encodedBytes);

    const reader2 = new TlvValueReader(rawBytes);
    while (!reader2.eof) {
      const rawFlags = reader2.readBigSize();
      const flags = new Bitmask(rawFlags);
      instance.flags.push(flags);
    }
    return instance;
  }

  public type: bigint = BigInt(1);
  public flags: Bitmask[] = [];

  public addFlags(...flags: Bitmask[]) {
    this.flags.push(...flags);
    return this;
  }

  public serializeValue(encoding: number = EncodingType.ZlibDeflate): Buffer {
    const writer = new TlvValueWriter();
    for (const flags of this.flags) {
      writer.writeBigSize(flags.value);
    }

    const encoder = new Encoder();
    return encoder.encode(encoding, writer.toBuffer());
  }

  public toJSON() {
    return {
      type: this.type.toString(),
      flags: this.flags.map(p => p.toNumber()),
    };
  }
}
