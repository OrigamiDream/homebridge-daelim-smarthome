export interface OnePassConfig {
    // Live view is opt-in:
    // it opens a real interphone call, which is exclusive with the One Pass phone app.
    enabled: boolean
    // Defaults to the Smart eLife username - both services use the same account id.
    userId?: string
    // Defaults to the building/unit the Smart eLife session reports.
    building?: string
    unit?: string
    hoIndex?: number
    // A One Pass `projectCode`. Normally left unset:
    // the complex is found by matching One Pass's `projectCode2`
    // against the Smart eLife session's `complexKey`.
    // This is *not* the Smart eLife complex code (`djCd`) -
    // the two numbering schemes never coincide.
    complexCode?: string
    // Override the `*.uasis.com` host discovered from the complex list.
    host?: string
    port?: number
    // Seconds to keep the call up after the last HomeKit viewer disconnects.
    lingerSeconds?: number
}

export interface OnePassCredentials {
    sipId: string
    sipPw: string
    sipDomain: string
    sipPort: number
    sipProtocol: string
    wallpadSipId: string
}

export function defaultOnePassConfig(): OnePassConfig {
    return {
        enabled: false,
    };
}
