export class ByteBuffer {

    static allocate(byteLength: number): ByteBuffer {
        return new ByteBuffer(new ArrayBuffer(byteLength));
    }

    static wrap(bytes: Uint8Array): ByteBuffer {
        return new ByteBuffer(bytes.buffer);
    }

    private dataView: DataView;
    private cursor: number;

    private constructor(buffer: ArrayBuffer) {
        this.dataView = new DataView(buffer);
        this.cursor = 0;
    }

    flip() {
        this.cursor = 0;
    }

    get(bytes: Uint8Array, offset = 0, length = bytes.byteLength): Uint8Array {
        this.move(offset);
        for(let i = 0; i < length; i++) {
            bytes[i] = this.getByte();
        }
        return bytes;
    }

    getByte(): number {
        const value = this.dataView.getUint8(this.cursor);
        this.move(1);
        return value;
    }

    getInt(): number {
        const value = this.dataView.getInt32(this.cursor);
        this.move(4);
        return value;
    }

    getShort(): number {
        const value = this.dataView.getInt16(this.cursor);
        this.move(2);
        return value;
    }

    put(bytes: Uint8Array, offset = 0, length = bytes.byteLength): ByteBuffer {
        this.move(offset);
        for(let i = 0; i < length; i++) {
            this.putByte(bytes[i]);
        }
        return this;
    }

    putByte(value: number): ByteBuffer {
        this.dataView.setUint8(this.cursor, value);
        this.move(1);
        return this;
    }

    putInt(value: number): ByteBuffer {
        this.dataView.setInt32(this.cursor, value);
        this.move(4);
        return this;
    }

    putShort(value: number): ByteBuffer {
        this.dataView.setInt16(this.cursor, value);
        this.move(2);
        return this;
    }

    array() {
        return new Uint8Array(this.dataView.buffer);
    }

    private move(bytes: number) {
        this.cursor += bytes;
    }

}