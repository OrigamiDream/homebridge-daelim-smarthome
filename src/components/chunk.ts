import { ByteBuffer } from "./byte-buffer";
import { Utils } from "./utils";

export class Chunk {

    private readonly data: Uint8Array;
    private readonly length: number;

    static parse(bytes: Uint8Array): Chunk | undefined {
        if(bytes.byteLength < 4) {
            return undefined;
        }
        const buffer = ByteBuffer.wrap(bytes);
        const length = buffer.getInt();
        if(bytes.byteLength < length - 4) {
            return undefined;
        }
        const data = new Uint8Array(length);
        Utils.arraycopy(bytes, 4, data, 0, length);
        return new Chunk(data, length);
    }

    private constructor(data: Uint8Array, length: number) {
        this.data = data;
        this.length = length;
    }

    getData(): Uint8Array {
        return this.data;
    }

    getSize() {
        return this.length + 4;
    }

}