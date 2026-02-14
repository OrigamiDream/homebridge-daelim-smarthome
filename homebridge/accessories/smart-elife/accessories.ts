import SmartELifeClient, {Listener, PushListener} from "../../../core/smart-elife/smart-elife-client";
import {API, Logging, PlatformAccessory, Service} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {WithUUID} from "hap-nodejs";
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

export type DeviceListener = (devices: DeviceWithOp[]) => void;
export type ServiceType = WithUUID<typeof Service>;

const DEFERRED_TASKS_MILLISECONDS = 500;

export default class Accessories<T extends AccessoryInterface> {
    protected _client?: SmartELifeClient;
    protected deferredTasks: Record<string, Promise<boolean>> = {};
    protected readonly accessories: PlatformAccessory[] = [];
    protected readonly capabilities: WallPadCapabilities;

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
            this.log.info("The device (%s) is disabled.", device.displayName);

            // Unregister accessory if exists.
            if(cachedAccessory)
                this.api.unregisterPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [cachedAccessory]);
            return undefined;
        }
        if(cachedAccessory) {
            cachedAccessory.context = context;
            cachedAccessory.context.init = false;
            return cachedAccessory;
        } else {
            this.log.info("Adding new accessory: %s (%s :: %s)", context.displayName, context.deviceId, this.deviceType.toString());

            const key = `${context.deviceId}${context.displayName}${context.deviceType.toString()}`;
            const uuid = this.api.hap.uuid.generate(key);

            const accessory = new this.api.platformAccessory(context.displayName, uuid);
            accessory.context = context;
            accessory.context.init = false;

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
        const info = this.getService(accessory, this.api.hap.Service.AccessoryInformation);
        info.setCharacteristic(this.api.hap.Characteristic.Manufacturer, Utils.MANUFACTURER_NAME);
        info.setCharacteristic(this.api.hap.Characteristic.Model, context.displayName);
        info.setCharacteristic(this.api.hap.Characteristic.SerialNumber, context.deviceId);

        const removals = [];
        for(const service of accessory.services) {
            if(this.isSupportedService(service)) {
                continue;
            }
            this.log.debug("The service %s is no longer supported from accessory: %s (%s)", service.name, context.displayName, this.deviceType.toString());
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

    private isSupportedService(service: Service): boolean {
        for(const t of this.serviceTypes) {
            if(t.UUID === service.UUID) {
                return true;
            }
        }
        return false;
    }

    private isSupportedServiceType(serviceType: ServiceType): boolean {
        for(const t of this.serviceTypes) {
            if(t.UUID === serviceType.UUID) {
                return true;
            }
        }
        return false;
    }

    protected getService(accessory: PlatformAccessory, serviceType: ServiceType): Service {
        if(!this.isSupportedServiceType(serviceType)) {
            throw new Error(`Service \`${serviceType.name}\` is not registered as a supported service type in \`${this.deviceType.toString()}\` accessories.`);
        }
        const context = this.getAccessoryInterface(accessory);
        return accessory.getService(serviceType.UUID) || accessory.addService(serviceType, context.displayName, serviceType.UUID);
    }

    protected findDevice(deviceId: string): Device | undefined {
        const devices = (this.config.devices || [])
            .filter((dev) => dev.deviceType === this.deviceType && dev.deviceId === deviceId);
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

    protected parseDevices(data: any): DeviceWithOp[] {
        const devices = data["devices"];
        const newDevices: DeviceWithOp[] = [];
        for(const device of devices) {
            const dev = this.findDevice(device["uid"]);
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

    protected addListener(listener: Listener) {
        this.client.addListener(this.deviceType, listener);
    }

    protected addDeviceListener(deviceListener: DeviceListener) {
        this.addListener((data, error) => {
            let devices: DeviceWithOp[];
            if(!data || !data["devices"]) {
                this.log.warn(`Devices (${this.deviceType.toString()}) not found: (${error.code}) ${error.message ?? "unknown reason"}`);
                devices = [];
            } else {
                devices = this.parseDevices(data);
            }
            if(devices.length === 0)
                this.log.warn("No devices op received for %s. Are the devices disconnected from WallPad?", this.deviceType.toString());

            deviceListener(devices);
        });
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