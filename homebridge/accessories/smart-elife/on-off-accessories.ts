import Accessories, {AccessoryInterface, ServiceType} from "./accessories";
import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";

export interface OnOffAccessoryInterface extends AccessoryInterface {
    on: boolean
}

export abstract class OnOffAccessories<T extends OnOffAccessoryInterface> extends Accessories<T> {
    protected constructor(log: Logging, api: API, config: SmartELifeConfig, deviceType: DeviceType, serviceTypes: ServiceType[],
                          protected readonly onOffServiceType: ServiceType) {
        super(log, api, config, deviceType, serviceTypes);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        const context = this.getAccessoryInterface(accessory);
        for(const on of [ !context.on, context.on ]) {
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

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        this.getService(accessory, this.onOffServiceType)
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.on === value) {
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const success = await this.setDeviceState({
                    ...device, op: { control: value ? "on" : "off" },
                });
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                context.on = value as boolean;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.on);
            });
    }
}
