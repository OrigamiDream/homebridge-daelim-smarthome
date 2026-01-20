import {TextDecoder, TextEncoder} from "util";
import { PacketHeader } from "./packet-header";
import { Chunk } from "./chunk";
import { Errors, SubTypes, Types } from "./fields";
import { ByteBuffer } from "./byte-buffer";
import { Utils } from "../utils";

interface PacketBody {
    raw: Uint8Array | undefined,
    json: object | undefined,
    string: string | undefined
}

interface PacketError {
    json: boolean,
    string: boolean
}

export class Packet {

    private readonly header: PacketHeader;
    private readonly body: PacketBody;
    private readonly error: PacketError;

    private constructor(header: PacketHeader, body: PacketBody, error: PacketError) {
        this.header = header;
        this.body = body;
        this.error = error;
    }

    static parse(bytes: Uint8Array, useJson = true): Packet | undefined {
        const chunk = Chunk.parse(bytes);
        if(chunk == undefined) {
            return undefined;
        }
        const buf = chunk.getData();
        const header = PacketHeader.parse(buf, 0);

        let decodedString = '';
        let stringError = false;
        let decodedObject = {};
        let objectError = false;

        if(useJson) {
            try {
                decodedString = new TextDecoder().decode(buf.slice(PacketHeader.HEADER_SIZE, buf.byteLength));
            } catch (e) {
                stringError = true;
            }
            if(buf.byteLength - PacketHeader.HEADER_SIZE > 0) {
                try {
                    decodedObject = JSON.parse(decodedString);
                } catch (e) {
                    objectError = true;
                }
            }
        }
        return new Packet(header, {
            raw: buf,
            json: decodedObject,
            string: decodedString
        }, {
            json: objectError,
            string: stringError
        });
    }

    static create(body: object, pin: string, type: Types, subType: SubTypes, src: number, dst: number): Packet {
        return new Packet(new PacketHeader(pin, type, subType, src, dst, Errors.SUCCESS), {
            raw: undefined,
            json: body,
            string: undefined
        }, {
            json: false,
            string: false
        });
    }

    getPacketBytes(): Uint8Array {
        const header = this.header.getBytes();
        const body = new TextEncoder().encode(JSON.stringify(this.body.json));
        const dst = new Uint8Array(body.byteLength + PacketHeader.HEADER_SIZE);
        Utils.arraycopy(header, 0, dst, 0, header.byteLength);
        Utils.arraycopy(body, 0, dst, 24, body.byteLength);
        return dst;
    }

    getBytes(): Uint8Array {
        const bytes = this.getPacketBytes();
        const buffer = ByteBuffer.allocate(bytes.byteLength + 4);
        buffer.putInt(bytes.byteLength);
        buffer.put(bytes);
        return buffer.array();
    }

    getHeader(): PacketHeader {
        return this.header;
    }

    getJSONBody(): object | undefined {
        return this.body.json;
    }

    getRawBody(): Uint8Array | undefined {
        return this.body.raw;
    }

}