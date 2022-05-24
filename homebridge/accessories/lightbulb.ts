import {Accessories, AccessoryInterface} from "./accessories";
import {DeviceSubTypes, LoginSubTypes, Types} from "../../core/fields";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue, Formats,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";

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

    condition: (brightness: string) => boolean
    maxBrightness: number
    minBrightness: number
    minSteps: number
    brightnessExceedJumpTo: number

    getBrightness: (brightness: number, settings: BrightnessAdjustableSettings) => number,
    fromBrightness: (brightness: CharacteristicValue, settings: BrightnessAdjustableSettings) => number,

}

const BRIGHTNESS_ADJUSTABLE_SETTINGS: BrightnessAdjustableSettings[] = [
    {
        condition: brightness => brightness.length >= 2, // 00, 10, 20, ...
        maxBrightness: 80,
        minBrightness: 10,
        minSteps: 100 / 8, // 10,
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
        condition: brightness => brightness.length == 1, // 0, 1, 2, ...
        maxBrightness: 7,
        minBrightness: 1,
        minSteps: 100 / 7, // 1
        brightnessExceedJumpTo: 7,

        getBrightness: (brightness, settings) => {
            return brightness * settings.minSteps;
        },
        fromBrightness: (brightness, settings) => {
            const level = (brightness as number) / settings.minSteps;
            if(level >= settings.maxBrightness) {
                return settings.brightnessExceedJumpTo;
            }
            return level;
        }
    }
]

export class LightbulbAccessories extends Accessories<LightbulbAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, ["light", "lightbulb"], [api.hap.Service.Lightbulb]);
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
                    format: Formats.FLOAT,
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
        let item: any = {
            device: "light",
            uid: accessory.context.deviceID,
            arg1: isActive ? "on" : "off"
        };
        if(isActive) {
            item["arg2"] = String(accessory.context.brightness)
        }
        return item;
    }

    matchesAccessoryDeviceID(accessory: PlatformAccessory, body: any): boolean {
        const items = body['item'] || [];
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceID = item['uid'];
            if(accessory.context.deviceID === deviceID) {
                return true;
            }
        }
        return false;
    }

    refreshLightbulbState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                accessory.context.on = item['arg1'] === 'on';
                accessory.context.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.On, accessory.context.on);
                    });
                }

                if(accessory.context.brightnessAdjustable) {
                    // Update new brightness rate when the accessory is on.
                    const brightness = item['arg2'];
                    const index = this.findAdjustableBrightnessSettingIndex(brightness);
                    const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[index];

                    if(force) {
                        accessory.context.minBrightness = settings.minBrightness;
                        accessory.context.maxBrightness = settings.maxBrightness;
                        accessory.context.minSteps = settings.minSteps;
                        accessory.context.brightnessExceedJumpTo = settings.brightnessExceedJumpTo;
                        accessory.context.brightnessSettingIndex = index;
                        this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                            service.getCharacteristic(this.api.hap.Characteristic.Brightness)
                                .setProps({
                                    minValue: 0,
                                    maxValue: 100,
                                    minStep: accessory.context.minSteps,
                                });
                        });
                    }

                    if(accessory.context.on) {
                        accessory.context.brightness = parseInt(brightness);

                        if(force) {
                            this.findService(accessory, this.api.hap.Service.Lightbulb, (service) => {
                                const brightness = settings.getBrightness(Math.min(accessory.context.maxBrightness, accessory.context.brightness), settings)
                                service.setCharacteristic(this.api.hap.Characteristic.Brightness, brightness);
                            });
                        }
                    }
                }
            }
        }
    }

    registerListeners() {
        this.client?.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            const controls = body['controlinfo'];
            const lights = controls['light'];
            if(lights) {
                for(let i = 0; i < lights.length; i++) {
                    const light = lights[i];

                    const deviceID = light['uid'];
                    const displayName = light['uname'];

                    const brightnessAdjustable = light['dimming'] === 'y';

                    this.addAccessory({
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
                    });
                }
                this.client?.sendUnreliableRequest({
                    type: 'query',
                    item: [{
                        device: 'light',
                        uid: 'All'
                    }]
                }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
            }
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.refreshLightbulbState(body['item'] || [], true);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshLightbulbState(body['item'] || [], true);
        });
    }

    findAdjustableBrightnessSettingIndex(brightness: string): number {
        for(let i = 0; i < BRIGHTNESS_ADJUSTABLE_SETTINGS.length; i++) {
            const settings = BRIGHTNESS_ADJUSTABLE_SETTINGS[i];
            if(settings.condition(brightness)) {
                return i;
            }
        }
        return 0;
    }
}