export interface DaelimComplexInfo {
    complexes: Region[]
}

export interface Region {
    region: string
    complexes: DaelimComplex[]
}

export interface DaelimComplex {
    index: string
    apartId: string
    region: string
    name: string
    status: string
    serverIp: string
    directoryName: string
    geolocation: ComplexGeoLocation
}

export interface ComplexGeoLocation {
    state: string
    city: string
    details: string
}