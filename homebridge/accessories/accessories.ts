import {Client} from "../../core/client";
import {API, CharacteristicGetCallback, Logging, PlatformAccessory, Service} from "homebridge";
import {Utils} from "../../core/utils";
import {WithUUID} from "hap-nodejs";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {DeviceSubTypes, LoginSubTypes, Types} from "../../core/fields";

export interface AccessoryInterface {

    deviceID: string,
    displayName: string,
    accessoryType?: string,
    init: boolean,
    version?: string,

}

type EnqueuedAccessoryValues = { [key: string]: string };

interface EnqueuedAccessoryInfo {
    displayName: string,
    values: EnqueuedAccessoryValues,
}
type EnqueuedAccessoryMap = { [deviceID: string]: EnqueuedAccessoryInfo };

type ServiceType = WithUUID<typeof Service>;
type UUIDCombinationGenerator = (context: AccessoryInterface) => string;

const OLD_UUID_COMBINATION: UUIDCombinationGenerator = (context) => `${context.deviceID}`;
const NEW_UUID_COMBINATION: UUIDCombinationGenerator = (context) => `${context.deviceID}-${context.displayName}-${context.accessoryType}`;

export class Accessories<T extends AccessoryInterface> {

    protected client?: Client;

    protected readonly accessories: PlatformAccessory[] = [];
    protected readonly enqueuedAccessoriesCache: EnqueuedAccessoryMap = {};

    private lastInitRequestTimestamp: number = -1;

    /**
     * Accessories class
     *
     * @param log Logging instance from Homebridge
     * @param api API instance from Homebridge
     * @param config Config instance parsed from Homebridge UI configuration
     * @param accessoryTypes Array of accessory types that can be used for requesting accessory initialization.
     *                       First element must be device type from DL E&C API.
     *                       TODO: This is anti-pattern. Must be changed in near future.
     * @param serviceTypes Array of service types that would be used for registering accessory to Homebridge
     */
    constructor(protected readonly log: Logging,
                protected readonly api: API,
                protected readonly config: DaelimConfig | undefined,
                protected readonly accessoryTypes: string[],
                protected readonly serviceTypes: ServiceType[]) {
        this.serviceTypes.push(api.hap.Service.AccessoryInformation);
    }

    setClient(client: Client) {
        this.client = client;
    }

    getDeviceType(): string {
        return this.accessoryTypes[0];
    }

