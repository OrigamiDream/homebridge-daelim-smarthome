import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";

interface GasAccessoryInterface extends AccessoryInterface {
    secured: boolean
}

export default class GasAccessories extends Accessories<GasAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.GAS, [api.hap.Service.LockMechanism]);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.LockMechanism)
            .getCharacteristic(this.api.hap.Characteristic.Name)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.displayName);
            });
        this.getService(accessory, this.api.hap.Service.LockMechanism)
            .getCharacteristic(this.api.hap.Characteristic.LockCurrentState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.secured
                    ? this.api.hap.Characteristic.LockCurrentState.SECURED
                    : this.api.hap.Characteristic.LockCurrentState.UNSECURED);
            });
        this.getService(accessory, this.api.hap.Service.LockMechanism)
            .getCharacteristic(this.api.hap.Characteristic.LockTargetState)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const secured = value === this.api.hap.Characteristic.LockTargetState.SECURED;
                if(context.secured === secured) {
                    callback(undefined);
                    return;
                }
                if(!secured) {
                    // Could not unsecure the Cooktop because of human security.
                    // Update the LockMechanism characteristic immediately.
                    this.getService(accessory, this.api.hap.Service.LockMechanism)
                        .setCharacteristic(this.api.hap.Characteristic.LockTargetState, this.api.hap.Characteristic.LockTargetState.SECURED);
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const success = await this.client.sendDeviceControl(device, "close");
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                context.secured = true;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.secured
                    ? this.api.hap.Characteristic.LockTargetState.SECURED
                    : this.api.hap.Characteristic.LockTargetState.UNSECURED);
            });
    }

    register() {
        super.register();
        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    secured: device.op["status"] === "close",
                });
                if(!accessory) continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.LockMechanism);
                service?.setCharacteristic(this.api.hap.Characteristic.LockTargetState, context.secured
                    ? this.api.hap.Characteristic.LockTargetState.SECURED
                    : this.api.hap.Characteristic.LockTargetState.UNSECURED);
            }
        });
    }
}