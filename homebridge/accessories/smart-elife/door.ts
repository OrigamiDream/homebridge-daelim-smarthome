import Accessories, {AccessoryInterface} from "./accessories";
import {API, CharacteristicEventTypes, CharacteristicGetCallback, Logging, PlatformAccessory} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface DoorAccessoryInterface extends AccessoryInterface {
    motionTimer?: Timeout
    motionDetected: boolean
}

export const EXTERIOR_FRONT_DOOR_DEVICE: Device = {
    displayName: "외부 세대현관",
    name: "세대현관",
    deviceType: DeviceType.DOOR,
    deviceId: "CMFDOR001",
    disabled: false,
};
export const EXTERIOR_COMMUNAL_DOOR_DEVICE: Device = {
    displayName: "외부 공동현관",
    name: "공동현관",
    deviceType: DeviceType.DOOR,
    deviceId: "CMFDOR002",
    disabled: false,
}
export const DOOR_TIMEOUT_DURATION_SECONDS = 5; // 5 seconds

export default class DoorAccessories extends Accessories<DoorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.DOOR, [api.hap.Service.MotionSensor]);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
        this.log.warn("Identifying `door` not supported.");
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });
    }

    registerPushListener(pushType: PushType, doorDevice: Device) {
        this.addPushListener(pushType, () => {
            const device = this.findDevice(doorDevice.deviceId);
            if(!device) {
                this.log.warn("Unknown device: %s", doorDevice.deviceId);
                return;
            }
            const accessory = this.findAccessory(device.deviceId);
            if(!accessory) {
                this.log.warn("Unknown accessory: %s", device.deviceId);
                return;
            }

            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer) {
                clearTimeout(context.motionTimer);
            }

            context.motionDetected = true;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer) {
                    clearTimeout(context.motionTimer);
                }
                context.motionTimer = undefined;
                context.motionDetected = false;

                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, (device.duration?.door || DOOR_TIMEOUT_DURATION_SECONDS) * 1000);

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });
    }

    register() {
        super.register();
        this.registerPushListener(PushType.FRONT_DOOR, EXTERIOR_FRONT_DOOR_DEVICE);
        // TODO: register for communal door after discovers communal door type.

        setTimeout(() => {
            for(const device of [EXTERIOR_FRONT_DOOR_DEVICE, EXTERIOR_COMMUNAL_DOOR_DEVICE]) {
                if(!this.findDevice(device.deviceId))
                    continue;

                this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    motionTimer: undefined,
                    motionDetected: false,
                });
            }
        }, 1000);
    }
}