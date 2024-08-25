import readlineSync from 'readline-sync';
import {DaelimConfig} from "./interfaces/daelim-config";
import {Semaphore, Utils} from "./utils";
import {Logging} from "homebridge";
import {ErrorCallback, NetworkHandler, ResponseCallback} from "./network";
import {Errors, LoginSubTypes, PushSubTypes, PushTypes, SettingSubTypes, SubTypes, Types} from "./fields";
import {Complex} from "./interfaces/complex";
import {setInterval} from "timers";
import Timeout = NodeJS.Timeout;
import {MenuItem} from "./interfaces/menu";
import PushReceiver from "@eneris/push-receiver";

export interface PushData {
    readonly from: string
    readonly priority: string
    readonly title: string
    readonly message: string
    readonly reserved: string
}

export type PushEventCallback = (data: PushData) => void;

interface ClientAuthorization {
    certification: string,
    login: string
}

interface ClientAddress {
    complex: string,
    room: string
}

interface PushEventListener {
    type: PushTypes
    subType: PushSubTypes
    callback: PushEventCallback
}

export class Client {

    public static MMF_SERVER_PORT = 25301;

    private readonly authorization: ClientAuthorization;
    private readonly address: ClientAddress;
    private readonly semaphore = new Semaphore();
    private complex?: Complex;
    private menuItems?: MenuItem[];
    private handler?: NetworkHandler;
    private isLoggedIn = false;
    private isRefreshing = false;
    private lastKeepAliveTimestamp: number;
    private enqueuedEstablishment?: Timeout;
    private readonly pushEventListeners: PushEventListener[] = [];

    constructor(private readonly log: Logging,
                private readonly config: DaelimConfig,
                private readonly push: PushReceiver) {
        this.config = config;
        this.authorization = {
            certification: '00000000',
            login: ''
        };
        this.address = {
            complex: '',
            room: ''
        };
        this.lastKeepAliveTimestamp = Date.now();
    }

