import ActiveAccessories, {ActiveAccessoryInterface} from "./active-accessories";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";

interface HeaterAccessoryInterface extends ActiveAccessoryInterface {
    currentTemperature: number
    desiredTemperature: number
}

const MIN_TEMPERATURE = 5;
const MAX_TEMPERATURE = 40;

export default class HeaterAccessories extends ActiveAccessories<HeaterAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.HEATER, [api.hap.Service.HeaterCooler], api.hap.Service.HeaterCooler);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        // CurrentHeaterCoolerState
        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentState(accessory));
            });

        // TargetHeaterCoolerState
        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState)
            .setProps({
                validValues: [this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT);
            });

        // HeatingThresholdTemperature
        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
            .setProps({
                minValue: MIN_TEMPERATURE,
                maxValue: MAX_TEMPERATURE,
                minStep: 1,
            })
            .setValue(this.getThresholdTemperature(accessory))
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.desiredTemperature === value || !context.active) {
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
                        value: this.getThresholdTemperature(accessory),
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
    }

    getThresholdTemperature(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, context.desiredTemperature));
    }

    getCurrentTemperature(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        return context.currentTemperature;
    }

    getCurrentState(accessory: PlatformAccessory): CharacteristicValue {
        const context = this.getAccessoryInterface(accessory);
        if(context.active && context.desiredTemperature > context.currentTemperature)
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
        else
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const active = device.op["status"] === "on";
                const currentTemperature = device.op["current_temp"] ? Number(device.op["current_temp"]) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const desiredTemperature = device.op["desired_temp"] ? Number(device.op["desired_temp"]) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    currentTemperature,
                    desiredTemperature,
                });
                if(!accessory) continue;

                const context = this.getAccessoryInterface(accessory);
                accessory.getService(this.api.hap.Service.HeaterCooler)
                    ?.setCharacteristic(this.api.hap.Characteristic.Active, context.active
                        ? this.api.hap.Characteristic.Active.ACTIVE
                        : this.api.hap.Characteristic.Active.INACTIVE)
                    .setCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature, this.getThresholdTemperature(accessory));
            }
        });
    }
}
