import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {Utils} from "../../../core/utils";
import {OnOffAccessories, OnOffAccessoryInterface} from "./on-off-accessories";

interface LightbulbAccessoryInterface extends OnOffAccessoryInterface {
    prefix: string
    brightness: number
    brightnessAdjustable: boolean

    /**
     * HomeKit/Home app value (mired), e.g. 140..500.
     */
    colorTemperature: number

    /**
     * Hardware/native value, e.g. 0..100.
     */
    colorTemperatureHw: number

    colorTemperatureAdjustable: boolean
}

// HomeKit uses mired (micro reciprocal degrees). Typical range is 140..500.
const MIRED_MIN_VALUE = 140;
const MIRED_MAX_VALUE = 500;

export default class LightbulbAccessories extends OnOffAccessories<LightbulbAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.LIGHT, [api.hap.Service.Lightbulb], api.hap.Service.Lightbulb);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        const context = this.getAccessoryInterface(accessory);

        if(context.brightnessAdjustable) {
            this.getService(accessory, this.api.hap.Service.Lightbulb)
                .getCharacteristic(this.api.hap.Characteristic.Brightness)
                .setProps({
                    format: this.api.hap.Formats.UINT16,
                    minValue: 0,
                    maxValue: 100,
                    minStep: 1,
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    const brightness = value as number;
                    if(context.brightness === brightness) {
                        callback(undefined);
                        return;
                    }
                    const device = this.findDevice(context.deviceId);
                    if(!device) {
                        callback(new Error(`Unknown device: ${context.deviceId}`));
                        return;
                    }
                    context.brightness = brightness;

                    this.defer(device.deviceId, this.setDeviceState({
                        ...device, op: {
                            value: this.createLightbulbValue(context),
                        },
                    }));

                    callback(undefined);
                })
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    callback(undefined, context.brightness);
                });
        }
        if(context.colorTemperatureAdjustable) {
            this.getService(accessory, this.api.hap.Service.Lightbulb)
                .getCharacteristic(this.api.hap.Characteristic.ColorTemperature)
                .setProps({
                    // HomeKit ColorTemperature is an integer mired value.
                    format: this.api.hap.Formats.UINT16,
                    minValue: MIRED_MIN_VALUE,
                    maxValue: MIRED_MAX_VALUE,
                    minStep: 1,
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    const mired = value as number;

                    const device = this.findDevice(context.deviceId);
                    if(!device) {
                        callback(new Error(`Unknown device: ${context.deviceId}`));
                        return;
                    }

                    // Convert 140..500 (HomeKit) -> 0..100 (hardware), quantize to integer step.
                    const hw = this.miredToHardwareColorTemperature(mired, MIRED_MIN_VALUE, MIRED_MAX_VALUE);
                    this.log.debug(`Lightbulb :: SET :: Color temperature: ${mired} (HomeKit) -> ${hw} (Hardware)`);
                    if(context.colorTemperatureHw === hw) {
                        callback(undefined);
                        return;
                    }

                    // Store BOTH values to keep GET / polling consistent and avoid drift.
                    context.colorTemperatureHw = hw;
                    context.colorTemperature = this.hardwareToMiredColorTemperature(hw, MIRED_MIN_VALUE, MIRED_MAX_VALUE);
                    this.log.debug(`Lightbulb :: SET :: Color temperature: ${hw} (Hardware) -> ${context.colorTemperature} (HomeKit)`);

                    this.defer(device.deviceId, this.setDeviceState({
                        ...device,
                        op: {
                            value: this.createLightbulbValue(context),
                        },
                    }));

                    callback(undefined);
                })
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    callback(undefined, context.colorTemperature);
                });
        }
    }

    private miredToHardwareColorTemperature(mired: number, minMired = MIRED_MIN_VALUE, maxMired = MIRED_MAX_VALUE): number {
        const clamped = Math.max(minMired, Math.min(maxMired, mired));
        const ratio = (clamped - minMired) / (maxMired - minMired); // 0..1
        return Math.round(ratio * 100); // 0..100, step 1
    }

    private hardwareToMiredColorTemperature(hw: number, minMired = MIRED_MIN_VALUE, maxMired = MIRED_MAX_VALUE): number {
        const clamped = Math.max(0, Math.min(100, hw));
        const mired = minMired + (clamped / 100) * (maxMired - minMired);
        return Math.round(mired); // HomeKit step 1
    }

    private createLightbulbValue(context: LightbulbAccessoryInterface): string {
        const brightness = Utils.addPadding(context.brightness, 3);
        // The device expects the hardware/native range (0..100).
        const colorTemperature = Utils.addPadding(context.colorTemperatureHw, 3);
        return `${context.prefix}_${colorTemperature}_${brightness}`;
    }

    private parseLightbulbValue(value: string) {
        const values = value.split("_");
        const colorTemperatureHw = Number(values[1]);
        const brightness = Number(values[2]);

        const colorTemperatureAdjustable = colorTemperatureHw !== 999;
        const brightnessAdjustable = brightness !== 999;

        // When the device says "not adjustable" it uses 999; map HomeKit to a safe default.
        const colorTemperature = colorTemperatureAdjustable
            ? this.hardwareToMiredColorTemperature(colorTemperatureHw, MIRED_MIN_VALUE, MIRED_MAX_VALUE)
            : MIRED_MIN_VALUE;

        return {
            prefix: values[0], // device prefix.
            brightness,
            brightnessAdjustable,
            colorTemperature,
            colorTemperatureHw,
            colorTemperatureAdjustable,
        }
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const values = this.parseLightbulbValue(device.op["value"]);
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    on: device.op["status"] === "on",
                    ...values,
                });
                if(!accessory)
                    continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.Lightbulb);
                service?.setCharacteristic(this.api.hap.Characteristic.On, context.on);
                if(context.brightnessAdjustable)
                    service?.setCharacteristic(this.api.hap.Characteristic.Brightness, context.brightness);
                if(context.colorTemperatureAdjustable)
                    service?.setCharacteristic(this.api.hap.Characteristic.ColorTemperature, context.colorTemperature);
            }
        });
    }
}
