import {Client} from "../components/client";
import {API, Logging, PlatformAccessory, Service} from "homebridge";
import {Utils} from "../components/utils";
import {WithUUID} from "hap-nodejs";

export interface AccessoryInterface {

    deviceID: string,
    displayName: string

}

type ServiceType = WithUUID<typeof Service>;

export class Accessories<T extends AccessoryInterface> {

    protected readonly log: Logging;
    protected readonly api: API;

    protected client?: Client;

    protected readonly accessories: PlatformAccessory[] = [];
    protected readonly serviceType: ServiceType;

    constructor(log: Logging, api: API, serviceType: ServiceType) {
        this.log = log;
        this.api = api;
        this.serviceType = serviceType;
    }

    setClient(client: Client) {
        this.client = client;
    }

    getServiceType(): ServiceType {
        return this.serviceType;
    }

    protected findAccessoryWithDeviceID(deviceID: string): PlatformAccessory | undefined {
        for(let accessory of this.accessories) {
            if(accessory.context.deviceID === deviceID) {
                return accessory;
            }
        }
        return undefined;
    }

    addAccessory(context: T) {
        const uuid = this.api.hap.uuid.generate(context.deviceID);
        if(!this.accessories.find(accessory => accessory.UUID === uuid)) {
            this.log.info("Adding new accessory: %s(%s)", context.displayName, context.deviceID);
            const accessory = new this.api.platformAccessory(context.displayName, uuid);

            const service = accessory.addService(this.serviceType, context.displayName);

            accessory.context = context;

            this.configureAccessory(accessory, service);
            this.api.registerPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [ accessory ]);
        } else {
            this.accessories.filter(accessory => accessory.UUID === uuid).forEach(accessory => {
                accessory.context = context;
            });
        }
    }

    configureAccessory(accessory: PlatformAccessory, service: Service) {
        this.log.info("Configuring accessory %s", accessory.displayName);
        this.accessories.push(accessory);
    }

    registerListeners() {
    }

}