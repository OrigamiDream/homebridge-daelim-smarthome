import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {DeviceSubTypes, Types} from "../../core/daelim/fields";

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

const FAN_SPEED_SUPPORTED_COMPLEXES = [
    'naturedasan3', // 다산신도시자연앤e편한세상2차, 자연앤이편한세상3차
    'yangju4', // e편한세상 옥정메트로포레
    'sooncheon', // e편한세상 순천(1~10), e편한세상 순천(11~12)
    'changwon', // e편한세상 창원파크센트럴1단지, e편한세상 창원파크센트럴2단지
    'sunbusquare', // e편한세상 선부역 어반스퀘어
    'inchang', // e편한세상 인창어반포레
    'youngcheon' // e편한세상 영천1단지, e편한세상 영천2단지
]

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
        if(this.client?.doesComplexMatch(FAN_SPEED_SUPPORTED_COMPLEXES)) {
            service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
                .setProps({
                    format: this.api.hap.Formats.FLOAT,
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
                        if(this.client?.doesComplexMatch(FAN_SPEED_SUPPORTED_COMPLEXES)) {
                            service.setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.getRotationSpeedPercentage(ctx));
                        }
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