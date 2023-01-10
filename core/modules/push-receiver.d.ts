declare module "push-receiver" {
    import EventEmitter from "events";

    export interface FirebaseKeys {
        privateKey: string
        publicKey: string
        authSecret: string
    }
    export interface FirebasePushCredential {
        token: string
        pushSet: string
    }

    export interface LegacyPushCredential {
        token: string
        androidId: string
        securityToken: string
        appId: string
    }
    export interface Credentials {
        keys: FirebaseKeys
        fcm: FirebasePushCredential
        gcm: LegacyPushCredential
    }

    export interface CredentialsWithPersistentIds extends Credentials {
        persistentIds: string[]
    }

    export interface NotificationData {
        notification: any
        persistentId: string
    }

    export class Client extends EventEmitter {
        static init(): void;
        constructor(credentials: Credentials | CredentialsWithPersistentIds, persistentIds: string[]);
    }

    export type NotificationCallback = (data: NotificationData) => void;
    export function register(senderId: string): Credentials;
    export function listen(credentials: CredentialsWithPersistentIds, notificationCallback: NotificationCallback): Client;
}
