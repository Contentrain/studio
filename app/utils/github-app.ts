export function getGitHubAppInstallUrl(): string {
  const config = useRuntimeConfig()
  const appSlug = config.public.githubAppSlug || 'contentrain-studio'
  return `https://github.com/apps/${appSlug}/installations/new`
}
