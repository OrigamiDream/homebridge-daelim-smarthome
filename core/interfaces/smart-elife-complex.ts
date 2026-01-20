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
