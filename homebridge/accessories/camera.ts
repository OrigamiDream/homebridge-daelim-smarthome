import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    APIEvent,
    AudioStreamingCodecType,
    AudioStreamingSamplerate,
    CameraController,
    CameraControllerOptions,
    CameraStreamingDelegate,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    HAP,
    Logging,
    PlatformAccessory,
    PrepareStreamCallback,
    PrepareStreamRequest,
    PrepareStreamResponse,
    Service,
    SnapshotRequest,
    SnapshotRequestCallback,
    SRTPCryptoSuites,
    StartStreamRequest,
    StreamingRequest,
    StreamRequestCallback,
    StreamRequestTypes,
    VideoInfo
} from "homebridge";
import {CameraConfig, DaelimConfig, defaultCameraConfig} from "../../core/interfaces/daelim-config";
import {EventPushTypes, InfoSubTypes, PushTypes, Types} from "../../core/fields";
import ffmpegPath from "ffmpeg-for-homebridge";
import pickPort, {pickPortOptions} from "pick-port";
import {ChildProcessWithoutNullStreams, spawn} from "child_process";
import axios from "axios";
import {Utils} from "../../core/utils";
import {Writable} from "stream";
import readline from "readline";
import {createSocket, Socket} from "dgram";
import {setInterval} from "timers";

enum CameraLocation {
    FRONT_DOOR = "door_record_duringlist",
    COMMUNAL_ENTRANCE = "lobby_record_duringlist"
}

interface VisitorOnCameraInfo {
    readonly index: number
    readonly cameraLocation: CameraLocation
    readonly date: string
    readonly mediaType: string
    readonly isNew: boolean
    snapshot?: Buffer
}

interface CameraAccessoryInterface extends AccessoryInterface {
    cameraLocation: CameraLocation
    motionTimer?: NodeJS.Timeout
    motionOnCamera: boolean
    visitorInfo?: VisitorOnCameraInfo
    recordingActive: boolean
    eventSnapshotsActive: boolean
    cameraActive: boolean
    periodicSnapshotsActive: boolean
}

interface CameraDevice {
    readonly cameraLocation: CameraLocation
    readonly deviceID: string
    readonly displayName: string
}

export const CAMERA_DEVICES: CameraDevice[] = [{
    cameraLocation: CameraLocation.FRONT_DOOR,
    deviceID: "FD-CAM0",
    displayName: "세대현관"
}, {
    cameraLocation: CameraLocation.COMMUNAL_ENTRANCE,
    deviceID: "CE-CAM0",
    displayName: "공동현관"
}];
export const CAMERA_TIMEOUT_DURATION = 3 * 60 * 1000; // 2 minutes

export class CameraAccessories extends Accessories<CameraAccessoryInterface> {

