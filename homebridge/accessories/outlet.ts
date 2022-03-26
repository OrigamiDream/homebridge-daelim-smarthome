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
import {DeviceSubTypes, LoginSubTypes, Types} from "../../core/fields";
import {DaelimConfig} from "../../core/interfaces/daelim-config";

interface OutletAccessoryInterface extends AccessoryInterface {

    on: boolean

}

export class OutletAccessories extends Accessories<OutletAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig | undefined) {
        super(log, api, config, "outlet", [api.hap.Service.Outlet]);
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
                this.client?.checkKeepAlive();
                callback(undefined, accessory.context.on);
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

    refreshOutletState(items: any[], force: boolean = false) {
        for(let i = 0; i < items.length; i++) {
            const item = items[i];

            const deviceID = item['uid'];

            const accessory = this.findAccessoryWithDeviceID(deviceID);
            if(accessory) {
                accessory.context.on = item['arg1'] === 'on';
                if(force) {
                    this.findService(accessory, this.api.hap.Service.Outlet, (service) => {
                        service.setCharacteristic(this.api.hap.Characteristic.On, accessory.context.on);
                    });
                }
            }
        }
    }

    registerListeners() {
        this.client?.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            const controls = body['controlinfo'];
            const outlets = controls['wallsocket'];
            if(outlets) {
                for(let i = 0; i < outlets.length; i++) {
                    const outlet = outlets[i];

                    const deviceID = outlet['uid'];
                    const displayName = outlet['uname'];

                    this.addAccessory({
                        deviceID: deviceID,
                        displayName: displayName,
                        on: false
                    });
                }
                this.client?.sendUnreliableRequest({
                    type: 'query',
                    item: [{
                        device: 'wallsocket',
                        uid: 'All'
                    }]
                }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
            }
        });
        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            this.refreshOutletState(body['item'] || [], true);
        });

        this.client?.registerResponseListener(Types.DEVICE, DeviceSubTypes.INVOKE_RESPONSE, (body) => {
            this.refreshOutletState(body['item'] || [], true);
        });
    }


}