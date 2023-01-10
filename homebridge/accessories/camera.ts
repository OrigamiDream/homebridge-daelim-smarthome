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
    StreamingRequest,
    StreamRequestCallback,
    VideoInfo
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {EventPushTypes, InfoSubTypes, PushTypes, Types} from "../../core/fields";
import pickPort, {pickPortOptions} from "pick-port";
import {spawn} from "child_process";
import axios from "axios";
import {Utils} from "../../core/utils";

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
export const CAMERA_TIMEOUT_DURATION = 2 * 60 * 1000; // 2 minutes
export const CAMERA_VIDEO_FILTER = "";

export class CameraAccessories extends Accessories<CameraAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, ["camera"], [api.hap.Service.MotionSensor]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        this.log.warn("Identifying Camera accessories is not possible");
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.MotionSensor, services);
        service.getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, this.getAccessoryInterface(accessory).motionOnCamera);
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
        for(const deviceInfo of CAMERA_DEVICES) {
            const accessory = this.addAccessory({
                deviceID: deviceInfo.deviceID,
                displayName: deviceInfo.displayName,
                init: false,
                cameraLocation: deviceInfo.cameraLocation,
                motionTimer: undefined,
                motionOnCamera: false,
                visitorInfo: undefined,
            });
            if(accessory) {
                const delegate = new VisitorOnCameraStreamingDelegate(this.api, this.api.hap, this.log, this.getAccessoryInterface(accessory));
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
            }, Types.INFO, InfoSubTypes.VISITOR_CHECK_REQUEST, InfoSubTypes.VISITOR_CHECK_RESPONSE, (_) => {
                return true;
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
            visitorInfo.snapshot = buffer;
            const accessory = this.findCameraAccessoryAt(visitorInfo.cameraLocation);
            if(accessory) {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer) {
                    clearTimeout(context.motionTimer);
                }
                context.visitorInfo = visitorInfo;
                context.motionTimer = this.createMotionTimer(accessory);
                context.motionOnCamera = true;
                context.init = true;

                this.refreshSensors(accessory);
            }
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

class VisitorOnCameraStreamingDelegate implements CameraStreamingDelegate {

    readonly controller: CameraController;
    private snapshotPromise?: Promise<Buffer>;
    private alternativeSnapshot?: Buffer;

    constructor(private readonly api: API,
                private readonly hap: HAP,
                private readonly log: Logging,
                private readonly context: CameraAccessoryInterface) {
        this.api.on(APIEvent.SHUTDOWN, () => {
            this.context.visitorInfo = undefined;
            if(this.context.motionTimer) {
                clearTimeout(this.context.motionTimer);
            }
            this.context.motionTimer = undefined;
        });
        const options: CameraControllerOptions = {
            cameraStreamCount: 2, // Maximum number of simultaneous stream watch
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
                    twoWayAudio: false,
                    codecs: [{
                        type: AudioStreamingCodecType.AAC_ELD,
                        samplerate: AudioStreamingSamplerate.KHZ_16
                    }]
                }
            }
        }
        this.controller = new hap.CameraController(options);
    }

    private async createAlternativeSnapshot(): Promise<Buffer> {
        if(!this.alternativeSnapshot) {
            this.log.debug("Creating alternative snapshot buffer");
            const response = await axios.get(Utils.HOMEKIT_SECURE_VIDEO_IDLE_URL, {
                responseType: "arraybuffer"
            });
            this.alternativeSnapshot = Buffer.from(response.data, "utf-8");
        } else {
            this.log.debug("Using cached alternative snapshot buffer");
        }
        return this.alternativeSnapshot;
    }

    private determineResolution(request: SnapshotRequest | VideoInfo): ResolutionInfo {
        const resInfo: ResolutionInfo = {
            width: request.width,
            height: request.height
        };

        const filters: Array<string> = CAMERA_VIDEO_FILTER.split(",") || [];
        const noneFilter = filters.indexOf("none");
        if(noneFilter >= 0) {
            filters.splice(noneFilter, 1);
        }
        resInfo.snapshotFilter = filters.join(",");
        if(noneFilter < 0 && (resInfo.width > 0 || resInfo.height > 0)) {
            resInfo.resizeFilter = "scale=" + (resInfo.width > 0 ? "'min(" + resInfo.width + ",iw)'" : "iw") + ":" + (resInfo.height > 0 ? "'min(" + resInfo.height + ",ih)'" : "ih") + ":force_original_aspect_ratio=decrease";
            filters.push(resInfo.resizeFilter);
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
            this.log.debug(`Snapshot command: ffmpeg ${ffmpegArgs}`);
            const ffmpeg = spawn("ffmpeg", ffmpegArgs.split(/\s+/), {
                env: process.env
            });

            let snapshotBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on("data", (data) => {
                snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
            });
            ffmpeg.on("error", (error: Error) => {
                reject("FFmpeg process creation failed: " + error.message);
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
                    reject("Failed to fetch snapshot.");
                }

                setTimeout(() => {
                    this.snapshotPromise = undefined;
                }, 3 * 1000); // Expire cached snapshot after 3 seconds

                const runtime = (Date.now() - startTime) / 1000;
                let message = "Fetching snapshot took " + runtime + " seconds.";
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
            this.log.debug(`Resize command: ffmpeg ${ffmpegArgs}`);
            const ffmpeg = spawn("ffmpeg", ffmpegArgs.split(/\s+/), {
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
        const resolution = this.determineResolution(request);
        try {
            const cachedSnapshot = !!this.snapshotPromise;

            this.log.debug(`Snapshot requested: ${request.width} x ${request.height}`);
            const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapshotFilter));
            this.log.debug(`Sending snapshot: ${resolution.width > 0 ? resolution.width : "native"} x ${resolution.height > 0 ? resolution.height : "native"} ${cachedSnapshot ? " (cached)" : ""}`);
            const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
            callback(undefined, resized);
        } catch (err) {
            this.log.error(err as string);
            callback();
        }
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        this.log.info("handleStreamRequest");
        callback();
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
        this.log.info("prepareStream (video %d -> ret:%d, audio %d -> ret:%d)", sessionInfo.videoPort, sessionInfo.videoReturnPort, sessionInfo.audioPort, sessionInfo.audioReturnPort);
        callback(undefined, response);
    }

}