import * as tls from "tls";
import * as os from "os";
import {Socket} from "dgram";
import {Logging} from "homebridge";
import {LoggerBase} from "../utils";
import {OnePassCredentials} from "../interfaces/smart-elife-onepass-config";
import {
    buildAuthorization,
    buildOffer,
    buildRequest,
    parseChallenge,
    parseContactUri,
    parseMessage,
    parseSdp,
    parseTag,
    randomBranch,
    randomToken,
    SdpAnswer,
    SipMessage,
} from "./sip";
import {H264_FILLER, isRtcp, isStun, PCMU_SILENCE, RtpRelay, RtpSender, stunBindingRequest} from "./rtp";

const SIP_TIMEOUT_MS = 20 * 1000;
const LATCH_INTERVAL_MS = 2 * 1000;
const AUDIO_INTERVAL_MS = 20;
const VIDEO_INTERVAL_MS = 40;
const STALL_TIMEOUT_MS = 5 * 1000;
const RECONNECT_BACKOFF_MS = 15 * 1000;
// The door camera line is single-session.
// These are the codes the PBX answers with
// when the phone app (or another household member) already holds it.
const BUSY_STATUS_CODES = [
    408, // Request Timeout - the wallpad never picked up
    480, // Temporarily Unavailable
    486, // Busy Here
    600, // Busy Everywhere
    603, // Decline
];

export class OnePassBusyError extends Error {
}

export interface MonitorMedia {
    // Payload type ffmpeg should expect on the relayed H.264 stream.
    // The loopback port is handed out per viewer by the live view, not fixed here.
    payloadType: string
}

// The address we advertise is cosmetic -
// it is almost always private, and the PBX reaches us by latching onto our RTP source instead.
// The One Pass app itself advertises a CLAT address that is unroutable from the PBX.
// Still, name a real interface so the Contact and SDP origin are well-formed.
function localAddress(): string {
    for(const addresses of Object.values(os.networkInterfaces())) {
        for(const address of addresses || []) {
            if(address.family === "IPv4" && !address.internal) {
                return address.address;
            }
        }
    }
    return "127.0.0.1";
}

// A single INVITE dialog against the wallpad extension.
// The whole trick is in the From display name:
// "monitoring_sip" routes the call into the PBX's door-camera context,
// so the wallpad never rings and the door camera answers one-way.
class MonitorCall {

    private readonly localAddress: string;
    private readonly callId = randomToken(16);
    private readonly fromTag = randomToken(10);
    private readonly waiters: {match: (message: SipMessage) => boolean, resolve: (message: SipMessage) => void}[] = [];

    private socket?: tls.TLSSocket;
    private buffer = "";
    private cseq = 20;
    private toTag?: string;
    private remoteTarget?: string;
    private closed = false;

    onClosed?: () => void;

    constructor(private readonly log: Logging | LoggerBase,
                private readonly credentials: OnePassCredentials) {
        this.localAddress = localAddress();
    }

    private get target(): string {
        return `sip:${this.credentials.wallpadSipId}@${this.credentials.sipDomain}:${this.credentials.sipPort}`;
    }

    private get fromHeader(): string {
        return `From: "monitoring_sip" <sip:${this.credentials.sipId}@${this.localAddress}>;tag=${this.fromTag}`;
    }

