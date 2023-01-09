import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {EventPushTypes, PushTypes} from "../../core/fields";

interface VehicleAccessoryInterface extends AccessoryInterface {
    timeoutId: number
    vehicleGettingIn: boolean
}

export const VEHICLE_DEVICE_ID = "VH-000000";
export const VEHICLE_DISPLAY_NAME = "주차차단기";
export const VEHICLE_TIMEOUT_DURATION = 5 * 1000; // 5 seconds

export class VehicleAccessories extends Accessories<VehicleAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, ["vehicle"], [api.hap.Service.MotionSensor]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        this.log.warn("Identifying Vehicle accessories is not possible.");
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.MotionSensor, services);
        service.getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, accessory.context.vehicleGettingIn);
            });
    }

    invalidateVehicleState() {
        const accessory = this.findAccessoryWithDeviceID(VEHICLE_DEVICE_ID);
        if(accessory) {
            if(accessory.context.timeoutId !== -1) {
                clearTimeout(accessory.context.timeoutId);
            }
            accessory.context.timeoutId = -1;
            accessory.context.vehicleGettingIn = false;

            this.updateVehicleCharacteristic(accessory);
        }
    }

    updateVehicleCharacteristic(accessory: PlatformAccessory) {
        this.findService(accessory, this.api.hap.Service.MotionSensor, (service) => {
            service.setCharacteristic(this.api.hap.Characteristic.MotionDetected, accessory.context.vehicleGettingIn);
        });
    }

    registerAccessories() {
        this.addAccessory({
            deviceID: VEHICLE_DEVICE_ID,
            displayName: VEHICLE_DISPLAY_NAME,
            init: false,
            timeoutId: -1,
            vehicleGettingIn: false
        });
    }

    registerListeners() {
        // NOTE: Vehicle should not call `super.registerListeners()` because this device does not lazy initialization
        this.client?.registerPushEventListener(PushTypes.EVENTS, EventPushTypes.CAR_GETTING_IN, (_) => {
            const accessory = this.findAccessoryWithDeviceID(VEHICLE_DEVICE_ID);
            if(accessory) {
                if(accessory.context.timeoutId !== -1) {
                    clearTimeout(accessory.context.timeoutId);
                }
                accessory.context.timeoutId = setTimeout(() => {
                    this.invalidateVehicleState();
                }, VEHICLE_TIMEOUT_DURATION);
                accessory.context.vehicleGettingIn = true;
                accessory.context.init = true;

                this.updateVehicleCharacteristic(accessory);
            }
        });
    }

}