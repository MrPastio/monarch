export function ownsSafeSessionResource(activeResource, candidateResource) {
  return Boolean(candidateResource) && activeResource === candidateResource;
}

export function shouldLockSafeOnBlur({ ownsSession, lockOnBlur, trustedAuthorizationOpen }) {
  return Boolean(ownsSession && lockOnBlur && !trustedAuthorizationOpen);
}
