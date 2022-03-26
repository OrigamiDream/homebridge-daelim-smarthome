import {Client} from "../../core/client";
import {API, Logging, PlatformAccessory, Service} from "homebridge";
import {Utils} from "../../core/utils";
import {WithUUID} from "hap-nodejs";
import {DaelimConfig} from "../../core/interfaces/daelim-config";

export interface AccessoryInterface {

    deviceID: string,
    displayName: string,
    accessoryType?: string,

}

type ServiceType = WithUUID<typeof Service>;

export class Accessories<T extends AccessoryInterface> {

    protected readonly log: Logging;
    protected readonly api: API;
    protected readonly config?: DaelimConfig;

    protected client?: Client;

    protected readonly accessories: PlatformAccessory[] = [];
    protected readonly serviceTypes: ServiceType[];
    protected readonly accessoryType: string;

    constructor(log: Logging, api: API, config: DaelimConfig | undefined, accessoryType: string, serviceTypes: ServiceType[]) {
        this.log = log;
        this.api = api;
        this.config = config;
        this.accessoryType = accessoryType;
        this.serviceTypes = serviceTypes;
        this.serviceTypes.push(api.hap.Service.AccessoryInformation);
    }

    setClient(client: Client) {
        this.client = client;
    }

    getAccessoryType(): string {
        return this.accessoryType;
    }

    getServiceTypes(): ServiceType[] {
        return this.serviceTypes;
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

            let services = this.serviceTypes.map((serviceType) => {
                return accessory.getService(serviceType) || accessory.addService(serviceType, context.displayName);
            })

            accessory.context = context;
            accessory.context.accessoryType = this.accessoryType;

            this.configureAccessory(accessory, services);
            this.api.registerPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [ accessory ]);
        } else {
            this.accessories.filter(accessory => accessory.UUID === uuid).forEach(accessory => {
                accessory.context = context;
                accessory.context.accessoryType = this.accessoryType;
            });
        }
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        this.log.info("Configuring accessory %s", accessory.displayName);
        accessory.on("identify", async () => {
            await this.identify(accessory);
            this.log.info("%s identified!", accessory.displayName);
        });
        if(this.config?.complex) {
            const accessoryInfo = this.ensureServiceAvailability(this.api.hap.Service.AccessoryInformation, services);
            accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Manufacturer, Utils.MANUFACTURER_NAME);
            accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Model, `${this.config.complex}-${accessory.context.displayName}`);
            accessoryInfo.setCharacteristic(this.api.hap.Characteristic.SerialNumber, accessory.context.deviceID);
        } else {
            throw 'The plugin must not reach here without configuration';
        }
        this.accessories.push(accessory);
    }

    async identify(accessory: PlatformAccessory) {
        this.log.info("Identifying %s", accessory.displayName);
    }

    findService(accessory: PlatformAccessory, serviceType: ServiceType, callback: (service: Service) => void): boolean {
        const service = accessory.getService(serviceType);
        if(service) {
            callback(service);
            return true;
        }
        return false;
    }

    ensureServiceAvailability(serviceType: ServiceType, services: Service[]): Service {
        for(const service of services) {
            if(service.UUID == serviceType.UUID) {
                return service;
            }
        }
        throw `Invalid service type '${serviceType}' in services [${services.map((service) => service.displayName).join(", ")}]`
    }

    registerListeners() {
    }

}