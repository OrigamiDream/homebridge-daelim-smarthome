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
const SIP_CONNECT_TIMEOUT_MS = 10 * 1000;
const LATCH_INTERVAL_MS = 2 * 1000;
const AUDIO_INTERVAL_MS = 20;
const VIDEO_INTERVAL_MS = 40;
const STALL_TIMEOUT_MS = 5 * 1000;
// The PBX only starts sending once it has latched onto the RTP we push at it,
// so the first packet of a leg is allowed longer
// than a running stream is allowed to skip.
const FIRST_PACKET_TIMEOUT_MS = 10 * 1000;
const RECONNECT_BACKOFF_MS = 15 * 1000;
// How many failed redials in a row a session survives.
// Reconnecting rides out a PBX that drops a long call and comes straight back,
// but a PBX that stays down would otherwise be redialed forever,
// with the session - and the viewers fed off it - held open the whole time.
// Three failures is about a minute of dead air;
// past that the call is declared dead and its owner tears the viewers down.
const REDIAL_ATTEMPT_LIMIT = 3;
// How many times a provisional response may push a transaction's deadline out.
// Each renewal buys the full wait over again,
// so a PBX that drips 180 Ringing forever would hold the INVITE open with it.
// Enough for the observed call flow - one 100 Trying and one 180 Ringing -
// with room to spare, while keeping the transaction finite.
const SIP_PROGRESS_RENEWAL_LIMIT = 5;
// `activate()` is called once ffmpeg has logged for the first time,
// which is the closest observable moment to it opening its input -
// measured at 62ms after spawn against a bind at 77ms.
// This only has to cover the gap between those two,
// not the process start-up before them, which is the part that varies with load.
const CONSUMER_STARTUP_DELAY_MS = 250;
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
// Every CVNET PBX reachable on 5061 serves this same self-signed certificate -
// one baked into the firmware, dated out to the year 3023 -
// which is what the One Pass app pins against.
// A chain cannot be built for it and it is addressed by IP,
// so pinning is the only verification available.
// `onePass.sipFingerprint` overrides it if a complex ever ships a different one.
const CVNET_SIP_FINGERPRINT = "00469B240794BD4BFCCF31E9FB08F1A0694BDE9F022FD51CBC40D2C378ECAD93";

export class OnePassBusyError extends Error {
}

// The PBX refused the credentials themselves rather than merely asking for them,
// which means the `sipPw` they were built from is no longer the one it expects.
export class OnePassSipAuthError extends Error {
}

interface SipWaiter {
    match: (message: SipMessage) => boolean
    // Runs for messages that did not match,
    // so a transaction the PBX is still working on can push its own deadline out.
    observe?: (message: SipMessage) => void
    resolve: (message: SipMessage) => void
    reject: (error: Error) => void
}

// Node reports `AA:BB:...`,
// while a fingerprint pasted out of `openssl` or a browser
// may include `sha256 Fingerprint=`, omit separators, or use lower case.
// Discard only the known label rather than every non-hex character:
// letters in the label itself are valid hex and would otherwise corrupt the pin.
// Anything that does not read as 32 bytes is simply not a fingerprint.
function readFingerprint(value?: string): string | undefined {
    if(!value?.trim()) {
        return undefined;
    }
    const equals = value.lastIndexOf("=");
    const candidate = (equals >= 0 ? value.slice(equals + 1) : value).trim();
    const fingerprint = candidate.replace(/[:\s-]/g, "").toUpperCase();
    return /^[A-F0-9]{64}$/.test(fingerprint) ? fingerprint : undefined;
}

// The same reading, for the pin the user configured
// rather than the one a server presented.
// Only this side may refuse: a value that cannot be read has to be reported,
// because falling back to the built-in pin would quietly verify
// against something other than what was asked for.
function parseFingerprint(value?: string): string | undefined {
    if(!value?.trim()) {
        return undefined;
    }
    const fingerprint = readFingerprint(value);
    if(!fingerprint) {
        throw new Error("The One Pass SIP certificate fingerprint must be 32 SHA-256 bytes in hex.");
    }
    return fingerprint;
}

