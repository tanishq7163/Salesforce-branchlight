export function extensionManifest(
  source: chrome.runtime.ManifestV3,
  apiUrl?: string,
): chrome.runtime.ManifestV3 {
  if (
    source.manifest_version !== 3 ||
    !source.name ||
    !source.version ||
    (source.description?.length ?? 0) > 132
  ) {
    throw new Error(
      'Extension metadata must use Manifest V3 with a description of at most 132 characters.',
    );
  }
  if (!apiUrl) return structuredClone(source);
  const parsed = new URL(apiUrl);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('A packaged hosted extension requires an HTTPS API origin.');
  }
  return {
    ...structuredClone(source),
    permissions: ['identity', 'storage'],
    host_permissions: [`https://${parsed.hostname}/*`],
  };
}
