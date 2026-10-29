declare const __WAITLIST_VERSION__: string | undefined

export const PACKAGE_VERSION: string = typeof __WAITLIST_VERSION__ === "string" ? __WAITLIST_VERSION__ : "dev"
