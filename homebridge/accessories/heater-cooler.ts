import {Accessories, AccessoryInterface} from "./accessories";
import {
    API, Characteristic,
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
import {WithUUID} from "hap-nodejs";

export interface HeaterCoolerAccessoryInterface extends AccessoryInterface {

    active: boolean
    desiredTemperature: number
    currentTemperature: number

}

export abstract class HeaterCoolerAccessories extends Accessories<HeaterCoolerAccessoryInterface> {

    protected constructor(log: Logging,
                api: API,
                config: DaelimConfig,
                accessoryTypes: string[],
                protected readonly minimumTemperature: number,
                protected readonly maximumTemperature: number) {
        super(log, api, config, accessoryTypes, [api.hap.Service.HeaterCooler]);
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
                        device: this.getDeviceType(),
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
                this.refreshHeaterCoolerState(response['item'] || []);
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
                validValues: this.getAvailableCurrentHeaterCoolerStates(),
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
                validValues: this.getAvailableTargetHeaterCoolerStates(),
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

        service.getCharacteristic(this.getThresholdTemperatureCharacteristic())
            .setValue(this.getThresholdTemperature(accessory))
            .setProps({
                minValue: this.minimumTemperature,
                maxValue: this.maximumTemperature,
                minStep: 1
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if(accessory.context.desiredTemperature === value || !accessory.context.active) {
                    // Temperature slider is disabled when the accessory is not active
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: this.getDeviceType(),
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
                this.refreshHeaterCoolerState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getThresholdTemperature(accessory));
            });

        service.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .setValue(this.getCurrentTemperature(accessory))
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, this.getCurrentTemperature(accessory));
            });
    }

    refreshHeaterCoolerState(items: any[], force: boolean = false) {
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
                const desiredTemperature = parseInt(item['arg2']) || accessory.context.desiredTemperature;
                const currentTemperature = parseInt(item['arg3']) || accessory.context.currentTemperature;
                accessory.context.desiredTemperature = desiredTemperature;
                accessory.context.currentTemperature = currentTemperature;
                accessory.context.active = active && desiredTemperature >= this.minimumTemperature;
                accessory.context.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.HeaterCooler, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.getCurrentTemperature(accessory));
                        service.setCharacteristic(this.api.hap.Characteristic.Active, accessory.context.active ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
                        service.setCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState(accessory));
                        service.setCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState());
                        service.setCharacteristic(this.getThresholdTemperatureCharacteristic(), this.getThresholdTemperature(accessory));
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
            this.refreshHeaterCoolerState(body['item'] || [], false);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshHeaterCoolerState(body['item'] || [], false);
        });
    }

    getThresholdTemperature(accessory: PlatformAccessory): CharacteristicValue {
        return Math.max(this.minimumTemperature, Math.min(this.maximumTemperature, parseFloat(accessory.context.desiredTemperature)));
    }

    getCurrentTemperature(accessory: PlatformAccessory): CharacteristicValue {
        return parseFloat(accessory.context.currentTemperature);
    }

    abstract getThresholdTemperatureCharacteristic(): WithUUID<{ new(): Characteristic }>;

    abstract getCurrentHeaterCoolerState(accessory: PlatformAccessory): CharacteristicValue;

    abstract getAvailableCurrentHeaterCoolerStates(): number[];

    abstract getTargetHeaterCoolerState(): CharacteristicValue;

    abstract getAvailableTargetHeaterCoolerStates(): number[];

}