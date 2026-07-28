import SmartELifeClient, {Listener, PushListener} from "../../../core/smart-elife/smart-elife-client";
import {API, Logging, PlatformAccessory, Service, type WithUUID} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {Utils} from "../../../core/utils";
import {getWallPadCapabilities, WallPadCapabilities} from "../../../core/smart-elife/parsers/version-parsers";

export interface AccessoryInterface {
    displayName: string
    deviceId: string
    deviceType: string
    init: boolean
}

export interface DeviceWithOp extends Device {
    op: any;
}

export type NonEmptyDeviceList = [DeviceWithOp, ...DeviceWithOp[]];
export type DeviceListener = (devices: NonEmptyDeviceList) => void;
export type ServiceType = WithUUID<typeof Service>;

const DEFERRED_TASKS_MILLISECONDS = 500;

export default class Accessories<T extends AccessoryInterface> {
    protected _client?: SmartELifeClient;
    protected deferredTasks: Record<string, Promise<boolean>> = {};
    protected readonly accessories: PlatformAccessory[] = [];
    protected readonly capabilities: WallPadCapabilities;
    // Device IDs already reported as disabled.
    // `addOrGetAccessory()` runs on every device poll, not just at registration,
    // so the notice has to be remembered or it repeats for the lifetime of the process.
    private readonly reportedDisabledDevices = new Set<string>();

    constructor(protected readonly log: Logging,
                protected readonly api: API,
                protected readonly config: SmartELifeConfig,
                readonly deviceType: DeviceType,
                readonly serviceTypes: ServiceType[]) {
        this.serviceTypes.push(this.api.hap.Service.AccessoryInformation);
        this.capabilities = getWallPadCapabilities(this.config.wallpadVersion);
    }

    get client(): SmartELifeClient {
        if(!this._client) {
            throw new Error("The client has not been initialized on Accessories.");
        }
        return this._client;
    }

    set client(value: SmartELifeClient) {
        this._client = value;
    }

    protected getAccessoryInterface(accessory: PlatformAccessory) {
        return accessory.context as T;
    }

    protected addOrGetAccessory(context: T): PlatformAccessory | undefined {
        const device = this.findDevice(context.deviceId);
        const cachedAccessory = this.findAccessory(context.deviceId);
        if(device && device.disabled) {
            if(!this.reportedDisabledDevices.has(context.deviceId)) {
                this.reportedDisabledDevices.add(context.deviceId);
                this.log.info("The device (%s) is disabled.", device.displayName);
            }

            // Unregister accessory if exists.
            if(cachedAccessory)
                this.api.unregisterPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [cachedAccessory]);
            return undefined;
        }
        if(cachedAccessory) {
            cachedAccessory.context = context;
            return cachedAccessory;
        } else {
            this.log.info("Adding new accessory: %s (%s :: %s)", context.displayName, context.deviceId, this.deviceType.toString());

            const key = `${context.deviceId}${context.displayName}${context.deviceType.toString()}`;
            const uuid = this.api.hap.uuid.generate(key);

            const accessory = new this.api.platformAccessory(context.displayName, uuid);
            accessory.context = context;

            this.api.registerPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [accessory]);

