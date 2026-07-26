export function zigZagEncode(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer)) {
    throw new Error(`Invalid signed integer for binary payload: ${value}`);
  }
  return integer >= 0 ? integer * 2 : -integer * 2 - 1;
}

export function zigZagDecode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid zigzag integer for binary payload: ${value}`);
  }
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

export class BinaryWriter {
  private readonly chunks: Uint8Array[] = [];
  private readonly scratch = new ArrayBuffer(8);
  private readonly scratchBytes = new Uint8Array(this.scratch);
  private readonly scratchView = new DataView(this.scratch);
  private buffer = new Uint8Array(1024 * 1024);
  private offset = 0;

  constructor(private readonly label = "binary payload") {}

  writeAscii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.writeByte(value.charCodeAt(index));
    }
  }

  writeByte(value: number): void {
    this.ensure(1);
    this.buffer[this.offset] = value & 0xff;
    this.offset += 1;
  }

  writeVarUint(value: number): void {
    let remaining = Math.trunc(value);
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      throw new Error(`Invalid unsigned integer for ${this.label}: ${value}`);
    }
    while (remaining >= 0x80) {
      this.writeByte((remaining % 0x80) | 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    this.writeByte(remaining);
  }

  writeSignedVarInt(value: number): void {
    this.writeVarUint(zigZagEncode(value));
  }

  writeFloat64(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid float64 for ${this.label}: ${value}`);
    }
    this.scratchView.setFloat64(0, value, true);
    this.ensure(8);
    this.buffer.set(this.scratchBytes, this.offset);
    this.offset += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeVarUint(bytes.byteLength);
    this.ensure(bytes.byteLength);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.byteLength;
  }

  finish(): Uint8Array {
    this.flush();
    const length = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  private ensure(length: number): void {
    if (this.offset + length <= this.buffer.byteLength) {
      return;
    }
    this.flush();
    if (length > this.buffer.byteLength) {
      this.buffer = new Uint8Array(length);
    }
  }

  private flush(): void {
    if (this.offset > 0) {
      this.chunks.push(this.buffer.slice(0, this.offset));
    }
    this.buffer = new Uint8Array(1024 * 1024);
    this.offset = 0;
  }
}

export class BinaryReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly label = "binary payload"
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readByte(): number {
    if (this.offset >= this.bytes.byteLength) {
      throw new Error(`Unexpected end of ${this.label}.`);
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  readVarUint(): number {
    let value = 0;
    let multiplier = 1;

    for (;;) {
      const byte = this.readByte();
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) {
          throw new Error(`${this.label} integer exceeds safe range.`);
        }
        return value;
      }
      multiplier *= 0x80;
      if (multiplier > Number.MAX_SAFE_INTEGER / 0x80) {
        throw new Error(`${this.label} varint is too large.`);
      }
    }
  }

  readSignedVarInt(): number {
    return zigZagDecode(this.readVarUint());
  }

  readFloat64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readBytes(): Uint8Array {
    const length = this.readVarUint();
    this.ensure(length);
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  expectAscii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const byte = this.readByte();
      if (byte !== value.charCodeAt(index)) {
        throw new Error(`${this.label} has an invalid header.`);
      }
    }
  }

  expectDone(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error(`${this.label} has trailing bytes.`);
    }
  }

  private ensure(length: number): void {
    if (this.offset + length > this.bytes.byteLength) {
      throw new Error(`Unexpected end of ${this.label}.`);
    }
  }
}
