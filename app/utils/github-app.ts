export function getGitHubAppInstallUrl(workspaceId: string): string {
  const config = useRuntimeConfig()
  const appSlug = config.public.githubAppSlug || 'contentrain-studio'
  const params = new URLSearchParams({ state: workspaceId })
  return `https://github.com/apps/${appSlug}/installations/new?${params.toString()}`
}
