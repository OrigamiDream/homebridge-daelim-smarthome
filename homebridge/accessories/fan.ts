import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Formats,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {DeviceSubTypes, Types} from "../../core/fields";

export const FAN_MENU_NAME = "환기";
export const FAN_ROTATION_SPEED_UNIT = 100 / 3.0;

enum FanRotationSpeed {
    OFF = "00",
    WEAK = "01",
    NORMAL = "02",
    STRONG = "03"
}

interface FanAccessoryInterface extends AccessoryInterface {
    active: boolean
    rotationSpeed: FanRotationSpeed
}

export class FanAccessories extends Accessories<FanAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["fan"], [api.hap.Service.Fan]);
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.Fan, services);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // Old state is same with new state
                const isActive = !!value;
                if(accessory.context.active === isActive) {
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'fan',
                        uid: accessory.context.deviceID,
                        arg1: isActive ? "on" : "off"
                    }]
                }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                    return this.matchesAccessoryDeviceID(accessory, body);
                }).catch(_ => {
                    return undefined;
                });
                if(response === undefined) {
                    callback(new Error('TIMED OUT'));
                    return;
                }
                this.refreshFanState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.active ? 1 : 0);
            });
        service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: Formats.FLOAT,
                minValue: 0,
                maxValue: 100, // Up to level 3
                minStep: FAN_ROTATION_SPEED_UNIT
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = accessory.context as FanAccessoryInterface;
                const speedIndex = Math.max(0, Math.min(3, parseInt(((value as number) / FAN_ROTATION_SPEED_UNIT).toFixed(0))));
                const oldRotationSpeed = ctx.rotationSpeed;
                const newRotationSpeed = `0${speedIndex}` as FanRotationSpeed;
                if(oldRotationSpeed === newRotationSpeed) {
                    callback(undefined);
                    return;
                }
                if(!ctx.active) {
                    // turn on the fan
                    const response = await this.client?.sendDeferredRequest({
                        type: 'invoke',
                        item: [{
                            device: 'fan',
                            uid: ctx.deviceID,
                            arg1: "on"
                        }]
                    }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                        return this.matchesAccessoryDeviceID(accessory, body);
                    }).catch(_ => {
                        return undefined;
                    });
                    if(response === undefined) {
                        callback(new Error('TIMED OUT'));
                        return;
                    }
                } else if(newRotationSpeed === FanRotationSpeed.OFF) {
                    callback(undefined);
                    return;
                }
                // set the fan rotation speed
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'fan',
                        uid: ctx.deviceID,
                        arg1: "on",
                        arg2: newRotationSpeed,
                        arg3: ""
                    }]
                }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                    return this.matchesAccessoryDeviceID(accessory, body);
                }).catch(_ => {
                    return undefined;
                });
                if(response === undefined) {
                    callback(new Error('TIMED OUT'));
                    return;
                }
                this.refreshFanState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                const ctx = accessory.context as FanAccessoryInterface;
                callback(undefined, this.getRotationSpeedPercentage(ctx));
            });
    }

    refreshFanState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            if(deviceType !== this.getDeviceType()) {
                continue;
            }
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                const ctx = accessory.context as FanAccessoryInterface;
                ctx.active = item['arg1'] === 'on';
                if(item['arg2'] === '') {
                    ctx.rotationSpeed = FanRotationSpeed.OFF;
                } else {
                    ctx.rotationSpeed = item['arg2'] as FanRotationSpeed;
                }
                ctx.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.Fan, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.On, ctx.active ? 1 : 0);
                        service.setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.getRotationSpeedPercentage(ctx));
                    });
                }
            }
        }
    }

    registerListeners() {
        super.registerListeners();
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            if(!this.client?.isDeviceSupported(FAN_MENU_NAME)) {
                return;
            }
            this.registerLazyAccessories(body, (deviceID, displayName) => {
                return {
                    deviceID: deviceID,
                    displayName: displayName,
                    init: false,
                    active: false,
                    rotationSpeed: FanRotationSpeed.OFF
                };
            });
            this.refreshFanState(body['item'] || [], true);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshFanState(body['item'] || [], true);
        });
    }

    getRotationSpeedPercentage(ctx: FanAccessoryInterface): number {
        const speedIndex = parseInt(ctx.rotationSpeed);
        return speedIndex * FAN_ROTATION_SPEED_UNIT;
    }

}