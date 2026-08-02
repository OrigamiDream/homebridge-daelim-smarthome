import AbstractUiProvider from "./ui-provider";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {LoggerBase, Semaphore, Utils} from "../../core/utils";
import SmartELifeClient, {HouseholdAttribution} from "../../core/smart-elife/smart-elife-client";
import {Device, DeviceType, SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {ClientResponseCode} from "../../core/smart-elife/responses";
import {Logging} from "homebridge";
import Timeout = NodeJS.Timeout;
import {WALLPAD_VERSION_3_0} from "../../core/smart-elife/parsers/version-parsers";
import {EXTERIOR_ELEVATOR_DEVICE} from "../../homebridge/accessories/smart-elife/elevator";
import {EXTERIOR_DOOR_DEVICES} from "../../homebridge/accessories/smart-elife/door";
import {EXTERIOR_VEHICLE_BARRIER_DEVICE} from "../../homebridge/accessories/smart-elife/vehicle";
import {
    EXTERIOR_COMMUNAL_DOOR_CAMERA_DEVICE,
    EXTERIOR_FRONT_DOOR_CAMERA_DEVICE
} from "../../homebridge/accessories/smart-elife/camera";
import OnePassClient from "../../core/smart-elife-onepass/onepass-client";
import {defaultOnePassConfig} from "../../core/interfaces/smart-elife-onepass-config";

export default class SmartELifeUiServer extends AbstractUiProvider {

    // Semaphore for Wall-pad code timers
    private readonly semaphore = new Semaphore();
    private semaphoreTimeout?: Timeout;
    private client?: SmartELifeClient;

    private devices: Device[] = [];
    private devicesFetched: boolean = false;
    /** How the last kept list was attributed, replayed with the cache. */
    private household: HouseholdAttribution = HouseholdAttribution.UNKNOWN;
    /** The resident's own room names from the last kept fetch, replayed with the cache. */
    private aliases: Record<string, string> = {};

    constructor(server: HomebridgePluginUiServer, log: LoggerBase | Logging) {
        super(server, log);
    }

    async configureInitialDevices(): Promise<Device[]> {
        const devices = await this.fetchIndoorAirQualityDevices();
        devices.push(EXTERIOR_ELEVATOR_DEVICE);
        for(const device of EXTERIOR_DOOR_DEVICES) {
            devices.push(device);
        }
        devices.push(EXTERIOR_VEHICLE_BARRIER_DEVICE);
        devices.push(EXTERIOR_FRONT_DOOR_CAMERA_DEVICE);
        devices.push(EXTERIOR_COMMUNAL_DOOR_CAMERA_DEVICE);
        return devices;
    }

    configure() {
        this.server.onRequest("/smart-elife/sign-in", this.signIn.bind(this));
        this.server.onRequest("/smart-elife/passcode", this.authorizePasscode.bind(this));
        this.server.onRequest("/smart-elife/invalidate", this.invalidate.bind(this));
        this.server.onRequest("/smart-elife/fetch-devices", this.onRequestDevices.bind(this));
        this.server.onRequest("/smart-elife/onepass-support", this.checkOnePassSupport.bind(this));
    }

    // Answers whether One Pass carries the signed-in household's complex.
    // An absent `supported` means the question could not be answered -
    // no session yet, or the listing was unreachable -
    // and the caller stays quiet rather than worrying a user whose complex is fine.
    async checkOnePassSupport(p: any): Promise<{ supported?: boolean }> {
        try {
            // The wizard signs in and stops there, never reaching `serve()`,
            // which is where the plugin proper learns its complex.
            // Asking for the lookup here is what makes the question answerable at all.
            const complexKey = (await this.client?.resolveComplex())?.complexKey;
            if(!complexKey) {
                return {};
            }
            // The form passes what the user has typed so far,
            // so a pinned complex code counts before it has been saved.
            const config = { ...defaultOnePassConfig(), ...(p?.onePass || {}) };
            const client = new OnePassClient(this.log, config, () => "");
            return { supported: await client.isComplexServed(complexKey) };
        } catch(e) {
            this.log.debug("Could not check the One Pass coverage: %s", (e as Error)?.message || e);
            return {};
        }
    }

    async onRequestDevices(p: any) {
        // `force` bypasses the cache. The frontend's re-fetch button needs it -
        // without it, reopening the settings replays whatever this process fetched first,
        // and the only way to actually query again was a full reset.
        if(!p?.force && this.devicesFetched && this.devices) {
            this.server.pushEvent("devices-fetched", {
                devices: this.devices,
                household: this.household,
                aliases: this.aliases,
            });
        } else {
            await this.signIn(p);
        }
    }

    async invalidate(_: any) {
        this.client = undefined;
        // A reset ends the session the cache belongs to. Without this, the first
        // force-less fetch after a re-login would replay the previous session's list,
        // because a sign-in refused as FOREIGN/INVALID deliberately leaves the cache alone.
        this.devices = [];
        this.devicesFetched = false;
        this.household = HouseholdAttribution.UNKNOWN;
        this.aliases = {};
    }

    async signIn(p: any) {
        const { username, password } = p;

        this.log.info(`username: ${username}`);

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
            username, password, uuid,
            wallpadVersion: WALLPAD_VERSION_3_0,
            version: Utils.currentSemanticVersion(),
            // The saved list the frontend sent along is the yardstick the client holds
            // rendered pages against. Without it every page passes as UNKNOWN -
            // the first sign-in of this process has no cache to fall back on.
            devices: Array.isArray(p.devices) ? p.devices : this.devices,
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

        const { roomKey, userKey } = this.client.getWebSocketCredentials();
        const version = await this.client.parseWallPadVersion();

        // Set up devices
        const result = await this.client.fetchDevices();
        if(result.household === HouseholdAttribution.FOREIGN
            || result.household === HouseholdAttribution.INVALID) {
            // The cache is left alone - a failed refresh must not become the list the next
            // request replays. `complete` still goes out: the session credentials are this
            // household's regardless of whose device list the page carried (measured),
            // and the runtime cannot start without them.
            this.server.pushEvent("device-refresh-failed", { reason: result.household });
            this.server.pushEvent("complete", { uuid, roomKey, userKey, version });
            return;
        }

        const devices = await this.configureInitialDevices();
        for(const device of result.devices) {
            devices.push(device);
        }
        this.devices = devices;
        this.devicesFetched = true;
        this.household = result.household;
        this.aliases = result.aliases;

        // On success
        // `devices-fetched` is pushed before `complete`,
        // so that a pane waiting only for the device list settles before the wizard moves on.
        // Without it, a sign-in triggered by `/fetch-devices` would report nothing the caller listens for.
        this.server.pushEvent("devices-fetched",
            { devices, household: result.household, aliases: result.aliases });
        this.server.pushEvent("complete", { uuid, roomKey, userKey, version });
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
