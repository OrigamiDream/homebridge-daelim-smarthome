import {Accessories, AccessoryInterface} from "./accessories";
import {DeviceSubTypes, Types} from "../../../core/daelim/fields";
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
import {DaelimConfig} from "../../../core/interfaces/daelim-config";

interface LightbulbAccessoryInterface extends AccessoryInterface {

    brightness: number
    brightnessAdjustable: boolean
    on: boolean
    maxBrightness: number
    minBrightness: number
    minSteps: number
    brightnessExceedJumpTo: number
    brightnessSettingIndex: number

}

interface BrightnessAdjustableSettings {

    condition: (deviceID: string, brightness?: string) => boolean
    maxBrightness: number
    minBrightness: number
    minSteps: number
    brightnessExceedJumpTo: number

    getBrightness: (brightness: number, settings: BrightnessAdjustableSettings) => number,
    fromBrightness: (brightness: CharacteristicValue, settings: BrightnessAdjustableSettings) => number,

}

export const REGEX_PATTERN_FOR_3_LEVEL_LIGHTBULB = /Lt([0-9]{0,2})-([0-9]{0,2})/i;
export const MINIMUM_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB = 1;
export const SECONDARY_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB = 3;
export const MAX_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB = 6;

function check3LevelBrightnessLightbulb(deviceID: string) {
    return REGEX_PATTERN_FOR_3_LEVEL_LIGHTBULB.test(deviceID);
}

const BRIGHTNESS_ADJUSTABLE_SETTINGS: BrightnessAdjustableSettings[] = [
    {
        condition: (deviceID, brightness) => {
            return brightness !== undefined && brightness.length >= 2; // 00, 10, 20, ...
        },
        maxBrightness: 80,
        minBrightness: 10,
        minSteps: 100 / 8,
        brightnessExceedJumpTo: 100,

        getBrightness: (brightness, settings) => {
            return (brightness / 10) * settings.minSteps;
        },
        fromBrightness: (brightness, settings) => {
            const level = (brightness as number) / settings.minSteps * 10;
            if(level >= settings.maxBrightness) {
                return settings.brightnessExceedJumpTo;
            }
            return level;
        }
    },
    {
        condition: (deviceID, brightness) => {
            return check3LevelBrightnessLightbulb(deviceID) && (brightness === undefined || brightness.length == 1); // 0, 1, 3, 6
        },
        maxBrightness: 6,
        minBrightness: 1,
        minSteps: 100 / 3, // 1, 3, 6
        brightnessExceedJumpTo: 6,

        getBrightness: (brightness, settings) => {
            if(brightness === 0) {
                return 0;
            } else if(brightness === MINIMUM_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB) {
                return settings.minSteps;
            } else if(brightness === SECONDARY_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB) {
                return settings.minSteps * 2;
            } else {
                return settings.minSteps * 3;
            }
        },
        fromBrightness: (brightness, settings) => {
            const level = parseInt(((brightness as number) / settings.minSteps).toFixed(0));
            if(level === 0) {
                return 0;
            } else if(level === 1) {
                return MINIMUM_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB;
            } else if(level === 2) {
                return SECONDARY_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB;
            } else {
                return MAX_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB;
            }
        }
    }
]

