import * as crypto from "crypto";
import {Socket} from "dgram";

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;

export function stunBindingRequest(): Buffer {
    const packet = Buffer.alloc(20);
    packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
    packet.writeUInt16BE(0, 2); // no attributes
    packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    crypto.randomBytes(12).copy(packet, 8);
    return packet;
}

// STUN and RTP share the port, so they are told apart the RFC 5764 way:
// RTP versions start at 0b10, while STUN message types have their top two bits clear.
export function isStun(packet: Buffer): boolean {
    return packet.length >= 20
        && (packet[0] & 0xc0) === 0
        && packet.readUInt32BE(4) === STUN_MAGIC_COOKIE;
}

// Behind NAT the PBX sends RTCP back to the port it latched, which is the RTP port.
// The reports have to be dropped rather than relayed:
// ffmpeg discards them on payload type without advancing its sequence counter,
// so every one it sees reads as a lost packet.
export function isRtcp(packet: Buffer): boolean {
    if(packet.length < 2) {
        return false;
    }
    const payloadType = packet[1] & 0x7f;
    return payloadType >= 72 && payloadType <= 76;
}

export const PCMU_SILENCE = Buffer.alloc(160, 0xff);
// H.264 filler data (NAL type 12).
// Valid to emit and ignored by every decoder,
// which makes it a safe payload for packets whose only job is to open the return path.
export const H264_FILLER = Buffer.from([0x0c, 0x80]);

// The SDP we offer necessarily advertises a private address,
// so the PBX can only reach us after it latches onto the source of packets we send
// (symmetric RTP).
// STUN alone is not enough - res_rtp_asterisk learns the remote address from received *RTP*.
export class RtpSender {

    private sequence = crypto.randomBytes(2).readUInt16BE(0);
    private timestamp = crypto.randomBytes(4).readUInt32BE(0);
    private readonly ssrc = crypto.randomBytes(4).readUInt32BE(0);

    constructor(private readonly socket: Socket,
                private readonly address: string,
                private readonly port: number,
                private readonly payloadType: number) {
    }

    send(payload: Buffer, samples: number): void {
        const packet = Buffer.alloc(12 + payload.length);
        packet[0] = 0x80;
        packet[1] = this.payloadType & 0x7f;
        packet.writeUInt16BE(this.sequence, 2);
        packet.writeUInt32BE(this.timestamp >>> 0, 4);
        packet.writeUInt32BE(this.ssrc, 8);
        payload.copy(packet, 12);
        try {
            this.socket.send(packet, this.port, this.address);
        } catch {
            // The socket can be torn down between the timer firing and this call.
        }
        this.sequence = (this.sequence + 1) & 0xffff;
        this.timestamp = (this.timestamp + samples) >>> 0;
    }
}

// FFmpeg keeps reading one continuous stream from a fixed loopback port,
// while the SIP dialog underneath may be re-established.
// Each new call leg brings a fresh SSRC and sequence space,
// so packets are rewritten into a single synthetic stream instead -
// that way a reconnect does not force the encoder (and the HomeKit session) to restart.
export class RtpRelay {

    // One 90 kHz frame at 25 fps - the gap inserted across a reconnect,
    // so the clock never rewinds
    // and ffmpeg does not read the seam as a huge backwards jump.
    private static readonly SEAM_TICKS = 3600;

    private readonly ssrc = crypto.randomBytes(4).readUInt32BE(0);
    private sequence = crypto.randomBytes(2).readUInt16BE(0);
    private timestampOffset = 0;
    private lastTimestamp = 0;
    private sourceSsrc?: number;
    private started = false;

    packets = 0;
    bytes = 0;
    lastPacketAt = 0;

    // One loopback port per viewer.
    // A port cannot be shared: when two readers bind the same UDP port,
    // only one of them receives the packets,
    // so a second HomeKit viewer would sit on a black screen.
    // Every packet is fanned out to all of them instead.
    private readonly destinations = new Set<number>();

    constructor(private readonly socket: Socket,
                private readonly address: string = "127.0.0.1") {
    }

    addDestination(port: number): void {
        this.destinations.add(port);
    }

    removeDestination(port: number): void {
        this.destinations.delete(port);
    }

    get destinationCount(): number {
        return this.destinations.size;
    }

    // Called whenever the underlying call is replaced,
    // so the next packet re-bases the timestamp continuation onto the new leg.
    reset(): void {
        this.sourceSsrc = undefined;
    }

    forward(packet: Buffer): void {
        if(packet.length < 12) {
            return;
        }
        const sourceSsrc = packet.readUInt32BE(8);
        const timestamp = packet.readUInt32BE(4);
        if(this.sourceSsrc !== sourceSsrc) {
            this.sourceSsrc = sourceSsrc;
            this.timestampOffset = this.started
                ? (this.lastTimestamp + RtpRelay.SEAM_TICKS - timestamp) >>> 0
                : 0;
            this.started = true;
        }

        // Packets are forwarded in arrival order over loopback,
        // so a plain monotonic counter is a valid sequence space
        // and avoids carrying the source's gaps.
        const rewritten = Buffer.from(packet);
        this.lastTimestamp = (timestamp + this.timestampOffset) >>> 0;
        rewritten.writeUInt16BE(this.sequence, 2);
        rewritten.writeUInt32BE(this.lastTimestamp, 4);
        rewritten.writeUInt32BE(this.ssrc, 8);
        this.sequence = (this.sequence + 1) & 0xffff;

        this.packets += 1;
        this.bytes += packet.length;
        this.lastPacketAt = Date.now();
        for(const port of this.destinations) {
            try {
                this.socket.send(rewritten, port, this.address);
            } catch {
                // Ignore: that consumer may have exited before we noticed.
            }
        }
    }
}
