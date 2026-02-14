import Accessories, {AccessoryInterface} from "./accessories";
import {API, CharacteristicEventTypes, CharacteristicGetCallback, Logging, PlatformAccessory} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface VehicleAccessoryInterface extends AccessoryInterface {
    motionTimer?: Timeout
    motionDetected: boolean
}

export const EXTERIOR_VEHICLE_BARRIER_DEVICE: Device = {
    displayName: "외부 주차차단기",
    name: "주차차단기",
    deviceType: DeviceType.VEHICLE,
    deviceId: "CMFCAR001",
    disabled: false,
}
export const VEHICLE_TIMEOUT_DURATION_SECONDS = 5; // 5 seconds

export default class VehicleAccessories extends Accessories<VehicleAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.VEHICLE, [api.hap.Service.MotionSensor]);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
        this.log.warn("Identifying `vehicle` not supported.");
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

    registerPushListener() {
        this.addPushListener(PushType.CAR, () => {
            const deviceDef = EXTERIOR_VEHICLE_BARRIER_DEVICE;
            const device = this.findDevice(deviceDef.deviceId);
            if(!device) {
                this.log.warn("Unknown device: %s", deviceDef.deviceId);
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
            }, (device.duration?.vehicle || VEHICLE_TIMEOUT_DURATION_SECONDS) * 1000);

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });
    }

    register() {
        super.register();
        this.registerPushListener();

        setTimeout(() => {
            const device = EXTERIOR_VEHICLE_BARRIER_DEVICE;
            if(!this.findDevice(device.deviceId))
                return;

            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                motionTimer: undefined,
                motionDetected: false,
            })
        }, 1000);
    }
}