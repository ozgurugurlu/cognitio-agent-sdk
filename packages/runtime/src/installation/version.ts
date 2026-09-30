declare global {
  const COGNITIO_VERSION: string
  const COGNITIO_CHANNEL: string
}

export const InstallationVersion = typeof COGNITIO_VERSION === "string" ? COGNITIO_VERSION : "local"
export const InstallationChannel = typeof COGNITIO_CHANNEL === "string" ? COGNITIO_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
