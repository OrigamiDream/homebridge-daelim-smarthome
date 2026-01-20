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
import {DeviceSubTypes, Types} from "../../core/daelim/fields";
import {DaelimConfig} from "../../core/interfaces/daelim-config";

interface GasAccessoryInterface extends AccessoryInterface {

    on: boolean

}

export class GasAccessories extends Accessories<GasAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["gas"], [api.hap.Service.LockMechanism]);
        this.removeLegacyService = true; // Magic flag for Valve → LockMechanism migration
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        if(!!accessory.context.on) {
            const response = await this.client?.sendDeferredRequest({
                type: 'invoke',
                item: [{
                    device: 'gas',
                    uid: accessory.context.deviceID,
                    arg1: "off"
                }]
            }, Types.DEVICE, DeviceSubTypes.INVOKE_REQUEST, DeviceSubTypes.INVOKE_RESPONSE, body => {
                return this.matchesAccessoryDeviceID(accessory, body);
            }).catch(_ => {
                return undefined;
            });
            if(response === undefined) {
                this.log.warn("The accessory %s does not respond", accessory.displayName);
            }
        } else {
            this.log.warn("The accessory %s is currently off, identification is impossible", accessory.displayName);
        }
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.LockMechanism, services);
        service.getCharacteristic(this.api.hap.Characteristic.Name)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.displayName);
            });
        service.getCharacteristic(this.api.hap.Characteristic.LockCurrentState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.on ? this.api.hap.Characteristic.LockCurrentState.UNSECURED : this.api.hap.Characteristic.LockCurrentState.SECURED);
            });
        service.getCharacteristic(this.api.hap.Characteristic.LockTargetState)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = accessory.context as GasAccessoryInterface;
                const isActive = value === this.api.hap.Characteristic.LockTargetState.UNSECURED;
                // Previous state is same with new state
                if(ctx.on === isActive) {
                    callback(undefined);
                    return;
                }
                if(!ctx.on) {
                    if(isActive) {
                        this.client?.sendUnreliableRequest({
                            type: 'query',
                            item: [{
                                device: 'gas',
                                uid: 'all'
                            }]
                        }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
                    }
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'gas',
                        uid: ctx.deviceID,
                        arg1: 'off'
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
                this.refreshGasValveState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.on ? this.api.hap.Characteristic.LockCurrentState.UNSECURED : this.api.hap.Characteristic.LockCurrentState.SECURED);
            });
    }

    refreshGasValveState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            if(deviceType !== this.getDeviceType()) {
                continue;
            }
            const deviceID = item['uid'];
            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                accessory.context.on = item['arg1'] === 'on';
                accessory.context.init = true;
                if(force) {
                    this.findService(accessory, this.api.hap.Service.LockMechanism, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.LockCurrentState, accessory.context.on ? this.api.hap.Characteristic.LockCurrentState.UNSECURED : this.api.hap.Characteristic.LockCurrentState.SECURED);
                        service.setCharacteristic(this.api.hap.Characteristic.LockTargetState, accessory.context.on ? this.api.hap.Characteristic.LockCurrentState.UNSECURED : this.api.hap.Characteristic.LockCurrentState.SECURED);
                    })
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
                    on: true // active as a default since this is off-only valve
                }
            })
            this.refreshGasValveState(body['item'] || [], true);
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshGasValveState(body['item'] || [], true);
        });
    }

}