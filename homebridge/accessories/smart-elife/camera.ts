import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {
    ControlQueryCategory,
    Device,
    DeviceType,
    PushType,
    SmartELifeConfig
} from "../../../core/interfaces/smart-elife-config";
import ffmpegPath from "ffmpeg-for-homebridge";
import {CameraAccessoryInterfaceBase, CameraInfo} from "../../../core/interfaces/camera";
import {defaultCameraConfig} from "../../../core/interfaces/config";
import VisitorOnCameraStreamingDelegate, {CAMERA_TIMEOUT_DURATION, reformatSnapshot} from "../../../core/camera-utils";

enum CameraLocation {
    FRONT_DOOR = "house",
    COMMUNAL_DOOR = "lobby",
}

interface VisitorOnCameraInfo extends CameraInfo {
    cameraLocation: CameraLocation
    date: string
}

interface CameraAccessoryInterface extends AccessoryInterface, CameraAccessoryInterfaceBase {
    cameraLocation: CameraLocation
}

interface CameraDevice extends Device {
    cameraLocation: CameraLocation
}

export const EXTERIOR_FRONT_DOOR_CAMERA_DEVICE: CameraDevice = {
    displayName: "외부 세대현관 초인종",
    name: "세대현관 초인종",
    deviceType: DeviceType.CAMERA,
    deviceId: "CMFCAM001",
    disabled: false,
    cameraLocation: CameraLocation.FRONT_DOOR,
};
export const EXTERIOR_COMMUNAL_DOOR_CAMERA_DEVICE: CameraDevice = {
    displayName: "외부 공동현관 초인종",
    name: "공동현관 초인종",
    deviceType: DeviceType.CAMERA,
    deviceId: "CMFCAM002",
    disabled: false,
    cameraLocation: CameraLocation.COMMUNAL_DOOR,
};

export default class CameraAccessories extends Accessories<CameraAccessoryInterface> {

