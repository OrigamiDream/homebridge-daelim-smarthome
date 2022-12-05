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

interface OutletAccessoryInterface extends AccessoryInterface {

    on: boolean

}

export class OutletAccessories extends Accessories<OutletAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, ["wallsocket", "outlet"], [api.hap.Service.Outlet]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        const alreadyOn = !!accessory.context.on;
        const procedures = [ !alreadyOn, alreadyOn ];
        for(let i = 0; i < procedures.length; i++) {
            const procedure = procedures[i];
            const response = await this.client?.sendDeferredRequest({
                type: 'invoke',
                item: [{
                    device: 'wallsocket',
                    uid: accessory.context.deviceID,
                    arg1: procedure ? "on" : "off"
                }]
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
        const service = this.ensureServiceAvailability(this.api.hap.Service.Outlet, services);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // Old state is same with new state
                if(accessory.context.on === value) {
                    callback(undefined);
                    return;
                }
                const response = await this.client?.sendDeferredRequest({
                    type: 'invoke',
                    item: [{
                        device: 'wallsocket',
                        uid: accessory.context.deviceID,
                        arg1: value ? "on" : "off"
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
                this.refreshOutletState(response['item'] || []);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if(!this.checkAccessoryAvailability(accessory, callback)) {
                    return;
                }
                callback(undefined, accessory.context.on);
            });
    }

    refreshOutletState(items: any[], force: boolean = false) {
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
                    this.findService(accessory, this.api.hap.Service.Outlet, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.On, accessory.context.on);
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
                    on: false
                };
            });
            this.refreshOutletState(body['item'] || [], true);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshOutletState(body['item'] || [], true);
        });
    }


}