    checkKeepAlive() {
        const currentTime = Date.now();
        if(currentTime - this.lastKeepAliveTimestamp < 10 * 60 * 1000) {
            // Check keep alive when last keep alive time has passed for 10 minutes
            return;
        }
        this.lastKeepAliveTimestamp = currentTime;
        this.log('Refreshing connection to MMF server');
        this.refresh();
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

    doesComplexMatch(directoryNames: string[]): boolean {
        for(const directoryName of directoryNames) {
            if(this.complex?.directoryName === directoryName) {
                return true;
            }
        }
        return false;
    }

    private checkPushPreferencesEnabled(response: any, name: string) {
        const items = response['item'] || [];
        for(const item of items) {
            if(item["name"] === name) {
                return item["arg1"] === "on";
            }
        }
        return false;
    }

    private async forceUpdatePushPreferences(response: any, name: string, state: string = "on") {
        if(this.checkPushPreferencesEnabled(response, name)) {
            return;
        }
        await this.sendDeferredRequest({
            type: "setting",
            item: [{
                name: name,
                arg1: state
            }]
        }, Types.SETTING, SettingSubTypes.PUSH_SETTING_REQUEST, SettingSubTypes.PUSH_SETTING_RESPONSE, (body) => {
            const items = body['item'] || [];
            for(const item of items) {
                if(item['name'] === name) {
                    return true;
                }
            }
            return false;
        });
    }

    sendUnreliableRequest(body: any, type: Types, subType: SubTypes) {
        if(this.handler !== undefined) {
            this.handler.sendUnreliableRequest(body, this.getAuthorizationPIN(), type, subType);
        }
    }

    sendDeferredRequest(body: any, type: Types, fromSubType: SubTypes, toSubType: SubTypes, matches?: (response: any) => boolean): Promise<any> {
        if(this.handler !== undefined) {
            return this.handler.sendDeferredRequest(body, this.getAuthorizationPIN(), type, fromSubType, toSubType, matches);
        }
        return new Promise<any>((resolve, reject) => reject('Handler not valid'));
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

    registerPushEventListener(type: PushTypes, subType: PushSubTypes, callback: PushEventCallback) {
        this.pushEventListeners.push({
            type: type,
            subType: subType,
            callback: callback
        });
    }

    registerListeners() {
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_RESPONSE, (body) => {
            this.authorization.certification = body['certpin'];
            this.address.complex = body['dong'];
            this.address.room = body['ho'];

            this.sendUnreliableRequest({
                id: this.config.username,
                pw: this.config.password,
                certpin: this.authorization.certification
            }, Types.LOGIN, LoginSubTypes.LOGIN_PIN_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.LOGIN_PIN_RESPONSE, (body) => {
            this.authorization.login = body['loginpin'];
            this.sendUnreliableRequest({}, Types.LOGIN, LoginSubTypes.MENU_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, async (_) => {
            const response = await this.sendDeferredRequest({
                type: "query",
                item: [{
                    name: "all"
                }]
            }, Types.SETTING, SettingSubTypes.PUSH_QUERY_REQUEST, SettingSubTypes.PUSH_QUERY_RESPONSE, (_) => true);
            await this.forceUpdatePushPreferences(response, "door");
            await this.forceUpdatePushPreferences(response, "car");
            await this.forceUpdatePushPreferences(response, "visitor"); // for camera

            // registering fcm push token
            this.sendUnreliableRequest({
                dong: this.address.complex,
                ho: this.address.room,
                pushID: this.push.fcmToken,
                phoneType: "android"
            }, Types.LOGIN, LoginSubTypes.PUSH_REQUEST);

            this.isLoggedIn = true;
            if(this.handler?.flushAllEnqueuedBuffers(this.getAuthorizationPIN())) {
                this.log("Flushed entire enqueued request buffers");
            }
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.WALL_PAD_RESPONSE, (_) => {
            this.log('Certified Wall pad PIN');
            this.sendCertificationRequest();
        });
    }

    registerErrorListeners() {
        this.registerErrorListener(Errors.UNCERTIFIED_DEVICE, () => {
            this.sendUnreliableRequest({
                id: this.config.username,
                pw: this.config.password,
            }, Types.LOGIN, LoginSubTypes.DELETE_CERTIFICATION_REQUEST);
            this.sendUnreliableRequest({
                id: this.config.username
            }, Types.LOGIN, LoginSubTypes.APPROVAL_DELETE_REQUEST);
            this.handleWallPadInput();
        });
        this.registerErrorListener(Errors.INVALID_CERTIFICATION_NUMBER, () => {
            this.handleWallPadInput();
        });
        this.registerErrorListener(Errors.INVALID_USERNAME_AND_PASSWORD, () => {
            this.log.error("Username or password is not valid.");
        });
        this.registerErrorListener(Errors.REGISTRATION_NOT_COMPLETED, () => {
            this.handleWallPadInput();
        });
    }

    requestForWallPad() {
        this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.config.username,
            auth: 2
        }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);
    }

    handleWallPadInput() {
        this.requestForWallPad();

        let wallPadNumber;
        try {
            wallPadNumber = readlineSync.question('Enter wall-pad PIN: ');
        } catch(e) {
            this.log.error("##");
            this.log.error("## Reading wall-pad number in terminal is not available.");
            this.log.error("## Run homebridge in inline mode.");
            this.log.error("##");
            return;
        }

        this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.config.username,
            num: String(wallPadNumber)
        }, Types.LOGIN, LoginSubTypes.WALL_PAD_REQUEST);
    }

    sendCertificationRequest() {
        this.sendUnreliableRequest({
            id: this.config.username,
            pw: this.config.password,
            UUID: this.config.uuid
        }, Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_REQUEST);
    }

    async prepareService() {
        this.push.onNotification((notification) => {
            const orig = notification.message;
            if(!orig || !orig.data) {
                return;
            }
            const pushData: PushData = {
                from: orig.from!,
                priority: orig.priority!,
                title: orig.data['title'] as string,
                message: orig.data['message'] as string,
                reserved: orig.data['data3'] as string,
            };
            this.log.debug(`<=== PUSH(Type: ${orig.data.data1}, Sub Type: ${orig.data.data2}) :: ${JSON.stringify(pushData)}`);
            for(const eventListener of this.pushEventListeners) {
                if(eventListener.type === parseInt(orig.data['data1'] as string) && eventListener.subType == parseInt(orig.data['data2'] as string)) {
                    eventListener.callback(pushData);
                }
            }
        });
        await this.push.connect();

        this.log('Looking for complex info...');
        this.complex = await Utils.findMatchedComplex(this.config.region, this.config.complex);
        this.menuItems = await Utils.fetchSupportedMenus(this.complex);
        this.log(`Complex info about (${this.config.complex}) has found.`);
        this.handler = new NetworkHandler(this.log, this.complex);
        this.handler.onConnected = () => {
            this.sendCertificationRequest();
        };
        this.handler.onDisconnected = () => {
            if(this.isRefreshing) {
                return;
            }
            this.isLoggedIn = false;
            if(this.semaphore.isLocked()) {
                this.enqueueEstablishment();
                return;
            }
            this.log("Connection broken. Reconnect to the server...");
            this.handler?.handle();
        };
    }

    enqueueEstablishment() {
        if(this.enqueuedEstablishment) {
            return;
        }
        this.enqueuedEstablishment = setInterval(() => {
            if(this.semaphore.isLocked()) {
                this.log.debug("Establishing connection failed due to semaphore from ui-server");
                return;
            }
            clearInterval(this.enqueuedEstablishment);
            this.enqueuedEstablishment = undefined;

            this.handler?.handle();
        }, 5000);
    }

    refresh() {
        if(this.semaphore.isLocked()) {
            this.enqueueEstablishment();
            return;
        }
        this.log.debug("Refreshing MMF client service...");
        this.isRefreshing = true;
        this.handler?.handle();
        setTimeout(() => {
            this.isRefreshing = false;
            this.log("Refreshing has been finished");
        }, 5000);
    }

    isNetworkRefreshing() {
        return this.isRefreshing;
    }

    isDeviceSupported(deviceMenuName: string): boolean {
        if(!this.menuItems) {
            this.log.warn("Failed to get list of supported of menu items");
            return false;
        }
        for(const item of this.menuItems) {
            if(item.menuName === deviceMenuName && item.supported) {
                return true;
            }
        }
        return false;
    }

    startService() {
        if(this.handler === undefined) {
            return;
        }
        this.handler.handle();
    }

}