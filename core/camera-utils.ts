import {
    API,
    APIEvent,
    AudioStreamingCodecType,
    AudioStreamingSamplerate,
    CameraController,
    CameraControllerOptions,
    CameraStreamingDelegate,
    HAP,
    Logging,
    PrepareStreamCallback,
    PrepareStreamRequest,
    PrepareStreamResponse,
    SnapshotRequest,
    SnapshotRequestCallback,
    SRTPCryptoSuites,
    StartStreamRequest,
    StreamingRequest,
    StreamRequestCallback,
    StreamRequestTypes,
    VideoInfo
} from "homebridge";
import pickPort, {pickPortOptions} from "pick-port";
import {ChildProcessWithoutNullStreams, spawn} from "child_process";
import axios from "axios";
import {Utils} from "./utils";
import {Writable} from "stream";
import readline from "readline";
import {createSocket, Socket} from "dgram";
import {setInterval} from "timers";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {CameraAccessoryInterfaceBase} from "./interfaces/camera";
import {CameraConfig} from "./interfaces/config";

export function reformatSnapshot(processorPath: string, log: Logging, name: string, snapshot: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const args: string[] = [];
        args.push("-i pipe:");
        args.push("-frames:v 1");
        args.push("-codec:v png"); // the alternative snapshot has PNG/rgba
        args.push("-pix_fmt rgba");
        args.push("-f image2 -");

        const ffmpegArgs = args.join(" ");
        log.debug(`[${name}] Snapshot resize command: ${processorPath} ${ffmpegArgs}`);
        const ffmpeg = spawn(processorPath, ffmpegArgs.split(/\s+/), {
            env: process.env
        });

        let buffer = Buffer.alloc(0);
        ffmpeg.stdout.on("data", (data) => {
            buffer = Buffer.concat([buffer, data]);
        });
        ffmpeg.on("error", (error: Error) => {
            reject(`FFmpeg process creation failed: ${error.message}`);
        });
        ffmpeg.on("close", () => {
            resolve(buffer);
        });
        ffmpeg.stdin.end(snapshot);
    });
}

/**
 * Builds the filter chain that fits a source frame into the requested box.
 *
 * The scale step targets the requested size directly,
 * so a source larger than the request is shrunk instead of passed through.
 * It has to be, because `pad` widens a canvas and cannot narrow one:
 * handing it a frame larger than its target fails the whole graph
 * with "Padded dimensions cannot be smaller than input dimensions".
 * A source smaller than the request is still enlarged,
 * and `pad` only fills whatever the aspect ratio leaves over.
 */
