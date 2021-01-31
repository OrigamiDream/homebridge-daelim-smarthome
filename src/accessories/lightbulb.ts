import {Accessories, AccessoryInterface} from "./accessories";
import {DeviceSubTypes, LoginSubTypes, Types} from "../components/fields";
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

interface LightbulbAccessoryInterface extends AccessoryInterface {

    brightness: number
    brightnessAdjustable: boolean
    on: boolean

}

export class LightbulbAccessories extends Accessories<LightbulbAccessoryInterface> {

    constructor(log: Logging, api: API) {
        super(log, api, api.hap.Service.Lightbulb);
    }

    configureAccessory(accessory: PlatformAccessory, service: Service) {
        super.configureAccessory(accessory, service);

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
                callback(undefined, accessory.context.on);
            });
        if(accessory.context.brightnessAdjustable) {
            service.getCharacteristic(this.api.hap.Characteristic.Brightness)
                .setProps({
                    minValue: 0,
                    maxValue: 80,
                    minStep: 10
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    let brightness = value;
                    if(brightness >= 80) {
                        brightness = 100;
                    }
                    accessory.context.brightness = brightness;
                    const response = await this.client?.sendDeferredRequest({
                        type: 'invoke',
                        item: [ this.createItemInterface(accessory, brightness >= 10) ]
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
                    callback(undefined, accessory.context.brightness);
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

    refreshLightbulbState(items: any[]) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                accessory.context.on = item['arg1'] === 'on';

                if(accessory.context.brightnessAdjustable && accessory.context.on) {
                    // Update new brightness rate when the accessory is on.
                    accessory.context.brightness = parseInt(item['arg2']);
                }
            }
        }
    }

    registerListeners() {
        this.client?.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            const controls = body['controlinfo'];
            const lights = controls['light'];
            for(let i = 0; i < lights.length; i++) {
                const light = lights[i];

                const deviceID = light['uid'];
                const displayName = light['uname'];

                const brightnessAdjustable = light['dimming'] === 'y';

                this.addAccessory({
                    deviceID: deviceID,
                    displayName: displayName,
                    brightness: 0,
                    brightnessAdjustable: brightnessAdjustable,
                    on: false
                });
            }
            this.client?.sendRequest({
                type: 'query',
                item: [{
                    device: 'light',
                    uid: 'All'
                }]
            }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.refreshLightbulbState(body['item'] || []);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshLightbulbState(body['item'] || []);
        });
    }

}