import AbstractSmartHomePlatform from "./platform";
import {API, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {Client} from "../../core/client";
import {Accessories, AccessoryInterface} from "../accessories/accessories";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {Utils} from "../../core/utils";
import PushReceiver from "@eneris/push-receiver";
import {LightbulbAccessories} from "../accessories/lightbulb";
import {OutletAccessories} from "../accessories/outlet";
import {HeaterAccessories} from "../accessories/heater";
import {CoolerAccessories} from "../accessories/cooler";
import {GasAccessories} from "../accessories/gas";
import {FanAccessories} from "../accessories/fan";
import {ElevatorAccessories} from "../accessories/elevator";
import {DoorAccessories} from "../accessories/door";
import {VehicleAccessories} from "../accessories/vehicle";
import {CameraAccessories} from "../accessories/camera";

export default class DaelimPlatform extends AbstractSmartHomePlatform {

    private client?: Client;
    private readonly config?: DaelimConfig;
    private readonly accessories: Accessories<AccessoryInterface>[] = [];

    constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
        super(log, api);

        this.config = this.configureCredentials(platformConfig);
        if(this.config) {
            this.accessories.push(new LightbulbAccessories(this.log, this.api, this.config));
            this.accessories.push(new OutletAccessories(this.log, this.api, this.config));
            this.accessories.push(new HeaterAccessories(this.log, this.api, this.config));
            this.accessories.push(new CoolerAccessories(this.log, this.api, this.config));
            this.accessories.push(new GasAccessories(this.log, this.api, this.config));
            this.accessories.push(new FanAccessories(this.log, this.api, this.config));
            this.accessories.push(new ElevatorAccessories(this.log, this.api, this.config));
            this.accessories.push(new DoorAccessories(this.log, this.api, this.config));
            this.accessories.push(new VehicleAccessories(this.log, this.api, this.config));
            this.accessories.push(new CameraAccessories(this.log, this.api, this.config));
        }
    }

    configureCredentials(config: PlatformConfig): DaelimConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined || !value) {
                return undefined;
            }
        }
        return {
            region: config["region"],
            complex: config["complex"],
            username: config["username"],
            password: config["password"],
            uuid: config["uuid"],
            version: Utils.currentSemanticVersion(),
            devices: config["devices"] || []
        };
    }

    configureAccessory(accessory: PlatformAccessory) {
        for(const accessories of this.accessories) {
            if(!accessories.getAccessoryTypes().includes(accessory.context.accessoryType)) {
                continue;
            }
            const services = accessories.getServiceTypes().map((serviceType) => {
                return accessory.getService(serviceType) || accessory.addService(serviceType, accessory.displayName, serviceType.UUID);
            });
            if(services.length > 0) {
                accessories.configureAccessory(accessory, services);
            }
        }
    }

    protected async serve(): Promise<void> {
        if(!this.config?.uuid) {
            this.log.warn("The plugin hasn't been configured. No available devices.");
            return;
        }

        // firebase cloud messaging
        const push = new PushReceiver({
            debug: false,
            persistentIds: [],
            firebase: {
                apiKey: Utils.FCM_API_KEY,
                appId: Utils.FCM_APP_ID,
                projectId: Utils.FCM_PROJECT_ID,
                messagingSenderId: Utils.FCM_SENDER_ID,
            },
            credentials: undefined,
        })
        this.client = new Client(this.log, this.config, push);
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