function buildResizeFilters(width: number, height: number): { resizeFilter: string, filters: Array<string> } {
    const w = width > 0 ? width : "iw";
    const h = height > 0 ? height : "ih";
    const resizeFilter = `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
    return {
        resizeFilter: resizeFilter,
        filters: [
            resizeFilter,
            `pad=${w}:${h}:x=(${w}-iw)/2:y=(${h}-ih)/2:color=black`,
            "scale=trunc(iw/2)*2:trunc(ih/2)*2" // Force to fit encoder restrictions
        ]
    };
}

interface SessionInfo {
    address: string // address of the HAP controller
    ipv6: boolean

    videoPort: number
    videoReturnPort: number
    videoCryptoSuite: SRTPCryptoSuites // should be saved if multiple suites are supported
    videoSRTP: Buffer // key and salt concatenated
    videoSSRC: number // rtp synchronization source

    audioPort: number
    audioReturnPort: number
    audioCryptoSuite: SRTPCryptoSuites
    audioSRTP: Buffer
    audioSSRC: number
}

interface ResolutionInfo {
    width: number
    height: number
    videoFilter?: string
    snapshotFilter?: string
    resizeFilter?: string
}

interface ActiveSession {
    mainProcess?: FFmpegProcess;
    returnProcess?: FFmpegProcess;
    timeout?: NodeJS.Timeout;
    feedInterval?: NodeJS.Timeout;
    progressInterval?: NodeJS.Timeout;
    bufferLock: boolean;
    cachedSnapshot?: Buffer;
    enqueuedSnapshots: Buffer[];
    transition: boolean;
    transitionReady: boolean;
    progress: StreamingProgress;
    socket?: Socket;
    liveLease?: LiveViewLease;
    sdpPath?: string;
}

// Supplied by providers that can offer a real-time feed for the camera.
// When it is absent or disabled the delegate serves the snapshot feed instead.
// When it is present but cannot produce a lease the stream fails outright,
// because a camera with a door station to call has nothing else worth showing.
export interface LiveViewSource {
    readonly enabled: boolean;
    acquire(): Promise<LiveViewLease>;
    // Fires when a running call ends.
    // Streams reading from it are dead at that point and must be stopped,
    // or ffmpeg sits on a silent socket and the picture freezes.
    onEnded(listener: () => void): void;
}

// The idle frame ships inside the package, next to `dist`.
// It used to be fetched from the repository on every cold start,
// which tied the placeholder to GitHub being reachable
// and left no way to change it before the change had been merged there.
const IDLE_IMAGE_DIRECTORY = path.join(__dirname, "..", "..", "assets");
const IDLE_IMAGE_DEFAULT = "hksv_camera_idle.png";

export interface LiveViewLease {
    media: {
        payloadType: string;
        relayPort: number;
        fmtp?: string;
    };
    activate(): void;
    release(): void;
}

// What came of trying to open the real-time feed for one stream request.
// It is returned rather than recorded on the delegate,
// because the delegate outlives the session that produced it:
// a session HomeKit has already stopped would otherwise leave its verdict behind
// for the next viewer to read, and the snapshot request that opens a camera tile
// carries no session of its own to tell one verdict from another.
type LiveViewOutcome =
    // No real-time feed is configured for this camera,
    // which is the ordinary case for every camera but the household front door.
    | {kind: "unsupported"}
    | {kind: "acquired", lease: LiveViewLease}
    | {kind: "unavailable", reason: string};

interface StreamingProgress {
    written: number;
    dropped: number;
}

interface TransitionSnapshot {
    index: number;
    snapshot: Buffer;
}

export const CAMERA_TIMEOUT_DURATION = 3 * 60; // 3 minutes
export const CAMERA_TRANSITION_DURATION = 0.5; // 0.5 seconds
// How long a live view may take before the stream is given up on.
// The door line is slow and remarkably consistent about it: four calls to the real
// PBX took 7.32, 7.33, 7.35 and 7.38 seconds, almost all of it the PBX taking its
// time over the INVITE - the sign-in before it is around 200ms, and the first video
// packet lands about 20ms after the answer. So the budget cannot be tight; it is set
// at roughly double the measured time, which still bounds a wait its own timeouts
// would otherwise let run into minutes.
const LIVE_VIEW_ACQUIRE_TIMEOUT = 15 * 1000;
// A live view is joined to the stream once ffmpeg first logs,
// which is as close as the process gets to announcing that its input is open.
// One that never logs still has to receive video,
// so this is the point where it is joined regardless.
const LIVE_VIEW_ACTIVATE_DEADLINE = 3 * 1000;

export default class VisitorOnCameraStreamingDelegate implements CameraStreamingDelegate {

    private readonly cameraName: string;
    readonly controller: CameraController;

    private snapshotPromise?: Promise<Buffer>;
    private alternativeSnapshot?: Buffer;
    private pendingSessions: Map<string, SessionInfo> = new Map();
    private ongoingSessions: Map<string, ActiveSession> = new Map();
    // Leases held between being acquired
    // and the session that owns them being registered.
    // `stopStream()` releases through `ActiveSession`,
    // so anything that fails in that window would otherwise strand a viewer,
    // and a stranded viewer holds the interphone line open until Homebridge restarts.
    private unownedLeases: Map<string, LiveViewLease> = new Map();

    constructor(private readonly api: API,
                private readonly hap: HAP,
                private readonly log: Logging,
                private readonly context: CameraAccessoryInterfaceBase,
                private readonly cameraConfig: CameraConfig,
                private readonly processor: string,
                private readonly liveView?: LiveViewSource) {
        this.cameraName = this.context.cameraDisplayName;
        // When the call behind the live feed goes away,
        // end the HomeKit sessions built on it.
        // Left alone they would keep an ffmpeg alive on a relay that never sends again,
        // which is what a frozen picture looks like from the Home app.
        this.liveView?.onEnded(() => {
            for(const [sessionId, session] of Array.from(this.ongoingSessions)) {
                if(!session.liveLease) continue;
                this.log.info(`[${this.cameraName}] Live view ended, stopping the video stream.`);
                this.controller.forceStopStreamingSession(sessionId);
                this.stopStream(sessionId);
            }
        });
        this.api.on(APIEvent.SHUTDOWN, () => {
            // `for...in` over a Map yields nothing; iterate the keys.
            for(const sessionId of Array.from(this.ongoingSessions.keys())) {
                this.stopStream(sessionId);
            }
            this.context.cameraInfo = undefined;
            if(this.context.motionTimer) {
                clearTimeout(this.context.motionTimer);
            }
            this.context.motionTimer = undefined;
        });
        const options: CameraControllerOptions = {
            cameraStreamCount: this.cameraConfig.maxStreams || 2, // Maximum number of simultaneous stream watch
            delegate: this,
            streamingOptions: {
                supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        [320, 180, 30],
                        [320, 240, 15], // Apple Watch requires this config
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1280, 960, 30],
                        [1920, 1080, 30],
                        [1600, 1200, 30]
                    ],
                    codec: {
                        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0]
                    }
                },
                audio: {
                    twoWayAudio: !!this.cameraConfig.returnAudioTarget,
                    codecs: [{
                        type: AudioStreamingCodecType.AAC_ELD,
                        samplerate: AudioStreamingSamplerate.KHZ_16
                    }]
                }
            }
        }
        this.controller = new hap.CameraController(options);
        setTimeout(async () => {
            await this.createAlternativeSnapshot();
        });
    }

    private async createAlternativeSnapshot(): Promise<Buffer> {
        if(this.alternativeSnapshot) {
            return this.alternativeSnapshot;
        }
        this.log.debug(`[${this.cameraName}] Creating alternative snapshot buffer from ${IDLE_IMAGE_DEFAULT}`);
        let snapshot: Buffer;
        try {
            snapshot = await fs.promises.readFile(path.join(IDLE_IMAGE_DIRECTORY, IDLE_IMAGE_DEFAULT));
        } catch(error) {
            // An install whose assets went missing still gets the published frame,
            // which is what every install used before they shipped with the package.
            this.log.debug(`[${this.cameraName}] Falling back to the published idle image: ${(error as Error)?.message || error}`);
            const response = await axios.get(Utils.HOMEKIT_SECURE_VIDEO_IDLE_URL, {
                responseType: "arraybuffer"
            });
            snapshot = Buffer.from(response.data);
        }
        this.alternativeSnapshot = snapshot;
        return snapshot;
    }

    private determineResolution(request: SnapshotRequest | VideoInfo, isSnapshot: boolean): ResolutionInfo {
        const resInfo: ResolutionInfo = {
            width: request.width,
            height: request.height
        };
        if(!isSnapshot) {
            if(this.cameraConfig.maxWidth !== undefined && (this.cameraConfig.forceMax || request.width > this.cameraConfig.maxWidth)) {
                resInfo.width = this.cameraConfig.maxWidth;
            }
            if(this.cameraConfig.maxHeight !== undefined && (this.cameraConfig.forceMax || request.height > this.cameraConfig.maxHeight)) {
                resInfo.height = this.cameraConfig.maxHeight;
            }
        }
        const filters: Array<string> = this.cameraConfig.videoFilter?.split(",") || [];
        const noneFilter = filters.indexOf("none");
        if(noneFilter >= 0) {
            filters.splice(noneFilter, 1);
        }
        resInfo.snapshotFilter = filters.join(",");
        if(noneFilter < 0 && (resInfo.width > 0 || resInfo.height > 0)) {
            const resize = buildResizeFilters(resInfo.width, resInfo.height);
            resInfo.resizeFilter = resize.resizeFilter;
            filters.push(...resize.filters);
        }

        if(filters.length > 0) {
            resInfo.videoFilter = filters.join(",");
        }
        return resInfo;
    }

    private fetchSnapshot(snapshotFilter?: string): Promise<Buffer> {
        this.snapshotPromise = new Promise(async (resolve, reject) => {
            const snapshot = this.context.cameraInfo?.snapshot || await this.createAlternativeSnapshot();

            const startTime = Date.now();
            const args: string[] = [];
            args.push("-i pipe:");
            args.push("-frames:v 1");
            if(snapshotFilter) {
                args.push(`-filter:v ${snapshotFilter}`);
            }
            args.push("-f image2 -");
            args.push("-hide_banner");
            args.push("-loglevel error");

            const ffmpegArgs = args.join(" ");
            this.log.debug(`[${this.cameraName}] Snapshot command: ${this.processor} ${ffmpegArgs}`);
            const ffmpeg = spawn(this.processor, ffmpegArgs.split(/\s+/), {
                env: process.env
            });

            let snapshotBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on("data", (data) => {
                snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
            });
            ffmpeg.on("error", (error: Error) => {
                reject(`FFmpeg process creation failed: ${error.message}`);
            })
            ffmpeg.stderr.on("data", (data) => {
                data.toString().split("\n").forEach((line: string) => {
                    if(line.length > 0) {
                        this.log.error(line);
                    }
                });
            });
            ffmpeg.on("close", () => {
                if(snapshotBuffer.length > 0) {
                    resolve(snapshotBuffer);
                } else {
                    reject(`Failed to fetch snapshot`);
                }

                setTimeout(() => {
                    this.snapshotPromise = undefined;
                }, 3 * 1000); // Expire cached snapshot after 3 seconds

                const runtime = (Date.now() - startTime) / 1000;
                let message = `[${this.cameraName}] Fetching snapshot took ${runtime} seconds.`;
                if(runtime < 5) {
                    this.log.debug(message);
                } else {
                    if(runtime < 22) {
                        this.log.warn(message);
                    } else {
                        message += " The request has timed out and the snapshot has not been refreshed in HomeKit.";
                        this.log.error(message);
                    }
                }
            });
            ffmpeg.stdin.end(snapshot);
        });
        return this.snapshotPromise;
    }

    private createRandomCharacterGenerator(characterSet: string, length: number) {
        return () => {
            let code = '';
            for(let i = 0; i < length; i++) {
                const randomIndex = crypto.randomBytes(1)[0] % characterSet.length;
                code += characterSet[randomIndex];
            }
            return code;
        };
    }

    enqueueTransitionSnapshots(activeSession: ActiveSession, resInfo: ResolutionInfo, background: Buffer, overlay: Buffer) {
        // create binary files like named pipes
        const generator = this.createRandomCharacterGenerator("0123456789abcdef", 10);
        let dirPath: string;
        do {
            dirPath = `./${generator()}`;
        } while(fs.existsSync(dirPath));
        fs.mkdirSync(dirPath);

        const backgroundPath = `${dirPath}/${generator()}.png`;
        const overlayPath = `${dirPath}/${generator()}.png`;
        fs.writeFileSync(backgroundPath, background, "binary");
        fs.writeFileSync(overlayPath, overlay, "binary");

        const startTime = Date.now();
        const duration = CAMERA_TRANSITION_DURATION * 30;
        const queues: Promise<TransitionSnapshot>[] = [];
        for(let i = 0; i < duration; i++) {
            const opacity = i / duration;

            const args: string[] = [];
            args.push(`-i ${overlayPath}`);
            args.push(`-i ${backgroundPath}`);
            args.push("-frames:v 1");

            const filters = buildResizeFilters(resInfo.width, resInfo.height).filters;

            const v0 = `format=rgba,colorchannelmixer=aa=${opacity.toFixed(5)},${filters.join(",")}[over]`;
            const v1 = `${filters.join(",")}[bg]`;

            const complex = [];
            complex.push(`[0:v]${v0}`);
            complex.push(`[1:v]${v1}`);
            complex.push("[bg][over]overlay");

            args.push(`-filter_complex ${complex.join(";")}`);
            args.push("-codec:v png");
            args.push("-pix_fmt rgba");
            args.push("-f image2 -");

            const ffmpegArgs = args.join(" ");
            if(i === 0) {
                this.log.debug(`[${this.cameraName}] Transition snapshot command (x${duration}): ${this.processor} ${ffmpegArgs}`);
            }
            queues.push(this.transitionSnapshotOverlay(i, ffmpegArgs));
        }
        Promise.all(queues).then((results) => {
            results.sort((a, b) => a.index - b.index);
            for(const result of results) {
                activeSession.enqueuedSnapshots.push(result.snapshot);
            }
            activeSession.transitionReady = true;
            const runtime = (Date.now() - startTime) / 1000;

            fs.rmSync(dirPath, {
                recursive: true,
                force: true
            });
            this.log.debug(`[${this.cameraName}] Enqueuing ${duration} transition snapshot took ${runtime} seconds.`);
        });
    }

    transitionSnapshotOverlay(index: number, ffmpegArgs: string): Promise<TransitionSnapshot> {
        return new Promise<TransitionSnapshot>((resolve, reject) => {
            const ffmpeg = spawn(this.processor, ffmpegArgs.split(/\s+/), {
                env: process.env
            });

            let buffer = Buffer.alloc(0);
            ffmpeg.stdout.on("data", (data) => {
                buffer = Buffer.concat([buffer, data]);
            });
            ffmpeg.on("error", (error: Error) => {
                reject(`FFmpeg process creation failed: ${error.message}`);
            })
            ffmpeg.on("close", () => {
                resolve({
                    index: index,
                    snapshot: buffer
                });
            });
            ffmpeg.stdin.end();
        });
    }

    resizeSnapshot(snapshot: Buffer, resizeFilter?: string): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const args: string[] = [];
            args.push("-i pipe:"); // Resize
            args.push("-frames:v 1");
            if(resizeFilter) {
                args.push(`-filter:v ${resizeFilter}`);
            }
            args.push("-f image2 -");

            const ffmpegArgs = args.join(" ");
            this.log.debug(`[${this.cameraName}] Resize command: ${this.processor} ${ffmpegArgs}`);
            const ffmpeg = spawn(this.processor, ffmpegArgs.split(/\s+/), {
                env: process.env
            });

            let resizeBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on("data", (data) => {
                resizeBuffer = Buffer.concat([resizeBuffer, data]);
            });
            ffmpeg.on("error", (error: Error) => {
                reject(`FFmpeg process creation failed: ${error.message}`);
            });
            ffmpeg.on("close", () => {
                resolve(resizeBuffer);
            });
            ffmpeg.stdin.end(snapshot);
        });
    }

    async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
        const resolution = this.determineResolution(request, true);
        try {
            const cachedSnapshot = !!this.snapshotPromise;

            this.log.debug(`[${this.cameraName}] Snapshot requested: ${request.width} x ${request.height}`);
            const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapshotFilter));
            this.log.debug(`[${this.cameraName}] Sending snapshot: ${resolution.width > 0 ? resolution.width : "native"} x ${resolution.height > 0 ? resolution.height : "native"} ${cachedSnapshot ? " (cached)" : ""}`);
            const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
            callback(undefined, resized);
        } catch (err) {
            this.log.error(err as string);
            callback();
        }
    }

    // Opens the real-time feed when one is configured.
    //
    // Taking too long counts as failing.
    // The timeouts underneath - sign-in, TLS, INVITE, the first packet,
    // and a retry over the lot of them - add up to minutes,
    // far past the point where HomeKit gives up on the stream,
    // so the wait is bounded here rather than left to the sum of its parts.
    //
    // The verdict leaves as a return value and is never recorded on the delegate.
    // HomeKit can stop a session while this is still running,
    // and anything written here would outlive the session that produced it:
    // the next viewer opens a camera tile with a snapshot request,
    // which would then be answered out of a call that viewer never asked for.
    private async acquireLiveView(): Promise<LiveViewOutcome> {
        if(!this.liveView?.enabled) {
            return {kind: "unsupported"};
        }
        let abandoned = false;
        let timer: NodeJS.Timeout | undefined;
        const pending = this.liveView.acquire();
        // The call carries on setting itself up either way.
        // A lease that turns up late is released rather than leaked -
        // the linger window keeps the call warm briefly in case HomeKit tries again.
        pending.then(
            (lease) => {
                if(abandoned) {
                    lease.release();
                }
            },
            () => undefined);
        try {
            const lease = await Promise.race([
                pending,
                new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => {
                        abandoned = true;
                        resolve(undefined);
                    }, LIVE_VIEW_ACQUIRE_TIMEOUT);
                }),
            ]);
            if(!lease) {
                const reason = `the door station did not answer within ${LIVE_VIEW_ACQUIRE_TIMEOUT / 1000}s`;
                this.log.warn(`[${this.cameraName}] Live view unavailable: ${reason}.`);
                return {kind: "unavailable", reason};
            }
            this.log.info(`[${this.cameraName}] Live view acquired.`);
            return {kind: "acquired", lease};
        } catch(err) {
            const reason = (err as Error)?.message || String(err);
            this.log.warn(`[${this.cameraName}] Live view unavailable: ${reason}`);
            return {kind: "unavailable", reason};
        } finally {
            if(timer) {
                clearTimeout(timer);
            }
        }
    }

    private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
        const sessionInfo = this.pendingSessions.get(request.sessionID);
        if(sessionInfo) {
            const outcome = await this.acquireLiveView();
            if(!this.pendingSessions.has(request.sessionID)) {
                // HomeKit gave up while the call was being set up.
                // Answering the request it abandoned is what closes it out.
                // Carrying on would leave an ffmpeg and an interphone call running
                // for a camera nobody is looking at,
                // and with no RTCP ever arriving
                // there is no inactivity timer to end either of them.
                if(outcome.kind === "acquired") {
                    outcome.lease.release();
                }
                callback(new Error("The video stream was stopped before it started"));
                return;
            }
            if(outcome.kind === "unavailable") {
                // A camera with a door station to call has nothing else to offer.
                // The snapshot feed would answer a request for live video
                // with whatever the last visitor left behind,
                // and would say nothing at all about the call that did not happen.
                // HomeKit's own unavailable state claims less, and is therefore true.
                this.pendingSessions.delete(request.sessionID);
                callback(new Error(`Live view unavailable: ${outcome.reason}`));
                return;
            }
            const liveLease = outcome.kind === "acquired" ? outcome.lease : undefined;
            if(liveLease) {
                // Hand the lease somewhere `stopStream()` can reach
                // until the session that owns it exists,
                // so that nothing between here and there can strand it.
                this.unownedLeases.set(request.sessionID, liveLease);
            }
            const codec = this.cameraConfig.codec || "libx264";
            const mtu = this.cameraConfig.packetSize || 1316; // request.video.mtu is not used
            let encoderOptions = this.cameraConfig.encoderOptions;
            if(!encoderOptions && codec === "libx264") {
                encoderOptions = "-preset ultrafast -tune zerolatency";
            }

            const resolution = this.determineResolution(request.video, false);
            let fps = request.video.fps;
            let videoBitrate = request.video.max_bit_rate;
            if(codec === "copy") {
                resolution.width = 0;
                resolution.height = 0;
                resolution.videoFilter = undefined;
                fps = 0;
                videoBitrate = 0;
            }

            this.log.debug(`[${this.cameraName}] Video stream requested: ${request.video.width} x ${request.video.height}, ${request.video.fps} fps, ${request.video.max_bit_rate} kbps`);
            this.log.info(`[${this.cameraName}] Starting video stream: ${resolution.width > 0 ? resolution.width : "native"} x ${resolution.height > 0 ? resolution.height : "native"}, ${fps > 0 ? fps : "native"} fps, ${videoBitrate > 0 ? videoBitrate : "???"} kbps ${this.cameraConfig.audio ? "(" + request.audio.codec + ")" : ""}`);

            const args: string[] = [];

            // Video
            if(liveLease) {
                // The SDP describes the loopback port the One Pass relay feeds,
                // and is handed over on stdin so no temporary file is needed.
                args.push("-protocol_whitelist pipe,udp,rtp");
                // The relay hands packets over in order,
                // so the reorder queue only adds latency -
                // and its overflow warnings read as packet loss that isn't real.
                args.push("-reorder_queue_size 0");
                // 64 KiB (the default) overflows on 720p bursts even over loopback.
                args.push("-buffer_size 2097152");
                args.push("-fflags +genpts+nobuffer");
                args.push("-flags low_delay");
                args.push("-f sdp");
                args.push("-i pipe:");
            } else {
                // A PNG pushed in frame by frame has nothing left to discover,
                // yet the default probe spends close to five seconds establishing that.
                // The viewer spends those seconds on whatever snapshot came before,
                // which is the wrong one exactly when this frame is the one
                // explaining why there is no video. The live view above keeps the
                // default probe, since it does have to wait for the first keyframe
                // to learn the size of what it is being given.
                args.push("-analyzeduration 0");
                args.push("-probesize 32");
                args.push("-i pipe:");
            }
            args.push(this.cameraConfig.mapVideo ? `-map ${this.cameraConfig.mapVideo}` : "-an -sn -dn");
            args.push(`-codec:v ${codec}`);
            args.push("-pix_fmt yuv420p");
            args.push("-color_range mpeg");
            if(fps > 0) {
                args.push(`-r ${fps}`);
            }
            if(!liveLease) {
                args.push("-f rawvideo");
            }
            if(encoderOptions) {
                args.push(encoderOptions);
            }
            if(resolution.videoFilter) {
                args.push(`-filter:v ${resolution.videoFilter}`);
            }
            if(videoBitrate > 0) {
                args.push(`-b:v ${videoBitrate}k`);
            }
            args.push(`-payload_type ${request.video.pt}`);

            // Video Stream
            args.push(`-ssrc ${sessionInfo.videoSSRC}`);
            args.push("-f rtp");
            args.push("-srtp_out_suite AES_CM_128_HMAC_SHA1_80");
            args.push(`-srtp_out_params ${sessionInfo.videoSRTP.toString("base64")}`);
            args.push(`srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`);

            if(this.cameraConfig.audio) {
                if(request.audio.codec === AudioStreamingCodecType.OPUS || request.audio.codec === AudioStreamingCodecType.AAC_ELD) {
                    // Audio
                    args.push(this.cameraConfig.mapAudio ? `-map ${this.cameraConfig.mapAudio}` : "-vn -sn -dn");
                    if(request.audio.codec === AudioStreamingCodecType.OPUS) {
                        args.push("-codec:a libopus");
                        args.push("-application lowdelay");
                    } else {
                        args.push("-codec:a libfdk_aac");
                        args.push("-profile:a aac_eld");
                    }
                    args.push("-flags +global_header");
                    args.push("-f null");
                    args.push(`-ar ${request.audio.sample_rate}k`);
                    args.push(`-b:a ${request.audio.max_bit_rate}k`);
                    args.push(`-ac ${request.audio.channel}`);
                    args.push(`-payload_type ${request.audio.pt}`);

                    // Audio Stream
                    args.push(`-ssrc ${sessionInfo.audioSSRC}`);
                    args.push("-f rtp");
                    args.push("-srtp_out_suite AES_CM_128_HMAC_SHA1_80");
                    args.push(`-srtp_out_params ${sessionInfo.audioSRTP.toString("base64")}`);
                    args.push(`srtp://${sessionInfo.address}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&pkt_size=188`);
                } else {
                    this.log.error(`[${this.cameraName}] Unsupported audio codec requested: ${request.audio.codec}`);
                }
            }

            args.push(`-loglevel level`);
            args.push("-progress pipe:1");
            const ffmpegArgs = args.join(" ");

            const activeSession: ActiveSession = {
                bufferLock: false,
                progress: {
                    written: 0,
                    dropped: 0
                },
                enqueuedSnapshots: [],
                transition: false,
                transitionReady: false,
                liveLease: liveLease
            };
            activeSession.socket = createSocket(sessionInfo.ipv6 ? "udp6" : "udp4");
            activeSession.socket.on("error", (err: Error) => {
                this.log.error(`[${this.cameraName}] Socket error: ${err.message}`);
                this.stopStream(request.sessionID);
            });
            activeSession.socket.on("message", () => {
                if(activeSession.timeout) {
                    clearTimeout(activeSession.timeout);
                }
                activeSession.timeout = setTimeout(() => {
                    this.log.info(`[${this.cameraName}] Device appears to be inactive. Stopping stream.`);
                    this.controller.forceStopStreamingSession(request.sessionID);
                    this.stopStream(request.sessionID);
                }, request.video.rtcp_interval * 5 * 1000);
            });
            activeSession.socket.bind(sessionInfo.videoReturnPort);

            activeSession.mainProcess = new FFmpegProcess(this.cameraName, request.sessionID, this.processor, ffmpegArgs, this.log, this, callback);
            if(liveLease) {
                const sdp: string[] = [];
                sdp.push("v=0");
                sdp.push("o=- 0 0 IN IP4 127.0.0.1");
                sdp.push("s=One Pass");
                sdp.push("c=IN IP4 127.0.0.1");
                sdp.push("t=0 0");
                sdp.push(`m=video ${liveLease.media.relayPort} RTP/AVP ${liveLease.media.payloadType}`);
                sdp.push(`a=rtpmap:${liveLease.media.payloadType} H264/90000`);
                if(liveLease.media.fmtp) {
                    sdp.push(`a=fmtp:${liveLease.media.payloadType} ${liveLease.media.fmtp}`);
                }
                activeSession.mainProcess.stdin.end(sdp.join("\r\n") + "\r\n");
                // Join the relay once ffmpeg is actually up,
                // rather than a fixed moment after it was asked to start,
                // so the retained keyframe is not replayed
                // at a port nothing is listening on yet.
                activeSession.mainProcess.onStarted(() => liveLease.activate());
                setTimeout(() => liveLease.activate(), LIVE_VIEW_ACTIVATE_DEADLINE);
            }
            if(this.cameraConfig.returnAudioTarget) {
                const returnArgs: string[] = [];
                returnArgs.push("-hide_banner");
                returnArgs.push("-protocol_whitelist pipe,udp,rtp,file,crypto");
                returnArgs.push("-f sdp");
                returnArgs.push("-c:a libfdk_aac");
                returnArgs.push("-i pipe:");
                returnArgs.push(this.cameraConfig.returnAudioTarget);
                returnArgs.push("-loglevel level");
                const ffmpegReturnArgs = returnArgs.join(" ");
                const ipVer = sessionInfo.ipv6 ? "IP6" : "IP4";

                const sdpReturnAudio: string[] = [];
                sdpReturnAudio.push("v=0");
                sdpReturnAudio.push(`o=- 0 0 IN ${ipVer} ${sessionInfo.address}`);
                sdpReturnAudio.push("s=Talk");
                sdpReturnAudio.push(`c=IN ${ipVer} ${sessionInfo.address}`);
                sdpReturnAudio.push("t=0 0");
                sdpReturnAudio.push(`m=audio ${sessionInfo.audioReturnPort} RTP/AVP 110`);
                sdpReturnAudio.push("b=AS:24");
                sdpReturnAudio.push("a=rtpmap:110 MPEG4-GENERIC/16000/1");
                sdpReturnAudio.push("a=rtcp-mux");
                sdpReturnAudio.push("a=fmtp:100 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3,indexdeltalength=3; config=F8F0212C00BC00");
                sdpReturnAudio.push(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${sessionInfo.audioSRTP.toString("base64")}`);
                activeSession.returnProcess = new FFmpegProcess(`${this.cameraName}] [Two-way`, request.sessionID, this.processor, ffmpegReturnArgs, this.log, this);
                activeSession.returnProcess.stdin.end(sdpReturnAudio.join("\r\n") + "\r\n");
            }
            // The snapshot slideshow only applies to the fallback path -
            // a live feed arrives over RTP,
            // and ffmpeg's stdin is already closed by the SDP above.
            if(liveLease) {
                this.ongoingSessions.set(request.sessionID, activeSession);
                this.unownedLeases.delete(request.sessionID);
                this.pendingSessions.delete(request.sessionID);
                return;
            }
            activeSession.progressInterval = setInterval(() => {
                this.log.debug("Stream feeding progress: frame buffer written %d, dropped: %d", activeSession.progress.written, activeSession.progress.dropped);
                activeSession.progress.written = 0;
                activeSession.progress.dropped = 0;
            }, 1000); // 1 seconds
            activeSession.feedInterval = setInterval(async () => {
                if(activeSession.bufferLock) {
                    activeSession.progress.dropped += 1;
                    return;
                }
                activeSession.bufferLock = true;

                let buffer = this.context.cameraInfo?.snapshot || await this.createAlternativeSnapshot();
                if(!activeSession.cachedSnapshot) {
                    activeSession.cachedSnapshot = buffer; // initialize state
                } else if(!activeSession.cachedSnapshot.equals(buffer) && !activeSession.transition && activeSession.enqueuedSnapshots.length === 0) {
                    // buffer has just been changed
                    this.enqueueTransitionSnapshots(activeSession, resolution, activeSession.cachedSnapshot, buffer);
                    activeSession.transition = true;
                }

                const duration = CAMERA_TRANSITION_DURATION * 30;
                if(activeSession.transition && !activeSession.transitionReady && activeSession.enqueuedSnapshots.length < duration) {
                    buffer = activeSession.cachedSnapshot; // new buffer won't be allowed to be used until the transition completed.
                } else if(activeSession.transitionReady) {
                    // consume the transition buffers
                    buffer = activeSession.enqueuedSnapshots.splice(0, 1)[0];
                    if(activeSession.enqueuedSnapshots.length === 0) {
                        // all transition buffers have been consumed
                        this.log.debug(`[${this.cameraName}] All transition snapshots have been consumed`);
                        activeSession.transition = false;
                        activeSession.transitionReady = false;
                        activeSession.cachedSnapshot = undefined;
                    }
                }

                activeSession.mainProcess?.stdin.write(Buffer.from(buffer));
                activeSession.progress.written += 1;

                activeSession.bufferLock = false;
            }, 1000 / 30); // 30 fps

            this.ongoingSessions.set(request.sessionID, activeSession);
            this.unownedLeases.delete(request.sessionID);
            this.pendingSessions.delete(request.sessionID);
        } else {
            this.log.error(`[${this.cameraName}] Error finding session information`);
            callback(new Error("Error finding session information"));
        }
    }

    public stopStream(sessionId: string): void {
        // A session HomeKit stops while it is still being set up
        // never reaches `ongoingSessions`,
        // so dropping it here is the only signal `startStream()` gets
        // that the viewer went away while it was waiting on the live view.
        this.pendingSessions.delete(sessionId);
        const unowned = this.unownedLeases.get(sessionId);
        if(unowned) {
            this.unownedLeases.delete(sessionId);
            try {
                unowned.release();
            } catch(err) {
                this.log.error(`[${this.cameraName}] Error occurred releasing the live view: ${err}`);
            }
        }
        const session = this.ongoingSessions.get(sessionId);
        if(session) {
            if(session.timeout) {
                clearTimeout(session.timeout);
            }
            if(session.feedInterval) {
                clearInterval(session.feedInterval);
            }
            if(session.progressInterval) {
                clearInterval(session.progressInterval);
            }
            try {
                session.liveLease?.release();
            } catch(err) {
                this.log.error(`[${this.cameraName}] Error occurred releasing the live view: ${err}`);
            }
            try {
                session.socket?.close();
            } catch(err) {
                this.log.error(`[${this.cameraName}] Error occurred closing socket: ${err}`);
            }
            try {
                session.mainProcess?.stop();
            } catch(err) {
                this.log.error(`[${this.cameraName}] Error occurred terminating main FFmpeg process: ${err}`);
            }
            try {
                session.returnProcess?.stop();
            } catch(err) {
                this.log.error(`[${this.cameraName}] Error occurred terminating two-way FFmpeg process: ${err}`);
            }
        }
        this.ongoingSessions.delete(sessionId);
        this.log.info(`[${this.cameraName}] Stopped video stream`);
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        switch (request.type) {
            case StreamRequestTypes.START:
                this.startStream(request, callback).catch((err) => {
                    this.log.error(`[${this.cameraName}] Could not start the video stream: ${err}`);
                    // Whatever got as far as being created has to be given back,
                    // including a live view lease that no session ever took ownership of.
                    this.stopStream(request.sessionID);
                    callback(err instanceof Error ? err : new Error(String(err)));
                });
                break;
            case StreamRequestTypes.STOP:
                this.stopStream(request.sessionID);
                callback();
                break;
            case StreamRequestTypes.RECONFIGURE:
                this.log.debug(`[${this.cameraName}] Received request to reconfigure: ${request.video.width} x ${request.video.height}, ${request.video.fps} fps, ${request.video.max_bit_rate} kbps (Ignored)`);
                callback();
                break;
        }
    }

    async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
        const ipv6 = request.addressVersion === "ipv6";
        const options: pickPortOptions = {
            type: "udp",
            ip: ipv6 ? "::" : "0.0.0.0",
            reserveTimeout: 15
        };
        const videoReturnPort = await pickPort(options);
        const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
        const audioReturnPort = await pickPort(options);
        const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

        const sessionInfo: SessionInfo = {
            address: request.targetAddress,
            ipv6: ipv6,

            videoPort: request.video.port,
            videoReturnPort: videoReturnPort,
            videoCryptoSuite: request.video.srtpCryptoSuite,
            videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            videoSSRC: videoSSRC,

            audioPort: request.audio.port,
            audioReturnPort: audioReturnPort,
            audioCryptoSuite: request.audio.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: audioSSRC
        };

        const response: PrepareStreamResponse = {
            video: {
                port: videoReturnPort,
                ssrc: videoSSRC,

                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            },
            audio: {
                port: audioReturnPort,
                ssrc: audioSSRC,

                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            }
        };
        this.pendingSessions.set(request.sessionID, sessionInfo);
        callback(undefined, response);
    }

}

interface FFmpegProgress {
    frame: number;
    fps: number;
    streamQ: number;
    bitrate: number;
    totalSize: number;
    outTimeMicroseconds: number;
    outTime: string;
    duplicateFrames: number;
    dropFrames: number;
    speed: number;
    progress: string;
}

export class FFmpegProcess {
    private readonly process: ChildProcessWithoutNullStreams;
    private killTimeout?: NodeJS.Timeout;
    private logged = false;
    private startListener?: () => void;
    readonly stdin: Writable;

    constructor(cameraName: string, sessionId: string, processor: string, ffmpegArgs: string, log: Logging, delegate: VisitorOnCameraStreamingDelegate, callback?: StreamRequestCallback) {
        log.debug(`Stream command: ${processor} ${ffmpegArgs}`);

        let started = false;
        const startTime = Date.now();
        this.process = spawn(processor, ffmpegArgs.split(/\s+/), {
            env: process.env
        });
        this.stdin = this.process.stdin;

        this.process.stdout.on("data", (data) => {
            const progress = this.parseProgress(data);
            if(progress) {
                if(!started && progress.frame > 0) {
                    started = true;
                    const runtime = (Date.now() - startTime) / 1000;
                    const message = `[${cameraName}] Getting the first frames took ${runtime} seconds.`;
                    if(runtime < 5) {
                        log.debug(message);
                    } else if(runtime < 22) {
                        log.warn(message);
                    } else {
                        log.error(message);
                    }
                }
            }
        });
        const stderr = readline.createInterface({
            input: this.process.stderr,
            terminal: false
        });
        stderr.on("line", (line: string) => {
            if(!this.logged) {
                this.logged = true;
                this.startListener?.();
                this.startListener = undefined;
            }
            if(callback) {
                callback();
                callback = undefined;
            }
            if(line.match(/(panic|fatal|error)/)) {
                log.error(`[${cameraName}] ${line}`);
            } else {
                log.debug(`[${cameraName}] ${line}`);
            }
        });
        this.process.on("error", (error: Error) => {
            log.error(`[${cameraName}] FFmpeg process creation failed: ${error.message}`);
            if(callback) {
                callback(new Error("FFmpeg process creation failed"));
            }
            delegate.stopStream(sessionId);
        });
        this.process.on("exit", (code: number, signal: NodeJS.Signals) => {
            if(this.killTimeout) {
                clearTimeout(this.killTimeout);
            }
            const message = `FFmpeg exited with code: ${code} and signal: ${signal}`;
            if(this.killTimeout && code === 0) {
                log.debug(`[${cameraName}] ${message} (Expected)`);
            } else if(code === null || code === 255) {
                if(this.process.killed) {
                    log.debug(`[${cameraName}] ${message} (Forced)`);
                } else {
                    log.error(`[${cameraName}] ${message} (Unexpected)`);
                }
            } else {
                log.error(`[${cameraName}] ${message} (Error)`);
                delegate.stopStream(sessionId);
                if(!started && callback) {
                    callback(new Error(message));
                } else {
                    delegate.controller.forceStopStreamingSession(sessionId);
                }
            }
        });
    }

    // Fires on the first line ffmpeg logs.
    // That is the closest this side gets to observing the input being opened:
    // it lands a few milliseconds before the RTP port is bound,
    // and well after the process start-up that actually varies with load.
    onStarted(listener: () => void): void {
        if(this.logged) {
            listener();
            return;
        }
        this.startListener = listener;
    }

    parseProgress(data: Uint8Array): FFmpegProgress | undefined {
        const input = data.toString();
        if(input.indexOf("frame=") === 0) {
            try {
                const progress = new Map<string, string>();
                input.split(/\r?\n/).forEach((line) => {
                    const split = line.split("=", 2);
                    progress.set(split[0], split[1]);
                });

                return {
                    frame: parseInt(progress.get("frame")!),
                    fps: parseFloat(progress.get("fps")!),
                    streamQ: parseFloat(progress.get("stream_0_0q")!),
                    bitrate: parseFloat(progress.get("bitrate")!),
                    totalSize: parseInt(progress.get("total_size")!),
                    outTimeMicroseconds: parseInt(progress.get("out_time_us")!),
                    outTime: progress.get("out_time")!.trim(),
                    duplicateFrames: parseInt(progress.get("dup_frames")!),
                    dropFrames: parseInt(progress.get("drop_frames")!),
                    speed: parseFloat(progress.get("speed")!),
                    progress: progress.get("progress")!.trim()
                };
            } catch {
                return undefined;
            }
        } else {
            return undefined;
        }
    }

    public stop(): void {
        this.process.stdin.end();
        this.killTimeout = setTimeout(() => {
            this.process.stdin.destroy();
            this.process.kill();
        }, 2 * 1000);
    }
}
