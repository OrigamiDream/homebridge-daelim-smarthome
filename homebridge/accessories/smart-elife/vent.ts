import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory, Service
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {SwitchableAccessories, SwitchableAccessoryInterface} from "./switchable-accessories";

enum FanRotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
}

const FAN_ROTATION_SPEED_STEP = 100 / 3.0;

interface VentAccessoryInterface extends SwitchableAccessoryInterface {
    rotationSpeed: FanRotationSpeed
}

export default class VentAccessories extends SwitchableAccessories<VentAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.VENT, [api.hap.Service.Fan], api.hap.Service.Fan);
    }

    private homebridgeToFanRotationSpeed(value: number): FanRotationSpeed {
        if(value <= 0) return FanRotationSpeed.OFF;
        if(value <= FAN_ROTATION_SPEED_STEP) return FanRotationSpeed.LOW;
        if(value <= FAN_ROTATION_SPEED_STEP * 2) return FanRotationSpeed.MIDDLE;
        return FanRotationSpeed.HIGH;
    }

    private fanRotationSpeedToHomebridge(rotationSpeed: FanRotationSpeed): number {
        switch (rotationSpeed) {
            case FanRotationSpeed.OFF: return 0;
            case FanRotationSpeed.LOW: return FAN_ROTATION_SPEED_STEP;
            case FanRotationSpeed.MIDDLE: return FAN_ROTATION_SPEED_STEP * 2;
            case FanRotationSpeed.HIGH: return 100;
        }
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        this.getService(this.api.hap.Service.Fan, services)
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: FAN_ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const numeric = value as number;
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const speed = this.homebridgeToFanRotationSpeed(numeric);
                this.log.debug(`Vent :: SET :: RotationSpeed: ${numeric.toFixed(2)} (HomeKit) -> ${speed.toString()}`);
                if(context.rotationSpeed === speed) {
                    callback(undefined);
                    return;
                }
                context.rotationSpeed = speed;

                // If the user sets a non-zero speed, ensure the fan is logically on.
                // If they set 0, treat it as off.
                const prev = context.on;
                context.on = speed !== FanRotationSpeed.OFF;
                if(prev !== context.on) {
                    const value = context.on ? "on" : "off";
                    this.log.debug(`Vent :: SET :: %s (due to fan speed: %s)`, value, speed.toString());
                    await this.setDeviceState({
                        ...device, op: { control: value },
                    });
                }

                this.defer(device.deviceId, this.setDeviceState({
                    ...device,
                    op: {
                        "wind_speed": speed.toString(),
                    }
                }));
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.init) {
                    callback(new Error("Not initialized."));
                    return;
                }
                callback(undefined, this.fanRotationSpeedToHomebridge(context.rotationSpeed));
            });
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const on = device.op["status"] === "on";
                const rotationSpeed = on ? device.op["wind_speed"] as FanRotationSpeed || FanRotationSpeed.OFF : FanRotationSpeed.OFF;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    on: on,
                    rotationSpeed: rotationSpeed,
                });
                if(!accessory)
                    continue;

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.Fan);
                service?.setCharacteristic(this.api.hap.Characteristic.On, context.on);
                service?.setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.fanRotationSpeedToHomebridge(context.rotationSpeed));
            }
        });
    }
}
