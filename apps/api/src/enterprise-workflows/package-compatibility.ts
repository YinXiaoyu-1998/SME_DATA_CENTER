// Package patches share the v1 protocol; new minor/major lines require service review.
// This is independent of the service capability version and never rewrites a run's pin.
export function supportsWorkflowPackageVersion(version: string): boolean {
  return /^1\.0\.(0|[1-9][0-9]*)$/.test(version);
}
