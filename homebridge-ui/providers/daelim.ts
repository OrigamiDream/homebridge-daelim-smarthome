import AbstractUiProvider from "./ui-provider";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {Device} from "../../core/interfaces/daelim-config";
import {ErrorCallback, NetworkHandler, ResponseCallback} from "../../core/daelim/network";
import {LoggerBase, Semaphore, Utils} from "../../core/utils";
import Timeout = NodeJS.Timeout;
import {MenuItem} from "../../core/interfaces/menu";
import {ELEVATOR_DEVICE_ID, ELEVATOR_DISPLAY_NAME, ELEVATOR_MENU_NAME} from "../../homebridge/accessories/daelim/elevator";
import {DOOR_DEVICES} from "../../homebridge/accessories/daelim/door";
import {VEHICLE_DEVICE_ID, VEHICLE_DISPLAY_NAME} from "../../homebridge/accessories/daelim/vehicle";
import {CAMERA_DEVICES} from "../../homebridge/accessories/daelim/camera";
import {DeviceSubTypes, Errors, LoginSubTypes, SubTypes, Types} from "../../core/daelim/fields";

const DEVICE_DISCOVERY_TIMEOUT_MILLISECONDS = 30 * 1000;
const WALLPAD_AUTHORIZATION_TIMEOUT_MILLISECONDS = 180 * 1000;

interface ClientAuthorization {
    certification: string,
    login: string
}

interface ClientAddress {
    complex: string,
    room: string
}

interface EnqueuedAccessory {
    name: string,
    deviceType: string,
    uid: string
}

interface ActiveDiscovery {
    promise: Promise<Device[]>,
    resolve: (devices: Device[]) => void,
    reject: (error: Error) => void,
    allowPasscode: boolean,
    completeEmitted: boolean,
    waitingForPasscode: boolean,
    settled: boolean,
    timeout?: Timeout
}

export default class DaelimUiServer extends AbstractUiProvider {

    private region?: string = undefined;
    private complex?: string = undefined;
    private username?: string = undefined;
    private password?: string = undefined;
    private uuid?: string = undefined;
    private enqueuedAccessories: { [key: string]: EnqueuedAccessory[] } = {};
    private readonly pendingAccessories = new Set<string>();
    private devices: Device[] = [];

    private handler?: NetworkHandler = undefined;
    private activeDiscovery?: ActiveDiscovery = undefined;
    private devicesFetched: boolean = false;
    private readonly authorization: ClientAuthorization;
    private readonly address: ClientAddress;
    private readonly semaphore = new Semaphore();

    constructor(server: HomebridgePluginUiServer, log: LoggerBase) {
        super(server, log);

        this.authorization = {
            certification: '00000000',
            login: ''
        };
        this.address = {
            complex: '',
            room: ''
        };
    }

    configure() {
        this.server.onRequest('/daelim/sign-in', this.signIn.bind(this));
        this.server.onRequest('/daelim/passcode', this.authorizePasscode.bind(this));
        this.server.onRequest('/daelim/invalidate', this.invalidate.bind(this));
        this.server.onRequest('/daelim/fetch-devices', this.onRequestDevices.bind(this));
    }

    async onRequestDevices(p: any) {
        const devices = this.devicesFetched
            ? [...this.devices]
            : await this.discoverDevices(p, false);

        // Keep the event for the existing pane, but make the request itself carry the
        // same terminal result. The request rejects if discovery cannot complete.
        this.server.pushEvent("devices-fetched", { devices });
        return { devices };
    }

    isDeviceSupportedIn(menuItems: MenuItem[], deviceMenuName: string): boolean {
        if(!menuItems || !menuItems.length) {
            return false;
        }
        for(const item of menuItems) {
            if(item.menuName === deviceMenuName && item.supported) {
                return true;
            }
        }
        return false;
    }

    prepareDefaultDevices(menuItems: MenuItem[]) {
        if(this.isDeviceSupportedIn(menuItems, ELEVATOR_MENU_NAME)) {
            this.devices.push({
                displayName: DaelimUiServer.getFriendlyName(ELEVATOR_DISPLAY_NAME, 'elevator'),
                name: ELEVATOR_DISPLAY_NAME,
                deviceType: 'elevator',
                deviceId: ELEVATOR_DEVICE_ID,
                disabled: false
            });
        }
        for(const device of DOOR_DEVICES) {
            this.devices.push({
                displayName: DaelimUiServer.getFriendlyName(device.displayName, 'door'),
                name: device.displayName,
                deviceType: 'door',
                deviceId: device.deviceID,
                disabled: false
            });
        }
        this.devices.push({
            displayName: DaelimUiServer.getFriendlyName(VEHICLE_DISPLAY_NAME, 'vehicle'),
            name: VEHICLE_DISPLAY_NAME,
            deviceType: 'vehicle',
            deviceId: VEHICLE_DEVICE_ID,
            disabled: false
        });
        for(const device of CAMERA_DEVICES) {
            this.devices.push({
                displayName: DaelimUiServer.getFriendlyName(device.displayName, 'camera'),
                name: device.displayName,
                deviceType: 'camera',
                deviceId: device.deviceID,
                disabled: false
            });
        }
    }

