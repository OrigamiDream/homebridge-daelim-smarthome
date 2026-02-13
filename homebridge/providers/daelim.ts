import AbstractProvider from "./provider";
import {API, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {DaelimClient} from "../../core/daelim/daelim-client";
import {Accessories, AccessoryInterface} from "../accessories/daelim/accessories";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {Utils} from "../../core/utils";
import PushReceiver from "@eneris/push-receiver";
import {LightbulbAccessories} from "../accessories/daelim/lightbulb";
import {OutletAccessories} from "../accessories/daelim/outlet";
import {HeaterAccessories} from "../accessories/daelim/heater";
import {CoolerAccessories} from "../accessories/daelim/cooler";
import {GasAccessories} from "../accessories/daelim/gas";
import {FanAccessories} from "../accessories/daelim/fan";
import {ElevatorAccessories} from "../accessories/daelim/elevator";
import {DoorAccessories} from "../accessories/daelim/door";
import {VehicleAccessories} from "../accessories/daelim/vehicle";
import {CameraAccessories} from "../accessories/daelim/camera";
import PushReceiverStateStore from "./push-receiver-state-store";

export default class DaelimProvider extends AbstractProvider {

    private client?: DaelimClient;
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

        const store = new PushReceiverStateStore(this.log, this.api, "daelim");
        const { credentials, persistentIds } = store.load();

        // firebase cloud messaging
        const push = new PushReceiver({
            debug: false,
            persistentIds,
            firebase: {
                apiKey: Utils.DAELIM_FCM_API_KEY,
                appId: Utils.DAELIM_FCM_APP_ID,
                projectId: Utils.DAELIM_FCM_PROJECT_ID,
                messagingSenderId: Utils.DAELIM_FCM_SENDER_ID,
            },
            credentials,
        })
        store.bind(push, credentials);
        this.client = new DaelimClient(this.log, this.config, push);
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