    private toHeader(withTag: boolean): string {
        const uri = withTag
            ? `sip:${this.credentials.wallpadSipId}@${this.credentials.sipDomain}`
            : this.target;
        return `To: "interphone_sip" <${uri}>${withTag && this.toTag ? `;tag=${this.toTag}` : ""}`;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = tls.connect({
                host: this.credentials.sipDomain,
                port: this.credentials.sipPort,
                // The PBX presents a self-signed certificate and is usually addressed by IP;
                // the app pins it rather than validating a chain.
                rejectUnauthorized: false,
            }, () => resolve());
            socket.on("error", (error) => {
                this.log.debug("One Pass SIP socket error: %s", error.message);
                reject(error);
            });
            socket.on("data", (chunk) => this.onData(chunk));
            socket.on("close", () => {
                this.closed = true;
                this.onClosed?.();
            });
            this.socket = socket;
        });
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString("binary");
        for(;;) {
            const separator = this.buffer.indexOf("\r\n\r\n");
            if(separator < 0) return;
            const head = this.buffer.slice(0, separator);
            if(!head.trim().length) {
                // Asterisk sends a bare CRLFCRLF as a connection keep-alive.
                this.buffer = this.buffer.slice(separator + 4);
                continue;
            }
            const length = parseInt(/content-length\s*:\s*(\d+)/i.exec(head)?.[1] || "0", 10);
            const total = separator + 4 + length;
            if(this.buffer.length < total) return;

            const message = parseMessage(this.buffer.slice(0, total));
            this.buffer = this.buffer.slice(total);
            this.log.debug("One Pass SIP <- %s", message.start);
            for(const waiter of this.waiters.slice()) {
                if(!waiter.match(message)) continue;
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve(message);
            }
        }
    }

    private send(text: string): void {
        this.log.debug("One Pass SIP -> %s", text.split("\r\n")[0]);
        this.socket?.write(text);
    }

    private waitFor(match: (message: SipMessage) => boolean): Promise<SipMessage> {
        return new Promise((resolve, reject) => {
            const waiter = {match, resolve};
            this.waiters.push(waiter);
            setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if(index < 0) return;
                this.waiters.splice(index, 1);
                reject(new Error("The One Pass PBX did not respond in time."));
            }, SIP_TIMEOUT_MS);
        });
    }

    private isInviteResponse(message: SipMessage): boolean {
        return message.statusCode !== undefined && /INVITE/.test(message.headers["cseq"] || "");
    }

    private buildInvite(branch: string, offer: string, authorization?: string): string {
        return buildRequest(`INVITE ${this.target} SIP/2.0`, [
            `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${branch}`,
            this.fromHeader,
            this.toHeader(false),
            `Contact: <sip:${this.credentials.sipId}@${this.localAddress}>`,
            `Call-ID: ${this.callId}`,
            `CSeq: ${this.cseq} INVITE`,
            "Content-Type: application/sdp",
            "Max-Forwards: 70",
            ...(authorization ? [`Authorization: ${authorization}`] : []),
            "Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, SUBSCRIBE, NOTIFY, INFO, PUBLISH, MESSAGE",
            "Privacy: none",
            "User-Agent: cvnetsip/1.0.0",
            "Supported: 100rel",
            "Supported: precondition",
        ], offer);
    }

    async invite(audioPort: number, videoPort: number): Promise<SdpAnswer> {
        const offer = buildOffer(this.localAddress, audioPort, videoPort);

        let branch = randomBranch();
        this.send(this.buildInvite(branch, offer));
        let response = await this.waitForFinal();

        if(response.statusCode === 401 || response.statusCode === 407) {
            this.toTag = parseTag(response.headers["to"]);
            // A non-2xx ACK stays in the INVITE transaction: same branch, same request URI.
            this.send(buildRequest(`ACK ${this.target} SIP/2.0`, [
                `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${branch}`,
                this.fromHeader,
                this.toHeader(true),
                `Call-ID: ${this.callId}`,
                `CSeq: ${this.cseq} ACK`,
                `Contact: <sip:${this.credentials.sipId}@${this.localAddress}>`,
                "Max-Forwards: 70",
            ]));

            const challenge = parseChallenge(response.headers["www-authenticate"] || response.headers["proxy-authenticate"]);
            if(!challenge) {
                throw new Error("The One Pass PBX sent an authentication challenge we could not parse.");
            }
            const authorization = buildAuthorization(
                challenge, this.credentials.sipId, this.credentials.sipPw, "INVITE", this.target);

            this.cseq += 1;
            this.toTag = undefined;
            branch = randomBranch();
            this.send(this.buildInvite(branch, offer, authorization));
            response = await this.waitForFinal();
        }

        if(response.statusCode !== 200) {
            const error = `The One Pass PBX rejected the call: ${response.statusCode} ${response.reason}`;
            throw BUSY_STATUS_CODES.includes(response.statusCode || 0)
                ? new OnePassBusyError(error)
                : new Error(error);
        }

        this.toTag = parseTag(response.headers["to"]);
        this.remoteTarget = parseContactUri(response.headers["contact"])
            || `sip:${this.credentials.sipDomain}:${this.credentials.sipPort};transport=TLS`;
        this.sendAck();

        // The PBX retransmits the 200 OK until it is satisfied; answer every copy.
        this.waitForRetransmissions();
        return parseSdp(response.body);
    }

    private async waitForFinal(): Promise<SipMessage> {
        let response = await this.waitFor((message) => this.isInviteResponse(message));
        while((response.statusCode || 0) < 200) {
            response = await this.waitFor((message) => this.isInviteResponse(message) && (message.statusCode || 0) >= 200);
        }
        return response;
    }

    private waitForRetransmissions(): void {
        if(this.closed) return;
        this.waitFor((message) => this.isInviteResponse(message) && message.statusCode === 200)
            .then(() => {
                this.sendAck();
                this.waitForRetransmissions();
            })
            .catch(() => {
                // Expected: the timeout simply means the PBX stopped retransmitting.
            });
    }

    private sendAck(): void {
        // A 2xx ACK is its own transaction:
        // fresh branch, addressed to the dialog's remote target rather than the original request URI.
        this.send(buildRequest(`ACK ${this.remoteTarget} SIP/2.0`, [
            `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${randomBranch()}`,
            this.fromHeader,
            this.toHeader(true),
            `Call-ID: ${this.callId}`,
            `CSeq: ${this.cseq} ACK`,
            `Contact: <sip:${this.credentials.sipId}@${this.localAddress}>`,
            "Max-Forwards: 70",
        ]));
    }

    hangUp(): void {
        if(this.closed || !this.remoteTarget) {
            this.socket?.destroy();
            return;
        }
        this.cseq += 1;
        try {
            this.send(buildRequest(`BYE ${this.remoteTarget} SIP/2.0`, [
                `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${randomBranch()}`,
                this.fromHeader,
                this.toHeader(true),
                `Call-ID: ${this.callId}`,
                `CSeq: ${this.cseq} BYE`,
                "Max-Forwards: 70",
            ]));
        } catch(error) {
            this.log.debug("One Pass BYE failed: %s", (error as Error)?.message);
        }
        // Give the BYE a moment on the wire before dropping the connection.
        setTimeout(() => this.socket?.destroy(), 500);
    }
}

