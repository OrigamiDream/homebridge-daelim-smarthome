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
                // Old state is same with new state
                const isActive = value === this.api.hap.Characteristic.Active.ACTIVE;
                if(accessory.context.active === isActive) {
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'heating',
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
                this.refreshHeaterState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                maxValue: this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING,
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, this.getCurrentHeaterCoolerState(accessory));
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
                this.client?.checkKeepAlive();
                callback(undefined, this.getTargetHeaterCoolerState(accessory));
            });

        service.getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
            .setProps({
                minValue: HeaterAccessories.MINIMUM_TEMPERATURE,
                maxValue: HeaterAccessories.MAXIMUM_TEMPERATURE,
                minStep: 1
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if(accessory.context.desiredTemperature === value) {
                    callback(undefined);
                    return;
                }
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
                this.client?.checkKeepAlive();
                callback(undefined, Math.max(HeaterAccessories.MINIMUM_TEMPERATURE, Math.min(HeaterAccessories.MAXIMUM_TEMPERATURE, parseFloat(accessory.context.desiredTemperature))));
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .setProps({
                minStep: 1
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
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

    refreshHeaterState(items: any[], force: boolean = false) {
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
                if(force) {
                    this.findService(accessory, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, parseFloat(accessory.context.currentTemperature));
                        service.setCharacteristic(this.api.hap.Characteristic.Active, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState(accessory));
                        service.setCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState(accessory));
                    });
                }
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
            this.client?.sendUnreliableRequest({
                type: 'query',
                item: [{
                    device: 'heating',
                    uid: 'All'
                }]
            }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.refreshHeaterState(body['item'] || [], true);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshHeaterState(body['item'] || [], true);
        });
    }

    getCurrentHeaterCoolerState(accessory: PlatformAccessory): CharacteristicValue {
        const context = accessory.context;
        if(context.active) {
            if(context.desiredTemperature > context.currentTemperature) {
                return this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
            } else {
                return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
            }
        } else {
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
    }

    getTargetHeaterCoolerState(accessory: PlatformAccessory): CharacteristicValue {
        return this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT;
    }

}