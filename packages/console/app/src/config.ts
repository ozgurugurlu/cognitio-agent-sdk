/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://cognitio.ai",

  // GitHub
  github: {
    repoUrl: "https://github.com/anomalyco/cognitio",
    starsFormatted: {
      compact: "140K",
      full: "140,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/cognitio",
    discord: "https://discord.gg/cognitio",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "850",
    commits: "11,000",
    monthlyUsers: "6.5M",
  },
} as const
