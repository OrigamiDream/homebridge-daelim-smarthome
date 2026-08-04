import {Logging} from "homebridge";
import {createSocket, Socket} from "dgram";
import pickPort from "pick-port";
import {LoggerBase} from "../utils";
import {OnePassConfig, OnePassCredentials} from "../interfaces/smart-elife-onepass-config";
import OnePassClient, {OnePassAuthError} from "./onepass-client";
import {MonitorMedia, MonitorStream, OnePassBusyError, OnePassMonitorSession, OnePassSipAuthError} from "./monitor";

const DEFAULT_LINGER_SECONDS = 5;
// `sipPw` is reissued on every login,
// so cached credentials are refreshed well before the server is likely to have rotated them.
const CREDENTIAL_TTL_MS = 30 * 60 * 1000;
const RTP_PORT_ATTEMPTS = 20;
const RELAY_PORT_ATTEMPTS = 20;
// The SIP pair binds its ports the moment they are picked,
// while HomeKit's return ports are only reserved in `prepareStream()`
// and bound well after that, once the live view has been acquired.
// A reservation lives in `pick-port`'s ledger, not in the kernel,
// so a bind from here would win the port
// and the later HomeKit bind would fail with EADDRINUSE.
// Keep the SIP pair out of the library's default 10000-20000 entirely.
const SIP_RTP_PORT_MIN = 30000;
const SIP_RTP_PORT_MAX = 39998;
// `pick-port` keys its reservations by address as well as by number,
// so a port it hands out on 127.0.0.1 is not the same reservation
// as the one HomeKit was handed on 0.0.0.0 -
// and a wildcard bind and a loopback bind on one number do collide.
// HomeKit's return ports come from the library default of 10000-20000,
// and it settles on the number in `prepareStream()`
// but only binds it once the live view has been acquired,
// so nothing in between can see the clash coming.
// Keep the two apart by range instead.
const RELAY_PORT_MIN = 20002;
const RELAY_PORT_MAX = 29998;

export interface LiveViewLease {
    media: {
        payloadType: string
        // Loopback port reserved for this viewer alone.
        relayPort: number
        fmtp?: string
    }
    activate(): void
    release(): void
}

export interface OnePassHousehold {
    // Smart eLife's `complexKey`, which One Pass carries verbatim as `projectCode2`.
    // The two services number complexes differently,
    // so this is the only reliable join.
    complexKey: string
    building: string
    unit: string
    username: string
}

function bindSocket(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createSocket("udp4");
        const onBindFailure = (error: Error) => reject(error);
        socket.once("error", onBindFailure);
        socket.bind(port, "0.0.0.0", () => {
            // The listener that was waiting for the bind to fail has to go once it has not.
            // A send failure arrives on this same event,
            // so leaving it attached feeds the first one to a promise that has already settled,
            // where it vanishes - taking the listener with it,
            // and leaving the next one with nothing at all to catch it.
            socket.removeListener("error", onBindFailure);
            resolve(socket);
        });
    });
}

// Whether a loopback port can be taken right now.
// Used to look rather than to keep:
// the port has to be free again by the time ffmpeg reaches for it.
function isLoopbackPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createSocket("udp4");
        socket.once("error", () => {
            try {
                socket.close();
            } catch {
                // Never bound.
            }
            resolve(false);
        });
        socket.bind(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
}

// RTP conventionally sits on an even port with RTCP on the odd one right after it,
// which is what the SDP we offer tells the PBX to expect.
// `pick-port` hands out whatever is free, so half of its answers are odd,
// and audio and video picked independently can land on each other's RTCP port.
// Bind the pair together instead, and hold the odd half for as long as the call lasts.
async function bindRtpPair(): Promise<MonitorStream> {
    for(let attempt = 0; attempt < RTP_PORT_ATTEMPTS; attempt++) {
        const port = await pickPort({
            type: "udp", ip: "0.0.0.0", reserveTimeout: 15,
            minPort: SIP_RTP_PORT_MIN, maxPort: SIP_RTP_PORT_MAX,
        });
        if(port % 2 !== 0) {
            continue;
        }
        const socket = await bindSocket(port);
        try {
            return {socket, port, rtcp: await bindSocket(port + 1)};
        } catch {
            // Something else holds the odd half.
            // Give the whole pair up rather than promise a port we do not own.
            socket.close();
        }
    }
    throw new Error("Could not reserve an even RTP port pair for the One Pass call.");
}

// Fronts the One Pass monitoring call for the camera accessory.
// The PBX only allows one session on the door line at a time,
// so every HomeKit viewer shares a single call,
// and the call is torn down shortly after the last of them goes away.
export default class OnePassLiveView {

    private readonly client: OnePassClient;
    private credentials?: OnePassCredentials;
    private credentialsAt = 0;
    private session?: OnePassMonitorSession;
    private openingSession?: OnePassMonitorSession;
    private starting?: Promise<MonitorMedia>;
    private media?: MonitorMedia;
    private viewers = 0;
    private lingerTimer?: NodeJS.Timeout;
    private generation = 0;
    // Loopback ports promised to a viewer, by the even port named in its SDP.
    // Each entry stands for that port and the odd one after it.
    private readonly claimedRelayPorts = new Set<number>();
    private readonly endListeners: (() => void)[] = [];

