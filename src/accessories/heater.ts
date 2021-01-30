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
import {DeviceSubTypes, LoginSubTypes, Types} from "../components/fields";

interface HeaterAccessoryInterface extends AccessoryInterface {

    active: boolean
    desiredTemperature: number
    currentTemperature: number

}

export class HeaterAccessories extends Accessories<HeaterAccessoryInterface> {

    public static MINIMUM_TEMPERATURE = 5;
    public static MAXIMUM_TEMPERATURE = 40;

    constructor(log: Logging, api: API) {
        super(log, api, api.hap.Service.HeaterCooler);
    }

    configureAccessory(accessory: PlatformAccessory, service: Service) {
        super.configureAccessory(accessory, service);

        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'heating',
                        uid: accessory.context.deviceID,
                        arg1: value === this.api.hap.Characteristic.Active.ACTIVE ? "on" : "off"
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
                this.refreshHeaterState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                maxValue: this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING,
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = accessory.context;
                let value;
                if(context.active) {
                    if(context.desiredTemperature > context.currentTemperature) {
                        value = this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
                    } else {
                        value = this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
                    }
                } else {
                    value = this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
                }
                callback(undefined, value);
            });

        service.getCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState)
            .setProps({
                minValue: this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT,
                maxValue: this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // NOTE: No need to update heater state
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = accessory.context;
                if(context.active) {
                    if(context.desiredTemperature > context.currentTemperature) {
                        callback(undefined, this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT);
                    } else {
                        callback(undefined, this.api.hap.Characteristic.TargetHeaterCoolerState.COOL);
                    }
                } else {
                    callback(undefined, this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO);
                }
            });

        service.getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
            .setProps({
                minValue: HeaterAccessories.MINIMUM_TEMPERATURE,
                maxValue: HeaterAccessories.MAXIMUM_TEMPERATURE,
                minStep: 1
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'heating',
                        uid: accessory.context.deviceID,
                        arg1: 'on',
                        arg2: value.toString()
                    }]
                }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
                    return this.matchesAccessoryDeviceID(accessory, body);
                }).catch(_ => {
                    return undefined;
                });
                if(response === undefined) {
                    callback(new Error('TIMED OUT'));
                    return;
                }
                this.refreshHeaterState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, parseFloat(accessory.context.desiredTemperature));
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .setProps({
                minStep: 1
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, parseFloat(accessory.context.currentTemperature));
            });
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

    refreshHeaterState(items: any[]) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];

            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                const active = item['arg1'] === 'on';
                const desiredTemperature = parseInt(item['arg2']);
                const currentTemperature = parseInt(item['arg3']);

                accessory.context.desiredTemperature = desiredTemperature;
                accessory.context.currentTemperature = currentTemperature;
                accessory.context.active = active && desiredTemperature >= HeaterAccessories.MINIMUM_TEMPERATURE;
            }
        }
    }

    registerListeners() {
        this.client?.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            const controls = body['controlinfo'];
            const heaters = controls['heating'];
            for(let i = 0; i < heaters.length; i++) {
                const heater = heaters[i];

                const deviceID = heater['uid'];
                const displayName = heater['uname'];

                this.addAccessory({
                    deviceID: deviceID,
                    displayName: displayName,
                    active: false,
                    desiredTemperature: 0,
                    currentTemperature: 0
                });
            }
            this.client?.sendRequest({
                type: 'query',
                item: [{
                    device: 'heating',
                    uid: 'All'
                }]
            }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.refreshHeaterState(body['item'] || []);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshHeaterState(body['item'] || []);
        });
    }

}