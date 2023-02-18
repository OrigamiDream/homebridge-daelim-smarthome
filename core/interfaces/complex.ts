export interface ComplexInfo {
    complexes: Region[]
}

export interface Region {
    region: string
    complexes: Complex[]
}

export interface Complex {
    index: string
    apartId: string
    region: string
    name: string
    status: string
    serverIp: string
    geolocation: ComplexGeoLocation
}

export interface ComplexGeoLocation {
    state: string
    city: string
    details: string
}