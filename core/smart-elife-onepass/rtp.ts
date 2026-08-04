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
    // A consumer joins a call that is already flowing,
    // so whatever it needs in order to start decoding has already gone past.
    // What it needs is the most recent keyframe and every frame since:
    // H.264 predicts forward,
    // so a consumer given an old keyframe and then the live stream
    // decodes against references it never received,
    // and produces a picture that never existed rather than no picture at all.
    // The whole of it is replayed in one burst,
    // so it has to stay under the receive buffer ffmpeg is started with
    // (`-buffer_size 2097152`), or the replay overruns it.
    private static readonly MAX_GOP_BYTES = 1024 * 1024;

    private readonly ssrc = crypto.randomBytes(4).readUInt32BE(0);
    private sequence = crypto.randomBytes(2).readUInt16BE(0);
    private timestampOffset = 0;
    private lastTimestamp = 0;
    private sourceSsrc?: number;
    private payloadType?: number;
    private started = false;
    // Rewritten packets from the last keyframe onwards, and what it takes to trust them.
    // Completeness is judged on the source's own numbering, read before the rewrite -
    // which is why the output can go on being renumbered contiguously.
    private gop: Buffer[] = [];
    private gopBytes = 0;
    private gopTracking = false;
    private gopUsable = false;
    private gopTimestamp = 0;
    // The access unit being received.
    // A keyframe is not the first packet of its own access unit:
    // this camera sends SPS and PPS ahead of it under the same timestamp,
    // and offers no `sprop-parameter-sets` to make up for losing them,
    // so the retention has to start where the access unit starts
    // rather than where the keyframe slice does.
    private accessUnit: Buffer[] = [];
    private accessUnitBytes = 0;
    private accessUnitTimestamp?: number;
    private accessUnitIntact = true;
    private lastSequence?: number;

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
        // Nothing worth replaying until a keyframe has been seen whole.
        // Before that the consumer simply waits for the next one off the live stream,
        // which is a few seconds of nothing rather than a few seconds of nonsense.
        if(!this.gopUsable || !this.gop.length) {
            this.destinations.add(port);
            return;
        }
        // `addDestination` is called only after ffmpeg has been spawned and given its SDP.
        // Rebase the retained frames immediately behind the current stream before queueing them:
        // a later viewer must not see an hours-old RTP timestamp followed by a live one.
        // The retention has no internal gaps - one would have thrown it away -
        // so numbering the replay contiguously up to the live position
        // is exact rather than an approximation.
        const lastRetained = this.gop[this.gop.length - 1].readUInt32BE(4);
        const timestampOffset = (this.lastTimestamp - lastRetained) >>> 0;
        let sequence = (this.sequence - this.gop.length) & 0xffff;
        for(const packet of this.gop) {
            const replay = Buffer.from(packet);
            replay.writeUInt16BE(sequence, 2);
            replay.writeUInt32BE((packet.readUInt32BE(4) + timestampOffset) >>> 0, 4);
            replay.writeUInt32BE(this.ssrc, 8);
            this.send(replay, port);
            sequence = (sequence + 1) & 0xffff;
        }
        // Datagrams sent by one socket keep their order, so joining the live fan-out
        // after the replay gives the new decoder a continuous sequence space.
        this.destinations.add(port);
    }

    removeDestination(port: number): void {
        this.destinations.delete(port);
    }

    get destinationCount(): number {
        return this.destinations.size;
    }

    // The payload type every consumer has been told to expect.
    // A later leg can be answered with a different one,
    // and an ffmpeg already holding its SDP cannot be told about the change,
    // so the first is pinned and the rest are rewritten to match -
    // the same treatment the SSRC and the sequence space get.
    pinPayloadType(payloadType: number): number {
        if(this.payloadType === undefined && payloadType >= 0 && payloadType <= 127) {
            this.payloadType = payloadType;
        }
        return this.payloadType ?? payloadType;
    }

    // Called whenever the underlying call is replaced,
    // so the next packet re-bases the timestamp continuation onto the new leg.
    reset(): void {
        this.sourceSsrc = undefined;
        // The new leg brings its own numbering,
        // so nothing held from the old one can be validated against it -
        // and replaying it would show the previous leg's footage
        // rebased to look like the present.
        this.discardGop();
        this.discardAccessUnit();
    }

    private discardGop(): void {
        this.gop = [];
        this.gopBytes = 0;
        this.gopTracking = false;
        this.gopUsable = false;
    }

    private discardAccessUnit(): void {
        this.accessUnit = [];
        this.accessUnitBytes = 0;
        this.accessUnitTimestamp = undefined;
        this.accessUnitIntact = true;
        this.lastSequence = undefined;
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

        // Consumers get one continuous sequence space, numbered in arrival order.
        // That is a trade rather than a simplification:
        // it hides the source's own losses and reorderings from ffmpeg.
        // Measured against the bundled build, hiding a loss costs nothing -
        // a fragmented NAL is stapled back together whether or not the gap is visible,
        // and reporting the gap changes neither the decode errors nor the frame count.
        // Hiding a reordering does cost something:
        // misordered packets arrive looking correctly ordered and are decoded that way.
        // Carrying the original spacing through only helps
        // once ffmpeg's reorder queue is enabled to act on it,
        // which trades away the latency this stream is tuned for -
        // so the trade stands until the path is known to reorder at all.
        const rewritten = Buffer.from(packet);
        this.lastTimestamp = (timestamp + this.timestampOffset) >>> 0;
        rewritten.writeUInt16BE(this.sequence, 2);
        rewritten.writeUInt32BE(this.lastTimestamp, 4);
        rewritten.writeUInt32BE(this.ssrc, 8);
        if(this.payloadType !== undefined) {
            // Keep the marker bit, which says where a frame ends.
            rewritten[1] = (packet[1] & 0x80) | this.payloadType;
        }
        this.sequence = (this.sequence + 1) & 0xffff;

        this.packets += 1;
        this.bytes += packet.length;
        this.lastPacketAt = Date.now();
        this.retain(rewritten, packet.readUInt16BE(2), timestamp, (packet[1] & 0x80) !== 0);
        for(const port of this.destinations) {
            this.send(rewritten, port);
        }
    }

    private send(packet: Buffer, port: number): void {
        try {
            this.socket.send(packet, port, this.address);
        } catch {
            // Ignore: that consumer may have exited before we noticed.
        }
    }

    // Keeps what a new consumer would have to be told in order to start decoding here:
    // the last keyframe and every packet since it.
    // `sequence`, `timestamp` and `marker` are the source's own, read before the rewrite.
    // They are the only way to tell a keyframe that arrived whole
    // from one that lost fragments on the way,
    // because the rewritten numbering is contiguous by construction
    // and so says nothing about either.
    private retain(rewritten: Buffer, sequence: number, timestamp: number, marker: boolean): void {
        // A hole anywhere means the chain back to the keyframe cannot be vouched for,
        // and neither can the access unit being assembled around it.
        if(this.lastSequence !== undefined && sequence !== ((this.lastSequence + 1) & 0xffff)) {
            this.accessUnitIntact = false;
            this.discardGop();
        }
        this.lastSequence = sequence;

        if(timestamp !== this.accessUnitTimestamp) {
            this.accessUnitTimestamp = timestamp;
            this.accessUnit = [];
            this.accessUnitBytes = 0;
            this.accessUnitIntact = true;
        }
        this.accessUnit.push(rewritten);
        this.accessUnitBytes += rewritten.length;
        if(this.accessUnitBytes > RtpRelay.MAX_GOP_BYTES) {
            // Bigger than could ever be replayed, so there is no point assembling it.
            this.accessUnit = [];
            this.accessUnitIntact = false;
        }

        if(this.startsIdr(rewritten)) {
            // A newer keyframe supersedes whatever was held:
            // replaying the older one and then the live stream
            // would leave out the frames in between,
            // which are exactly the ones the live stream predicts from.
            // Taking the access unit whole is what carries the parameter sets along,
            // and what lets a keyframe split across several slices arrive in one piece.
            if(!this.accessUnitIntact) {
                this.discardGop();
                return;
            }
            this.gop = this.accessUnit.slice();
            this.gopBytes = this.accessUnitBytes;
            this.gopTracking = true;
            // A keyframe that is its own whole access unit is already usable.
            // Waiting for the next packet to notice as much
            // would leave a viewer arriving in between with nothing to start from.
            this.gopUsable = marker;
            this.gopTimestamp = timestamp;
            return;
        }
        if(!this.gopTracking) {
            return;
        }
        if(this.gopBytes + rewritten.length > RtpRelay.MAX_GOP_BYTES) {
            // Longer than can be replayed in one burst.
            this.discardGop();
            return;
        }
        this.gop.push(rewritten);
        this.gopBytes += rewritten.length;
        if(!this.gopUsable && (marker || timestamp !== this.gopTimestamp)) {
            // The stream has finished the keyframe's access unit
            // and nothing went missing along the way,
            // so from here on what is held can actually be decoded.
            this.gopUsable = true;
        }
    }

    private startsIdr(packet: Buffer): boolean {
        let offset = 12 + (packet[0] & 0x0f) * 4;
        if(packet.length <= offset) {
            return false;
        }
        if((packet[0] & 0x10) !== 0) {
            if(packet.length < offset + 4) {
                return false;
            }
            offset += 4 + packet.readUInt16BE(offset + 2) * 4;
            if(packet.length <= offset) {
                return false;
            }
        }

        const nalType = packet[offset] & 0x1f;
        if(nalType === 5) {
            return true;
        }
        // A fragmented NAL only counts where it opens.
        // Every fragment of an IDR carries type 5 in its FU header,
        // so accepting one without the S bit takes a keyframe
        // the relay only caught the tail of -
        // which a decoder cannot start from,
        // and which then blocks the complete IDR that follows
        // from ever being retained in its place.
        if(nalType === 28 && packet.length > offset + 1) {
            const fragment = packet[offset + 1];
            return (fragment & 0x80) !== 0 && (fragment & 0x1f) === 5;
        }
        if(nalType !== 24) {
            return false;
        }

        // STAP-A can carry SPS, PPS and the first IDR slice in one RTP packet.
        offset += 1;
        while(packet.length >= offset + 2) {
            const length = packet.readUInt16BE(offset);
            offset += 2;
            if(length === 0 || packet.length < offset + length) {
                return false;
            }
            if((packet[offset] & 0x1f) === 5) {
                return true;
            }
            offset += length;
        }
        return false;
    }
}
