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

export function writeStringId(
  writer: BinaryWriter,
  stringIds: Map<string, number>,
  value: string,
  dictionaryLabel = "binary"
): void {
  const id = stringIds.get(value);
  if (id === undefined) {
    throw new Error(`String is missing from ${dictionaryLabel} dictionary: ${value}`);
  }
  writer.writeVarUint(id);
}

export function writeNullableStringId(
  writer: BinaryWriter,
  stringIds: Map<string, number>,
  value: string | null,
  dictionaryLabel = "binary"
): void {
  if (value === null) {
    writer.writeVarUint(0);
    return;
  }
  const id = stringIds.get(value);
  if (id === undefined) {
    throw new Error(`String is missing from ${dictionaryLabel} dictionary: ${value}`);
  }
  writer.writeVarUint(id + 1);
}

export function readStringId(reader: BinaryReader, strings: string[], dictionaryLabel = "binary"): string {
  const id = reader.readVarUint();
  const value = strings[id];
  if (value === undefined) {
    throw new Error(`Invalid ${dictionaryLabel} string id ${id}.`);
  }
  return value;
}

export function readNullableStringId(reader: BinaryReader, strings: string[], dictionaryLabel = "binary"): string | null {
  const id = reader.readVarUint();
  if (id === 0) {
    return null;
  }
  const value = strings[id - 1];
  if (value === undefined) {
    throw new Error(`Invalid ${dictionaryLabel} nullable string id ${id}.`);
  }
  return value;
}

export function writeNullableUint(writer: BinaryWriter, value: number | null, fieldLabel = "binary field"): void {
  if (value === null) {
    writer.writeVarUint(0);
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${fieldLabel}: ${value}`);
  }
  writer.writeVarUint(Math.round(value) + 1);
}

export function readNullableUint(reader: BinaryReader): number | null {
  const value = reader.readVarUint();
  return value === 0 ? null : value - 1;
}

export function writeNullableScaledSigned(
  writer: BinaryWriter,
  value: number | null,
  scale: number,
  fieldLabel = "binary field"
): void {
  if (value === null) {
    writer.writeVarUint(0);
    return;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldLabel}: ${value}`);
  }
  writer.writeVarUint(zigZagEncode(Math.round(value * scale)) + 1);
}

export function readNullableScaledSigned(reader: BinaryReader, scale: number): number | null {
  const value = reader.readVarUint();
  return value === 0 ? null : zigZagDecode(value - 1) / scale;
}

export function nullableBooleanId(value: boolean | null): number {
  if (value === true) {
    return 2;
  }
  if (value === false) {
    return 1;
  }
  return 0;
}

export function readNullableBoolean(reader: BinaryReader, fieldLabel = "binary nullable boolean"): boolean | null {
  const value = reader.readByte();
  if (value === 0) {
    return null;
  }
  if (value === 1) {
    return false;
  }
  if (value === 2) {
    return true;
  }
  throw new Error(`Invalid ${fieldLabel} id ${value}.`);
}

export function stateCodeNumber(value: string, fieldLabel = "binary payload"): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid state code for ${fieldLabel}: ${value}`);
  }
  return number;
}

export function stateCodeFromNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid state code number for binary payload: ${value}`);
  }
  return String(value).padStart(2, "0");
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
