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
    motionTimer: number
    changesDetected: boolean
}

interface DoorDevice {
    readonly deviceID: string
    readonly displayName: string
    readonly isCommunal: boolean
}

export const DOOR_DEVICES: DoorDevice[] = [{
    deviceID: "FD-000000",
    displayName: "세대현관",
    isCommunal: false
}, {
    deviceID: "CE-000000",
    displayName: "공동현관",
    isCommunal: true
}];
export const DOOR_TIMEOUT_DURATION = 5 * 1000; // 5 seconds

export class DoorAccessories extends Accessories<DoorAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig) {
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
    
    createMotionTimer(accessory: PlatformAccessory) {
        const device = this.findDeviceInfoFromAccessory(accessory);
        return setTimeout(() => {
            if(accessory.context.motionTimer !== -1) {
                clearTimeout(accessory.context.motionTimer);
            }
            accessory.context.motionTimer = -1;
            accessory.context.changesDetected = false;

            this.refreshSensors(accessory);
        }, device?.duration?.door || DOOR_TIMEOUT_DURATION);
    }

    findDoorAccessoryOf(isCommunal: boolean): PlatformAccessory | undefined {
        const devices = DOOR_DEVICES.filter((device) => device.isCommunal === isCommunal);
        if(!devices || !devices.length) {
            return undefined;
        }
        const device = devices[0];
        return this.findAccessoryWithDeviceID(device.deviceID);
    }

    refreshSensors(accessory: PlatformAccessory) {
        this.findService(accessory, this.api.hap.Service.MotionSensor, (service) => {
            service.setCharacteristic(this.api.hap.Characteristic.MotionDetected, accessory.context.changesDetected);
        });
    }

    registerAccessories() {
        for(const doorDevice of DOOR_DEVICES) {
            this.addAccessory({
                deviceID: doorDevice.deviceID,
                displayName: doorDevice.displayName,
                init: false,
                motionTimer: -1,
                changesDetected: false
            });
        }
    }

    registerListeners() {
        // NOTE: Door should not call `super.registerListeners()` because this device does not lazy initialization
        this.client?.registerPushEventListener(PushTypes.EVENTS, EventPushTypes.FRONT_DOOR_CHANGES, (data) => {
            const accessory = this.findDoorAccessoryOf(data.message.indexOf("공동현관") !== -1);
            if(accessory) {
                // if push event have come within timeout duration, renew the timeout to keep device state
                if(accessory.context.motionTimer !== -1) {
                    clearTimeout(accessory.context.motionTimer);
                }
                accessory.context.motionTimer = this.createMotionTimer(accessory);
                accessory.context.changesDetected = true;
                accessory.context.init = true;

                this.refreshSensors(accessory);
            }
        });
    }

}