            this.configureAccessory(accessory);
            return accessory;
        }
    }

    configureAccessory(accessory: PlatformAccessory) {
        this.log.info("Configuring accessory %s :: %s", this.deviceType, accessory.displayName);

        accessory.on("identify", async () => {
            await this.identify(accessory);
            this.log.info("%s identified!", accessory.displayName);
        });

        const context = this.getAccessoryInterface(accessory);
        accessory.getService(this.api.hap.Service.AccessoryInformation)!
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, Utils.homekitString(Utils.MANUFACTURER_NAME))
            .setCharacteristic(this.api.hap.Characteristic.Model, Utils.homekitString(context.displayName))
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, Utils.homekitString(context.deviceId))
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, Utils.homekitString(Utils.currentSemanticVersion().toString()));

        const removals = [];
        for(const service of accessory.services) {
            if(this.isMandatoryService(service)) {
                continue;
            }
            if(this.isSupportedService(service, accessory)) {
                continue;
            }
            this.log.debug("The service %s is no longer supported from accessory: %s (%s)", service.constructor.name, context.displayName, this.deviceType.toString());
            removals.push(service);
        }
        for(const service of removals) {
            accessory.removeService(service);
        }

        this.accessories.push(accessory);
    }

    protected async identify(accessory: PlatformAccessory) {
        this.log.info("Identifying %s", accessory.displayName);
    }

    // Services HAP requires on every accessory, whatever a subclass considers supported.
    // `AccessoryInformation` in particular is dereferenced unconditionally
    // while the accessory cache is deserialized,
    // so an accessory that lost it takes the whole bridge down on the *next* start -
    // long after whatever removed it ran.
    protected isMandatoryService(service: Service): boolean {
        return service.UUID === this.api.hap.Service.AccessoryInformation.UUID;
    }

    protected isSupportedService(service: Service, _: PlatformAccessory): boolean {
        for(const t of this.serviceTypes) {
            if(t.UUID === service.UUID) {
                return true;
            }
        }
        return false;
    }

    protected isSupportedServiceType(serviceType: ServiceType, _: PlatformAccessory): boolean {
        for(const t of this.serviceTypes) {
            if(t.UUID === serviceType.UUID) {
                return true;
            }
        }
        return false;
    }

    protected getService(accessory: PlatformAccessory, serviceType: ServiceType): Service {
        if(!this.isSupportedServiceType(serviceType, accessory)) {
            throw new Error(`Service \`${serviceType.name}\` is not registered as a supported service type in \`${this.deviceType.toString()}\` accessories.`);
        }
        const context = this.getAccessoryInterface(accessory);
        return accessory.getService(serviceType.UUID) || accessory.addService(serviceType, context.displayName, serviceType.UUID);
    }

    protected findDevice(deviceId: string, deviceType: DeviceType = this.deviceType): Device | undefined {
        const devices = (this.config.devices || [])
            .filter((dev) => dev.deviceType === deviceType && dev.deviceId === deviceId);
        return !!devices ? devices[0] : undefined;
    }

    protected findAccessory(deviceId: string): PlatformAccessory | undefined {
        for(const accessory of this.accessories) {
            const context = this.getAccessoryInterface(accessory);
            if(context.deviceId === deviceId) {
                return accessory;
            }
        }
        return undefined;
    }

    protected parseDevices(data: any, deviceType: DeviceType = this.deviceType): DeviceWithOp[] {
        const devices = data["devices"];
        const newDevices: DeviceWithOp[] = [];
        for(const device of devices) {
            const dev = this.findDevice(device["uid"], deviceType);
            if(!dev)
                continue;
            const op = device["operation"];
            newDevices.push({ ...dev, op });
        }
        return newDevices;
    }

    protected async sendWsJson(payload: any) {
        const { userKey, roomKey, accessToken } = this.client.getWebSocketCredentials();
        await this.client.sendJson({
            roomKey, userKey, accessToken,
            data: payload,
        });
    }

    async setDeviceState(device: DeviceWithOp): Promise<boolean> {
        return await this.client.sendDeviceControlOp(device, device.op);
    }

    protected addListener(listener: Listener, deviceType: DeviceType = this.deviceType) {
        this.client.addListener(deviceType, listener);
    }

    protected addDeviceListener(deviceListener: DeviceListener, deviceType: DeviceType = this.deviceType) {
        this.addListener((data, error) => {
            let devices: DeviceWithOp[];
            if(!data || !data["devices"]) {
                this.log.warn(`Devices (${deviceType.toString()}) not found: (${error.code}) ${error.message ?? "unknown reason"}`);
                devices = [];
            } else {
                devices = this.parseDevices(data, deviceType);
            }
            // The wallpad can return no devices, and broadcasts for other households can leave
            // no locally configured devices after parsing. Neither case carries device state for
            // this listener but retains the signal at debug level for troubleshooting.
            if(devices.length === 0) {
                if(data && Array.isArray(data["devices"])) {
                    this.log.debug("Ignoring %s listener event: %d device(s) received and no configured device state was available.",
                        deviceType.toString(), data["devices"].length);
                }
                return;
            }

            deviceListener(devices as NonEmptyDeviceList);
        }, deviceType);
    }

    protected addPushListener(pushType: PushType, listener: PushListener) {
        this.client.addPushListener(pushType, listener);
    }

    protected defer(deviceId: string, task: Promise<boolean>) {
        this.deferredTasks[deviceId] = task;
    }

    register() {
        setInterval(async () => {
            const tasks = [];
            for(const deviceId in this.deferredTasks) {
                tasks.push(this.deferredTasks[deviceId]);
            }
            if(!tasks.length) {
                return;
            }
            await Promise.all(tasks);
            this.deferredTasks = {}; // clear
            this.log.debug("%d deferred tasks are proceeded.", tasks.length);
        }, DEFERRED_TASKS_MILLISECONDS);
    }
}
