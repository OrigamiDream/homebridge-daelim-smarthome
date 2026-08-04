import ActiveAccessories, {ActiveAccessoryInterface} from "./active-accessories";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";

interface HeaterAccessoryInterface extends ActiveAccessoryInterface {
    currentTemperature: number
    desiredTemperature: number
    mode?: HeaterMode
}

enum HeaterMode {
    HEAT = "heat",
    AWAY = "out",
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
            // Props before the value throughout: a value written first is clamped to the
            // range HAP gives the characteristic by default, which is narrower than the
            // one being installed right after it.
            .setProps({
                validValues: [this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT],
            })
            .updateValue(this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT)
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
            .updateValue(this.getThresholdTemperature(accessory))
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.desiredTemperature === value || !context.active) {
                    callback(undefined);
                    return;
                }
                if(context.mode !== HeaterMode.HEAT) {
                    callback(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
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
                        // The wallpad heater keys its target temperature as `set_temp`
                        // (confirmed against the live device op, and matching the sibling
                        // A/C). `value` was copy-pasted from lightbulb and had no effect.
                        set_temp: this.getThresholdTemperature(accessory),
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
            .updateValue(this.getCurrentTemperature(accessory))
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
        if(!context.active)
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        if(context.mode !== HeaterMode.HEAT)
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
        if(context.desiredTemperature > context.currentTemperature)
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
        // Powered on but already at/above the target: idling, not inactive. Reporting
        // INACTIVE here contradicts the ACTIVE state and mirrors the sibling A/C's IDLE.
        return this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
    }

    // Whether what the listener publishes would land as a change worth a line.
    // The characteristic itself is the reference rather than the context,
    // because the context is overwritten by `addOrGetAccessory()` before the report is published.
    //
    // The room's own temperature is deliberately not part of this.
    // It is a live sensor reading that drifts by a degree between polls
    // with nobody touching anything - one line per poll, measured on a real WallPad -
    // so including it would keep the line coming every thirty seconds
    // and bury the log this exists to serve.
    // It is still printed on the line, where it gives context to the change that did happen.
    private reportDiffers(service: Service, accessory: PlatformAccessory, context: HeaterAccessoryInterface): boolean {
        const hap = this.api.hap;
        const active = context.active ? hap.Characteristic.Active.ACTIVE : hap.Characteristic.Active.INACTIVE;
        return service.getCharacteristic(hap.Characteristic.Active).value !== active
            || service.getCharacteristic(hap.Characteristic.CurrentHeaterCoolerState).value !== this.getCurrentState(accessory)
            || service.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).value !== this.storedThreshold(accessory);
    }

    /**
     * The target temperature as the characteristic will hold it.
     *
     * HAP rounds what it is given to `minStep`, which is one degree here,
     * so a wallpad report of 22.5 is stored as 23.
     * Comparing the raw number against the stored one would differ on every poll,
     * and the wallpad does send halves.
     */
    private storedThreshold(accessory: PlatformAccessory): number {
        // Equivalent to HAP's own rounding while `minValue` and `minStep` are whole numbers.
        return Math.round(this.getThresholdTemperature(accessory) as number);
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const active = (device.op["control"] ?? device.op["status"]) === "on";
                const currentTemperature = device.op["current_temp"] ? Number(device.op["current_temp"]) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const targetTemperature = device.op["desired_temp"] ?? device.op["set_temp"];
                const desiredTemperature = targetTemperature ? Number(targetTemperature) : MIN_TEMPERATURE || MIN_TEMPERATURE;
                const mode = device.op["mode"] as HeaterMode | undefined;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    currentTemperature,
                    desiredTemperature,
                    mode,
                });
                if(!accessory) continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.HeaterCooler);

                // Say so only where something will actually go out.
                // The device list is polled every thirty seconds,
                // and a room nobody has touched is republished on every poll.
                if(service && this.reportDiffers(service, accessory, context)) {
                    this.log.debug("Heater :: %s :: reporting active=%s target=%s current=%s",
                        context.displayName, context.active ? "on" : "off",
                        String(this.getThresholdTemperature(accessory)), String(this.getCurrentTemperature(accessory)));
                }
                accessory.getService(this.api.hap.Service.HeaterCooler)
                    ?.updateCharacteristic(this.api.hap.Characteristic.Active, context.active
                        ? this.api.hap.Characteristic.Active.ACTIVE
                        : this.api.hap.Characteristic.Active.INACTIVE)
                    .updateCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentState(accessory))
                    .updateCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature, this.getThresholdTemperature(accessory))
                    .updateCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.getCurrentTemperature(accessory));
            }
        });
    }
}