    async invalidate(_: any) {
        if(this.activeDiscovery && !this.activeDiscovery.settled) {
            this.failDiscovery(new Error("Daelim device discovery was invalidated."));
        } else {
            this.cleanupTransport(false);
        }
        this.activeDiscovery = undefined;

        this.authorization.certification = '00000000';
        this.authorization.login = '';
        this.address.complex = '';
        this.address.room = '';
        this.region = undefined;
        this.complex = undefined;
        this.username = undefined;
        this.password = undefined;
        this.uuid = undefined;
        this.devicesFetched = false;
        this.devices = [];
    }

    async signIn(p: any) {
        const discovery = this.discoverDevices(p, true);

        // Sign-in continues to report progress through its existing events. Device
        // fetching joins this same promise and is the request that exposes its result.
        void discovery.catch((error: Error) => {
            this.log.warn(error.message);
        });
    }

    async authorizePasscode(payload: any) {
        const { passcode } = payload;
        if(!this.activeDiscovery || this.activeDiscovery.settled) {
            throw new Error("There is no active Daelim authorization request.");
        }

        this.resetDiscoveryTimeout(DEVICE_DISCOVERY_TIMEOUT_MILLISECONDS);
        if(!this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.username,
            num: String(passcode),
        }, Types.LOGIN, LoginSubTypes.WALL_PAD_REQUEST)) {
            const error = new Error("Could not send the Daelim wall-pad authorization request.");
            this.failPreparation(error);
            throw error;
        }
    }

    private static getFriendlyName(displayName: string, deviceType: string): string {
        const suffixMap: { [key: string]: string } = {
            'light': '전등',
            'heating': '난방',
            'cooling': '에어컨',
            'wallsocket': '콘센트',
            'fan': '환풍기',
            'camera': '초인종'
        }
        const suffix = suffixMap[deviceType];
        if(suffix === undefined) {
            return displayName;
        }
        return `${displayName} ${suffix}`.trim();
    }

    private static accessoryKey(deviceType: string, uid: string): string {
        return `${deviceType}:${uid}`;
    }

    private getAuthorizationPIN(): string {
        let pin: string;
        if(this.authorization.login.length !== 8) {
            pin = this.authorization.certification;
        } else {
            pin = this.authorization.login;
        }
        return pin;
    }

    private sendUnreliableRequest(body: any, type: Types, subType: SubTypes): boolean {
        return this.handler?.sendUnreliableRequest(body, this.getAuthorizationPIN(), type, subType) || false;
    }

    private registerResponseListener(type: Types, subType: SubTypes, callback: ResponseCallback) {
        this.handler?.registerResponseListener(type, subType, callback);
    }

    private registerErrorListener(error: Errors, callback: ErrorCallback) {
        this.handler?.registerErrorListener(error, callback);
    }

    private sendCertificationRequest(): boolean {
        return this.sendUnreliableRequest({
            id: this.username,
            pw: this.password,
            UUID: this.uuid,
        }, Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_REQUEST);
    }

    private discoverDevices(p: any, allowPasscode: boolean): Promise<Device[]> {
        if(this.devicesFetched) {
            return Promise.resolve([...this.devices]);
        }
        if(this.activeDiscovery && !this.activeDiscovery.settled) {
            this.activeDiscovery.allowPasscode ||= allowPasscode;
            return this.activeDiscovery.promise;
        }
        if(this.activeDiscovery?.settled) {
            if(!allowPasscode) {
                // A pane fetch that starts just after a terminal failure must observe
                // that failure instead of opening a second MMF connection.
                return this.activeDiscovery.promise;
            }
            // An explicit sign-in is a user-requested retry.
            this.activeDiscovery = undefined;
        }

        const { region, complex, username, password } = p || {};
        if(!region || !complex || !username || !password) {
            return Promise.reject(new Error("Daelim credentials and complex information are required."));
        }

        this.log.info(`region = ${region}, complex = ${complex}, username: ${username}`);
        this.region = region;
        this.complex = complex;
        this.username = username;
        this.password = password;
        this.uuid = Utils.generateUUID(username);
        this.devicesFetched = false;
        this.devices = [];
        this.enqueuedAccessories = {};
        this.pendingAccessories.clear();

        let resolveDiscovery!: (devices: Device[]) => void;
        let rejectDiscovery!: (error: Error) => void;
        const promise = new Promise<Device[]>((resolve, reject) => {
            resolveDiscovery = resolve;
            rejectDiscovery = reject;
        });
        const discovery: ActiveDiscovery = {
            promise,
            resolve: resolveDiscovery,
            reject: rejectDiscovery,
            allowPasscode,
            completeEmitted: false,
            waitingForPasscode: false,
            settled: false
        };
        this.activeDiscovery = discovery;

        try {
            this.semaphore.createSemaphore();
            this.resetDiscoveryTimeout(DEVICE_DISCOVERY_TIMEOUT_MILLISECONDS);
            this.log.info('Starting service...');
            void this.createService(discovery).catch((error: unknown) => {
                if(this.activeDiscovery === discovery) {
                    this.failPreparation(this.asError(error));
                }
            });
        } catch(error: unknown) {
            this.failPreparation(this.asError(error));
        }

        return promise;
    }

    private resetDiscoveryTimeout(timeoutMilliseconds: number) {
        const discovery = this.activeDiscovery;
        if(!discovery || discovery.settled) {
            return;
        }
        if(discovery.timeout) {
            clearTimeout(discovery.timeout);
        }
        discovery.timeout = setTimeout(() => {
            this.failPreparation(new Error("Daelim device discovery timed out."));
        }, timeoutMilliseconds);
    }

    private completeDiscovery() {
        const discovery = this.activeDiscovery;
        if(!discovery || discovery.settled) {
            return;
        }

        discovery.settled = true;
        const devices = [...this.devices];
        this.devicesFetched = true;
        this.cleanupTransport(true, discovery);
        discovery.resolve(devices);
    }

    private failDiscovery(error: Error, eventName?: string, eventData: any = {}) {
        const discovery = this.activeDiscovery;
        if(!discovery || discovery.settled) {
            return;
        }

        discovery.settled = true;
        this.cleanupTransport(false, discovery);
        if(eventName) {
            this.server.pushEvent(eventName, eventData);
        }
        discovery.reject(error);
    }

    private failPreparation(error: Error) {
        this.failDiscovery(error, 'authorization-failed', {
            reason: 'wallpad-preparation-fail'
        });
    }

    private cleanupTransport(preserveDevices: boolean, discovery = this.activeDiscovery) {
        if(discovery?.timeout) {
            clearTimeout(discovery.timeout);
            discovery.timeout = undefined;
        }

        const handler = this.handler;
        this.handler = undefined;
        if(handler) {
            handler.onConnected = undefined;
            handler.onDisconnected = undefined;
            handler.disconnect();
        }

        this.enqueuedAccessories = {};
        this.pendingAccessories.clear();
        if(!preserveDevices) {
            this.devicesFetched = false;
            this.devices = [];
        }

        try {
            this.semaphore.removeSemaphore();
        } catch(error: unknown) {
            this.log.warn(`Could not remove the Daelim semaphore: ${this.asError(error).message}`);
        }
    }

    private asError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private requestWallpadAuthorization(includeDeleteRequests: boolean) {
        const discovery = this.activeDiscovery;
        if(!discovery || discovery.settled) {
            return;
        }
        if(discovery.waitingForPasscode) {
            return;
        }

        let requestsSent = true;
        if(includeDeleteRequests) {
            requestsSent = this.sendUnreliableRequest({
                id: this.username,
                pw: this.password
            }, Types.LOGIN, LoginSubTypes.DELETE_CERTIFICATION_REQUEST) && requestsSent;
            requestsSent = this.sendUnreliableRequest({
                id: this.username
            }, Types.LOGIN, LoginSubTypes.APPROVAL_DELETE_REQUEST) && requestsSent;
        }
        requestsSent = this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.username,
            auth: 2
        }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST) && requestsSent;
        if(!requestsSent) {
            this.failPreparation(new Error("Could not request Daelim wall-pad authorization."));
            return;
        }

        if(discovery.allowPasscode) {
            discovery.waitingForPasscode = true;
            this.resetDiscoveryTimeout(WALLPAD_AUTHORIZATION_TIMEOUT_MILLISECONDS);
            this.server.pushEvent('require-wallpad-passcode', {});
        } else {
            this.failDiscovery(
                new Error("Daelim wall-pad reauthorization is required."),
                'require-wallpad-passcode'
            );
        }
    }

    private async createService(discovery: ActiveDiscovery) {
        const complex = await Utils.findMatchedComplex(this.region || "", this.complex || "");
        if(this.activeDiscovery !== discovery || discovery.settled) {
            return;
        }
        const menuItems = await Utils.fetchSupportedMenus(complex);
        if(this.activeDiscovery !== discovery || discovery.settled) {
            return;
        }

        this.prepareDefaultDevices(menuItems);
        this.handler = new NetworkHandler(this.log, complex);
        this.handler.onConnected = () => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }
            if(!this.username || !this.password) {
                this.failDiscovery(
                    new Error("Username and password are not valid."),
                    'authorization-failed',
                    { reason: 'invalid-authorization' }
                );
                return;
            }
            if(!this.sendCertificationRequest()) {
                this.failPreparation(new Error("Could not send the Daelim certification request."));
            }
        };
        this.handler.onDisconnected = () => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }
            this.log.info('Connection broken.');
            this.failPreparation(new Error("The Daelim connection closed before device discovery completed."));
        };

        this.registerResponseListener(Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_RESPONSE, (body) => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }
            this.authorization.certification = body['certpin'];
            this.address.complex = body['dong'];
            this.address.room = body['ho'];

            if(!this.sendUnreliableRequest({
                id: this.username,
                pw: this.password,
                certpin: this.authorization.certification
            }, Types.LOGIN, LoginSubTypes.LOGIN_PIN_REQUEST)) {
                this.failPreparation(new Error("Could not send the Daelim login request."));
            }
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.LOGIN_PIN_RESPONSE, (body) => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }
            this.authorization.login = body['loginpin'];
            if(!this.sendUnreliableRequest({}, Types.LOGIN, LoginSubTypes.MENU_REQUEST)) {
                this.failPreparation(new Error("Could not request the Daelim device menu."));
            }
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.WALL_PAD_RESPONSE, () => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }
            discovery.waitingForPasscode = false;
            if(!this.sendCertificationRequest()) {
                this.failPreparation(new Error("Could not restart Daelim certification."));
            }
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }

            if(!discovery.completeEmitted) {
                discovery.completeEmitted = true;
                this.server.pushEvent('complete', { uuid: this.uuid });
            }
            this.resetDiscoveryTimeout(DEVICE_DISCOVERY_TIMEOUT_MILLISECONDS);

            const controlInfo = body['controlinfo'] || {};
            for(const key of Object.keys(controlInfo)) {
                if(key === 'fan' && !this.isDeviceSupportedIn(menuItems, "환기")) {
                    // possibility of fan support in contents info but not in menu items
                    continue;
                }

                const devices = Array.isArray(controlInfo[key]) ? controlInfo[key] : [];
                if(devices.length === 0) {
                    continue;
                }
                this.enqueuedAccessories[key] = [];
                for(const device of devices) {
                    if(!device || device['uid'] === undefined) {
                        this.failPreparation(new Error(`Invalid Daelim device metadata for ${key}.`));
                        return;
                    }
                    const accessory = {
                        name: device['uname'],
                        deviceType: key,
                        uid: String(device['uid'])
                    };
                    this.enqueuedAccessories[key].push(accessory);
                    this.pendingAccessories.add(DaelimUiServer.accessoryKey(key, accessory.uid));
                }

                if(!this.sendUnreliableRequest({
                    type: 'query',
                    item: [{
                        device: key,
                        uid: 'all'
                    }]
                }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST)) {
                    this.failPreparation(new Error(`Could not query Daelim ${key} devices.`));
                    return;
                }
            }

            if(this.pendingAccessories.size === 0) {
                this.completeDiscovery();
            }
        });
        this.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, (body) => {
            if(this.activeDiscovery !== discovery || discovery.settled) {
                return;
            }

            const items = Array.isArray(body['item']) ? body['item'] : [];
            for(const item of items) {
                const deviceType = item['device'];
                const uid = String(item['uid']);
                const enqueuedAccessory = (this.enqueuedAccessories[deviceType] || [])
                    .find(device => device.uid === uid);
                if(!enqueuedAccessory) {
                    continue;
                }

                const key = DaelimUiServer.accessoryKey(deviceType, uid);
                if(!this.pendingAccessories.delete(key)) {
                    continue;
                }
                this.devices.push({
                    displayName: DaelimUiServer.getFriendlyName(enqueuedAccessory.name, deviceType),
                    name: enqueuedAccessory.name,
                    deviceType,
                    deviceId: uid,
                    disabled: false
                });
            }

            if(this.pendingAccessories.size === 0) {
                this.completeDiscovery();
            }
        });

        this.registerErrorListener(Errors.UNCERTIFIED_DEVICE, () => {
            this.requestWallpadAuthorization(true);
        });
        this.registerErrorListener(Errors.INVALID_CERTIFICATION_NUMBER, () => {
            this.failDiscovery(
                new Error("The Daelim wall-pad passcode is invalid."),
                'invalid-wallpad-passcode'
            );
        });
        this.registerErrorListener(Errors.INVALID_USERNAME_AND_PASSWORD, () => {
            this.failDiscovery(
                new Error("The Daelim username or password is invalid."),
                'authorization-failed',
                { reason: 'invalid-authorization' }
            );
        });
        this.registerErrorListener(Errors.REGISTRATION_NOT_COMPLETED, () => {
            this.requestWallpadAuthorization(false);
        });

        this.handler.handle();
    }
}