    private readonly processorPath: string;

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.CAMERA, [
            api.hap.Service.MotionSensor,
            api.hap.Service.CameraOperatingMode,
            api.hap.Service.CameraRecordingManagement,
        ]);
        this.processorPath = ffmpegPath || "ffmpeg";
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
        this.log.warn("Identifying `camera` not supported.");
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        // MotionSensor
        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getAccessoryInterface(accessory).motionDetected);
            });

        // CameraRecordingManagement
        this.getService(accessory, this.api.hap.Service.CameraRecordingManagement)
            .getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.recordingActive ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.recordingActive = value === this.api.hap.Characteristic.Active.ACTIVE;
                callback(undefined);
            });
        this.getService(accessory, this.api.hap.Service.CameraRecordingManagement)
            .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive)
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
        this.getService(accessory, this.api.hap.Service.CameraOperatingMode)
            .getCharacteristic(this.api.hap.Characteristic.EventSnapshotsActive)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.eventSnapshotsActive ? this.api.hap.Characteristic.EventSnapshotsActive.ENABLE : this.api.hap.Characteristic.EventSnapshotsActive.DISABLE);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.eventSnapshotsActive = value === this.api.hap.Characteristic.EventSnapshotsActive.ENABLE;
                callback(undefined);
            });
        this.getService(accessory, this.api.hap.Service.CameraOperatingMode)
            .getCharacteristic(this.api.hap.Characteristic.HomeKitCameraActive)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.cameraActive ? this.api.hap.Characteristic.HomeKitCameraActive.ON : this.api.hap.Characteristic.HomeKitCameraActive.OFF);
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.cameraActive = value === this.api.hap.Characteristic.HomeKitCameraActive.ON;
                callback(undefined);
            });
        this.getService(accessory, this.api.hap.Service.CameraOperatingMode)
            .getCharacteristic(this.api.hap.Characteristic.PeriodicSnapshotsActive)
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

    async getSnapshotInfo(): Promise<VisitorOnCameraInfo | undefined> {
        const data = {
            "page": 1,
            "count": 1,
            "include_image": "N"
        };
        const response = await this.client.sendControlQuery(ControlQueryCategory.BOARD, "visitor", data, "query_request");
        if(!response["result"] || response["result"]["status"] !== "000") {
            this.log.warn("Could not fetch the list of visitors");
            return undefined;
        }
        const snapshots: VisitorOnCameraInfo[] = response["data"]["list"]
            .map((e: any): VisitorOnCameraInfo => {
                return {
                    cameraLocation: e["door_type"] as CameraLocation,
                    date: e["reg_num"],
                };
            });
        if(!snapshots || snapshots.length === 0) {
            this.log.warn("Could not fetch the list of visitors.");
            return undefined;
        }
        return snapshots[0];
    }

    async getSnapshotBuffer(snapshot: VisitorOnCameraInfo) {
        const data = {
            "reg_num": snapshot.date,
            "door_type": snapshot.cameraLocation.toString(),
        };
        const response = await this.client.sendControlQuery(ControlQueryCategory.BOARD, "visitor_detail", data, "query_request");
        if(!response["result"] || response["result"]["status"] !== "000") {
            this.log.warn("Could not fetch the buffer of snapshot.");
            return undefined;
        }
        const b64 = response["data"]["image"].replace(/[\n\r\s]/gi, "");
        return Buffer.from(b64, "base64");
    }

    register() {
        super.register();
        this.client.addPushListener(PushType.VISITOR, async () => {
            const cameraInfo = await this.getSnapshotInfo();
            if(!cameraInfo) {
                this.log.warn("Could not fetch the snapshot info.");
                return;
            }
            const buffer = await this.getSnapshotBuffer(cameraInfo!);
            if(!buffer) {
                this.log.warn("Could not fetch the buffer of snapshot.");
                return;
            }
            let cameraDevice: CameraDevice;
            switch(cameraInfo.cameraLocation) {
                case CameraLocation.FRONT_DOOR:
                    cameraDevice = EXTERIOR_FRONT_DOOR_CAMERA_DEVICE;
                    break;
                case CameraLocation.COMMUNAL_DOOR:
                    cameraDevice = EXTERIOR_COMMUNAL_DOOR_CAMERA_DEVICE;
                    break;
            }
            const device = this.findDevice(cameraDevice.deviceId);
            if(!device)
                return;
            const accessory = this.findAccessory(device.deviceId);
            if(!accessory)
                return;

            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer)
                clearTimeout(context.motionTimer);
            cameraInfo.snapshot = await reformatSnapshot(this.processorPath, this.log, context.displayName, buffer);

            context.cameraInfo = cameraInfo;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer)
                    clearTimeout(context.motionTimer);
                context.cameraInfo = undefined;
                context.motionTimer = undefined;
                context.motionDetected = false;

                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, (device.duration?.camera || CAMERA_TIMEOUT_DURATION) * 1000);
            context.motionDetected = true;

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });
        setTimeout(() => {
            for(const cameraDevice of [EXTERIOR_FRONT_DOOR_CAMERA_DEVICE, EXTERIOR_COMMUNAL_DOOR_CAMERA_DEVICE]) {
                const device = this.findDevice(cameraDevice.deviceId);
                if(!device)
                    continue;

                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    cameraActive: false,
                    cameraDisplayName: device.displayName,
                    cameraLocation: cameraDevice.cameraLocation,
                    init: true,
                    motionTimer: undefined,
                    motionDetected: false,
                    eventSnapshotsActive: false,
                    periodicSnapshotsActive: false,
                    recordingActive: false
                });
                if(!accessory)
                    continue;

                const config = device.camera || defaultCameraConfig();
                const delegate = new VisitorOnCameraStreamingDelegate(this.api, this.api.hap, this.log, this.getAccessoryInterface(accessory), config, this.processorPath);
                accessory.configureController(delegate.controller);
            }
        }, 1000);
    }
}