// Owns the media plumbing for one live call,
// and keeps it alive underneath a stable loopback endpoint,
// so HomeKit sessions survive a reconnect of the SIP dialog.
export class OnePassMonitorSession {

    private call?: MonitorCall;
    private latchTimer?: NodeJS.Timeout;
    private audioTimer?: NodeJS.Timeout;
    private videoTimer?: NodeJS.Timeout;
    private stalledTimer?: NodeJS.Timeout;
    private relay?: RtpRelay;
    private stopped = false;
    private reconnecting = false;
    private retryAfter = 0;

    constructor(private readonly log: Logging | LoggerBase,
                private readonly credentials: OnePassCredentials,
                private readonly audio: Socket,
                private readonly video: Socket,
                private readonly relaySocket: Socket,
                private readonly audioPort: number,
                private readonly videoPort: number) {
    }

    async start(): Promise<MonitorMedia> {
        this.relay = new RtpRelay(this.relaySocket);
        this.video.on("message", (packet) => {
            if(isStun(packet) || isRtcp(packet)) return;
            this.relay?.forward(packet);
        });
        // Audio is negotiated but never consumed;
        // draining the socket keeps the kernel buffer from filling
        // and the port alive for the latch.
        this.audio.on("message", () => undefined);

        const payloadType = await this.dial();
        this.watchForStalls();
        return {payloadType};
    }

