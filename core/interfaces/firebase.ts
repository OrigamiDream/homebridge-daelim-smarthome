interface FirebaseKeys {
    privateKey: string
    publicKey: string
    authSecret: string
}

interface FirebasePushCredential {
    token: string
    pushSet: string
}

interface LegacyPushCredential {
    token: string
    androidId: string
    securityToken: string
    appId: string
}

export interface FirebaseCredentials {
    keys: FirebaseKeys
    fcm: FirebasePushCredential
    gcm: LegacyPushCredential
}

export interface PushData {
    readonly from: string
    readonly priority: string
    readonly title: string
    readonly message: string
    readonly reserved: string
}