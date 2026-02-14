import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory,
    Service,
} from "homebridge";
import {DaelimConfig} from "../../../core/interfaces/daelim-config";
import {EventPushTypes, InfoSubTypes, PushTypes, Types} from "../../../core/daelim/fields";
import ffmpegPath from "ffmpeg-for-homebridge";
import VisitorOnCameraStreamingDelegate, {CAMERA_TIMEOUT_DURATION, reformatSnapshot} from "../../../core/camera-utils";
import {defaultCameraConfig} from "../../../core/interfaces/config";
import {CameraAccessoryInterfaceBase, CameraInfo} from "../../../core/interfaces/camera";

enum CameraLocation {
    FRONT_DOOR = "door_record_duringlist",
    COMMUNAL_ENTRANCE = "lobby_record_duringlist"
}

interface VisitorOnCameraInfo extends CameraInfo {
    readonly index: number
    readonly cameraLocation: CameraLocation
    readonly date: string
    readonly mediaType: string
    readonly isNew: boolean
}

interface CameraAccessoryInterface extends AccessoryInterface, CameraAccessoryInterfaceBase {
    cameraLocation: CameraLocation
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

export class CameraAccessories extends Accessories<CameraAccessoryInterface> {

    private readonly processor: string;

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["camera"], [
            api.hap.Service.MotionSensor,
            api.hap.Service.CameraOperatingMode,
            api.hap.Service.CameraRecordingManagement
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
                callback(undefined, this.getAccessoryInterface(accessory).motionDetected);
            });

        // CameraRecordingManagement
        const recordingService = this.ensureServiceAvailability(this.api.hap.Service.CameraRecordingManagement, services);
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
            service.setCharacteristic(this.api.hap.Characteristic.MotionDetected, this.getAccessoryInterface(accessory).motionDetected);
        });
    }

    createMotionTimer(accessory: PlatformAccessory) {
        const device = this.findDeviceInfoFromAccessory(accessory);
        return setTimeout(() => {
            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer) {
                clearTimeout(context.motionTimer);
            }
            context.cameraInfo = undefined;
            context.motionTimer = undefined;
            context.motionDetected = false;

            this.refreshSensors(accessory);
        }, (device?.duration?.camera || CAMERA_TIMEOUT_DURATION) * 1000);
    }

    registerAccessories() {
        for(const cameraDevice of CAMERA_DEVICES) {
            const accessory = this.addAccessory({
                deviceID: cameraDevice.deviceID,
                displayName: cameraDevice.displayName,
                cameraDisplayName: cameraDevice.displayName,
                init: false,
                cameraLocation: cameraDevice.cameraLocation,
                motionTimer: undefined,
                motionDetected: false,
                cameraInfo: undefined,
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
            if(!visitorInfo.isNew) {
                this.log.warn("The fetched visitors info is not newly added (old)");
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
                visitorInfo.snapshot = await reformatSnapshot(this.processor, this.log, context.displayName, buffer);

                context.cameraInfo = visitorInfo;
                context.motionTimer = this.createMotionTimer(accessory);
                context.motionDetected = true;
                context.init = true;

                this.refreshSensors(accessory);
            }
        });
    }
}