export class LightbulbAccessories extends Accessories<LightbulbAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["light", "lightbulb"], [api.hap.Service.Lightbulb], ["dimming"]);
    }

    async identify(accessory: PlatformAccessory) {
        await super.identify(accessory);

        const alreadyOn = !!accessory.context.on;
        const procedures = [ !alreadyOn, alreadyOn ];
        for(let i = 0; i < procedures.length; i++) {
            const procedure = procedures[i];
            const response = await this.client?.sendDeferredRequest({
                type: 'invoke',
                item: [ this.createItemInterface(accessory, procedure) ]
            }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                return this.matchesAccessoryDeviceID(accessory, body);
            }).catch(_ => {
                return undefined;
            });
            if(response === undefined) {
                this.log.warn("The accessory %s does not respond", accessory.displayName);
                break;
            }
        }
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.Lightbulb, services);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // Old state is same with new state
                if(accessory.context.on === value) {
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [ this.createItemInterface(accessory, !!value) ]
                }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                    return this.matchesAccessoryDeviceID(accessory, body);
                }).catch(_ => {
                    return undefined;
                });
                if(response === undefined) {
                    callback(new Error('TIMED OUT'));
                    return;
                }
                this.refreshLightbulbState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.on);
            });
        if(accessory.context.brightnessAdjustable) {
            service.getCharacteristic(this.api.hap.Characteristic.Brightness)
                .setProps({
                    format: this.api.hap.Formats.FLOAT,
                    minValue: 0,
                    maxValue: 100,
                    minStep: accessory.context.minSteps
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const context = accessory.context as LightbulbAccessoryInterface;
                    const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[context.brightnessSettingIndex];
                    const brightness = Math.round(settings.fromBrightness(value, settings));

                    if(accessory.context.brightness === brightness) {
                        callback(undefined);
                        return;
                    }
                    accessory.context.brightness = brightness;

                    const response = await this.client?.sendDeferredRequest({
                        type: 'invoke',
                        item: [ this.createItemInterface(accessory, brightness >= context.minBrightness) ]
                    }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                        return this.matchesAccessoryDeviceID(accessory, body);
                    }).catch(_ => {
                        return undefined;
                    });
                    if(response === undefined) {
                        callback(new Error('TIMED OUT'));
                        return;
                    }
                    this.refreshLightbulbState(response['item'] || []);
                    callback(undefined);
                })
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    if(!this.checkAccessoryAvailability(accessory, callback)) {
                        return;
                    }
                    const context = accessory.context as LightbulbAccessoryInterface;
                    const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[context.brightnessSettingIndex];
                    const brightness = settings.getBrightness(Math.min(context.maxBrightness, context.brightness), settings);
                    callback(undefined, brightness);
                });
        }
    }

    createItemInterface(accessory: PlatformAccessory, isActive: boolean): any {
        const context = accessory.context as LightbulbAccessoryInterface;
        let item: any = {
            device: "light",
            uid: context.deviceID,
            arg1: isActive ? "on" : "off"
        };
        if(isActive && context.brightnessAdjustable) {
            item["arg2"] = String(context.brightness);
            item["arg3"] = "y";
        }
        return item;
    }

    refreshLightbulbState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            if(deviceType !== this.getDeviceType()) {
                continue;
            }
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                const ctx = accessory.context as LightbulbAccessoryInterface;
                ctx.on = item['arg1'] === 'on';
                ctx.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.On, ctx.on);
                    });
                }

                if(ctx.brightnessAdjustable) {
                    // Update new brightness rate when the accessory is on.
                    let brightness = item['arg2'];
                    if(check3LevelBrightnessLightbulb(ctx.deviceID) && brightness === undefined) {
                        brightness = ctx.on ? MAX_BRIGHTNESS_FOR_3_LEVEL_LIGHTBULB : 0;
                    }
                    const index = this.findAdjustableBrightnessSettingIndex(ctx.deviceID, brightness.toString());
                    const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[index];

                    if(force) {
                        ctx.minBrightness = settings.minBrightness;
                        ctx.maxBrightness = settings.maxBrightness;
                        ctx.minSteps = settings.minSteps;
                        ctx.brightnessExceedJumpTo = settings.brightnessExceedJumpTo;
                        ctx.brightnessSettingIndex = index;
                        this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                            service.getCharacteristic(this.api.hap.Characteristic.Brightness)
                                .setProps({
                                    minValue: 0,
                                    maxValue: 100,
                                    minStep: ctx.minSteps,
                                });
                        });
                    }

                    if(ctx.on) {
                        ctx.brightness = parseInt(brightness);

                        if(force) {
                            this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                                const brightness = settings.getBrightness(Math.min(ctx.maxBrightness, ctx.brightness), settings)
                                service.setCharacteristic(this.api.hap.Characteristic.Brightness, brightness);
                            });
                        }
                    }
                }
            }
        }
    }

    registerListeners() {
        super.registerListeners();
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.registerLazyAccessories(body, (deviceID, displayName, info) => {
                const brightnessAdjustable = info["dimming"] === "y";
                return {
                    deviceID: deviceID,
                    displayName: displayName,
                    init: false,
                    brightness: 0,
                    brightnessAdjustable: brightnessAdjustable,
                    on: false,
                    maxBrightness: 100,
                    minBrightness: 0,
                    minSteps: 10,
                    brightnessExceedJumpTo: 100,
                    brightnessSettingIndex: 0
                };
            })
            this.refreshLightbulbState(body['item'] || [], true);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshLightbulbState(body['item'] || [], true);
        });
    }

    findAdjustableBrightnessSettingIndex(deviceID: string, brightness: string): number {
        for(let i = 0; i < BRIGHTNESS_ADJUSTABLE_SETTINGS.length; i++) {
            const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[i];
            if(settings.condition(deviceID, brightness)) {
                return i;
            }
        }
        return 0;
    }
}