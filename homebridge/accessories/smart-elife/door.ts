import Accessories, {AccessoryInterface, ServiceType} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicValue,
    HAPStatus,
    Logging,
    PlatformAccessory, Service,
} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface DoorAccessoryInterface extends AccessoryInterface {
    motionTimer?: Timeout
    motionDetected: boolean
    isSmartDoorLock?: boolean
    closed?: boolean
    batteryLevel?: number
}

interface DoorDevice extends Device {
    isSmartDoorLock: boolean
    pushType: PushType
}

export const EXTERIOR_DOOR_DEVICES: DoorDevice[] = [
    {
        displayName: "외부 세대현관",
        name: "세대현관",
        deviceType: DeviceType.DOOR,
        deviceId: "CMFDOR001",
        disabled: false,
        isSmartDoorLock: true,
        pushType: PushType.FRONT_DOOR,
    },
    {
        displayName: "외부 공동현관",
        name: "공동현관",
        deviceType: DeviceType.DOOR,
        deviceId: "CMFDOR002",
        disabled: false,
        isSmartDoorLock: false,
        pushType: PushType.COMMUNAL_DOOR,
    },
];

export const DOOR_TIMEOUT_DURATION_SECONDS = 5; // 5 seconds
const LOW_BATTERY_THRESHOLD = 20;

