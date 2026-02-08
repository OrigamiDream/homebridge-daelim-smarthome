export enum ClientResponseCode {
    SUCCESS = 0,
    WRONG_RESULT_PASSWORD,
    UNCERTIFIED_WALLPAD,
    INCOMPLETE_USER_INFO,
    EMPTY_PARAMETER,
    NO_EXIST_USER,
    FAIL_ADD_HOME,
    FAIL_UPDATE_HOME,
    AUTHORIZATION_MISMATCH,
    WALLPAD_AUTHORIZATION_PREPARATION_FAILED,
}

export namespace ClientResponseCode {
    export function parseResponseCode(error: any): ClientResponseCode {
        if(error === "305") {
            return ClientResponseCode.AUTHORIZATION_MISMATCH;
        } else if(error === "") {
            return ClientResponseCode.SUCCESS;
        }
        return ClientResponseCode[error as keyof typeof ClientResponseCode] as ClientResponseCode;
    }
}
