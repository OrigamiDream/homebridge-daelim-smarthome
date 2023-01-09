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

interface DoorAccessoryInterface extends AccessoryInterface {
    timeoutId: number
    changesDetected: boolean
}

export const DOOR_DEVICE_ID = "FD-000000";
export const DOOR_DISPLAY_NAME = "현관문";
export const DOOR_TIMEOUT_DURATION = 5 * 1000; // 5 seconds

export class DoorAccessories extends Accessories<DoorAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, ["door"], [api.hap.Service.MotionSensor]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        this.log.warn("Identifying Door accessories is not possible.");
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.MotionSensor, services);
        service.getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, accessory.context.changesDetected);
            });
    }

    invalidateDoorState() {
        const accessory = this.findAccessoryWithDeviceID(DOOR_DEVICE_ID);
        if(accessory) {
            if(accessory.context.timeoutId !== -1) {
                clearTimeout(accessory.context.timeoutId);
            }
            accessory.context.timeoutId = -1;
            accessory.context.changesDetected = false;

            this.updateDoorCharacteristic(accessory);
        }
    }

    updateDoorCharacteristic(accessory: PlatformAccessory) {
        this.findService(accessory, this.api.hap.Service.MotionSensor, (service) => {
            service.setCharacteristic(this.api.hap.Characteristic.MotionDetected, accessory.context.changesDetected);
        });
    }

    registerAccessories() {
        this.addAccessory({
            deviceID: DOOR_DEVICE_ID,
            displayName: DOOR_DISPLAY_NAME,
            init: false,
            timeoutId: -1,
            changesDetected: false
        });
    }

    registerListeners() {
        // NOTE: Door should not call `super.registerListeners()` because this device does not lazy initialization
        this.client?.registerPushEventListener(PushTypes.EVENTS, EventPushTypes.FRONT_DOOR_CHANGES, (_) => {
            const accessory = this.findAccessoryWithDeviceID(DOOR_DEVICE_ID);
            if(accessory) {
                // if push event have come within timeout duration, renew the timeout to keep device state
                if(accessory.context.timeoutId !== -1) {
                    clearTimeout(accessory.context.timeoutId);
                }
                accessory.context.timeoutId = setTimeout(() => {
                    this.invalidateDoorState();
                }, DOOR_TIMEOUT_DURATION);
                accessory.context.changesDetected = true;
                accessory.context.init = true;

                this.updateDoorCharacteristic(accessory);
            }
        });
    }

}