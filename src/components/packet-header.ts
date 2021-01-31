import { TextDecoder, TextEncoder } from "util";
import { ByteBuffer } from "./byte-buffer";
import {Errors, SubTypes, Types} from "./fields";
import {Utils} from "./utils";

export class PacketHeader {

    public static HEADER_SIZE = 24;

    static parse(b: ByteBuffer | Uint8Array, offset = 0): PacketHeader {
        if(b instanceof ByteBuffer) {
            return this.parseBuffer(b);
        } else {
            return this.parseBytes(b, offset);
        }
    }

    private static parseBuffer(buffer: ByteBuffer): PacketHeader {
        const pin = new Uint8Array(8);
        buffer.get(pin, 0, 8);
        return new PacketHeader(
            new TextDecoder().decode(pin),
            buffer.getInt() as Types,
            buffer.getInt() as SubTypes,
            buffer.getShort(),
            buffer.getShort(),
            buffer.getByte()
        );
    }

    private static parseBytes(bytes: Uint8Array, offset = 0): PacketHeader {
        const buffer = ByteBuffer.allocate(this.HEADER_SIZE);
        buffer.put(bytes, offset, this.HEADER_SIZE);
        buffer.flip();
        return PacketHeader.parseBuffer(buffer);
    }

    private readonly pin: string;
    private readonly type: Types;
    private readonly subType: SubTypes;
    private readonly src: number;
    private readonly dst: number;
    private readonly error: Errors;

    private readonly encoder = new TextEncoder();

    constructor(pin: string, type: Types, subType: SubTypes, src: number, dst: number, error: Errors) {
        this.pin = pin;
        this.type = type;
        this.subType = subType;
        this.src = src;
        this.dst = dst;
        this.error = error;
    }

    getBytes() {
        const buffer = ByteBuffer.allocate(PacketHeader.HEADER_SIZE);
        buffer.put(this.encoder.encode(this.pin));
        buffer.putInt(this.type);
        buffer.putInt(this.subType);
        buffer.putShort(this.src);
        buffer.putShort(this.dst);
        buffer.putByte(this.error);
        buffer.putByte(0).putByte(0).putByte(0); // preserved
        return buffer.array();
    }

    getType(): Types {
        return this.type;
    }

    getSubType(): SubTypes {
        return this.subType;
    }

    getError(): Errors {
        return this.error;
    }

    toString(): string {
        return `PIN: ${this.pin}, Type: ${Types[this.type]}, Sub Type: ${Utils.findSubType(this.type)[this.subType]}, Error: ${Errors[this.error]}`;
    }

}