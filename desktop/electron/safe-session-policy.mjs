export function ownsSafeSessionResource(activeResource, candidateResource) {
  return Boolean(candidateResource) && activeResource === candidateResource;
}