    private async dial(): Promise<string> {
        const call = new MonitorCall(this.log, this.credentials);
        await call.connect();
        const answer = await call.invite(this.audioPort, this.videoPort);

        const video = answer.media["video"];
        const audio = answer.media["audio"];
        // A zero port means the PBX declined the stream outright.
        if(!video?.address || !video.port || !video.payloads.length) {
            call.hangUp();
            throw new Error("The One Pass PBX answered without a video stream.");
        }
        this.log.debug("One Pass media: video %s:%d, audio %s:%d",
            video.address, video.port, audio?.address, audio?.port);

        this.call = call;
        this.relay?.reset();
        this.startMedia(answer);
        return video.payloads[0];
    }

    private startMedia(answer: SdpAnswer): void {
        this.stopMedia();
        const video = answer.media["video"];
        const audio = answer.media["audio"];

        const latch = () => {
            try {
                this.video.send(stunBindingRequest(), video.port, video.address);
                if(audio?.address) {
                    this.audio.send(stunBindingRequest(), audio.port, audio.address);
                }
            } catch {
                // The socket may already be closing.
            }
        };
        latch();
        this.latchTimer = setInterval(latch, LATCH_INTERVAL_MS);

        const videoSender = new RtpSender(this.video, video.address!, video.port, parseInt(video.payloads[0], 10));
        this.videoTimer = setInterval(() => videoSender.send(H264_FILLER, 3600), VIDEO_INTERVAL_MS);
        if(audio?.address && audio.payloads.length) {
            const audioSender = new RtpSender(this.audio, audio.address, audio.port, parseInt(audio.payloads[0], 10));
            this.audioTimer = setInterval(() => audioSender.send(PCMU_SILENCE, 160), AUDIO_INTERVAL_MS);
        }
    }

    private stopMedia(): void {
        for(const timer of [this.latchTimer, this.audioTimer, this.videoTimer]) {
            if(timer) clearInterval(timer);
        }
        this.latchTimer = undefined;
        this.audioTimer = undefined;
        this.videoTimer = undefined;
    }

    // The PBX has been observed to drop long sessions.
    // Rather than pre-empt it on a fixed timer,
    // watch the media itself and rebuild the dialog only once it dries up.
    private watchForStalls(): void {
        this.stalledTimer = setInterval(async () => {
            if(this.stopped || this.reconnecting || !this.relay) return;
            if(Date.now() < this.retryAfter) return;
            const since = Date.now() - this.relay.lastPacketAt;
            if(this.relay.lastPacketAt === 0 || since < STALL_TIMEOUT_MS) return;

            this.reconnecting = true;
            this.log.info("One Pass live view stalled for %ds, reconnecting.", Math.round(since / 1000));
            this.call?.hangUp();
            this.call = undefined;
            this.stopMedia();
            try {
                await this.dial();
                this.retryAfter = 0;
            } catch(error) {
                // Back off so a busy line or a downed PBX is not hammered every stall tick.
                this.retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
                this.log.warn("Could not reconnect the One Pass live view: %s", (error as Error)?.message);
            } finally {
                this.reconnecting = false;
            }
        }, 2000);
    }

    // Each HomeKit viewer gets its own loopback port; the relay fans every packet out.
    addConsumer(port: number): void {
        this.relay?.addDestination(port);
    }

    removeConsumer(port: number): void {
        this.relay?.removeDestination(port);
    }

    stop(): void {
        if(this.stopped) return;
        this.stopped = true;
        this.stopMedia();
        if(this.stalledTimer) {
            clearInterval(this.stalledTimer);
        }
        this.call?.hangUp();
        this.call = undefined;
        for(const socket of [this.audio, this.video, this.relaySocket]) {
            try {
                socket.close();
            } catch {
                // Already closed.
            }
        }
    }
}