    getAccessoryTypes(): string[] {
        return this.accessoryTypes;
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

    private enqueueControllableAccessories(controlInfo: any, keysToKeep: any[] = []) {
        const devices = controlInfo[this.getDeviceType()];
        if(!devices) {
            return;
        }
        for(let i = 0; i < devices.length; i++) {
            const device = devices[i];
            const values: EnqueuedAccessoryValues = {};
            for(const key of keysToKeep) {
                values[key] = device[key];
            }
            this.enqueuedAccessoriesCache[device['uid']] = {
                displayName: device['uname'],
                values: values,
            };
        }
        this.client?.sendUnreliableRequest({
            type: 'query',
            item: [{
                device: this.getDeviceType(),
                uid: 'All'
            }]
        }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
    }

    private verifyAndFlushEnqueuedAccessories(body: any): any[] {
        const items = body['item'] || [];
        const filtered = [];
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            if(deviceType === this.getDeviceType()) {
                filtered.push(item);
            }
        }
        if(!filtered) {
            return [];
        }
        const accessories = [];
        for(let i = 0; i < filtered.length; i++) {
            const item = filtered[i];
            const device = item['device'];
            if(device !== this.getDeviceType()) {
                continue;
            }
            const deviceID = item['uid'];
            if(!(deviceID in this.enqueuedAccessoriesCache)) {
                continue;
            }
            const cache = this.enqueuedAccessoriesCache[deviceID];
            accessories.push({
                deviceID: deviceID,
                displayName: cache.displayName,
                info: cache.values,
            })
            delete this.enqueuedAccessoriesCache[deviceID];
        }
        return accessories;
    }

    protected registerLazyAccessories(body: any, registrar: (deviceID: string, displayName: string, info?: any) => T) {
        const devices = this.verifyAndFlushEnqueuedAccessories(body);
        for(const device of devices) {
            this.addAccessory(registrar(device.deviceID, device.displayName, device.info));
        }
    }

    addAccessory(context: T) {
        if(this.client?.isNetworkRefreshing()) {
            // This prevents changing the accessories to uninitialized state while refreshing the connection.
            // Uninitialized state makes the accessories are no response in Home app.
            return;
        }
        // Support backward compatibility
        const generators = [OLD_UUID_COMBINATION, NEW_UUID_COMBINATION];
        for(let i = 0; i < generators.length; i++) {
            const generate = generators[i];
            const uuid = this.api.hap.uuid.generate(generate(context));
            const cachedAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
            const isLegacy = i === 0;

            if(cachedAccessory) {
                const version = cachedAccessory.context.version;
                cachedAccessory.context = context;
                cachedAccessory.context.version = version; // Always keep first-initial version for compatibility management
                cachedAccessory.context.accessoryType = this.getDeviceType();
                cachedAccessory.context.init = false;

                if(isLegacy) {
                    this.log.info("Restoring cached legacy accessory: %s (%s, %s)", context.displayName, context.deviceID, this.getDeviceType());
                } else {
                    this.log.info("Restoring cached accessory: %s (%s, %s)", context.displayName, context.deviceID, this.getDeviceType());
                }
                return true;
            }
        }
        const uuid = this.api.hap.uuid.generate(NEW_UUID_COMBINATION(context));
        this.log.info("Adding new accessory: %s (%s, %s)", context.displayName, context.deviceID, this.getDeviceType());
        const accessory = new this.api.platformAccessory(context.displayName, uuid);

        let services = this.serviceTypes.map((serviceType) => {
            return accessory.getService(serviceType) || accessory.addService(serviceType, context.displayName);
        })
        accessory.context = context;
        accessory.context.version = Utils.currentSemanticVersion().toString();
        accessory.context.accessoryType = this.getDeviceType();
        accessory.context.init = false;

        this.api.registerPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [ accessory ]);
        this.configureAccessory(accessory, services);
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        const accessoryType = this.getAccessoryTypes()[this.getAccessoryTypes().length - 1];
        this.log.info("Configuring accessory %s :: %s", accessoryType, accessory.displayName);
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

    protected checkAccessoryAvailability(accessory: PlatformAccessory, callback: CharacteristicGetCallback): boolean {
        this.client?.checkKeepAlive();
        if(accessory.context.init) {
            return true;
        }
        this.requestAccessoryInit();
        callback(new Error('Accessory have not initialized'));
        return false;
    }

    private requestAccessoryInit() {
        const currentTime = Date.now();
        if(this.lastInitRequestTimestamp != -1 && currentTime - this.lastInitRequestTimestamp < 10 * 60) {
            // Check init request when last init request time has passed for 1 minute
            return;
        }
        this.lastInitRequestTimestamp = currentTime;
        this.client?.sendUnreliableRequest({
            type: 'query',
            item: [{
                device: this.getDeviceType(),
                uid: 'All'
            }]
        }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
    }

    matchesAccessoryDeviceID(accessory: PlatformAccessory, body: any): boolean {
        const items = body['item'] || [];
        for(let i = 0; i < items.length; i++) {
            const item = items[i];
            const deviceType = item['device'];
            const deviceID = item['uid'];
            if(accessory.context.deviceID === deviceID && this.getDeviceType() === deviceType) {
                return true;
            }
        }
        return false;
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

    registerAccessories() {
    }

    registerListeners() {
        this.client?.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            this.enqueueControllableAccessories(body['controlinfo']);
        });
    }

}