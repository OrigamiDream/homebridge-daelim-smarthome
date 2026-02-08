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

export default class DaelimUiServer extends AbstractUiProvider {

    private region?: string = undefined;
    private complex?: string = undefined;
    private username?: string = undefined;
    private password?: string = undefined;
    private uuid?: string = undefined;
    private enqueuedAccessories: { [key: string]: EnqueuedAccessory[] } = {};
    private enqueuedDeviceTypes: string[] = [];
    private devices: Device[] = [];

    private handler?: NetworkHandler = undefined;
    private isLoggedIn: boolean = false;
    private devicesFetched: boolean = false;
    private readonly authorization: ClientAuthorization;
    private readonly address: ClientAddress;
    private readonly semaphore = new Semaphore();
    private semaphoreTimeout?: Timeout;

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
        if(this.devicesFetched && this.devices) {
            this.server.pushEvent("devices-fetched", {
                devices: this.devices,
            });
        } else {
            await this.signIn(p);
        }
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
        this.authorization.certification = '00000000';
        this.authorization.login = '';
        this.address.complex = '';
        this.address.room = '';
        this.region = undefined;
        this.complex = undefined;
        this.username = undefined;
        this.password = undefined;
        this.uuid = undefined;
        this.isLoggedIn = false;
        this.devicesFetched = false;
        this.devices = [];
    }

    async signIn(p: any) {
        const { region, complex, username, password } = p;

        this.log.info(`region = ${region}, complex = ${complex}, username: ${username}`);

        this.region = region;
        this.complex = complex;
        this.username = username;
        this.password = password;
        this.uuid = Utils.generateUUID(username);
        if(region && complex) {
            // create semaphores and its expirations
            this.semaphore.createSemaphore();
            this.semaphoreTimeout = setTimeout(() => {
                if(!this.semaphoreTimeout) {
                    return;
                }
                this.semaphore.removeSemaphore(); // remove timed out semaphore

                clearTimeout(this.semaphoreTimeout);
                this.semaphoreTimeout = undefined;
            }, 10 * 1000);

            this.log.info('Starting service...');
            await this.createService();
        }
    }

    async authorizePasscode(payload: any) {
        const { passcode } = payload;

        this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.username,
            num: String(passcode),
        }, Types.LOGIN, LoginSubTypes.WALL_PAD_REQUEST);
    }

    private static getFriendlyName(displayName: string, deviceType: string): string {
        const suffixMap: { [key: string]: string } = {
            'light': '전등',
            'heating': '난방',
            'cooling': '에어컨',
            'wallsocket': '콘센트',
            'fan': '환풍기',
            'camera': '인터폰'
        }
        const suffix = suffixMap[deviceType];
        if(suffix === undefined) {
            return displayName;
        }
        return `${displayName} ${suffix}`.trim();
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

    sendUnreliableRequest(body: any, type: Types, subType: SubTypes) {
        if(this.handler !== undefined) {
            this.handler.sendUnreliableRequest(body, this.getAuthorizationPIN(), type, subType);
        }
    }

    registerResponseListener(type: Types, subType: SubTypes, callback: ResponseCallback) {
        if(this.handler !== undefined) {
            this.handler.registerResponseListener(type, subType, callback);
        }
    }

    registerErrorListener(error: Errors, callback: ErrorCallback) {
        if(this.handler !== undefined) {
            this.handler.registerErrorListener(error, callback);
        }
    }

    sendCertificationRequest() {
        this.sendUnreliableRequest({
            id: this.username,
            pw: this.password,
            UUID: this.uuid,
        }, Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_REQUEST);
    }

    async createService() {
        const complex = await Utils.findMatchedComplex(this.region || "", this.complex || "");
        const menuItems = await Utils.fetchSupportedMenus(complex);
        this.prepareDefaultDevices(menuItems);
        this.handler = new NetworkHandler(this.log, complex);
        this.handler.onConnected = () => {
            if(!this.username || !this.password) {
                this.log.error("Username and password is not valid");
            }
            this.sendCertificationRequest();
        };
        this.handler.onDisconnected = () => {
            this.log.info('Connection broken.');
        };

        // Start the service
        this.handler.handle();

        // Event Listeners
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_RESPONSE, (body) => {
            this.authorization.certification = body['certpin'];
            this.address.complex = body['dong'];
            this.address.room = body['ho'];

            this.sendUnreliableRequest({
                id: this.username,
                pw: this.password,
                certpin: this.authorization.certification
            }, Types.LOGIN, LoginSubTypes.LOGIN_PIN_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.LOGIN_PIN_RESPONSE, async (body) => {
            this.authorization.login = body['loginpin'];
            this.sendUnreliableRequest({}, Types.LOGIN, LoginSubTypes.MENU_REQUEST);
        })
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.WALL_PAD_RESPONSE, async (_) => {
            this.sendCertificationRequest();
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, async (body) => {
            this.isLoggedIn = true;
            this.server.pushEvent('complete', { uuid: this.uuid });

            const controlInfo = body['controlinfo'];
            const keys = Object.keys(controlInfo);
            for(const key of keys) {
                if(key === 'fan' && !this.isDeviceSupportedIn(menuItems, "환기")) {
                    // possibility of fan support in contents info but not in menu items
                    continue;
                }
                const devices = controlInfo[key]
                if(devices && devices.length && !this.enqueuedAccessories[key]) {
                    this.enqueuedAccessories[key] = [];
                }
                for(const device of devices) {
                    this.enqueuedAccessories[key].push({
                        name: device['uname'],
                        deviceType: key,
                        uid: device['uid']
                    });
                }
                this.enqueuedDeviceTypes.push(key);
                this.sendUnreliableRequest({
                    type: 'query',
                    item: [{
                        device: key,
                        uid: 'all'
                    }]
                }, Types.DEVICE, DeviceSubTypes.QUERY_REQUEST);
            }
        });
        this.registerResponseListener(Types.DEVICE, DeviceSubTypes.QUERY_RESPONSE, async (body) => {
            const items = body['item'] || [];
            const filtered: EnqueuedAccessory[] = items.map((item: any) => {
                const devices = this.enqueuedAccessories[item['device']];
                for(const device of devices) {
                    if(device.uid === item['uid']) {
                        return device;
                    }
                }
                return undefined;
            }).filter((device: EnqueuedAccessory) => device !== undefined);

            if(!filtered || !filtered.length) {
                return;
            }
            for(const enqueuedAccessory of filtered) {
                const deviceType = enqueuedAccessory.deviceType;
                this.devices.push({
                    displayName: DaelimUiServer.getFriendlyName(enqueuedAccessory.name, deviceType),
                    name: enqueuedAccessory.name,
                    deviceType: deviceType,
                    deviceId: enqueuedAccessory.uid,
                    disabled: false
                })
                const index = this.enqueuedAccessories[deviceType].indexOf(enqueuedAccessory);
                if(index !== -1) {
                    this.enqueuedAccessories[deviceType].splice(index, 1);
                }
                const typeIndex = this.enqueuedDeviceTypes.indexOf(deviceType);
                if(typeIndex !== -1) {
                    this.enqueuedDeviceTypes.splice(typeIndex, 1);
                }
            }
            if(this.enqueuedDeviceTypes.length === 0) {
                // disconnect all
                if(this.handler) {
                    this.handler.disconnect();
                    this.handler = undefined;
                }
                await this.invalidate(null);

                // remove all semaphores
                this.semaphore.removeSemaphore();
                clearTimeout(this.semaphoreTimeout);
                this.semaphoreTimeout = undefined;

                this.server.pushEvent('devices-fetched', {
                    devices: this.devices,
                });
                this.devicesFetched = true;
            }
        });
        // Error Listeners
        this.registerErrorListener(Errors.UNCERTIFIED_DEVICE, () => {
            this.sendUnreliableRequest({
                id: this.username,
                pw: this.password
            }, Types.LOGIN, LoginSubTypes.DELETE_CERTIFICATION_REQUEST);
            this.sendUnreliableRequest({
                id: this.username
            }, Types.LOGIN, LoginSubTypes.APPROVAL_DELETE_REQUEST);
            this.sendUnreliableRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.username,
                auth: 2
            }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);

            this.server.pushEvent('require-wallpad-passcode', {});
        });
        this.registerErrorListener(Errors.INVALID_CERTIFICATION_NUMBER, () => {
            this.server.pushEvent('invalid-wallpad-passcode', {});
        });
        this.registerErrorListener(Errors.INVALID_USERNAME_AND_PASSWORD, () => {
            this.server.pushEvent('authorization-failed', {
                reason: 'invalid-authorization'
            });
        });
        this.registerErrorListener(Errors.REGISTRATION_NOT_COMPLETED, () => {
            this.sendUnreliableRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.username,
                auth: 2
            }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);

            this.server.pushEvent('require-wallpad-passcode', {});
        });
    }
}