import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import ActiveAccessories, {ActiveAccessoryInterface} from "./active-accessories";

enum RotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
}

enum Mode {
    AUTO_DRIVING = "auto",
    MANUAL = "manual",
}

const ROTATION_SPEED_STEP = 100 / 3.0;

interface VentAccessoryInterface extends ActiveAccessoryInterface {
    rotationSpeed: RotationSpeed
    mode: Mode
    modeHw: string
}

export default class VentAccessories extends ActiveAccessories<VentAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.VENT, [api.hap.Service.AirPurifier, api.hap.Service.AirQualitySensor], api.hap.Service.AirPurifier);
    }

    private homebridgeToRotationSpeed(value: number): RotationSpeed {
        if(value <= 0) return RotationSpeed.OFF;
        if(value <= ROTATION_SPEED_STEP) return RotationSpeed.LOW;
        if(value <= ROTATION_SPEED_STEP * 2) return RotationSpeed.MIDDLE;
        return RotationSpeed.HIGH;
    }

    private rotationSpeedToHomebridge(rotationSpeed: RotationSpeed): number {
        switch (rotationSpeed) {
            case RotationSpeed.OFF: return 0;
            case RotationSpeed.LOW: return ROTATION_SPEED_STEP;
            case RotationSpeed.MIDDLE: return ROTATION_SPEED_STEP * 2;
            case RotationSpeed.HIGH: return 100;
        }
    }

    onSetActivityOp(value: boolean, op: Record<string, any>): any {
        if(value)
            op["off_rsv_time"] = "0";
        return op;
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.active || context.rotationSpeed === RotationSpeed.OFF) {
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                let success;
                let mode;
                if(value === this.api.hap.Characteristic.TargetAirPurifierState.MANUAL) {
                    success = await this.setDeviceState({
                        ...device,
                        op: { mode: Mode.MANUAL.toString() },
                    });
                    mode = Mode.MANUAL;
                } else {
                    success = await this.setDeviceState({
                        ...device,
                        op: { mode: context.modeHw },
                    });
                    mode = Mode.AUTO_DRIVING;
                }
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                context.mode = mode;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.init) {
                    callback(new Error("Not initialized."));
                    return;
                }
                switch(context.mode) {
                    case Mode.AUTO_DRIVING:
                        callback(undefined, this.api.hap.Characteristic.TargetAirPurifierState.AUTO);
                        break;
                    case Mode.MANUAL:
                        callback(undefined, this.api.hap.Characteristic.TargetAirPurifierState.MANUAL);
                        break;
                }
            });
        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.init) {
                    callback(new Error("Not initialized."));
                    return;
                }
                callback(undefined, context.active
                    ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
                    : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
            });
        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const numeric = value as number;
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const oldSpeed = context.rotationSpeed;
                const newSpeed = this.homebridgeToRotationSpeed(numeric);
                if(context.mode === Mode.AUTO_DRIVING) {
                    // Fallthrough the update in auto-driving mode.
                    callback(undefined);
                    return;
                }
                this.log.debug(`Vent :: SET :: RotationSpeed: ${numeric.toFixed(2)} (HomeKit) -> ${newSpeed.toString()}`);
                if(oldSpeed === newSpeed) {
                    callback(undefined);
                    return;
                }
                context.rotationSpeed = newSpeed;
                if(!context.active) {
                    this.log.debug(`Vent :: SET :: Automatically turned on Vent.`);
                    await this.setDeviceState({
                        ...device, op: { control: "on" },
                    });
                } else if(newSpeed === RotationSpeed.OFF) {
                    // HomeKit automatically emits INACTIVE when rotation speed is 0.
                    callback(undefined);
                    return;
                }

                this.defer(device.deviceId, this.setDeviceFanSpeed(accessory, newSpeed));
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.init) {
                    callback(new Error("Not initialized."));
                    return;
                }
                callback(undefined, this.rotationSpeedToHomebridge(context.rotationSpeed));
            });
    }

    async setDeviceFanSpeed(accessory: PlatformAccessory, newSpeed: RotationSpeed) {
        const context = this.getAccessoryInterface(accessory);
        if(!context.active) {
            return false;
        }
        const device = this.findDevice(context.deviceId);
        return await this.setDeviceState({
            ...device!,
            op: {
                "wind_speed": newSpeed.toString(),
            }
        });
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const active = device.op["status"] === "on";
                const rotationSpeed = active ? device.op["wind_speed"] as RotationSpeed || RotationSpeed.OFF : RotationSpeed.OFF;
                const mode = device.op["mode"] as Mode || Mode.AUTO_DRIVING;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    rotationSpeed,
                    mode,
                    modeHw: device.op["mode"],
                });
                if(!accessory) continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.AirPurifier);
                service?.setCharacteristic(this.api.hap.Characteristic.Active, context.active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
                switch(context.mode) {
                    case Mode.AUTO_DRIVING:
                        service?.setCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, this.api.hap.Characteristic.TargetAirPurifierState.AUTO);
                        break;
                    case Mode.MANUAL:
                        service?.setCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, this.api.hap.Characteristic.TargetAirPurifierState.MANUAL);
                        break;
                }
                service?.setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeedToHomebridge(rotationSpeed));
            }
        });
    }
}
