import {API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig,} from "homebridge";
import {DaelimConfig} from "../core/interfaces/daelim-config";
import {Client} from "../core/client";
import {LightbulbAccessories} from "./accessories/lightbulb";
import {Semaphore, Utils} from "../core/utils";
import {Accessories, AccessoryInterface} from "./accessories/accessories";
import {OutletAccessories} from "./accessories/outlet";
import {HeaterAccessories} from "./accessories/heater";
import {GasAccessories} from "./accessories/gas";
import {ElevatorAccessories} from "./accessories/elevator";
import {DoorAccessories} from "./accessories/door";
import {VehicleAccessories} from "./accessories/vehicle";
import fcm, {Credentials} from "push-receiver";

export = (api: API) => {
    api.registerPlatform(Utils.PLATFORM_NAME, DaelimSmartHomePlatform);
}

class DaelimSmartHomePlatform implements DynamicPlatformPlugin {

    private readonly log: Logging;
    private readonly api: API;
    private readonly config?: DaelimConfig;
    private client?: Client;

    private readonly accessories: Accessories<AccessoryInterface>[] = [];

    constructor(log: Logging, config: PlatformConfig, api: API) {
        this.log = log;
        this.api = api;

        this.config = this.configureCredentials(config);

        this.accessories.push(new LightbulbAccessories(this.log, this.api, this.config));
        this.accessories.push(new OutletAccessories(this.log, this.api, this.config));
        this.accessories.push(new HeaterAccessories(this.log, this.api, this.config));
        this.accessories.push(new GasAccessories(this.log, this.api, this.config));
        this.accessories.push(new ElevatorAccessories(this.log, this.api, this.config));
        this.accessories.push(new DoorAccessories(this.log, this.api, this.config));
        this.accessories.push(new VehicleAccessories(this.log, this.api, this.config));

        api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            const semaphore = new Semaphore();
            semaphore.removeSemaphore(); // remove all orphan semaphores

            await this.createSmartHomeService();
            log.info("DL E&C Smart Home did finished launching");
        });
    }

    configureCredentials(config: PlatformConfig): DaelimConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined || !value) {
                return undefined;
            }
        }
        return {
            region: config['region'],
            complex: config['complex'],
            username: config['username'],
            password: config['password'],
            uuid: config['uuid'],
            version: Utils.currentSemanticVersion(),
            devices: config['devices'] || []
        };
    }

    configureAccessory(accessory: PlatformAccessory): void {
        for(const accessories of this.accessories) {
            if(!accessories.getAccessoryTypes().includes(accessory.context.accessoryType)) {
                continue;
            }
            const services = accessories.getServiceTypes().map((serviceType) => {
                return accessory.getService(serviceType) || accessory.addService(serviceType, accessory.displayName);
            });
            if(services.length > 0) {
                accessories.configureAccessory(accessory, services);
            }
        }
    }

    async createSmartHomeService() {
        if(!this.config?.uuid) {
            this.log.warn("Config parameters are not set. No accessories.");
            return;
        }

        // firebase cloud messaging
        const credentials = await fcm.register(Utils.FCM_SENDER_ID);
        this.client = new Client(this.log, this.config, credentials as Credentials);
        await this.client.prepareService();

        this.client.registerListeners();
        this.client.registerErrorListeners();

        this.accessories.forEach(accessories => {
            accessories.setClient(this.client!);
            accessories.registerListeners();
            accessories.registerAccessories();
        });

        this.client.startService();
    }
}