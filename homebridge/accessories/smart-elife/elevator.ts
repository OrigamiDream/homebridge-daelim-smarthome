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
    timeoutId: Timeout | number
    called: boolean
}

export const ELEVATOR_DEVICE: Device = {
    displayName: "외부 엘리베이터",
    name: "엘리베이터",
    deviceType: DeviceType.ELEVATOR,
    deviceId: "CMF990100",
    disabled: false,
};

export default class ElevatorAccessories extends Accessories<ElevatorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.ELEVATOR, [api.hap.Service.Switch]);
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
                            .setCharacteristic(this.api.hap.Characteristic.On, context.called);
                    }, 0);
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(ELEVATOR_DEVICE.deviceId);
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
                    if(context.timeoutId !== -1) clearTimeout(context.timeoutId);

                    context.timeoutId = setTimeout(() => {
                        if(context.timeoutId !== -1) clearTimeout(context.timeoutId);

                        context.timeoutId = -1;
                        context.called = false;
                        this.getService(accessory, this.api.hap.Service.Switch)
                            .setCharacteristic(this.api.hap.Characteristic.On, false);
                    }, device.duration?.elevator || 30 * 1000); // 30s as default.
                }
                context.called = called;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.called);
            });
    }

    register() {
        super.register();

        setTimeout(async () => {
            if(!this.findDevice(ELEVATOR_DEVICE.deviceId)) {
                return;
            }
            const device = ELEVATOR_DEVICE;
            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                timeoutId: -1,
                called: false,
            });
        }, 1000);
    }
}
