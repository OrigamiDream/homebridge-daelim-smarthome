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
import {DeviceSubTypes, Types} from "../../core/fields";
import {DaelimConfig} from "../../core/interfaces/daelim-config";

interface HeaterAccessoryInterface extends AccessoryInterface {

    active: boolean
    desiredTemperature: number
    currentTemperature: number

}

export class HeaterAccessories extends Accessories<HeaterAccessoryInterface> {

    public static MINIMUM_TEMPERATURE = 5;
    public static MAXIMUM_TEMPERATURE = 40;

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["heating", "heater"], [api.hap.Service.HeaterCooler]);
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.HeaterCooler, services);

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
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getCurrentHeaterCoolerState(accessory));
            });

        service.getCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState)
            .setValue(this.getTargetHeaterCoolerState())
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT,
                ],
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // NOTE: No need to update heater state
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getTargetHeaterCoolerState());
            });

        service.getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
            .setValue(this.getHeatingThresholdTemperature(accessory))
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
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getHeatingThresholdTemperature(accessory));
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .setValue(this.getCurrentTemperature(accessory))
            .setProps({
                minValue: HeaterAccessories.MINIMUM_TEMPERATURE,
                maxValue: HeaterAccessories.MAXIMUM_TEMPERATURE,
                minStep: 1
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getCurrentTemperature(accessory));
            });
    }

    refreshHeaterState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            if(deviceType !== this.getDeviceType()) {
                continue;
            }
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                const active = item['arg1'] === 'on';
                const desiredTemperature = parseInt(item['arg2']);
                const currentTemperature = parseInt(item['arg3']);

                accessory.context.desiredTemperature = desiredTemperature;
                accessory.context.currentTemperature = currentTemperature;
                accessory.context.active = active && desiredTemperature >= HeaterAccessories.MINIMUM_TEMPERATURE;
                accessory.context.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.HeaterCooler, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.getCurrentTemperature(accessory));
                        service.setCharacteristic(this.api.hap.Characteristic.Active, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState(accessory));
                        service.setCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState());
                        service.setCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature, this.getHeatingThresholdTemperature(accessory));
                    });
                }
            }
        }
    }

    registerListeners() {
        super.registerListeners();
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.registerLazyAccessories(body, (deviceID, displayName) => {
                return {
                    deviceID: deviceID,
                    displayName: displayName,
                    init: false,
                    active: false,
                    desiredTemperature: 0,
                    currentTemperature: 0
                }
            })
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

    getTargetHeaterCoolerState(): CharacteristicValue {
        return this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT;
    }

    getHeatingThresholdTemperature(accessory: PlatformAccessory): CharacteristicValue {
        return Math.max(HeaterAccessories.MINIMUM_TEMPERATURE, Math.min(HeaterAccessories.MAXIMUM_TEMPERATURE, parseFloat(accessory.context.desiredTemperature)))
    }

    getCurrentTemperature(accessory: PlatformAccessory): CharacteristicValue {
        return Math.max(HeaterAccessories.MINIMUM_TEMPERATURE, Math.min(HeaterAccessories.MAXIMUM_TEMPERATURE, parseFloat(accessory.context.currentTemperature)));
    }

}