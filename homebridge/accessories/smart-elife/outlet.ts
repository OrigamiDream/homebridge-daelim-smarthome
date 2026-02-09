import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {API, Logging} from "homebridge";
import {SwitchableAccessories, SwitchableAccessoryInterface} from "./switchable-accessories";

interface OutletAccessoryInterface extends SwitchableAccessoryInterface {}

export default class OutletAccessories extends SwitchableAccessories<OutletAccessoryInterface> {

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.WALL_SOCKET, [api.hap.Service.Outlet], api.hap.Service.Outlet);
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
                    init: true,
                    on: device.op["status"] === "on",
                });
                if(!accessory)
                    continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.Outlet);
                service?.setCharacteristic(this.api.hap.Characteristic.On, context.on);
            }
        });
    }
}