export interface MonitorMedia {
    // Payload type ffmpeg should expect on the relayed H.264 stream.
    // The loopback port is handed out per viewer by the live view, not fixed here.
    payloadType: string
    // Codec parameters from the PBX answer,
    // including sprop-parameter-sets on the servers that supply them.
    // Passing those to ffmpeg frees the decoder
    // from needing an early RTP copy of SPS/PPS.
    fmtp?: string
}

// One direction of media: the even RTP port we offer,
// plus the odd RTCP port of the pair, held open for as long as the call lasts
// so nothing else on the host can take the port the SDP has already promised away.
export interface MonitorStream {
    socket: Socket
    port: number
    rtcp: Socket
}

// The address we advertise is cosmetic -
// it is almost always private,
// and the PBX reaches us by latching onto our RTP source instead.
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
    private readonly fingerprint: string;
    private readonly callId = randomToken(16);
    private readonly fromTag = randomToken(10);
    private readonly waiters: SipWaiter[] = [];

    private socket?: tls.TLSSocket;
    private buffer = "";
    private cseq = 20;
    private toTag?: string;
    private remoteTarget?: string;
    private closed = false;
    private hangingUp = false;

    constructor(private readonly log: Logging | LoggerBase,
                private readonly credentials: OnePassCredentials,
                sipFingerprint?: string) {
        this.localAddress = localAddress();
        this.fingerprint = parseFingerprint(sipFingerprint) || CVNET_SIP_FINGERPRINT;
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
            let settled = false;
            const finish = (error?: Error) => {
                if(settled) return;
                settled = true;
                error ? reject(error) : resolve();
            };
            const fail = (error: Error) => {
                // Settle before tearing the socket down.
                // Destroying it raises `close`, which settles with a reason of its own,
                // and whichever lands first is the one the caller gets to see -
                // so the specific reason has to be in place before that can happen.
                finish(error);
                socket.destroy();
            };
            const socket = tls.connect({
                host: this.credentials.sipDomain,
                port: this.credentials.sipPort,
                // The PBX presents a self-signed certificate and is addressed by IP,
                // so no chain can be built for it and no name can be checked.
                // Verification happens against the pinned fingerprint below instead,
                // which is what the app does;
                // this flag only lets the handshake get far enough to be pinned.
                rejectUnauthorized: false,
            }, () => {
                const presented = socket.getPeerCertificate()?.fingerprint256;
                // Reading, not validating:
                // a certificate whose fingerprint does not parse is one that fails the pin,
                // and this runs inside a TLS callback
                // where a throw would take the bridge down instead.
                if(readFingerprint(presented) !== this.fingerprint) {
                    fail(new Error(`The One Pass PBX presented an unexpected certificate: ${presented || "none"}`));
                    return;
                }
                // The handshake is done, so drop the deadline -
                // it is an idle timeout, and a quiet call is normal from here on.
                socket.setTimeout(0);
                finish();
            });
            // A router that drops the SYN rather than refusing it
            // would otherwise leave this pending until the OS gives up,
            // with the snapshot fallback and the HomeKit callback waiting behind it.
            socket.setTimeout(SIP_CONNECT_TIMEOUT_MS, () => {
                fail(new Error("The One Pass PBX did not accept a connection in time."));
            });
            socket.on("error", (error) => {
                this.log.debug("One Pass SIP socket error: %s", error.message);
                fail(error);
            });
            socket.on("data", (chunk) => this.onData(chunk));
            socket.on("close", () => {
                this.closed = true;
                finish(new Error("The One Pass SIP connection closed before the call was established."));
                const waiters = this.waiters.splice(0);
                for(const waiter of waiters) {
                    waiter.reject(new Error("The One Pass SIP connection closed while waiting for a response."));
                }
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
                if(!waiter.match(message)) {
                    waiter.observe?.(message);
                    continue;
                }
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve(message);
            }
        }
    }

    private send(text: string): void {
        this.log.debug("One Pass SIP -> %s", text.split("\r\n")[0]);
        this.socket?.write(text);
    }

    // `progress` marks the messages that mean the PBX is still working on the request.
    // They buy the same wait over again rather than counting against it -
    // up to `SIP_PROGRESS_RENEWAL_LIMIT` times, so the wait stays finite.
    private waitFor(match: (message: SipMessage) => boolean,
                    progress?: (message: SipMessage) => boolean): Promise<SipMessage> {
        return new Promise((resolve, reject) => {
            let renewals = 0;
            const waiter: SipWaiter = {
                match,
                observe: progress && ((message: SipMessage) => {
                    if(progress(message) && renewals < SIP_PROGRESS_RENEWAL_LIMIT) {
                        renewals += 1;
                        timer.refresh();
                    }
                }),
                resolve: (message: SipMessage) => {
                    clearTimeout(timer);
                    resolve(message);
                },
                reject: (error: Error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if(index < 0) return;
                this.waiters.splice(index, 1);
                reject(new Error("The One Pass PBX did not respond in time."));
            }, SIP_TIMEOUT_MS);
            this.waiters.push(waiter);
        });
    }

    private isInviteResponse(message: SipMessage): boolean {
        return message.statusCode !== undefined && /INVITE/.test(message.headers["cseq"] || "");
    }

    private buildInvite(branch: string, offer: string, authorizationHeader?: string): string {
        return buildRequest(`INVITE ${this.target} SIP/2.0`, [
            `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${branch}`,
            this.fromHeader,
            this.toHeader(false),
            `Contact: <sip:${this.credentials.sipId}@${this.localAddress}>`,
            `Call-ID: ${this.callId}`,
            `CSeq: ${this.cseq} INVITE`,
            "Content-Type: application/sdp",
            "Max-Forwards: 70",
            ...(authorizationHeader ? [authorizationHeader] : []),
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
            // A proxy challenge and an endpoint challenge
            // are carried in different headers in both directions,
            // and a PBX that asks with one ignores credentials sent in the other.
            const proxy = response.statusCode === 407;
            this.sendNonSuccessAck(branch, response);

            const challenge = parseChallenge(
                response.headers[proxy ? "proxy-authenticate" : "www-authenticate"]);
            if(!challenge) {
                throw new Error("The One Pass PBX sent an authentication challenge we could not parse.");
            }
            const credentials = buildAuthorization(
                challenge, this.credentials.sipId, this.credentials.sipPw, "INVITE", this.target);

            this.cseq += 1;
            this.toTag = undefined;
            branch = randomBranch();
            this.send(this.buildInvite(branch, offer,
                `${proxy ? "Proxy-Authorization" : "Authorization"}: ${credentials}`));
            response = await this.waitForFinal();
        }

        // RFC 3261 17.1.1.2: a final response of 300 or above belongs to the INVITE
        // client transaction, which has to acknowledge it before it can terminate.
        // This covers a second challenge, a refusal and a wallpad that never picked up alike.
        // Skipping it leaves the PBX retransmitting that response until its own timer gives up.
        if((response.statusCode || 0) >= 300) {
            this.sendNonSuccessAck(branch, response);
        }

        // Still challenged after answering, or refused outright:
        // the credentials are the problem, not the request.
        if(response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 407) {
            throw new OnePassSipAuthError(
                `The One Pass PBX rejected the SIP credentials: ${response.statusCode} ${response.reason}`);
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

    // One waiter, for the response that ends the transaction.
    // Resolving on a provisional and registering the next waiter afterwards
    // drops the 200 OK whenever the two arrive in the same TLS chunk:
    // `onData()` walks that chunk synchronously,
    // while the re-registration is a microtask behind it.
    private waitForFinal(): Promise<SipMessage> {
        return this.waitFor(
            (message) => this.isInviteResponse(message) && (message.statusCode || 0) >= 200,
            (message) => this.isInviteResponse(message));
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

    // A non-2xx ACK stays inside the INVITE transaction it answers:
    // the branch, the request URI and the CSeq number are the ones the INVITE carried,
    // and the To tag comes from the response being acknowledged.
    private sendNonSuccessAck(branch: string, response: SipMessage): void {
        this.toTag = parseTag(response.headers["to"]);
        this.send(buildRequest(`ACK ${this.target} SIP/2.0`, [
            `Via: SIP/2.0/TLS ${this.localAddress};rport;branch=${branch}`,
            this.fromHeader,
            this.toHeader(true),
            `Call-ID: ${this.callId}`,
            `CSeq: ${this.cseq} ACK`,
            `Contact: <sip:${this.credentials.sipId}@${this.localAddress}>`,
            "Max-Forwards: 70",
        ]));
    }

    private sendAck(): void {
        // A 2xx ACK is its own transaction:
        // fresh branch, addressed to the dialog's remote target
        // rather than to the original request URI.
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
        if(this.hangingUp) {
            return;
        }
        this.hangingUp = true;
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
    private openingCall?: MonitorCall;
    private latchTimer?: NodeJS.Timeout;
    private audioTimer?: NodeJS.Timeout;
    private videoTimer?: NodeJS.Timeout;
    private stalledTimer?: NodeJS.Timeout;
    private relay?: RtpRelay;
    private readonly consumerTimers = new Map<number, NodeJS.Timeout>();
    private stopped = false;
    private reconnecting = false;
    private retryAfter = 0;
    private legStartedAt = 0;
    private redialFailures = 0;
    private diedListener?: () => void;

    constructor(private readonly log: Logging | LoggerBase,
                private credentials: OnePassCredentials,
                private readonly refreshCredentials: () => Promise<OnePassCredentials>,
                private readonly sipFingerprint: string | undefined,
                private readonly audio: MonitorStream,
                private readonly video: MonitorStream,
                private readonly relaySocket: Socket) {
        // A UDP send that fails - an interface that went away mid-call, a media address
        // the PBX named that cannot be reached - does not throw where it is called from.
        // It arrives here, later, as an event, and an event nobody is listening for is
        // fatal to the whole Homebridge process rather than to this call.
        // There is nothing useful to do about one beyond noticing: the media will dry up,
        // and the stall watchdog rebuilds the dialog on its own.
        for(const socket of this.sockets()) {
            socket.on("error", (error) => {
                this.log.debug("One Pass media socket error: %s", error.message);
            });
        }
    }

    private sockets(): Socket[] {
        return [
            this.audio.socket, this.audio.rtcp,
            this.video.socket, this.video.rtcp,
            this.relaySocket,
        ];
    }

    async start(): Promise<MonitorMedia> {
        this.relay = new RtpRelay(this.relaySocket);
        this.video.socket.on("message", (packet) => {
            if(isStun(packet) || isRtcp(packet)) return;
            this.relay?.forward(packet);
        });
        // Audio is negotiated but never consumed;
        // draining the socket keeps the kernel buffer from filling
        // and the port alive for the latch.
        this.audio.socket.on("message", () => undefined);

        const media = await this.dial();
        if(this.stopped) {
            throw new Error("The One Pass live view was stopped while it was starting.");
        }
        this.watchForStalls();
        return media;
    }

    private async dial(): Promise<MonitorMedia> {
        if(this.stopped) {
            throw new Error("The One Pass live view was stopped before the call started.");
        }
        const call = new MonitorCall(this.log, this.credentials, this.sipFingerprint);
        this.openingCall = call;
        try {
            await call.connect();
            this.ensureOpening(call);
            const answer = await call.invite(this.audio.port, this.video.port);
            this.ensureOpening(call);

            const video = answer.media["video"];
            const audio = answer.media["audio"];
            // A zero port means the PBX declined the stream outright.
            if(!video?.address || !video.port || !video.payloads.length) {
                throw new Error("The One Pass PBX answered without a video stream.");
            }
            this.log.debug("One Pass media: video %s:%d, audio %s:%d",
                video.address, video.port, audio?.address, audio?.port);

            const packetsBefore = this.relay?.packets || 0;
            this.relay?.reset();
            // Consumers keep the payload type they were first told about,
            // so a later leg answered with a different one is rewritten rather than reported.
            // Its `fmtp` is left as the first leg's:
            // an SDP already handed to ffmpeg cannot be revised,
            // and H.264 repeats its parameter sets in band ahead of each keyframe anyway.
            const answered = parseInt(video.payloads[0], 10);
            const pinned = this.relay?.pinPayloadType(answered) ?? answered;
            this.startMedia(answer);
            this.call = call;
            this.legStartedAt = Date.now();
            await this.waitForFirstVideoPacket(packetsBefore);
            this.ensureOpening(call);

            // The codec parameters belong to the type the PBX answered with,
            // even when consumers are told about the pinned one.
            return {payloadType: String(pinned), fmtp: video.fmtp[video.payloads[0]]};
        } catch(error) {
            if(this.call === call) {
                this.call = undefined;
            }
            this.stopMedia();
            // The dialog did not become a usable media leg, so nothing else owns it.
            call.hangUp();
            throw error;
        } finally {
            if(this.openingCall === call) {
                this.openingCall = undefined;
            }
        }
    }

    private ensureOpening(call: MonitorCall): void {
        if(this.stopped || this.openingCall !== call) {
            throw new Error("The One Pass live view was stopped while the call was opening.");
        }
    }

    private waitForFirstVideoPacket(packetsBefore: number): Promise<void> {
        if((this.relay?.packets || 0) > packetsBefore) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
                if(settled) return;
                settled = true;
                clearTimeout(timer);
                this.video.socket.removeListener("message", onMessage);
                this.video.socket.removeListener("close", onClose);
                error ? reject(error) : resolve();
            };
            const onMessage = (packet: Buffer) => {
                if(isStun(packet) || isRtcp(packet)) return;
                if((this.relay?.packets || 0) > packetsBefore) {
                    finish();
                }
            };
            const onClose = () => finish(new Error("The One Pass video socket closed before media arrived."));
            const timer = setTimeout(() => finish(
                new Error("The One Pass PBX call connected, but no video arrived in time.")), FIRST_PACKET_TIMEOUT_MS);
            this.video.socket.on("message", onMessage);
            this.video.socket.once("close", onClose);

            // Do not miss a packet delivered between the check above and listener registration.
            if((this.relay?.packets || 0) > packetsBefore) {
                finish();
            }
        });
    }

    private startMedia(answer: SdpAnswer): void {
        this.stopMedia();
        const video = answer.media["video"];
        const audio = answer.media["audio"];

        const latch = () => {
            try {
                this.video.socket.send(stunBindingRequest(), video.port, video.address);
                if(audio?.address) {
                    this.audio.socket.send(stunBindingRequest(), audio.port, audio.address);
                }
            } catch {
                // The socket may already be closing.
            }
        };
        latch();
        this.latchTimer = setInterval(latch, LATCH_INTERVAL_MS);

        const videoSender = new RtpSender(this.video.socket, video.address!, video.port, parseInt(video.payloads[0], 10));
        this.videoTimer = setInterval(() => videoSender.send(H264_FILLER, 3600), VIDEO_INTERVAL_MS);
        if(audio?.address && audio.payloads.length) {
            const audioSender = new RtpSender(this.audio.socket, audio.address, audio.port, parseInt(audio.payloads[0], 10));
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
            // A leg that has produced nothing yet is measured from when it came up,
            // so a call the PBX answers but never sends media on
            // - UDP blocked on the way back, or an SDP it did not honour -
            // is caught as well.
            // Waiting on `lastPacketAt` alone leaves that case at the previous leg's value,
            // which every tick reads as a stream that is merely between packets.
            const running = this.relay.lastPacketAt > this.legStartedAt;
            const since = Date.now() - Math.max(this.relay.lastPacketAt, this.legStartedAt);
            if(since < (running ? STALL_TIMEOUT_MS : FIRST_PACKET_TIMEOUT_MS)) return;

            this.reconnecting = true;
            this.log.info("One Pass live view %s for %ds, reconnecting.",
                running ? "stalled" : "never started", Math.round(since / 1000));
            this.call?.hangUp();
            this.call = undefined;
            this.stopMedia();
            try {
                await this.redial();
                this.retryAfter = 0;
                this.redialFailures = 0;
            } catch(error) {
                if(this.stopped) return;
                this.redialFailures += 1;
                if(this.redialFailures >= REDIAL_ATTEMPT_LIMIT) {
                    this.log.warn("Could not reconnect the One Pass live view after %d attempts, giving up: %s",
                        this.redialFailures, (error as Error)?.message);
                    this.die();
                    return;
                }
                // Back off so a busy line or a downed PBX is not hammered every stall tick.
                this.retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
                this.log.warn("Could not reconnect the One Pass live view: %s", (error as Error)?.message);
            } finally {
                this.reconnecting = false;
            }
        }, 2000);
    }

    // Called by the owner once, before the session is put to work.
    // Fires when the session has given up on bringing the call back,
    // so the owner can end the viewers instead of leaving them
    // pointed at a relay that will never send again.
    onDied(listener: () => void): void {
        this.diedListener = listener;
    }

    private die(): void {
        const listener = this.diedListener;
        this.stop();
        listener?.();
    }

    private async redial(): Promise<void> {
        try {
            await this.dial();
        } catch(error) {
            if(!(error instanceof OnePassSipAuthError) || this.stopped) {
                throw error;
            }
            this.log.debug("The One Pass PBX rejected SIP credentials during reconnect; signing in again.");
            const credentials = await this.refreshCredentials();
            if(this.stopped) {
                throw new Error("The One Pass live view was stopped while credentials were refreshing.");
            }
            this.credentials = credentials;
            await this.dial();
        }
    }

    // Each HomeKit viewer gets its own loopback port; the relay fans every packet out.
    // The lease activates only after ffmpeg has been spawned and given its SDP.
    addConsumer(port: number): void {
        if(this.stopped || this.consumerTimers.has(port)) return;
        const timer = setTimeout(() => {
            this.consumerTimers.delete(port);
            if(!this.stopped) {
                this.relay?.addDestination(port);
            }
        }, CONSUMER_STARTUP_DELAY_MS);
        this.consumerTimers.set(port, timer);
    }

    removeConsumer(port: number): void {
        const timer = this.consumerTimers.get(port);
        if(timer) {
            clearTimeout(timer);
            this.consumerTimers.delete(port);
        }
        this.relay?.removeDestination(port);
    }

    stop(): void {
        if(this.stopped) return;
        this.stopped = true;
        this.stopMedia();
        if(this.stalledTimer) {
            clearInterval(this.stalledTimer);
            this.stalledTimer = undefined;
        }
        for(const timer of this.consumerTimers.values()) {
            clearTimeout(timer);
        }
        this.consumerTimers.clear();
        const calls = new Set<MonitorCall>();
        if(this.openingCall) {
            calls.add(this.openingCall);
        }
        if(this.call) {
            calls.add(this.call);
        }
        for(const call of calls) {
            call.hangUp();
        }
        this.openingCall = undefined;
        this.call = undefined;
        for(const socket of this.sockets()) {
            try {
                socket.close();
            } catch {
                // Already closed.
            }
        }
    }
}
