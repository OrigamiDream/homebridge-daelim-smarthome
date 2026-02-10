import AbstractUiProvider from "./ui-provider";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {LoggerBase, Semaphore, Utils} from "../../core/utils";
import SmartELifeClient from "../../core/smart-elife/smart-elife-client";
import {Device, DeviceType, SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {ClientResponseCode} from "../../core/smart-elife/responses";
import {Logging} from "homebridge";
import Timeout = NodeJS.Timeout;
import {WALLPAD_VERSION_3_0} from "../../core/smart-elife/parsers/version-parsers";

export default class SmartELifeUiServer extends AbstractUiProvider {

    // Semaphore for Wall-pad code timers
    private readonly semaphore = new Semaphore();
    private semaphoreTimeout?: Timeout;
    private client?: SmartELifeClient;

    private devices: Device[] = [];
    private devicesFetched: boolean = false;

    constructor(server: HomebridgePluginUiServer, log: LoggerBase | Logging) {
        super(server, log);
    }

    async configureInitialDevices(): Promise<Device[]> {
        // TODO: Add initial devices (elevator, motion sensors, etc.)
        return await this.fetchIndoorAirQualityDevices();
    }

    configure() {
        this.server.onRequest("/smart-elife/sign-in", this.signIn.bind(this));
        this.server.onRequest("/smart-elife/passcode", this.authorizePasscode.bind(this));
        this.server.onRequest("/smart-elife/invalidate", this.invalidate.bind(this));
        this.server.onRequest("/smart-elife/fetch-devices", this.onRequestDevices.bind(this));
    }

    async onRequestDevices(p: any) {
        if(this.devicesFetched && this.devices) {
            this.server.pushEvent("devices-fetched", {
                devices: this.devices,
            });
        } else {
            await this.signIn(p);
        }
    }

    async invalidate(_: any) {
        this.client = undefined;
    }

    async signIn(p: any) {
        const { complex, username, password } = p;

        this.log.info(`complex = ${complex}, username: ${username}`);

        const uuid = Utils.sha256(Utils.generateUUID(username), "daelim");

        this.semaphore.createSemaphore();
        this.semaphoreTimeout = setTimeout(() => {
            if(!this.semaphoreTimeout) {
                return;
            }
            this.semaphore.removeSemaphore();
            clearTimeout(this.semaphoreTimeout);
            this.semaphoreTimeout = undefined;
        }, 10 * 1000);

        this.log.info("Starting up Smart eLife...");

        const config: SmartELifeConfig = {
            complex, username, password, uuid,
            wallpadVersion: WALLPAD_VERSION_3_0,
            version: Utils.currentSemanticVersion(),
            devices: this.devices,
        };
        this.client = SmartELifeClient.createForUI(this.log, config);

        const response = await this.client.signIn();
        switch(response) {
            case ClientResponseCode.WRONG_RESULT_PASSWORD: {
                this.server.pushEvent("authorization-failed", {
                    "reason": "invalid-authorization",
                });
                return;
            }
            case ClientResponseCode.WALLPAD_AUTHORIZATION_PREPARATION_FAILED: {
                this.server.pushEvent("authorization-failed", {
                    "reason": "wallpad-preparation-fail",
                });
                return;
            }
            case ClientResponseCode.INCOMPLETE_USER_INFO: {
                this.server.pushEvent("authorization-failed", {
                    "reason": "incomplete-user-info",
                });
                return;
            }
            case ClientResponseCode.UNCERTIFIED_WALLPAD: {
                this.server.pushEvent("require-wallpad-passcode", {});
                return;
            }
            case ClientResponseCode.SUCCESS: {
                // fallthrough
                break;
            }
            default: {
                this.log.error(`Unexpected error: ${response}`);
                return;
            }
        }

        const { roomKey, userKey } = this.client.getRoomAndUserKeys();
        const version = await this.client.parseWallPadVersion();

        // On success
        this.server.pushEvent("complete", { uuid, roomKey, userKey, version });

        // Set up devices
        const fetchedDevices = await this.client.fetchDevices();

        const devices = await this.configureInitialDevices();
        for(const device of fetchedDevices) {
            devices.push(device);
        }
        this.devices = devices;
        this.server.pushEvent("devices-fetched", {
            devices: this.devices,
        });
        this.devicesFetched = true;
    }

    async authorizePasscode(p: any) {
        const { passcode, ...rests } = p;
        if(!this.client) {
            this.log.error("Unexpected access to wallpad authorization.");
            return;
        }
        const response = await this.client.authorizeWallpadPasscode(passcode);
        switch(response) {
            case ClientResponseCode.SUCCESS: {
                await this.signIn(rests);
                break;
            }
            default: {
                this.server.pushEvent("invalid-wallpad-passcode", {});
            }
        }
    }

    async fetchIndoorAirQualityDevices(): Promise<Device[]> {
        const response = await this.client?.sendHttpJson(
            "/monitoring/getAirList.ajax", { location: "all" });
        if(!response["data"]) {
            return [];
        }
        const devices: Device[] = [];
        let index = 0;
        for(const device of response["data"]["list"] as any[]) {
            index++;
            const name = `공기질 센서 ${index}`;
            devices.push({
                displayName: `${device['location']} ${name}`,
                name: name,
                deviceType: DeviceType.INDOOR_AIR_QUALITY,
                deviceId: `CMFIAQ${Utils.addPadding(index, 3)}`,
                disabled: false,
            });
        }
        return devices;
    }
}