    // The household is resolved lazily:
    // the Smart eLife session only learns its complex while `serve()` runs,
    // which is after the accessories have registered.
    constructor(private readonly log: Logging | LoggerBase,
                private readonly config: OnePassConfig,
                private readonly household: () => OnePassHousehold | undefined) {
        this.client = new OnePassClient(log, config, () => this.resolveHousehold().username);
    }

    get enabled(): boolean {
        return !!this.config.enabled;
    }

    private resolveHousehold(): OnePassHousehold {
        const household = this.household();
        if(!household) {
            throw new Error("The Smart eLife session has not reported the household yet.");
        }
        return household;
    }

    private async getCredentials(): Promise<OnePassCredentials> {
        if(this.credentials && Date.now() - this.credentialsAt < CREDENTIAL_TTL_MS) {
            return this.credentials;
        }
        const household = this.resolveHousehold();
        const credentials = await this.client.signIn(
            household.complexKey,
            this.config.building || household.building,
            this.config.unit || household.unit);
        this.credentials = credentials;
        this.credentialsAt = Date.now();
        this.log.debug("One Pass SIP line: %s -> %s", credentials.sipId, credentials.wallpadSipId);
        // The dialog speaks TLS and nothing else,
        // so a server that starts answering otherwise
        // would fail in a way that says nothing about the cause.
        if(credentials.sipProtocol.toLowerCase() !== "tls") {
            this.log.warn("One Pass reported a '%s' SIP transport, but the live view only speaks TLS.",
                credentials.sipProtocol);
        }
        return credentials;
    }

    private async refreshCredentials(): Promise<OnePassCredentials> {
        this.credentials = undefined;
        return await this.getCredentials();
    }

    // A viewer takes two loopback ports, not one.
    // The SDP names only the RTP port,
    // but ffmpeg binds the RTCP port right after it as well - checked against the
    // bundled build - so a second viewer handed that odd port would fail to open
    // its input, or take one out from under the first.
    //
    // Neither port can be held open here, because ffmpeg is what has to bind them.
    // They are claimed instead:
    // an even base, so that two claims can never half-overlap,
    // with the odd half looked at once to see that nothing else already has it.
    private async reserveRelayPort(): Promise<number> {
        for(let attempt = 0; attempt < RELAY_PORT_ATTEMPTS; attempt++) {
            const port = await pickPort({
                type: "udp", ip: "127.0.0.1", reserveTimeout: 15,
                minPort: RELAY_PORT_MIN, maxPort: RELAY_PORT_MAX,
            });
            if(port % 2 !== 0 || this.claimedRelayPorts.has(port)) {
                continue;
            }
            if(!await isLoopbackPortFree(port + 1)) {
                continue;
            }
            this.claimedRelayPorts.add(port);
            return port;
        }
        throw new Error("Could not reserve a loopback port pair for the One Pass viewer.");
    }

