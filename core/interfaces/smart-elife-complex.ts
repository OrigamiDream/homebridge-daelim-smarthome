export interface SmartELifeComplex {
    complexKey: string
    complexName: string
    complexAccessKey: string
    complexCode: string
    complexDisplayName: string

    dongs: SmartELifeDong[]
}

export interface SmartELifeDong {
    dong: string
    hos: string[]
}

export interface SmartELifeUserInfo {
    complexCode: string
    apartment: SmartELifeApartment
    username: string
    guid: string
}

export interface SmartELifeApartment {
    building: string
    unit: string
}