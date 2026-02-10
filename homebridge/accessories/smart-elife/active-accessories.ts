import Accessories, {AccessoryInterface, ServiceType} from "./accessories";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory, Service
} from "homebridge";

export interface ActiveAccessoryInterface extends AccessoryInterface {
    active: boolean
}

export default abstract class ActiveAccessories<T extends ActiveAccessoryInterface> extends Accessories<T> {
    protected constructor(log: Logging, api: API, config: SmartELifeConfig, deviceType: DeviceType, serviceTypes: ServiceType[],
                          protected readonly activeServiceType: ServiceType) {
        super(log, api, config, deviceType, serviceTypes);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        const context = this.getAccessoryInterface(accessory);
        for(const on of [ !context.active, context.active ]) {
            const device = this.findDevice(context.deviceId);
            if(!device) continue;

            const success = await this.setDeviceState({
                ...device, op: { control: on ? "on" : "off" },
            });
            if(!success) {
                this.log.warn("The accessory %s does not respond.", accessory.displayName);
                break;
            }
        }
    }

    onSetActivityOp(value: boolean, op: Record<string, any>): any {}

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);

        this.getService(this.activeServiceType, services)
            .getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.active === value) {
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }

                const op = this.onSetActivityOp(
                    value as boolean,
                    { control: value ? "on" : "off" });

                const success = await this.setDeviceState({ ...device, op });
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                context.active = value as boolean;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.init) {
                    callback(new Error("Not initialized."));
                    return;
                }
                const state = context.active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE;
                callback(undefined, state);
            });
    }
}
