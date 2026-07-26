import {Logging} from "homebridge";
import {createSocket, Socket} from "dgram";
import pickPort from "pick-port";
import {LoggerBase} from "../utils";
import {OnePassConfig, OnePassCredentials} from "../interfaces/smart-elife-onepass-config";
import OnePassClient, {OnePassAuthError} from "./onepass-client";
import {MonitorMedia, OnePassBusyError, OnePassMonitorSession} from "./monitor";

const DEFAULT_LINGER_SECONDS = 5;
// `sipPw` is reissued on every login, so cached credentials are refreshed well before the
// server is likely to have rotated them under us.
const CREDENTIAL_TTL_MS = 30 * 60 * 1000;

export interface LiveViewLease {
    media: {
        payloadType: string
        // Loopback port reserved for this viewer alone.
        relayPort: number
    }
    release(): void
}

export interface OnePassHousehold {
    // Smart eLife's `complexKey`, which One Pass carries verbatim as `projectCode2`.
    // The two services number complexes differently, so this is the only reliable join.
    complexKey: string
    building: string
    unit: string
    username: string
}

function bindSocket(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createSocket("udp4");
        socket.once("error", reject);
        socket.bind(port, "0.0.0.0", () => resolve(socket));
    });
}

// Fronts the One Pass monitoring call for the camera accessory. The PBX only allows one
// session on the door line at a time, so every HomeKit viewer shares a single call and
// the call is torn down shortly after the last of them goes away.
export default class OnePassLiveView {

    private readonly client: OnePassClient;
    private credentials?: OnePassCredentials;
    private credentialsAt = 0;
    private session?: OnePassMonitorSession;
    private starting?: Promise<MonitorMedia>;
    private media?: MonitorMedia;
    private viewers = 0;
    private lingerTimer?: NodeJS.Timeout;
    private readonly endListeners: (() => void)[] = [];

    // The household is resolved lazily: the Smart eLife session only learns its complex
    // while `serve()` runs, which is after the accessories have registered.
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
        return credentials;
    }

    // Resolves once media is flowing. Throws `OnePassBusyError` when the door line is
    // already in use, which the caller is expected to translate into a fallback.
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
            const media = await (this.starting ||= this.startSession());
            // A lease may only ever decrement the count once. `stopStream()` can be
            // reached from several directions (HomeKit STOP, an ffmpeg exit, a forced
            // teardown), and a double release would strand the call with viewers still
            // watching - which reads as the picture freezing a few seconds in.
            // A port of its own per viewer: two ffmpeg readers cannot share one UDP
            // port, so a shared port would leave every viewer but the first with a
            // black screen.
            const relayPort = await pickPort({type: "udp", ip: "127.0.0.1", reserveTimeout: 15});
            this.session?.addConsumer(relayPort);
            let released = false;
            return {
                media: {payloadType: media.payloadType, relayPort},
                release: () => {
                    if(released) return;
                    released = true;
                    this.session?.removeConsumer(relayPort);
                    this.release();
                },
            };
        } catch(error) {
            this.release();
            throw error;
        }
    }

    private async startSession(): Promise<MonitorMedia> {
        if(this.media) {
            return this.media;
        }
        let audio: Socket | undefined;
        let video: Socket | undefined;
        let relay: Socket | undefined;
        try {
            const credentials = await this.getCredentials();
            // RTP conventionally sits on even ports with RTCP on the following odd one.
            const audioPort = await pickPort({type: "udp", ip: "0.0.0.0", reserveTimeout: 15});
            const videoPort = await pickPort({type: "udp", ip: "0.0.0.0", reserveTimeout: 15});
            audio = await bindSocket(audioPort);
            video = await bindSocket(videoPort);
            relay = createSocket("udp4");

            const session = new OnePassMonitorSession(
                this.log, credentials, audio, video, relay, audioPort, videoPort);
            const media = await session.start();
            this.session = session;
            this.media = media;
            this.log.info("One Pass live view is up.");
            return media;
        } catch(error) {
            for(const socket of [audio, video, relay]) {
                try {
                    socket?.close();
                } catch {
                    // Never bound.
                }
            }
            this.starting = undefined;
            if(error instanceof OnePassAuthError) {
                // Force a fresh sign-in on the next attempt.
                this.credentials = undefined;
            }
            throw error;
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
            // Re-check rather than trusting the timer: a viewer that arrived while the
            // callback was already queued must keep the call alive.
            if(this.viewers > 0) {
                return;
            }
            this.shutdown();
        }, linger);
    }

    // Notified whenever a running call goes away, so the streams feeding off it can be
    // torn down instead of being left pointed at a relay that will never send again.
    onEnded(listener: () => void): void {
        this.endListeners.push(listener);
    }

    shutdown(): void {
        if(this.lingerTimer) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = undefined;
        }
        if(!this.session) {
            return;
        }
        this.log.info("Ending the One Pass live view call.");
        this.session.stop();
        this.session = undefined;
        for(const listener of this.endListeners.slice()) {
            try {
                listener();
            } catch(error) {
                this.log.debug("One Pass live view end listener failed: %s", (error as Error)?.message);
            }
        }
        this.media = undefined;
        this.starting = undefined;
    }
}

export {OnePassBusyError};
