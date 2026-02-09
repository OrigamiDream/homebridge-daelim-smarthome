import Accessories, {AccessoryInterface} from "./accessories";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory, Service
} from "homebridge";

interface OutletAccessoryInterface extends AccessoryInterface {
    on: boolean
}

export default class OutletAccessories extends Accessories<OutletAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.WALL_SOCKET, [api.hap.Service.Outlet]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
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

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);

        this.getService(this.api.hap.Service.Outlet, services)
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
                if(!context.init) {
                    callback(new Error("Not initialized."));
                }
                callback(undefined, context.on);
            });
    }

    register() {
        super.register();

        this.addListener((data: any) => {
            const devices = this.parseDevices(data);
            for(const device of devices) {
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: false,
                    on: false,
                });
                if(!accessory)
                    continue;

                const context = this.getAccessoryInterface(accessory);
                context.on = device.op["status"] === "on";
                context.init = true;

                const service = accessory.getService(this.api.hap.Service.Outlet);
                service?.setCharacteristic(this.api.hap.Characteristic.On, context.on);
            }
        });
    }
}
