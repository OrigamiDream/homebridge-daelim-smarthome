import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {Device, DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface ElevatorAccessoryInterface extends AccessoryInterface {
    switchTimer?: Timeout
    switchLocked: boolean

    motionTimer?: Timeout
    motionDetected: boolean
}

export const EXTERIOR_ELEVATOR_DEVICE: Device = {
    displayName: "외부 엘리베이터",
    name: "엘리베이터",
    deviceType: DeviceType.ELEVATOR,
    deviceId: "CMF990100",
    disabled: false,
};
const ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS = 5; // 5 seconds

export default class ElevatorAccessories extends Accessories<ElevatorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.ELEVATOR, [api.hap.Service.Switch, api.hap.Service.MotionSensor]);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.Switch)
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const called = value as boolean;
                if(!called) {
                    setTimeout(() => {
                        this.getService(accessory, this.api.hap.Service.Switch)
                            .setCharacteristic(this.api.hap.Characteristic.On, context.switchLocked);
                    }, 0);
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                if(called) {
                    const success = await this.client.sendElevatorCallQuery();
                    if(!success) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                    if(context.switchTimer) clearTimeout(context.switchTimer);

                    context.switchTimer = setTimeout(() => {
                        if(context.switchTimer) clearTimeout(context.switchTimer);

                        context.switchTimer = undefined;
                        context.switchLocked = false;
                        this.getService(accessory, this.api.hap.Service.Switch)
                            .setCharacteristic(this.api.hap.Characteristic.On, false);
                    }, (device.duration?.elevator || 30) * 1000); // 30s as default.
                }
                context.switchLocked = called;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.switchLocked);
            });

        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });
    }

    register() {
        super.register();

        this.addListener((data) => {
            if(!data) return;
            if(!["unprogressing", "down", "up"].includes(data["rerection"])) return;

            const device = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
            if(!device) return;

            const accessory = this.findAccessory(device.deviceId);
            if(!accessory) return;

            const context = this.getAccessoryInterface(accessory);
            if(context.switchTimer)
                clearTimeout(context.switchTimer);
            context.switchLocked = false;
            context.switchTimer = undefined;

            context.motionDetected = true;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer)
                    clearTimeout(context.motionTimer);
                context.motionTimer = undefined;
                context.motionDetected = false;

                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS * 1000);

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });

        setTimeout(async () => {
            if(!this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId)) {
                return;
            }
            const device = EXTERIOR_ELEVATOR_DEVICE;
            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                switchTimer: undefined,
                switchLocked: false,
                motionTimer: undefined,
                motionDetected: false,
            });
        }, 1000);
    }
}
