import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory, Service
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Accessories, {AccessoryInterface, ServiceType} from "./accessories";
import {getGlobalIndoorRelativeHumidity} from "./indoor-air-quality-cache";

interface AirConditionerInterface extends AccessoryInterface {
    active: boolean
    mode: Mode
    rotationSpeed: RotationSpeed
    currentTemperature: number
    desiredTemperature: number
}

enum RotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
}

enum Mode {
    AUTO = "auto", // In auto mode, adjusting RotationSpeed is disallowed, but temperature.
    COOLING = "cool", // In cooling mode, adjusting RotationSpeed and temperature is allowed.
    DEHUMIDIFYING = "dehumi", // In dehumidifying mode, adjusting RotationSpeed and temperature is disallowed.
    FAN = "fan", // In fan mode, setting RotationSpeed as auto and adjusting temperature is disallowed.
}

const ROTATION_SPEED_STEP = 100 / 3.0;
const MIN_TEMPERATURE = 18;
const MAX_TEMPERATURE = 30;

export default class AirConditionerAccessories extends Accessories<AirConditionerInterface> {

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.AIR_CONDITIONER, [
            api.hap.Service.HeaterCooler,
            api.hap.Service.HumidifierDehumidifier,
            api.hap.Service.AirPurifier,
        ]);
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

    private getHeaterCoolerTargetState(mode: Mode): CharacteristicValue {
        if(mode === Mode.AUTO) {
            return this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO;
        }
        return this.api.hap.Characteristic.TargetHeaterCoolerState.COOL;
    }

    private getCurrentDehumidifierState(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        if(context.active && context.mode === Mode.DEHUMIDIFYING) {
            return this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
        }
        return this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }

    private getCurrentAirPurifierState(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        if(context.active && context.mode === Mode.FAN) {
            return this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
        }
        return this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE;
    }

    private isTemperatureAdjustable(context: AirConditionerInterface): boolean {
        return context.active && (context.mode === Mode.AUTO || context.mode === Mode.COOLING);
    }

    private setAllInactive(accessory: PlatformAccessory) {
        for(const serviceType of this.serviceTypes) {
            if(serviceType.UUID === this.api.hap.Service.AccessoryInformation.UUID) {
                continue;
            }
            this.getService(accessory, serviceType)
                .setCharacteristic(this.api.hap.Characteristic.Active, this.api.hap.Characteristic.Active.INACTIVE);
        }
    }

    private async activateMode(accessory: PlatformAccessory, mode: Mode): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        const device = this.findDevice(context.deviceId);
        if(!device) {
            return false;
        }
        const op: Record<string, any> = {
            control: "on",
            mode: mode.toString(),
        };
        if(mode === Mode.AUTO || mode === Mode.COOLING) {
            op["set_temp"] = this.getThresholdTemperature(accessory);
        }
        if((mode === Mode.COOLING || mode === Mode.FAN) && context.rotationSpeed !== RotationSpeed.OFF) {
            op["wind_speed"] = context.rotationSpeed.toString();
        }
        const success = await this.setDeviceState({
            ...device,
            op,
        });
        if(!success) {
            return false;
        }
        context.active = true;
        context.mode = mode;
        return true;
    }

    private async deactivate(accessory: PlatformAccessory): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        const device = this.findDevice(context.deviceId);
        if(!device) {
            return false;
        }
        const success = await this.setDeviceState({
            ...device,
            op: {
                control: "off",
            },
        });
        if(!success) {
            return false;
        }
        context.active = false;
        return true;
    }

    private async onSetServiceActive(
        accessory: PlatformAccessory,
        serviceType: ServiceType,
        active: boolean,
        mode: Mode,
        callback: CharacteristicSetCallback,
    ) {
        const context = this.getAccessoryInterface(accessory);
        const targetServiceActive = context.active && context.mode === mode;
        if(targetServiceActive === active) {
            callback(undefined);
            return;
        }
        let success;
        if(active) {
            success = await this.activateMode(accessory, mode);
            if(success) {
                this.setActive(accessory, serviceType);
            }
        } else {
            success = await this.deactivate(accessory);
            if(success) {
                this.setAllInactive(accessory);
            }
        }
        if(!success) {
            callback(new Error("Failed to set the device state."));
            return;
        }
        this.syncAccessoryState(accessory);
        callback(undefined);
    }

    private async onSetRotationSpeed(
        accessory: PlatformAccessory,
        value: CharacteristicValue,
        mode: Mode,
        callback: CharacteristicSetCallback,
    ) {
        const context = this.getAccessoryInterface(accessory);
        const numeric = value as number;
        const newSpeed = this.homebridgeToRotationSpeed(numeric);
        const oldSpeed = context.rotationSpeed;
        if(oldSpeed === newSpeed) {
            callback(undefined);
            return;
        }

        const device = this.findDevice(context.deviceId);
        if(!device) {
            callback(new Error(`Unknown device: ${context.deviceId}`));
            return;
        }

        if(newSpeed === RotationSpeed.OFF) {
            if(!context.active) {
                context.rotationSpeed = RotationSpeed.OFF;
                callback(undefined);
                return;
            }
            const success = await this.deactivate(accessory);
            if(!success) {
                callback(new Error("Failed to set the device state."));
                return;
            }
            context.rotationSpeed = RotationSpeed.OFF;
            this.setAllInactive(accessory);
            this.syncAccessoryState(accessory);
            callback(undefined);
            return;
        }

        const op: Record<string, any> = {
            wind_speed: newSpeed.toString(),
        };
        if(!context.active || context.mode !== mode) {
            op["control"] = "on";
            op["mode"] = mode.toString();
            context.mode = mode;
            context.active = true;
        }
        const success = await this.setDeviceState({
            ...device,
            op,
        });
        if(!success) {
            callback(new Error("Failed to set the device state."));
            return;
        }
        context.rotationSpeed = newSpeed;
        if(context.active) {
            switch (context.mode) {
                case Mode.AUTO:
                case Mode.COOLING:
                    this.setActive(accessory, this.api.hap.Service.HeaterCooler);
                    break;
                case Mode.DEHUMIDIFYING:
                    this.setActive(accessory, this.api.hap.Service.HumidifierDehumidifier);
                    break;
                case Mode.FAN:
                    this.setActive(accessory, this.api.hap.Service.AirPurifier);
                    break;
            }
        }
        this.syncAccessoryState(accessory);
        callback(undefined);
    }

    private syncAccessoryState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);

        const heaterCooler = this.getService(accessory, this.api.hap.Service.HeaterCooler);
        const heaterCoolerMode = context.mode === Mode.AUTO || context.mode === Mode.COOLING;
        const heaterActive = context.active && heaterCoolerMode;
        heaterCooler
            .setCharacteristic(this.api.hap.Characteristic.Active, heaterActive
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .setCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentState(accessory))
            .setCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState, this.getHeaterCoolerTargetState(context.mode))
            .setCharacteristic(this.api.hap.Characteristic.CoolingThresholdTemperature, this.getThresholdTemperature(accessory))
            .setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.getCurrentTemperature(accessory))
            .setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeedToHomebridge(context.rotationSpeed));

        const dehumidifier = this.getService(accessory, this.api.hap.Service.HumidifierDehumidifier);
        const dehumidifierActive = context.active && context.mode === Mode.DEHUMIDIFYING;
        dehumidifier
            .setCharacteristic(this.api.hap.Characteristic.Active, dehumidifierActive
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .setCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, this.getCurrentDehumidifierState(accessory))
            .setCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, getGlobalIndoorRelativeHumidity())
            .setCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState,
                this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);

        const airPurifier = this.getService(accessory, this.api.hap.Service.AirPurifier);
        const fanActive = context.active && context.mode === Mode.FAN;
        airPurifier
            .setCharacteristic(this.api.hap.Characteristic.Active, fanActive
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .setCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, this.getCurrentAirPurifierState(accessory))
            .setCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState,
                this.api.hap.Characteristic.TargetAirPurifierState.MANUAL)
            .setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeedToHomebridge(context.rotationSpeed));
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                const context = this.getAccessoryInterface(accessory);
                const mode = context.mode === Mode.AUTO ? Mode.AUTO : Mode.COOLING;
                await this.onSetServiceActive(accessory, this.api.hap.Service.HeaterCooler, active, mode, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = context.active && (context.mode === Mode.AUTO || context.mode === Mode.COOLING);
                callback(undefined, active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });

        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.COOLING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentState(accessory));
            });

        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO,
                    this.api.hap.Characteristic.TargetHeaterCoolerState.COOL,
                ],
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const targetMode = value === this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO
                    ? Mode.AUTO
                    : Mode.COOLING;
                const context = this.getAccessoryInterface(accessory);
                if(context.mode === targetMode) {
                    callback(undefined);
                    return;
                }
                context.mode = targetMode;
                if(!context.active) {
                    this.syncAccessoryState(accessory);
                    callback(undefined);
                    return;
                }
                const success = await this.activateMode(accessory, targetMode);
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                this.setActive(accessory, this.api.hap.Service.HeaterCooler);
                this.syncAccessoryState(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.getHeaterCoolerTargetState(context.mode));
            });

        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.CoolingThresholdTemperature)
            .setValue(this.getThresholdTemperature(accessory))
            .setProps({
                minValue: MIN_TEMPERATURE,
                maxValue: MAX_TEMPERATURE,
                minStep: 1,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.desiredTemperature === value || !this.isTemperatureAdjustable(context)) {
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                context.desiredTemperature = value as number;
                this.defer(device.deviceId, this.setDeviceState({
                    ...device, op: {
                        "set_temp": this.getThresholdTemperature(accessory),
                    },
                }));
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getThresholdTemperature(accessory));
            });

        // CurrentTemperature
        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .setValue(this.getCurrentTemperature(accessory))
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentTemperature(accessory));
            });

        // RotationSpeed
        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.onSetRotationSpeed(accessory, value, Mode.COOLING, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.rotationSpeedToHomebridge(context.rotationSpeed));
            });

        this.configureDehumidifier(accessory);
        this.configureAirPurifier(accessory);
    }

    getThresholdTemperature(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, context.desiredTemperature));
    }

    getCurrentTemperature(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        return context.currentTemperature;
    }

    getCurrentState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        if(!context.active || (context.mode !== Mode.COOLING && context.mode !== Mode.AUTO)) {
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        if(context.active && context.desiredTemperature < context.currentTemperature)
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.COOLING;
        return this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
    }

    configureDehumidifier(accessory: PlatformAccessory): Service {
        const service = this.getService(accessory, this.api.hap.Service.HumidifierDehumidifier);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                await this.onSetServiceActive(accessory, this.api.hap.Service.HumidifierDehumidifier, active, Mode.DEHUMIDIFYING, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = context.active && context.mode === Mode.DEHUMIDIFYING;
                callback(undefined, active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });
        service.getCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentDehumidifierState(accessory));
            });
        service.getCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState)
            .setValue(this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
            });
        service.getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, getGlobalIndoorRelativeHumidity());
            });
        return service;
    }

    configureAirPurifier(accessory: PlatformAccessory): Service {
        const service = this.getService(accessory, this.api.hap.Service.AirPurifier);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                await this.onSetServiceActive(accessory, this.api.hap.Service.AirPurifier, active, Mode.FAN, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = context.active && context.mode === Mode.FAN;
                callback(undefined, active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });
        service.getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentAirPurifierState(accessory));
            });
        service.getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .setProps({
                validValues: [this.api.hap.Characteristic.TargetAirPurifierState.MANUAL],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.TargetAirPurifierState.MANUAL);
            });
        service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.onSetRotationSpeed(accessory, value, Mode.FAN, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.rotationSpeedToHomebridge(context.rotationSpeed));
            });
        return service;
    }

    setActive(accessory: PlatformAccessory, serviceType: ServiceType) {
        // Activate the service only.
        for(const service of this.serviceTypes) {
            if(service.UUID === this.api.hap.Service.AccessoryInformation.UUID) {
                continue;
            }
            if(service.UUID === serviceType.UUID) {
                this.getService(accessory, service)
                    .setCharacteristic(this.api.hap.Characteristic.Active, this.api.hap.Characteristic.Active.ACTIVE);
            } else {
                this.getService(accessory, service)
                    .setCharacteristic(this.api.hap.Characteristic.Active, this.api.hap.Characteristic.Active.INACTIVE);
            }
        }
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const active = device.op["status"] === "on";
                const currentTemperature = device.op["current_temp"] ? Number(device.op["current_temp"]) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const desiredTemperature = device.op["desired_temp"] ? Number(device.op["desired_temp"]) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const rotationSpeed = active ? device.op["wind_speed"] as RotationSpeed || RotationSpeed.OFF : RotationSpeed.OFF;
                const operationMode = device.op["mode"] as Mode || Mode.AUTO;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    currentTemperature,
                    desiredTemperature,
                    rotationSpeed,
                    mode: operationMode,
                });
                if(!accessory) continue;

                this.syncAccessoryState(accessory);
            }
        });
    }
}
