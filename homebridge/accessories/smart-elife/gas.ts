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
                callback(undefined, this.lockCurrentState(context));
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
                    setTimeout(() => {
                        this.getService(accessory, this.api.hap.Service.LockMechanism)
                            .getCharacteristic(this.api.hap.Characteristic.LockTargetState)
                            .updateValue(this.lockTargetState(this.getAccessoryInterface(accessory)));
                    }, 0);
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
                this.updateLockState(accessory);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.lockTargetState(context));
            });
    }

    private lockCurrentState(context: GasAccessoryInterface): CharacteristicValue {
        return context.secured
            ? this.api.hap.Characteristic.LockCurrentState.SECURED
            : this.api.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    private lockTargetState(context: GasAccessoryInterface): CharacteristicValue {
        return context.secured
            ? this.api.hap.Characteristic.LockTargetState.SECURED
            : this.api.hap.Characteristic.LockTargetState.UNSECURED;
    }

    private updateLockState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const lock = this.getService(accessory, this.api.hap.Service.LockMechanism);
        lock.getCharacteristic(this.api.hap.Characteristic.LockCurrentState)
            .updateValue(this.lockCurrentState(context));
        lock.getCharacteristic(this.api.hap.Characteristic.LockTargetState)
            .updateValue(this.lockTargetState(context));
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

                this.updateLockState(accessory);
            }
        });
    }
}