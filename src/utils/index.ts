export function arraysEqual(arr1: any[], arr2: any[]): boolean {
    if (arr1.length !== arr2.length) {
        return false;
    }

    for (let i = arr1.length; i--;) {
        if (arr1[i] !== arr2[i]) {
            return false;
        }
    }

    return true;
}

export function getStackTrace(): any {
    const obj: any = {};
    Error.captureStackTrace(obj, getStackTrace);

    return obj.stack;
}