    // Resolves once media is flowing.
    // Throws `OnePassBusyError` when the door line is already in use,
    // which the caller is expected to translate into a fallback.
    async acquire(): Promise<LiveViewLease> {
        if(!this.enabled) {
            throw new Error("One Pass live view is not enabled.");
        }
        if(this.lingerTimer) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = undefined;
        }
        this.viewers += 1;
        try {
            const media = await (this.starting || this.beginSession());
            // A lease may only ever decrement the count once.
            // `stopStream()` can be reached from several directions
            // (HomeKit STOP, an ffmpeg exit, a forced teardown),
            // and a double release would strand the call with viewers still watching -
            // which reads as the picture freezing a few seconds in.
            // A port of its own per viewer:
            // two ffmpeg readers cannot share one UDP port,
            // so a shared port would leave every viewer but the first with a black screen.
            const relayPort = await this.reserveRelayPort();
            const session = this.session;
            if(!session) {
                this.claimedRelayPorts.delete(relayPort);
                throw new Error("The One Pass live view ended while the viewer was being prepared.");
            }
            let released = false;
            let activated = false;
            return {
                media: {payloadType: media.payloadType, relayPort, fmtp: media.fmtp},
                activate: () => {
                    if(released || activated) return;
                    activated = true;
                    session.addConsumer(relayPort);
                },
                release: () => {
                    if(released) return;
                    released = true;
                    session.removeConsumer(relayPort);
                    // Both halves of the pair go back to the pool together.
                    this.claimedRelayPorts.delete(relayPort);
                    this.release();
                },
            };
        } catch(error) {
            this.release();
            throw error;
        }
    }

    private beginSession(): Promise<MonitorMedia> {
        const starting = this.startSession();
        this.starting = starting;
        starting.catch(() => {
            // A cancelled, older start must not erase a newer generation's promise.
            if(this.starting === starting) {
                this.starting = undefined;
            }
        });
        return starting;
    }

    private async startSession(): Promise<MonitorMedia> {
        if(this.media) {
            return this.media;
        }
        try {
            return await this.attemptSession();
        } catch(error) {
            if(error instanceof OnePassAuthError || error instanceof OnePassSipAuthError) {
                // Force a fresh sign-in on the next attempt.
                this.credentials = undefined;
            }
            throw error;
        }
    }

    // One sign-in's worth of attempts.
    // Credentials the PBX itself turns down have been rotated out from under the cache,
    // and signing in again hands over a working pair right away,
    // so that one case is worth a second call rather than half an hour of snapshots.
    private async attemptSession(): Promise<MonitorMedia> {
        try {
            return await this.openSession();
        } catch(error) {
            if(!(error instanceof OnePassSipAuthError) || !this.credentials) {
                throw error;
            }
            this.log.debug("The One Pass PBX rejected the cached SIP credentials; signing in again.");
            this.credentials = undefined;
            return await this.openSession();
        }
    }

    private async openSession(): Promise<MonitorMedia> {
        const generation = this.generation;
        let audio: MonitorStream | undefined;
        let video: MonitorStream | undefined;
        let relay: Socket | undefined;
        let session: OnePassMonitorSession | undefined;
        try {
            const credentials = await this.getCredentials();
            this.ensureGeneration(generation);
            audio = await bindRtpPair();
            this.ensureGeneration(generation);
            video = await bindRtpPair();
            this.ensureGeneration(generation);
            relay = createSocket("udp4");

            session = new OnePassMonitorSession(
                this.log, credentials, () => this.refreshCredentials(),
                this.config.sipFingerprint, audio, video, relay);
            this.openingSession = session;
            const media = await session.start();
            this.ensureGeneration(generation);
            if(this.openingSession !== session) {
                throw new Error("The One Pass live view was cancelled while it was opening.");
            }
            this.openingSession = undefined;
            const opened = session;
            this.session = opened;
            opened.onDied(() => this.sessionDied(opened));
            this.media = media;
            this.log.info("One Pass live view is up.");
            return media;
        } catch(error) {
            session?.stop();
            if(this.openingSession === session) {
                this.openingSession = undefined;
            }
            for(const socket of [audio?.socket, audio?.rtcp, video?.socket, video?.rtcp, relay]) {
                try {
                    socket?.close();
                } catch {
                    // Never bound.
                }
            }
            throw error;
        }
    }

    private ensureGeneration(generation: number): void {
        if(generation !== this.generation) {
            throw new Error("The One Pass live view was cancelled while it was starting.");
        }
    }

    private release(): void {
        this.viewers = Math.max(0, this.viewers - 1);
        this.log.debug("One Pass live view viewers: %d", this.viewers);
        if(this.viewers > 0) {
            return;
        }
        const linger = (this.config.lingerSeconds ?? DEFAULT_LINGER_SECONDS) * 1000;
        this.lingerTimer = setTimeout(() => {
            this.lingerTimer = undefined;
            // Re-check rather than trusting the timer:
            // a viewer that arrived while the callback was already queued
            // must keep the call alive.
            if(this.viewers > 0) {
                return;
            }
            this.shutdown();
        }, linger);
    }

    // Notified whenever a running call goes away,
    // so the streams feeding off it can be torn down
    // instead of being left pointed at a relay that will never send again.
    onEnded(listener: () => void): void {
        this.endListeners.push(listener);
    }

    // A running call that gave up on reconnecting reports itself here.
    // The teardown is the one a deliberate shutdown takes,
    // so the viewers are ended through the same listeners
    // and the Home app gets to report the dead stream in its own words.
    private sessionDied(session: OnePassMonitorSession): void {
        if(this.session !== session) {
            return;
        }
        this.log.warn("The One Pass live view could not be recovered; ending the call.");
        this.shutdown();
    }

    shutdown(): void {
        if(this.lingerTimer) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = undefined;
        }
        // Invalidates work that is still signing in or reserving ports.
        // An already-created session is stopped below as well,
        // which closes the SIP call it has pending.
        this.generation += 1;
        const running = this.session;
        const opening = this.openingSession;
        if(running || opening) {
            this.log.info("Ending the One Pass live view call.");
        }
        const sessions = new Set<OnePassMonitorSession>();
        if(running) sessions.add(running);
        if(opening) sessions.add(opening);
        for(const session of sessions) {
            session.stop();
        }
        this.session = undefined;
        this.openingSession = undefined;
        if(running) {
            for(const listener of this.endListeners.slice()) {
                try {
                    listener();
                } catch(error) {
                    this.log.debug("One Pass live view end listener failed: %s", (error as Error)?.message);
                }
            }
        }
        this.media = undefined;
        this.starting = undefined;
        // End listeners release their leases synchronously and may schedule a new linger.
        // A shutdown has already ended the call, so that timer has no work left to do.
        if(this.lingerTimer) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = undefined;
        }
    }
}

export {OnePassBusyError, OnePassSipAuthError};
