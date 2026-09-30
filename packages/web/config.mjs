const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://cognitio.ai" : `https://${stage}.cognitio.ai`,
  console: stage === "production" ? "https://cognitio.ai/auth" : `https://${stage}.cognitio.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/cognitio",
  discord: "https://cognitio.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