export default class DoorAccessories extends Accessories<DoorAccessoryInterface> {

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.DOOR, [api.hap.Service.MotionSensor, api.hap.Service.ContactSensor, api.hap.Service.Battery]);
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
        this.log.warn("Identifying `door` not supported.");
    }

    protected isSupportedServiceType(serviceType: ServiceType, accessory: PlatformAccessory): boolean {
        const context = this.getAccessoryInterface(accessory);
        if(context.isSmartDoorLock) {
            return super.isSupportedServiceType(serviceType, accessory);
        }
        // Communal door only supports MotionSensor, plus the mandatory information service.
        return serviceType.UUID === this.api.hap.Service.MotionSensor.UUID
            || serviceType.UUID === this.api.hap.Service.AccessoryInformation.UUID;
    }

    protected isSupportedService(service: Service, accessory: PlatformAccessory): boolean {
        const context = this.getAccessoryInterface(accessory);
        if(context.isSmartDoorLock) {
            return super.isSupportedService(service, accessory);
        }
        // Communal door only supports MotionSensor, plus the mandatory information service.
        return service.UUID === this.api.hap.Service.MotionSensor.UUID
            || service.UUID === this.api.hap.Service.AccessoryInformation.UUID;
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });

        const context = this.getAccessoryInterface(accessory);
        if(!context.isSmartDoorLock) {
            return;
        }

        // `LockMechanism` requires a writable `LockTargetState`,
        // which cannot express the BLE-only (read-only from HomeKit's perspective) door lock.
        // A `ContactSensor` is inherently read-only
        // and still surfaces the open/close state under the Home app's security category.
        const contact = this.getService(accessory, this.api.hap.Service.ContactSensor);
        contact.setPrimaryService(true);
        contact.getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.closed === undefined) {
                    callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    return;
                }
                callback(undefined, this.contactSensorState(context.closed));
            });

        const battery = this.getService(accessory, this.api.hap.Service.Battery);
        battery.getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.batteryLevel === undefined) {
                    callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    return;
                }
                callback(undefined, context.batteryLevel);
            });
        battery.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.batteryLevel === undefined) {
                    callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    return;
                }
                callback(undefined, this.lowBatteryState(context.batteryLevel));
            });
        battery.getCharacteristic(this.api.hap.Characteristic.ChargingState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE);
            });
    }

    private contactSensorState(closed: boolean): CharacteristicValue {
        return closed
            ? this.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
            : this.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }

    private lowBatteryState(batteryLevel: number): CharacteristicValue {
        return batteryLevel <= LOW_BATTERY_THRESHOLD
            ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    private parseBatteryLevel(raw: unknown): number | undefined {
        if(raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
            return undefined;
        }
        const level = Number(raw);
        if(!Number.isFinite(level)) {
            return undefined;
        }
        return Math.max(0, Math.min(100, Math.round(level)));
    }

    private addOrGetDoorAccessory(doorDevice: DoorDevice): PlatformAccessory | undefined {
        const device = this.findDevice(doorDevice.deviceId);
        if(!device) return undefined;

        const existing = this.findAccessory(device.deviceId);
        const context = existing
            ? this.getAccessoryInterface(existing)
            : undefined;
        return this.addOrGetAccessory({
            deviceId: device.deviceId,
            deviceType: device.deviceType,
            displayName: device.displayName,
            init: true,
            motionTimer: context?.motionTimer,
            motionDetected: context?.motionDetected ?? false,
            isSmartDoorLock: doorDevice.isSmartDoorLock,
            closed: doorDevice.isSmartDoorLock ? context?.closed : undefined,
            batteryLevel: doorDevice.isSmartDoorLock ? context?.batteryLevel : undefined,
        });
    }

    private refreshSmartDoorLockState(accessory: PlatformAccessory, op: any) {
        const context = this.getAccessoryInterface(accessory);

        const status = op?.["status"];
        if(status === "open") {
            context.closed = false;
        } else if(status === "close") {
            context.closed = true;
        } else {
            this.log.debug("Ignoring unknown smartdoor status: %s", String(status));
        }
        if(context.closed !== undefined) {
            accessory.getService(this.api.hap.Service.ContactSensor)
                ?.getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
                .updateValue(this.contactSensorState(context.closed));
        }

        const parsedBatteryLevel = this.parseBatteryLevel(op?.["battery"]);
        if(parsedBatteryLevel === undefined) return;

        context.batteryLevel = parsedBatteryLevel;
        const battery = accessory.getService(this.api.hap.Service.Battery);
        battery?.getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .updateValue(context.batteryLevel);
        battery?.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .updateValue(this.lowBatteryState(context.batteryLevel));
    }

    registerPushListener(doorDevice: DoorDevice) {
        this.addPushListener(doorDevice.pushType, () => {
            const device = this.findDevice(doorDevice.deviceId);
            if(!device) {
                this.log.warn("Unknown device: %s", doorDevice.deviceId);
                return;
            }
            const accessory = this.addOrGetDoorAccessory(doorDevice);
            if(!accessory) {
                this.log.warn("Unknown accessory: %s", device.deviceId);
                return;
            }

            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer) {
                clearTimeout(context.motionTimer);
            }

            const holdSeconds = device.duration?.door || DOOR_TIMEOUT_DURATION_SECONDS;
            context.motionDetected = true;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer) {
                    clearTimeout(context.motionTimer);
                }
                context.motionTimer = undefined;
                context.motionDetected = false;

                this.log.debug("Door :: %s :: reporting the motion as over", context.displayName);
                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, holdSeconds * 1000);

            this.log.debug("Door :: %s :: reporting the motion as detected, holding it for %d seconds",
                context.displayName, holdSeconds);
            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });
    }

    register() {
        super.register();
        for(const doorDevice of EXTERIOR_DOOR_DEVICES) {
            this.registerPushListener(doorDevice);
        }

        this.addDeviceListener((devices) => {
            if(devices.length > 1) {
                this.log.warn("Currently, only one `smartdoor` device is supported. The other devices are discarded: %s", JSON.stringify(devices));
            }
            const device = devices[0];
            for(const doorDevice of EXTERIOR_DOOR_DEVICES) {
                if(!doorDevice.isSmartDoorLock) continue;

                const accessory = this.addOrGetDoorAccessory(doorDevice);
                if(!accessory) continue;

                this.refreshSmartDoorLockState(accessory, device.op);
            }
        }, DeviceType.SMART_DOOR);

        setTimeout(() => {
            for(const doorDevice of EXTERIOR_DOOR_DEVICES) {
                this.addOrGetDoorAccessory(doorDevice);
            }
        }, 1000);
    }
}