    private readonly processor: string;

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["camera"], [
            api.hap.Service.MotionSensor,
            api.hap.Service.CameraOperatingMode,
            api.hap.Service.CameraEventRecordingManagement
        ]);
        this.processor = ffmpegPath || "ffmpeg";
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        this.log.warn("Identifying Camera accessories is not possible");
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);

        // MotionSensor
        const motionService = this.ensureServiceAvailability(this.api.hap.Service.MotionSensor, services);
        motionService.getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getAccessoryInterface(accessory).motionOnCamera);
            });

        // CameraEventRecordingManagement
        const recordingService = this.ensureServiceAvailability(this.api.hap.Service.CameraEventRecordingManagement, services);
        recordingService.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.recordingActive ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.recordingActive = value === this.api.hap.Characteristic.Active.ACTIVE;
                callback(undefined);
            });
        recordingService.getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive)
            .setProps({
                validValues: [this.api.hap.Characteristic.RecordingAudioActive.DISABLE]
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.RecordingAudioActive.DISABLE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                callback(new Error("Setting RecordingAudioActive characteristic is not possible."));
            });

        // CameraOperatingMode
        const operatingServie = this.ensureServiceAvailability(this.api.hap.Service.CameraOperatingMode, services);
        operatingServie.getCharacteristic(this.api.hap.Characteristic.EventSnapshotsActive)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.eventSnapshotsActive ? this.api.hap.Characteristic.EventSnapshotsActive.ENABLE : this.api.hap.Characteristic.EventSnapshotsActive.DISABLE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.eventSnapshotsActive = value === this.api.hap.Characteristic.EventSnapshotsActive.ENABLE;
                callback(undefined);
            });
        operatingServie.getCharacteristic(this.api.hap.Characteristic.HomeKitCameraActive)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.cameraActive ? this.api.hap.Characteristic.HomeKitCameraActive.ON : this.api.hap.Characteristic.HomeKitCameraActive.OFF);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.cameraActive = value === this.api.hap.Characteristic.HomeKitCameraActive.ON;
                callback(undefined);
            });
        operatingServie.getCharacteristic(this.api.hap.Characteristic.PeriodicSnapshotsActive)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.periodicSnapshotsActive ? this.api.hap.Characteristic.PeriodicSnapshotsActive.ENABLE : this.api.hap.Characteristic.PeriodicSnapshotsActive.DISABLE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.periodicSnapshotsActive = value === this.api.hap.Characteristic.PeriodicSnapshotsActive.ENABLE;
                callback(undefined);
            });
    }

    findCameraAccessoryAt(cameraLocation: CameraLocation): PlatformAccessory | undefined {
        const devices = CAMERA_DEVICES.filter((device) => device.cameraLocation === cameraLocation);
        if(!devices || !devices.length) {
            return undefined;
        }
        const device = devices[0];
        return this.findAccessoryWithDeviceID(device.deviceID);
    }

    refreshSensors(accessory: PlatformAccessory) {
        this.findService(accessory, this.api.hap.Service.MotionSensor, (service) => {
            service.setCharacteristic(this.api.hap.Characteristic.MotionDetected, this.getAccessoryInterface(accessory).motionOnCamera);
        });
    }

    createMotionTimer(accessory: PlatformAccessory) {
        this.log.debug("Creating a new motion detector timer");
        return setTimeout(() => {
            this.log.debug("Invalidating the motion detector timer");
            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer) {
                clearTimeout(context.motionTimer);
            }
            context.visitorInfo = undefined;
            context.motionTimer = undefined;
            context.motionOnCamera = false;

            this.refreshSensors(accessory);
        }, CAMERA_TIMEOUT_DURATION);
    }

    registerAccessories() {
        for(const cameraDevice of CAMERA_DEVICES) {
            const accessory = this.addAccessory({
                deviceID: cameraDevice.deviceID,
                displayName: cameraDevice.displayName,
                init: false,
                cameraLocation: cameraDevice.cameraLocation,
                motionTimer: undefined,
                motionOnCamera: false,
                visitorInfo: undefined,
                recordingActive: true,
                eventSnapshotsActive: true,
                cameraActive: true,
                periodicSnapshotsActive: true
            });
            if(accessory) {
                const deviceInfo = this.findDeviceInfo(accessory.context.deviceID, accessory.context.displayName);
                const config = deviceInfo?.camera || defaultCameraConfig();
                const delegate = new VisitorOnCameraStreamingDelegate(this.api, this.api.hap, this.log, this.getAccessoryInterface(accessory), config, this.processor);
                accessory.configureController(delegate.controller);
            }
        }
    }

    registerListeners() {
        this.client?.registerPushEventListener(PushTypes.EVENTS, EventPushTypes.VISITOR_PICTURE_STORED, async (_) => {
            const visitorInfo = await this.client?.sendDeferredRequest({
                page: 0,
                listcount: 1
            }, Types.INFO, InfoSubTypes.VISITOR_LIST_REQUEST, InfoSubTypes.VISITOR_LIST_RESPONSE, (_) => {
                return true;
            }).then((histories) => {
                return histories["list"][0]; // the first history
            }).then((history: any): VisitorOnCameraInfo => {
                return {
                    index: parseInt(history["index"]),
                    cameraLocation: history["location"] as CameraLocation,
                    date: history["InputDate"],
                    mediaType: history["filetype"],
                    isNew: history["new"] === "true",
                    snapshot: undefined
                };
            }).catch(() => {
                return undefined;
            });
            if(!visitorInfo) {
                this.log.warn("Failed to get recent visitors info");
                return;
            }
            const buffer = await this.client?.sendDeferredRequest({
                index: visitorInfo.index,
                read: "Y"
            }, Types.INFO, InfoSubTypes.VISITOR_CHECK_REQUEST, InfoSubTypes.VISITOR_CHECK_RESPONSE, (response) => {
                return parseInt(response["index"]) === visitorInfo.index;
            }).then((response) => {
                const hex: string = response["image"];
                const cleanHex = hex.replace(/[\r\n]/, "")
                    .replace(/([\da-fA-F]{2}) ?/g, "0x$1 ")
                    .replace(/ +$/, "")
                    .split(" ");
                const hexArray = cleanHex.map((digit) => parseInt(digit, 16));
                return Buffer.from(String.fromCharCode(...hexArray), "binary");
            }).catch(() => {
                return undefined;
            });
            if(!buffer) {
                this.log.warn("Failed to fetch the picture of visitor");
                return;
            }
            const accessory = this.findCameraAccessoryAt(visitorInfo.cameraLocation);
            if(accessory) {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer) {
                    clearTimeout(context.motionTimer);
                }
                visitorInfo.snapshot = await this.reformatSnapshot(context.displayName, buffer);

                context.visitorInfo = visitorInfo;
                context.motionTimer = this.createMotionTimer(accessory);
                context.motionOnCamera = true;
                context.init = true;

                this.refreshSensors(accessory);
            }
        });
    }

    reformatSnapshot(cameraName: string, snapshot: Buffer): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const args: string[] = [];
            args.push("-i pipe:");
            args.push("-frames:v 1");
            args.push("-codec:v png"); // the alternative snapshot has PNG/rgba
            args.push("-pix_fmt rgba");
            args.push("-f image2 -");

            const ffmpegArgs = args.join(" ");
            this.log.debug(`[${cameraName}] Snapshot resize command: ${this.processor} ${ffmpegArgs}`);
            const ffmpeg = spawn(this.processor, ffmpegArgs.split(/\s+/), {
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
    socket?: Socket;
}

class VisitorOnCameraStreamingDelegate implements CameraStreamingDelegate {

    private readonly cameraName: string;
    readonly controller: CameraController;

    private snapshotPromise?: Promise<Buffer>;
    private alternativeSnapshot?: Buffer;
    private pendingSessions: Map<string, SessionInfo> = new Map();
    private ongoingSessions: Map<string, ActiveSession> = new Map();

    constructor(private readonly api: API,
                private readonly hap: HAP,
                private readonly log: Logging,
                private readonly context: CameraAccessoryInterface,
                private readonly cameraConfig: CameraConfig,
                private readonly processor: string) {
        this.cameraName = this.context.displayName;
        this.api.on(APIEvent.SHUTDOWN, () => {
            for(const session in this.ongoingSessions) {
                this.stopStream(session);
            }
            this.context.visitorInfo = undefined;
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
        if(!this.alternativeSnapshot) {
            this.log.debug(`[${this.cameraName}] Creating alternative snapshot buffer`);
            const response = await axios.get(Utils.HOMEKIT_SECURE_VIDEO_IDLE_URL, {
                responseType: "arraybuffer"
            });
            this.alternativeSnapshot = Buffer.from(response.data, "utf-8");
        }
        return this.alternativeSnapshot;
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
            resInfo.resizeFilter = "scale=" + (resInfo.width > 0 ? "'max(" + resInfo.width + ",iw)'" : "iw") + ":" + (resInfo.height > 0 ? "'max(" + resInfo.height + ",ih)'" : "ih") + ":force_original_aspect_ratio=decrease";
            filters.push(resInfo.resizeFilter);
            filters.push(`pad=${resInfo.width > 0 ? resInfo.width : "iw"}:${resInfo.height > 0 ? resInfo.height : "ih"}:x=(${resInfo.width > 0 ? resInfo.width : "iw"}-iw)/2:y=(${resInfo.height > 0 ? resInfo.height : "ih"}-ih)/2:color=black`);
            filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2"); // Force to fit encoder restrictions
        }

        if(filters.length > 0) {
            resInfo.videoFilter = filters.join(",");
        }
        return resInfo;
    }

    private fetchSnapshot(snapshotFilter?: string): Promise<Buffer> {
        this.snapshotPromise = new Promise(async (resolve, reject) => {
            const snapshot = this.context.visitorInfo?.snapshot || await this.createAlternativeSnapshot();

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

    private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
        const sessionInfo = this.pendingSessions.get(request.sessionID);
        if(sessionInfo) {
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
            args.push("-i pipe:");
            args.push(this.cameraConfig.mapVideo ? `-map ${this.cameraConfig.mapVideo}` : "-an -sn -dn");
            args.push(`-codec:v ${codec}`);
            args.push("-pix_fmt yuv420p");
            args.push("-color_range mpeg");
            if(fps > 0) {
                args.push(`-r ${fps}`);
            }
            args.push("-f rawvideo");
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

            const activeSession: ActiveSession = {};
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
            activeSession.feedInterval = setInterval(async () => {
                const buffer = this.context.visitorInfo?.snapshot || await this.createAlternativeSnapshot();
                activeSession.mainProcess?.stdin.write(buffer);
            }, 1000 / 30); // 30 fps

            this.ongoingSessions.set(request.sessionID, activeSession);
            this.pendingSessions.delete(request.sessionID);
        } else {
            this.log.error(`[${this.cameraName}] Error finding session information`);
            callback(new Error("Error finding session information"));
        }
    }

    public stopStream(sessionId: string): void {
        const session = this.ongoingSessions.get(sessionId);
        if(session) {
            if(session.timeout) {
                clearTimeout(session.timeout);
            }
            if(session.feedInterval) {
                clearInterval(session.feedInterval);
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
                this.startStream(request, callback);
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